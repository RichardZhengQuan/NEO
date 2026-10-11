/**
 * Write path: observe(), remember(), approve(), reject(), forget(), link(),
 * unlink(), and reinforcement after recall.
 *
 * Every write runs in ONE transaction through {@link runWrite}. Embeddings are
 * computed before the transaction (they are async); vectors are written with
 * the rows and enter the cache only after commit, so a rollback leaves the
 * cache, the FTS index and the rows consistent.
 */
import type {
  EdgeType,
  Embedder,
  MemoryEdge,
  MemoryKind,
  MemoryNode,
  MemorySource,
  MemoryWriteResult,
  Message,
  ObservedTurn,
  RecalledMemory,
  RememberInput,
  Sensitivity,
} from '@neo/protocol';
import { describeUiEvent, EdgeTypeSchema, NeoError, newId, RememberInputSchema } from '@neo/protocol';
import { MEMORY_CONSTANTS } from './constants.js';
import type { MemoryContext } from './context.js';
import {
  addEdge,
  deleteNodes,
  findEdge,
  findEntityByName,
  getEdge,
  getEdgeBySrcDstType,
  getNode,
  insertEdge,
  insertNode,
  rowToEdge,
  updateNode,
  type EdgeRow,
  type NodeRow,
} from './db-helpers.js';
import { nodeEmbedText } from './embedder.js';
import { buildExtractionInput, llmExtract, type ExtractionResult, type MemoryOp } from './extract.js';
import { heuristicEpisode, heuristicExtract } from './heuristic.js';
import { redactJournal } from './journal.js';
import { cleanLabel, containsTerm, deriveLabel, hasCJK, hasCredentials, looksSensitive, mentionsBlockedTopic, normalizeText } from './text.js';
import { clamp01, dot, effectiveEdgeWeight, initialStability, normalized, reinforcedFields } from './utils.js';
import { tagVector, vectorModel } from './vectors.js';

const C = MEMORY_CONSTANTS;
type WritableStatus = 'active' | 'pending';

// ─────────────────────────────── write sessions ────────────────────────────────

/**
 * Embed texts; on failure, log and return nulls (the nodes are re-embedded later).
 * `local` (one flag, or one per text) marks text that must stay on the device
 * ({@link MemoryContext.keepLocal}): it goes to the local embedder only. Every
 * vector is tagged with the model it came from.
 */
export async function embedTexts(ctx: MemoryContext, texts: string[], local: boolean | readonly boolean[] = false): Promise<(Float32Array | null)[]> {
  if (!texts.length) return [];
  const out: (Float32Array | null)[] = texts.map(() => null);
  const groups = new Map<Embedder, number[]>();
  texts.forEach((_, i) => {
    const onDevice = typeof local === 'boolean' ? local : local[i] === true;
    const embedder = onDevice ? ctx.localEmbedder : ctx.embedder;
    groups.set(embedder, [...(groups.get(embedder) ?? []), i]);
  });
  for (const [embedder, idx] of groups) {
    try {
      const vectors = await embedder.embed(idx.map((i) => texts[i]!));
      if (vectors.length !== idx.length) throw new Error(`embedder returned ${vectors.length} vectors for ${idx.length} texts`);
      idx.forEach((i, k) => {
        const v = vectors[k];
        const vec = v ? (normalized(v) ?? (v.every((x) => x === 0) ? Float32Array.from(v) : null)) : null;
        out[i] = vec ? tagVector(vec, embedder.id) : null;
      });
    } catch (err) {
      ctx.logger.warn('memory: embedding failed; vectors will be computed later', { error: String(err) });
    }
  }
  return out;
}

/** State of one write transaction: staged vectors and the node ids each change event will carry. */
export class WriteSession {
  readonly staged = new Map<string, Float32Array>();
  readonly created = new Set<string>();
  readonly pending = new Set<string>();
  readonly updated = new Set<string>();
  readonly deleted = new Set<string>();
  /** Vectors of entity names, computed before the transaction, by normalized name. */
  readonly entityVectors = new Map<string, Float32Array | null>();
  missingVectors = false;

  constructor(
    readonly ctx: MemoryContext,
    readonly now: number,
  ) {}

  get model(): string {
    return this.ctx.embedder.id;
  }

  /**
   * A node's vector in the given model (default: the main one): staged in this
   * session, else cached. Vectors of other models are never returned, so they are
   * never compared with each other.
   */
  vectorOf(id: string, model: string = this.model): Float32Array | undefined {
    const staged = this.staged.get(id);
    if (staged) return (vectorModel(staged) ?? this.model) === model ? staged : undefined;
    return this.ctx.vectors.get(model, id);
  }

  /**
   * Store the vector of a node's (new) text under the model it was computed with;
   * without one, mark the node for background re-embedding. Returns the model, or null.
   */
  writeVector(id: string, vector: Float32Array | null | undefined): string | null {
    const model = vector ? (vectorModel(vector) ?? this.model) : this.model;
    const stored = vector ? this.ctx.vectors.write(model, id, vector) : null;
    if (stored) {
      this.staged.set(id, stored);
      return model;
    }
    this.ctx.db.prepare('UPDATE memory_nodes SET embedding_model = NULL WHERE id = ?').run(id);
    this.missingVectors = true;
    return null;
  }

  /**
   * After a status or sensitivity change: a node whose vector is not where it now
   * belongs (local while it must stay on the device, main otherwise) is queued
   * for re-embedding. Text that must stay local is never sent anywhere by this.
   */
  syncVectorPlace(node: MemoryNode): void {
    const { ctx } = this;
    if (ctx.localEmbedder === ctx.embedder) return;
    const want = ctx.keepLocal(node) ? ctx.localEmbedder.id : ctx.embedder.id;
    const row = ctx.db.prepare('SELECT embedding_model FROM memory_nodes WHERE id = ?').get(node.id) as { embedding_model: string | null } | undefined;
    if (!row || row.embedding_model === want || row.embedding_model === null) return;
    ctx.db.prepare('UPDATE memory_nodes SET embedding_model = NULL WHERE id = ?').run(node.id);
    this.missingVectors = true;
  }

  markNew(node: MemoryNode): void {
    (node.status === 'pending' ? this.pending : this.created).add(node.id);
  }
}

/** Run `fn` in one transaction; on commit, cache the vectors and emit change events. */
export function runWrite<T>(ctx: MemoryContext, now: number, fn: (s: WriteSession) => T): T {
  ctx.vectors.all(ctx.embedder.id); // lazy load outside the transaction
  const s = new WriteSession(ctx, now);
  const result = ctx.db.transaction(() => fn(s));
  for (const [id, vec] of s.staged) if (!s.deleted.has(id)) ctx.vectors.remember(vectorModel(vec) ?? s.model, id, vec);
  for (const id of s.deleted) ctx.vectors.drop(id);
  if (s.missingVectors) void ctx.vectors.reembedStale(ctx.embedder);
  const fresh = new Set([...s.created, ...s.pending, ...s.deleted]);
  const updated = [...s.updated].filter((id) => !fresh.has(id));
  if (s.created.size) ctx.emit({ type: 'created', nodeIds: [...s.created].filter((id) => !s.deleted.has(id)) });
  if (s.pending.size) ctx.emit({ type: 'pending', nodeIds: [...s.pending].filter((id) => !s.deleted.has(id)) });
  if (updated.length) ctx.emit({ type: 'updated', nodeIds: updated });
  if (s.deleted.size) ctx.emit({ type: 'deleted', nodeIds: [...s.deleted] });
  return result;
}

// ─────────────────────────────── create / merge ────────────────────────────────

export interface CreateSpec {
  kind: MemoryKind;
  label: string;
  content: string;
  importance: number;
  confidence: number;
  sensitivity: Sensitivity;
  pinned: boolean;
  status: WritableStatus;
  source: MemorySource;
  entities: string[];
  /** For an entity: its own type; otherwise: the type of entities created for `entities`. */
  entityType?: string;
  tags: string[];
  validUntil?: number;
  metadata?: Record<string, unknown>;
  vector: Float32Array | null;
}

/** Embedding text of a new entity created for a name. */
function entityText(name: string): string {
  return nodeEmbedText('entity', name, entityContent(name), []);
}

function entityContent(name: string): string {
  return `Entity: ${name}`;
}

/**
 * Collect entity names that need a vector (no entity of that name yet) into the session map.
 * `local` says which names must stay on the device (they belong to a sensitive or pending write).
 */
export async function prepareEntityVectors(
  ctx: MemoryContext,
  names: Iterable<string>,
  into: Map<string, Float32Array | null>,
  local: boolean | ((name: string) => boolean) = false,
): Promise<void> {
  const todo = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim().slice(0, 120);
    const key = normalizeText(name);
    if (!key || todo.has(key) || into.has(key) || findEntityByName(ctx.db, name)) continue;
    todo.set(key, name);
  }
  const flags = [...todo.values()].map((name) => (typeof local === 'boolean' ? local : local(name)));
  const vectors = await embedTexts(ctx, [...todo.values()].map(entityText), flags);
  [...todo.keys()].forEach((key, i) => into.set(key, vectors[i] ?? null));
}

/** The more restrictive of two sensitivities. */
function stricter(a: Sensitivity, b: Sensitivity | undefined): Sensitivity {
  return a === 'sensitive' || b === 'sensitive' ? 'sensitive' : 'normal';
}

/** An active/pending node of the same kind with similarity ≥ dedupeSimilarity (exact text when no vector). */
function findDuplicate(s: WriteSession, spec: CreateSpec): MemoryNode | null {
  const { db } = s.ctx;
  if (spec.vector) {
    const model = vectorModel(spec.vector) ?? s.model;
    const ids = db.prepare(`SELECT id FROM memory_nodes WHERE kind = ? AND status IN ('active', 'pending')`).all(spec.kind) as { id: string }[];
    let best: { id: string; sim: number } | null = null;
    for (const { id } of ids) {
      const v = s.vectorOf(id, model);
      if (!v) continue;
      const sim = dot(v, spec.vector);
      if (sim >= C.dedupeSimilarity && (!best || sim > best.sim)) best = { id, sim };
    }
    if (best) return getNode(db, best.id);
  }
  const rows = db
    .prepare(`SELECT * FROM memory_nodes WHERE kind = ? AND norm_label = ? AND status IN ('active', 'pending')`)
    .all(spec.kind, normalizeText(spec.label)) as unknown as NodeRow[];
  const content = normalizeText(spec.content);
  const same = rows.find((r) => normalizeText(r.content) === content);
  return same ? getNode(db, same.id) : null;
}

/** Content is replaced unless the new text adds nothing (a placeholder, or already contained). */
function shouldReplaceContent(target: MemoryNode, content: string): boolean {
  const next = normalizeText(content);
  const prev = normalizeText(target.content);
  if (!next || next === prev) return false;
  if (next === normalizeText(entityContent(target.label))) return false;
  return !prev.includes(next);
}

/** Mark `oldId` superseded (confidence halved). Returns the updated node, or null when it no longer applies. */
function applySupersession(s: WriteSession, oldId: string): MemoryNode | null {
  const old = getNode(s.ctx.db, oldId);
  if (!old || old.status === 'superseded') return null;
  const updated = updateNode(s.ctx.db, old.id, { status: 'superseded', confidence: old.confidence * 0.5 }, s.now);
  if (updated) s.updated.add(updated.id);
  return updated;
}

/** Make a pending node active; a pending revision now supersedes its predecessor. */
function activate(s: WriteSession, node: MemoryNode, extra: Partial<MemoryNode> = {}): { node: MemoryNode; superseded: MemoryNode | null } {
  const { supersedes, ...rest } = node.metadata ?? {};
  const fields: Partial<MemoryNode> = { ...extra, status: 'active' };
  if (typeof supersedes === 'string') fields.metadata = Object.keys(rest).length ? rest : undefined;
  const updated = updateNode(s.ctx.db, node.id, fields, s.now)!;
  s.updated.add(updated.id);
  // Approved: its text may now use the main embedder (unless it is sensitive and must stay local).
  s.syncVectorPlace(updated);
  const superseded = typeof supersedes === 'string' ? applySupersession(s, supersedes) : null;
  return { node: updated, superseded };
}

/** Merge a create into an existing node: reinforce, raise importance/confidence, maybe replace content. */
function mergeInto(s: WriteSession, target: MemoryNode, spec: CreateSpec): MemoryNode {
  const fields: Partial<MemoryNode> = reinforcedFields(target, s.now);
  let touch = false;
  // In approve mode a merge must not silently edit an active memory: it only reinforces it.
  const canEdit = !(target.status !== 'pending' && spec.status === 'pending');
  if (spec.importance > target.importance) {
    fields.importance = spec.importance;
    touch = true;
  }
  if (spec.confidence > target.confidence) fields.confidence = spec.confidence;
  let contentChanged = false;
  if (canEdit && shouldReplaceContent(target, spec.content)) {
    fields.content = spec.content;
    contentChanged = touch = true;
  }
  if (spec.sensitivity === 'sensitive' && target.sensitivity !== 'sensitive') {
    fields.sensitivity = 'sensitive';
    touch = true;
  }
  if (canEdit) {
    if (spec.pinned && !target.pinned) fields.pinned = touch = true;
    const tags = [...new Set([...target.tags, ...spec.tags])].slice(0, 20);
    if (tags.length !== target.tags.length) {
      fields.tags = tags;
      touch = true;
    }
    if (spec.kind === 'entity' && spec.entityType && !target.entityType) fields.entityType = spec.entityType;
    if (spec.validUntil !== undefined && spec.validUntil !== target.validUntil) fields.validUntil = spec.validUntil;
  }
  let merged: MemoryNode;
  if (spec.status === 'active' && target.status !== 'active') {
    // Stated again by an active write: a pending memory is now confirmed, an archived one restored.
    merged = activate(s, target, fields).node;
  } else {
    merged = updateNode(s.ctx.db, target.id, fields, s.now, { touch })!;
    s.updated.add(merged.id);
  }
  if (!contentChanged) s.syncVectorPlace(merged);
  if (contentChanged) {
    // The incoming vector was computed where the *write* belongs. When the merged memory belongs
    // elsewhere (e.g. a normal restatement replaced a sensitive memory's content), it is not stored;
    // the node is re-embedded in its own space instead (on the device when it must stay there).
    const want = s.ctx.keepLocal(merged) ? s.ctx.localEmbedder.id : s.ctx.embedder.id;
    const fits = !!spec.vector && (vectorModel(spec.vector) ?? s.model) === want;
    s.writeVector(merged.id, fits ? spec.vector : null);
    // The vector was computed for the incoming label; when the node keeps another label (or has
    // aliases) it is close but not exact, so the node is also queued for an exact re-embedding.
    if (normalizeText(merged.label) !== normalizeText(spec.label) || merged.aliases.length) {
      s.ctx.db.prepare('UPDATE memory_nodes SET embedding_model = NULL WHERE id = ?').run(merged.id);
      s.missingVectors = true;
    }
  }
  return merged;
}

/** Find or create the entity called `name`. New entities inherit the writer's status (pending in approve mode). */
function upsertEntity(
  s: WriteSession,
  name: string,
  opts: { status: WritableStatus; sensitive: boolean; entityType?: string; source: MemorySource },
): MemoryNode | null {
  const label = name.trim().slice(0, 120);
  if (!normalizeText(label)) return null;
  const existing = findEntityByName(s.ctx.db, label);
  if (existing) {
    if (existing.status === 'pending' && opts.status === 'active') return activate(s, existing).node;
    return existing;
  }
  const node: MemoryNode = {
    id: newId('mem', s.now),
    kind: 'entity',
    label,
    content: entityContent(label),
    entityType: opts.entityType,
    aliases: [],
    tags: [],
    importance: 0.5,
    confidence: C.extractionConfidence,
    stability: initialStability('entity', 0.5),
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: s.now,
    updatedAt: s.now,
    status: opts.status,
    pinned: false,
    // An entity that only exists because of a sensitive memory is itself sensitive.
    sensitivity: opts.sensitive ? 'sensitive' : 'normal',
    source: opts.source,
  };
  insertNode(s.ctx.db, node);
  // Use the precomputed vector only when it lives where this entity belongs (local while it is
  // pending or sensitive); otherwise it is re-embedded in the right place later.
  const pre = s.entityVectors.get(normalizeText(label)) ?? null;
  const want = s.ctx.keepLocal(node) ? s.ctx.localEmbedder.id : s.ctx.embedder.id;
  s.writeVector(node.id, pre && (vectorModel(pre) ?? s.model) === want ? pre : null);
  s.markNew(node);
  return node;
}

/**
 * about-edges to the spec's entities (+ episode mentions), and derived_from to the episode.
 * New entities take the status of the incoming write, never that of the node it merged into:
 * in approve mode a write that dedupes into an active memory still creates only pending entities.
 */
function linkProvenance(
  s: WriteSession,
  node: MemoryNode,
  spec: Pick<CreateSpec, 'entities' | 'entityType' | 'kind' | 'sensitivity' | 'source' | 'status'>,
  episodeId?: string,
  derivedWeight = 0.5,
): void {
  for (const name of spec.entities) {
    if (node.kind === 'entity' && normalizeText(name) === normalizeText(node.label)) continue;
    const entity = upsertEntity(s, name, {
      status: spec.status === 'pending' || node.status === 'pending' ? 'pending' : 'active',
      sensitive: spec.sensitivity === 'sensitive' || node.sensitivity === 'sensitive',
      entityType: spec.kind === 'entity' ? undefined : spec.entityType,
      source: spec.source,
    });
    if (!entity || entity.id === node.id) continue;
    addEdge(s.ctx.db, node.id, entity.id, 'about', 0.8, s.now);
    if (episodeId) addEdge(s.ctx.db, episodeId, entity.id, 'mentions', 0.6, s.now);
  }
  if (episodeId && episodeId !== node.id) addEdge(s.ctx.db, node.id, episodeId, 'derived_from', derivedWeight, s.now);
}

/**
 * The create path shared by observe, remember and consolidation: entity
 * upsert by name/alias, dedupe against same-kind active/pending nodes
 * (merge + reinforce), else insert with entities and provenance edges.
 */
export function createOrMerge(s: WriteSession, spec: CreateSpec, opts: { episodeId?: string; derivedWeight?: number } = {}): { node: MemoryNode; merged: boolean } {
  const { db } = s.ctx;
  let target: MemoryNode | null = null;
  if (spec.kind === 'entity') {
    const named = findEntityByName(db, spec.label);
    if (named && named.status !== 'superseded') target = named;
  }
  target ??= findDuplicate(s, spec);
  if (target) {
    const node = mergeInto(s, target, spec);
    linkProvenance(s, node, spec, opts.episodeId, opts.derivedWeight);
    return { node, merged: true };
  }
  const node: MemoryNode = {
    id: newId('mem', s.now),
    kind: spec.kind,
    label: spec.label,
    content: spec.content,
    entityType: spec.kind === 'entity' ? spec.entityType : undefined,
    aliases: [],
    tags: spec.tags.slice(0, 20),
    importance: clamp01(spec.importance),
    confidence: clamp01(spec.confidence),
    stability: initialStability(spec.kind, spec.importance),
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: s.now,
    updatedAt: s.now,
    status: spec.status,
    pinned: spec.pinned,
    sensitivity: spec.sensitivity,
    source: spec.source,
    validUntil: spec.validUntil,
    metadata: spec.metadata,
  };
  insertNode(db, node);
  const model = s.writeVector(node.id, spec.vector);
  if (model) node.embeddingModel = model;
  s.markNew(node);
  linkProvenance(s, node, spec, opts.episodeId, opts.derivedWeight);
  return { node, merged: false };
}

/**
 * A new version of `old` with an edge `new —supersedes→ old` and old's
 * about-edges copied. Pending revisions remember what they supersede so
 * approval applies it and rejection leaves the old belief untouched.
 */
function createRevision(
  s: WriteSession,
  old: MemoryNode,
  r: {
    kind: MemoryKind;
    label: string;
    content: string;
    status: WritableStatus;
    source: MemorySource;
    reason?: string;
    vector: Float32Array | null;
    episodeId?: string;
    /** Raised (never lowered) from the old node's. */
    sensitivity?: Sensitivity;
  },
): MemoryNode {
  const metadata: Record<string, unknown> = {};
  if (r.status === 'pending') metadata['supersedes'] = old.id;
  if (r.reason) metadata['reason'] = r.reason.slice(0, 500);
  const node: MemoryNode = {
    id: newId('mem', s.now),
    kind: r.kind,
    label: r.label,
    content: r.content,
    entityType: r.kind === 'entity' ? old.entityType : undefined,
    aliases: r.kind === 'entity' && old.kind === 'entity' ? old.aliases : [],
    tags: old.tags,
    importance: old.importance,
    confidence: C.extractionConfidence,
    stability: initialStability(r.kind, old.importance),
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: s.now,
    updatedAt: s.now,
    status: r.status,
    pinned: old.pinned,
    sensitivity: stricter(old.sensitivity, r.sensitivity),
    source: r.source,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
  insertNode(s.ctx.db, node);
  const model = s.writeVector(node.id, r.vector);
  if (model) node.embeddingModel = model;
  s.markNew(node);
  addEdge(s.ctx.db, node.id, old.id, 'supersedes', 1, s.now);
  const about = s.ctx.db.prepare(`SELECT dst, weight FROM memory_edges WHERE src = ? AND type = 'about'`).all(old.id) as { dst: string; weight: number }[];
  for (const e of about) addEdge(s.ctx.db, node.id, e.dst, 'about', e.weight, s.now);
  if (r.episodeId) addEdge(s.ctx.db, node.id, r.episodeId, 'derived_from', 0.5, s.now);
  return node;
}

// ─────────────────────────────── observe ────────────────────────────────

/** Visible text of a message: text parts (+ described UI events for the user). Never context parts or tool outputs. */
export function messageText(message: Message, includeUiEvents: boolean): string {
  const out: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') out.push(part.text);
    else if (part.type === 'ui_event' && includeUiEvents) out.push(describeUiEvent(part));
  }
  return out.join('\n').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Episode content when the extractor gave no summary: the user's own words,
 * "User: …" within 600 chars. NEO's reply is left out: an episode recalls what
 * the user did, and the assistant's wording must not become recallable text.
 */
function rawEpisodeContent(userText: string): string {
  return `User: ${clip(userText.replace(/<\/?ui_event>/g, '').replace(/\s+/g, ' ').trim(), 594)}`;
}

function heuristicPlan(userText: string): ExtractionResult {
  const extracted = heuristicExtract(userText);
  const memories: MemoryOp[] = extracted.map((m) => {
    const op: MemoryOp = {
      op: 'create',
      kind: m.kind ?? 'fact',
      label: m.label ?? deriveLabel(m.content),
      content: m.content,
      importance: m.importance ?? 0.5,
      sensitivity: m.sensitivity ?? 'normal',
    };
    if (m.entities?.length) op.entities = m.entities;
    if (m.entityType) op.entityType = m.entityType;
    return op;
  });
  const label = heuristicEpisode(userText, extracted);
  return { episode: label ? { label, importance: 0.3 } : null, memories, links: [] };
}

// ─────────────────────────────── memories written by tools in this turn ────────────────────────────────

const MEMORY_ID = /^mem_[A-Za-z0-9_-]{1,100}$/;

/** The object a successful tool call of `name` returned (JSON strings are parsed). */
function toolOutputs(assistant: Message, name: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const part of assistant.parts) {
    if (part.type !== 'tool_result' || part.name !== name || part.isError) continue;
    let output: unknown = part.output;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output) as unknown;
      } catch {
        continue;
      }
    }
    if (output && typeof output === 'object' && !Array.isArray(output)) out.push(output as Record<string, unknown>);
  }
  return out;
}

/** Memory ids our own memory tools returned; nothing else of their output is read. */
function memoryIds(values: unknown[]): string[] {
  return values.filter((id): id is string => typeof id === 'string' && MEMORY_ID.test(id));
}

/**
 * Memories the `remember` tool wrote while NEO answered this turn ("Remember that
 * I am vegetarian" → the model called remember). Only the id our own tool
 * returned is read, to look the node up in the net; no other tool output, and
 * no text of any tool output, is ever used.
 */
function rememberedThisTurn(ctx: MemoryContext, assistant: Message): MemoryNode[] {
  const out = new Map<string, MemoryNode>();
  for (const id of memoryIds(toolOutputs(assistant, 'remember').map((o) => o['id']))) {
    if (out.has(id)) continue;
    const node = getNode(ctx.db, id);
    if (node && (node.status === 'active' || node.status === 'pending')) out.set(id, node);
  }
  return [...out.values()];
}

/**
 * True when the turn touched a sensitive memory: sensitive memories were recalled
 * into it (the context part says so, or the recall tool returned one), or the
 * remember tool stored a sensitive memory in it.
 */
function turnTouchesSensitive(ctx: MemoryContext, turn: ObservedTurn, written: readonly MemoryNode[]): boolean {
  if (turn.userMessage.sensitive || turn.assistantMessage.sensitive) return true;
  if (turn.assistantMessage.parts.some((p) => p.type === 'tool_result' && p.sensitive === true)) return true;
  if (turn.userMessage.parts.some((p) => p.type === 'context' && p.sensitive === true)) return true;
  if (written.some((n) => n.sensitivity === 'sensitive')) return true;
  const recalledIds = memoryIds(
    toolOutputs(turn.assistantMessage, 'recall').flatMap((o) =>
      Array.isArray(o['memories']) ? (o['memories'] as unknown[]).map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>)['id'] : undefined)) : [],
    ),
  );
  return recalledIds.some((id) => getNode(ctx.db, id)?.sensitivity === 'sensitive');
}

/**
 * True when the turn involved sensitive content, so a cloud model must not see
 * it (unless policy.sendSensitiveToCloud): it touched a sensitive memory
 * ({@link turnTouchesSensitive}), or the texts touch a sensitive topic.
 */
function turnIsSensitive(touchesSensitive: boolean, texts: string[]): boolean {
  if (touchesSensitive || texts.some(looksSensitive)) return true;
  return texts.some((t) => heuristicExtract(t).some((m) => m.sensitivity === 'sensitive'));
}

/** Normalized text for containment checks: NFKC, lower case, punctuation and symbols as spaces. */
function dedupeText(text: string): string {
  return normalizeText(text.replace(/[\p{P}\p{S}]+/gu, ' '));
}

/** Long enough that containing it means saying the same thing ("vegetarian", "喜欢喝茶"; not "tea"). */
function substantial(text: string): boolean {
  return hasCJK(text) ? [...text].length >= 3 : text.length >= 6;
}

/** Either text contains the other as whole words (substring for CJK). */
function overlaps(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (substantial(b) && containsTerm(a, b)) || (substantial(a) && containsTerm(b, a));
}

const PERSONAL_KINDS = new Set<MemoryKind>(['fact', 'preference']);

/**
 * The memory written by a tool in this turn that an extracted create restates:
 * same kind (fact and preference count as one), and the same or contained label
 * or content, or a vector similarity ≥ turnDedupeSimilarity. Looser than
 * dedupeSimilarity on purpose: within one turn, both say what the user just said.
 */
function sameTurnMemory(
  s: WriteSession,
  op: { kind: MemoryKind; label: string; content: string },
  vector: Float32Array | null,
  written: readonly MemoryNode[],
): MemoryNode | null {
  const label = dedupeText(op.label);
  const content = dedupeText(op.content);
  // Only vectors of the same embedding model are comparable (equal dimensions are not enough).
  const model = vector ? (vectorModel(vector) ?? s.model) : s.model;
  for (const node of written) {
    if (node.kind !== op.kind && !(PERSONAL_KINDS.has(node.kind) && PERSONAL_KINDS.has(op.kind))) continue;
    if (overlaps(label, dedupeText(node.label)) || overlaps(content, dedupeText(node.content))) return node;
    const v = vector ? s.vectorOf(node.id, model) : undefined;
    if (vector && v && dot(vector, v) >= C.turnDedupeSimilarity) return node;
  }
  return null;
}

/** As a related memory for the extraction prompt (the model then reinforces instead of creating). */
function asRelated(node: MemoryNode): RecalledMemory {
  return { node, score: 1, activation: 1, similarity: 1, retention: 1, via: [], reason: 'written by the remember tool in this turn' };
}

const nothing = (skipped: string): MemoryWriteResult => ({ created: [], updated: [], superseded: [], pending: [], linked: 0, skipped });

export interface ObserveDeps {
  /** Related memories for the extraction prompt (recall without reinforcement). */
  related(text: string, allowSensitive: boolean): Promise<RecalledMemory[]>;
}

/** Extract, filter and apply what is worth remembering from one exchange. */
export async function observe(ctx: MemoryContext, turn: ObservedTurn, deps: ObserveDeps): Promise<MemoryWriteResult> {
  const policy = ctx.policy();
  if (policy.mode === 'off') return nothing('memory is off');
  const now = turn.now ?? ctx.clock();
  const userText = messageText(turn.userMessage, true).slice(0, C.maxTurnTextChars);
  const assistantText = messageText(turn.assistantMessage, false).slice(0, C.maxTurnTextChars);
  if (!userText) return nothing('nothing to remember');
  // What the remember tool already wrote in this turn counts as existing memory, not news.
  const written = rememberedThisTurn(ctx, turn.assistantMessage);
  const writtenIds = new Set(written.map((n) => n.id));
  const touchesSensitive = turnTouchesSensitive(ctx, turn, written);

  // Labels of memories the forget tool deleted in this turn — a create op must not re-create them.
  const forgottenLabels: string[] = toolOutputs(turn.assistantMessage, 'forget')
    .flatMap((o) => (Array.isArray(o['forgotten']) ? (o['forgotten'] as unknown[]) : []))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);

  // ── 1. extraction (model, else heuristic) ──
  let plan: ExtractionResult | null = null;
  const llm = ctx.llm();
  // A cloud extraction model never sees a turn that involved sensitive content unless the user
  // allowed sending sensitive memories to the cloud: such turns are extracted on the device.
  const keepOffCloud = !!llm && !llm.isLocal && !policy.sendSensitiveToCloud && turnIsSensitive(touchesSensitive, [userText, assistantText]);
  if (llm && !keepOffCloud) {
    try {
      // Sensitive memories only go to a model on the user's own infrastructure (or when allowed).
      const allowSensitive = llm.isLocal || policy.sendSensitiveToCloud;
      const recalled = await deps.related(userText, allowSensitive).catch((err: unknown) => {
        ctx.logger.warn('memory: related-memory lookup failed', { error: String(err) });
        return [];
      });
      const related = [
        ...written.filter((n) => allowSensitive || n.sensitivity === 'normal').map(asRelated),
        ...recalled.filter((m) => !writtenIds.has(m.node.id)),
      ];
      const input = buildExtractionInput({ userText, assistantText, related, policy, date: new Date(now).toISOString().slice(0, 10) });
      plan = await llmExtract(llm.model, llm.name, input);
      if (!plan) ctx.logger.warn('memory: extraction reply was not usable; using the offline extractor');
    } catch (err) {
      ctx.logger.warn('memory: extraction failed; using the offline extractor', { error: String(err) });
    }
  }
  plan ??= heuristicPlan(userText);

  // ── 2. filters (always, also on model output) ──
  const allowed = new Set<MemoryKind>(policy.allowedKinds);
  const refused = (...texts: (string | undefined)[]) =>
    texts.some((t) => !!t && (mentionsBlockedTopic(t, policy.blockedTopics) || hasCredentials(t)));
  const ops = plan.memories
    .map((op): MemoryOp => {
      // Labels are titles: no quotes, no punctuation at the ends ("Prefers window seats”." → "Prefers window seats").
      if (op.op === 'create' || op.op === 'supersede') return { ...op, label: cleanLabel(op.label) || deriveLabel(op.content) };
      if (op.op === 'update' && op.label !== undefined) return { ...op, label: cleanLabel(op.label) || op.label };
      return op;
    })
    .filter((op) => {
      switch (op.op) {
        case 'create':
          if (op.validUntil !== undefined && op.validUntil <= now) return false;
          if (!allowed.has(op.kind) || refused(op.label, op.content, ...(op.entities ?? []), ...(op.tags ?? []))) return false;
          // Don't re-create a memory the forget tool just deleted in this same turn.
          if (forgottenLabels.length > 0) {
            const dl = dedupeText(op.label);
            const dc = dedupeText(op.content);
            if (forgottenLabels.some((fl) => overlaps(dl, dedupeText(fl)) || overlaps(dc, dedupeText(fl)))) return false;
          }
          return true;
        case 'update':
          return !refused(op.label, op.content);
        case 'supersede':
          return (!op.kind || allowed.has(op.kind)) && !refused(op.label, op.content);
        case 'reinforce':
          // Written by the remember tool a moment ago: already as strong as this turn makes it.
          return !writtenIds.has(op.id);
      }
    });
  let episode: { label: string; content: string; importance: number } | null = null;
  if (plan.episode && policy.storeEpisodes && allowed.has('episode') && !mentionsBlockedTopic(userText, policy.blockedTopics)) {
    const content = plan.episode.summary ?? rawEpisodeContent(userText);
    const label = cleanLabel(plan.episode.label ?? '') || deriveLabel(plan.episode.summary ?? userText);
    if (!refused(label, content)) episode = { label: label.slice(0, 80), content: content.slice(0, 600), importance: plan.episode.importance ?? 0.3 };
  }
  if (!episode && !ops.length && !plan.links.length) {
    return nothing(mentionsBlockedTopic(userText, policy.blockedTopics) ? 'blocked topic' : 'nothing worth remembering');
  }

  // ── 3. embeddings (async, before the transaction) ──
  // Every text is embedded where its memory's privacy allows: pending and sensitive memories
  // stay on the device (ctx.keepLocal) unless the main embedder is local anyway.
  const { db } = ctx;
  let status: WritableStatus = policy.mode === 'approve' ? 'pending' : 'active';
  const sens = (sensitive: boolean): Sensitivity => (sensitive ? 'sensitive' : 'normal');
  // An episode is as sensitive as the turn it records: one that touched a sensitive memory, whose
  // user text (or the episode's own text) looks sensitive, or that produced or revised sensitive
  // memories. A merge into a sensitive memory, only known inside the transaction, raises it there.
  const episodeSensitive =
    touchesSensitive ||
    looksSensitive(userText) ||
    (!!episode && (looksSensitive(episode.label) || looksSensitive(episode.content))) ||
    ops.some((op) => op.op !== 'reinforce' && op.sensitivity === 'sensitive') ||
    ops.some((op) => (op.op === 'update' || op.op === 'supersede') && getNode(db, op.id)?.sensitivity === 'sensitive');
  const texts: string[] = [];
  const local: boolean[] = [];
  const at = (text: string, node: { sensitivity: Sensitivity; status: string }) => {
    local.push(ctx.keepLocal(node));
    return texts.push(text) - 1;
  };
  const episodeIdx = episode ? at(nodeEmbedText('episode', episode.label, episode.content, []), { sensitivity: sens(episodeSensitive), status }) : -1;
  const opIdx = ops.map((op) => {
    if (op.op === 'create') return at(nodeEmbedText(op.kind, op.label, op.content, []), { sensitivity: op.sensitivity ?? 'normal', status });
    if (op.op === 'update') {
      const existing = getNode(db, op.id);
      if (!existing) return -1;
      const after = { sensitivity: stricter(existing.sensitivity, op.sensitivity), status: status === 'pending' && existing.status === 'active' ? 'pending' : existing.status };
      return at(nodeEmbedText(existing.kind, op.label ?? existing.label, op.content, existing.aliases), after);
    }
    if (op.op === 'supersede') {
      const old = getNode(db, op.id);
      const kind = op.kind ?? old?.kind ?? 'fact';
      const after = { sensitivity: stricter(old?.sensitivity ?? 'normal', op.sensitivity), status };
      return at(nodeEmbedText(kind, op.label, op.content, kind === 'entity' ? (old?.aliases ?? []) : []), after);
    }
    return -1;
  });
  const vectors = await embedTexts(ctx, texts, local);
  const vec = (i: number) => (i >= 0 ? (vectors[i] ?? null) : null);
  const entityVectors = new Map<string, Float32Array | null>();
  const localNames = new Set(
    ops.flatMap((op) => (op.op === 'create' && ctx.keepLocal({ sensitivity: op.sensitivity ?? 'normal', status }) ? (op.entities ?? []) : [])).map(normalizeText),
  );
  await prepareEntityVectors(
    ctx,
    ops.flatMap((op) => (op.op === 'create' ? (op.entities ?? []) : [])),
    entityVectors,
    (name) => localNames.has(normalizeText(name)),
  );

  // ── 4. apply in one transaction ──
  // Recheck policy after the async embedding gap: the user may have turned memory off or switched
  // to approve-first mode while we were waiting for vectors.
  {
    const latestPolicy = ctx.policy();
    // Critical: if memory was disabled while we were embedding, drop everything.
    if (latestPolicy.mode === 'off') return nothing('memory was disabled after extraction');
    // If the mode tightened to approve-first, route everything to pending so nothing lands silently.
    if (latestPolicy.mode === 'approve') status = 'pending';
    // Any other policy change (allowed kinds, blocked topics, privacy) invalidates the filters above:
    // dropping this observation is safer than writing under rules the user just replaced.
    const { mode: _m1, ...latestRules } = latestPolicy;
    const { mode: _m2, ...capturedRules } = policy;
    if (JSON.stringify(latestRules) !== JSON.stringify(capturedRules)) return nothing('memory settings changed during extraction');
  }

  const source: MemorySource = { by: 'extraction', conversationId: turn.conversationId, messageId: turn.userMessage.id };
  return runWrite(ctx, now, (s) => {
    for (const [k, v] of entityVectors) s.entityVectors.set(k, v);
    const result: MemoryWriteResult = { created: [], updated: [], superseded: [], pending: [], linked: 0 };
    const listed = new Map<string, MemoryNode[]>();
    const list = (target: MemoryNode[], node: MemoryNode) => {
      const where = listed.get(node.id);
      if (where) where[where.findIndex((n) => n.id === node.id)] = node;
      else {
        target.push(node);
        listed.set(node.id, target);
      }
    };
    const touched: MemoryNode[] = [];

    let episodeId: string | undefined;
    let episodeNode: MemoryNode | undefined;
    if (episode) {
      const node: MemoryNode = {
        id: newId('mem', now),
        kind: 'episode',
        label: episode.label,
        content: episode.content,
        aliases: [],
        tags: [],
        importance: episode.importance,
        confidence: C.extractionConfidence,
        stability: initialStability('episode', episode.importance),
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: now,
        updatedAt: now,
        status,
        pinned: false,
        sensitivity: sens(episodeSensitive),
        source,
      };
      insertNode(db, node);
      s.writeVector(node.id, vec(episodeIdx));
      s.markNew(node);
      episodeId = node.id;
      episodeNode = node;
      list(status === 'pending' ? result.pending : result.created, node);
      touched.push(node);
      const prev = db
        .prepare(
          `SELECT id FROM memory_nodes
           WHERE kind = 'episode' AND id != ? AND status != 'superseded' AND created_at <= ?
             AND json_extract(source, '$.conversationId') = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(node.id, now, turn.conversationId) as { id: string } | undefined;
      if (prev) addEdge(db, prev.id, node.id, 'precedes', 1, now);
    }

    ops.forEach((op, i) => {
      switch (op.op) {
        case 'create': {
          const spec: CreateSpec = {
            kind: op.kind,
            label: op.label,
            content: op.content,
            importance: op.importance ?? 0.5,
            confidence: C.extractionConfidence,
            sensitivity: op.sensitivity ?? 'normal',
            pinned: false,
            status,
            source,
            entities: op.entities ?? [],
            entityType: op.entityType,
            tags: op.tags ?? [],
            validUntil: op.validUntil,
            vector: vec(opIdx[i]!),
          };
          const same = sameTurnMemory(s, op, spec.vector, written);
          if (same) {
            // The remember tool already wrote it this turn: only add what extraction knows on top
            // (its entities, the episode it came from, and its sensitivity: sensitivity only goes
            // up), never a second copy.
            let current = getNode(db, same.id) ?? same;
            if (spec.sensitivity === 'sensitive' && current.sensitivity !== 'sensitive') {
              current = updateNode(db, current.id, { sensitivity: 'sensitive' }, now)!;
              // Its vector moves on the device when the main embedder is remote.
              s.syncVectorPlace(current);
              s.updated.add(current.id);
              list(result.updated, current);
            }
            linkProvenance(s, current, { ...spec, sensitivity: current.sensitivity }, episodeId);
            touched.push(current);
            break;
          }
          const { node, merged } = createOrMerge(s, spec, { episodeId });
          list(merged ? result.updated : node.status === 'pending' ? result.pending : result.created, node);
          touched.push(node);
          break;
        }
        case 'update': {
          const existing = getNode(db, op.id);
          if (!existing || (existing.status !== 'active' && existing.status !== 'pending')) break;
          if (status === 'pending' && existing.status === 'active') {
            // Approve mode: the edit becomes a pending revision the user can accept or reject.
            const revision = createRevision(s, existing, {
              kind: existing.kind,
              label: op.label ?? existing.label,
              content: op.content,
              status,
              source,
              reason: op.reason,
              vector: vec(opIdx[i]!),
              episodeId,
              sensitivity: op.sensitivity,
            });
            list(result.pending, revision);
            touched.push(revision);
            break;
          }
          const updated = updateNode(db, existing.id, {
            label: op.label ?? existing.label,
            content: op.content,
            confidence: Math.min(1, existing.confidence + 0.05),
            // An update may make a memory sensitive (a diagnosis), never less sensitive.
            sensitivity: stricter(existing.sensitivity, op.sensitivity),
            ...reinforcedFields(existing, now),
          }, now)!;
          s.writeVector(updated.id, vec(opIdx[i]!));
          s.updated.add(updated.id);
          list(result.updated, updated);
          touched.push(updated);
          break;
        }
        case 'supersede': {
          const old = getNode(db, op.id);
          if (!old || old.status === 'superseded') break;
          const revision = createRevision(s, old, {
            kind: op.kind ?? old.kind,
            label: op.label,
            content: op.content,
            status,
            source,
            reason: op.reason,
            vector: vec(opIdx[i]!),
            episodeId,
            sensitivity: op.sensitivity,
          });
          list(status === 'pending' ? result.pending : result.created, revision);
          touched.push(revision);
          if (status === 'active') {
            const superseded = applySupersession(s, old.id);
            if (superseded) result.superseded.push(superseded);
          }
          break;
        }
        case 'reinforce': {
          const node = getNode(db, op.id);
          if (node?.status === 'active') updateNode(db, node.id, reinforcedFields(node, now), now, { touch: false });
          break;
        }
      }
    });

    // The turn merged into (or otherwise touched) a sensitive memory: its episode is sensitive too.
    if (episodeNode && episodeNode.sensitivity !== 'sensitive' && touched.some((n) => n.id !== episodeNode.id && n.sensitivity === 'sensitive')) {
      const raised = updateNode(db, episodeNode.id, { sensitivity: 'sensitive' }, now)!;
      s.syncVectorPlace(raised);
      list(status === 'pending' ? result.pending : result.created, raised);
      touched[touched.findIndex((n) => n.id === raised.id)] = raised;
    }

    const resolve = (ref: string): MemoryNode | null => {
      const norm = normalizeText(ref);
      const local = touched.find((n) => n.id === ref || normalizeText(n.label) === norm);
      if (local) return local;
      const byId = getNode(db, ref);
      if (byId && byId.status !== 'superseded') return byId;
      return findEntityByName(db, ref);
    };
    for (const link of plan.links) {
      const from = resolve(link.from);
      const to = resolve(link.to);
      if (!from || !to || from.id === to.id) continue;
      if (addEdge(db, from.id, to.id, link.type, link.weight ?? 0.5, now)) {
        result.linked++;
        s.updated.add(from.id);
        s.updated.add(to.id);
      }
    }
    return result;
  });
}

// ─────────────────────────────── remember ────────────────────────────────

/** Explicit "remember this" (memory UI or the remember tool). */
export async function remember(ctx: MemoryContext, input: RememberInput): Promise<MemoryNode> {
  const parsed = RememberInputSchema.safeParse(input);
  if (!parsed.success) throw new NeoError('bad_request', `Invalid memory: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  const data = parsed.data;
  const policy = ctx.policy();
  if (policy.mode === 'off') throw new NeoError('forbidden', 'Memory is turned off.');

  const content = data.content.trim();
  if (!content) throw new NeoError('bad_request', 'Invalid memory: content is empty');
  const label = (data.label?.trim() || deriveLabel(content)).slice(0, 300);
  const kind = data.kind ?? 'fact';
  const entities = (data.entities ?? []).map((e) => e.trim()).filter(Boolean);
  const tags = (data.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const all = [label, content, ...entities, ...tags];
  if (all.some(hasCredentials)) {
    throw new NeoError('bad_request', 'That looks like a password, key or card number. NEO never stores secrets in memory.');
  }
  const source: MemorySource = data.source ?? { by: 'tool' };
  const byUser = source.by === 'user';
  // The user's own edits in the memory UI are theirs to make; the model is held to the policy.
  if (!byUser) {
    if (all.some((t) => mentionsBlockedTopic(t, policy.blockedTopics))) throw new NeoError('forbidden', 'That topic is blocked in your memory settings.');
    if (!policy.allowedKinds.includes(kind)) throw new NeoError('forbidden', `Memories of kind "${kind}" are turned off in your memory settings.`);
  }
  const status: WritableStatus = byUser || policy.mode !== 'approve' ? 'active' : 'pending';
  // Sensitive-looking content (health, finances, …) is sensitive unless said otherwise. Only the
  // user's own explicit "normal" (memory UI) keeps it normal: the model can raise, never lower it.
  const userSaysNormal = byUser && data.sensitivity === 'normal';
  const sensitivity: Sensitivity =
    data.sensitivity === 'sensitive' || (!userSaysNormal && [label, content, ...tags].some(looksSensitive)) ? 'sensitive' : 'normal';
  const now = ctx.clock();

  const onDevice = ctx.keepLocal({ sensitivity, status });
  const [vector] = await embedTexts(ctx, [nodeEmbedText(kind, label, content, [])], onDevice);
  const entityVectors = new Map<string, Float32Array | null>();
  await prepareEntityVectors(ctx, entities, entityVectors, onDevice);

  return runWrite(ctx, now, (s) => {
    for (const [k, v] of entityVectors) s.entityVectors.set(k, v);
    return createOrMerge(s, {
      kind,
      label,
      content,
      importance: data.importance ?? 0.8,
      confidence: C.userConfidence,
      sensitivity,
      pinned: data.pinned ?? false,
      status,
      source,
      entities,
      entityType: data.entityType,
      tags,
      validUntil: data.validUntil ?? undefined,
      vector: vector ?? null,
    }).node;
  });
}

// ─────────────────────────────── approve / reject ────────────────────────────────

/** Pending entities linked (either direction) to `nodeId`. */
function pendingEntityNeighbors(s: WriteSession, nodeId: string): string[] {
  const rows = s.ctx.db
    .prepare(
      `SELECT n.id FROM memory_edges e
       JOIN memory_nodes n ON n.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
       WHERE (e.src = ? OR e.dst = ?) AND n.kind = 'entity' AND n.status = 'pending'`,
    )
    .all(nodeId, nodeId, nodeId) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * A pending entity follows the memories that mention it: active once every
 * linked memory is active, deleted when nothing links to it any more.
 */
function settleEntity(s: WriteSession, entityId: string, deleteOrphan: boolean): void {
  const entity = getNode(s.ctx.db, entityId);
  if (!entity || entity.kind !== 'entity' || entity.status !== 'pending') return;
  const others = s.ctx.db
    .prepare(
      `SELECT n.status FROM memory_edges e
       JOIN memory_nodes n ON n.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
       WHERE e.src = ? OR e.dst = ?`,
    )
    .all(entityId, entityId, entityId) as { status: string }[];
  if (!others.length) {
    if (deleteOrphan) for (const id of deleteNodes(s.ctx.db, [entityId])) s.deleted.add(id);
    return;
  }
  if (others.every((o) => o.status === 'active')) activate(s, entity);
}

/** Approve pending nodes inside an open write session. Returns how many were approved. */
export function approveNodes(s: WriteSession, ids: Iterable<string>): number {
  let count = 0;
  const entities = new Set<string>();
  for (const id of new Set(ids)) {
    const node = getNode(s.ctx.db, id);
    if (!node || node.status !== 'pending') continue;
    activate(s, node);
    count++;
    for (const e of pendingEntityNeighbors(s, id)) entities.add(e);
  }
  for (const e of entities) settleEntity(s, e, false);
  return count;
}

export function approve(ctx: MemoryContext, ids: string[]): number {
  return runWrite(ctx, ctx.clock(), (s) => approveNodes(s, ids));
}

export function reject(ctx: MemoryContext, ids: string[]): number {
  return runWrite(ctx, ctx.clock(), (s) => {
    const targets: string[] = [];
    const entities = new Set<string>();
    const labels = new Map<string, string>();
    for (const id of new Set(ids)) {
      const node = getNode(ctx.db, id);
      if (!node || node.status !== 'pending') continue;
      targets.push(id);
      labels.set(id, node.label);
      for (const e of pendingEntityNeighbors(s, id)) {
        entities.add(e);
        if (!labels.has(e)) labels.set(e, getNode(ctx.db, e)?.label ?? '');
      }
    }
    const deleted = deleteNodes(ctx.db, targets);
    for (const id of deleted) {
      s.deleted.add(id);
      entities.delete(id);
    }
    for (const e of entities) settleEntity(s, e, true);
    // Like forget: the text of rejected memories (and of the orphaned entities deleted with them)
    // must not outlive them in the consolidation journal.
    redactJournal(ctx.db, [...s.deleted].map((id) => ({ id, label: labels.get(id) ?? '' })));
    return deleted.length;
  });
}

// ─────────────────────────────── forget ────────────────────────────────

/** Hard delete, including the older versions each node superseded (its history). */
export function forget(ctx: MemoryContext, ids: string[]): number {
  return runWrite(ctx, ctx.clock(), (s) => {
    const all = new Set<string>();
    const queue = [...new Set(ids)];
    while (queue.length) {
      const id = queue.pop()!;
      if (all.has(id)) continue;
      all.add(id);
      const older = ctx.db
        .prepare(`SELECT n.id FROM memory_edges e JOIN memory_nodes n ON n.id = e.dst WHERE e.src = ? AND e.type = 'supersedes' AND n.status = 'superseded'`)
        .all(id) as { id: string }[];
      for (const o of older) queue.push(o.id);
    }
    const labels = new Map(
      [...all].flatMap((id) => {
        const row = ctx.db.prepare('SELECT label FROM memory_nodes WHERE id = ?').get(id) as { label: string } | undefined;
        return row ? [[id, row.label] as const] : [];
      }),
    );
    const deleted = deleteNodes(ctx.db, [...all]);
    for (const id of deleted) s.deleted.add(id);
    // Their text must not outlive them in the consolidation journal.
    redactJournal(ctx.db, deleted.map((id) => ({ id, label: labels.get(id) ?? '' })));
    return deleted.length;
  });
}

// ─────────────────────────────── link / unlink ────────────────────────────────

export function link(ctx: MemoryContext, from: string, to: string, type: EdgeType, weight?: number): MemoryEdge {
  if (!EdgeTypeSchema.safeParse(type).success) throw new NeoError('bad_request', `Unknown edge type "${String(type)}"`);
  if (from === to) throw new NeoError('bad_request', 'A memory cannot be linked to itself');
  if (weight !== undefined && !Number.isFinite(weight)) throw new NeoError('bad_request', 'Edge weight must be a number between 0 and 1');
  const now = ctx.clock();
  return runWrite(ctx, now, (s) => {
    if (!getNode(ctx.db, from)) throw new NeoError('not_found', `Memory ${from} not found`);
    if (!getNode(ctx.db, to)) throw new NeoError('not_found', `Memory ${to} not found`);
    const existing = getEdgeBySrcDstType(ctx.db, from, to, type) ?? findEdge(ctx.db, from, to, type);
    s.updated.add(from);
    s.updated.add(to);
    if (existing) {
      if (weight === undefined) return existing;
      ctx.db.prepare('UPDATE memory_edges SET weight = ?, last_reinforced_at = ?, updated_at = ? WHERE id = ?').run(clamp01(weight), now, now, existing.id);
      return getEdge(ctx.db, existing.id)!;
    }
    const edge: MemoryEdge = {
      id: newId('edge', now),
      from,
      to,
      type,
      weight: clamp01(weight ?? 0.5),
      createdAt: now,
      updatedAt: now,
      lastReinforcedAt: now,
      coactivations: 0,
    };
    insertEdge(ctx.db, edge);
    return edge;
  });
}

export function unlink(ctx: MemoryContext, edgeId: string): boolean {
  return runWrite(ctx, ctx.clock(), (s) => {
    const edge = getEdge(ctx.db, edgeId);
    if (!edge) return false;
    ctx.db.prepare('DELETE FROM memory_edges WHERE id = ?').run(edgeId);
    s.updated.add(edge.from);
    s.updated.add(edge.to);
    return true;
  });
}

// ─────────────────────────────── reinforcement ────────────────────────────────

/**
 * After a recall: spaced-repetition reinforcement of the selected nodes, and
 * Hebbian strengthening of `related` edges among the top selected query seeds.
 * An access, not an edit: `updatedAt` and the FTS index are untouched.
 */
export function reinforceRecall(ctx: MemoryContext, selectedIds: string[], seedIds: string[], now: number): void {
  if (!selectedIds.length) return;
  ctx.db.transaction(() => {
    for (const id of selectedIds) {
      const node = getNode(ctx.db, id);
      if (!node) continue;
      updateNode(ctx.db, id, reinforcedFields(node, now), now, { touch: false });
    }
    const pairs = seedIds.slice(0, C.hebbianPairs);
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const a = pairs[i]!;
        const b = pairs[j]!;
        const row = ctx.db
          .prepare(`SELECT * FROM memory_edges WHERE type = 'related' AND ((src = ? AND dst = ?) OR (src = ? AND dst = ?)) LIMIT 1`)
          .get(a, b, b, a) as EdgeRow | undefined;
        if (row) {
          const edge = rowToEdge(row);
          const wEff = effectiveEdgeWeight('related', edge.weight, edge.lastReinforcedAt, now);
          const w = Math.min(1, wEff + C.hebbianRate * (1 - wEff));
          ctx.db
            .prepare('UPDATE memory_edges SET weight = ?, last_reinforced_at = ?, updated_at = ?, coactivations = coactivations + 1 WHERE id = ?')
            .run(w, now, now, edge.id);
        } else {
          insertEdge(ctx.db, {
            id: newId('edge', now),
            from: a,
            to: b,
            type: 'related',
            weight: C.hebbianRate,
            createdAt: now,
            updatedAt: now,
            lastReinforcedAt: now,
            coactivations: 1,
          });
        }
      }
    }
  });
}
