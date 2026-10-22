/**
 * Consolidation ("sleep"), docs/MEMORY.md: re-embed, fade, prune, discover
 * links, merge entities, abstract episodes, journal.
 *
 * The caller (service.ts) handles the interval, `force`, single-flight and the
 * `consolidated` event. Every step checks the abort signal; an aborted run
 * keeps what it already did, journals it, and leaves `lastConsolidationAt`
 * alone so the next run starts over.
 */
import { z } from 'zod';
import type { ConsolidationReport, MemoryKind, MemoryNode } from '@neo/protocol';
import { newId, SELF_MEMORY_ID, STRUCTURAL_EDGE_TYPES } from '@neo/protocol';
import { toNum } from '@neo/storage';
import { MEMORY_CONSTANTS } from './constants.js';
import type { MemoryContext } from './context.js';
import {
  addEdge,
  deleteNodes,
  findEdge,
  getMeta,
  getNode,
  rowToEdge,
  rowToNode,
  setMeta,
  updateNode,
  type EdgeRow,
  type NodeRow,
} from './db-helpers.js';
import { nodeEmbedText } from './embedder.js';
import { callModel, parseLenientJson } from './extract.js';
import { addNote, journalJson } from './journal.js';
import { hasCredentials, normalizeText } from './text.js';
import { clamp01, DAY_MS, dot, effectiveEdgeWeight, isStructural, retention } from './utils.js';
import { createOrMerge, embedTexts, prepareEntityVectors, runWrite } from './write.js';
import { sameSpace, vectorModel } from './vectors.js';

const C = MEMORY_CONSTANTS;
const LAST_RUN_KEY = 'lastConsolidationAt';
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const CONSOLIDATION_PROMPT = `You are the memory of a personal AI assistant called NEO. While the user is away you consolidate recent conversation episodes into lasting knowledge, the way sleep turns experiences into memories.
From the episodes below, return:
- "summary": one short self-contained third-person statement of what these episodes have in common, or null when they share nothing lasting;
- "facts": durable facts, preferences, skills or goals about the user and their world that the episodes clearly support, each a short self-contained statement in the third person.
Never invent what the episodes do not support. Never include secrets. Mark health, finances, sexuality, religion, politics, exact addresses and identity numbers as "sensitive".
importance: 0.9+ core identity & critical, 0.6–0.8 durable preferences/goals, 0.3–0.5 minor details.
Return ONLY a JSON object:
{"summary": {"label": string, "content": string, "importance": number} | null,
 "facts": [{"kind": "fact"|"preference"|"skill"|"goal", "label": string, "content": string, "importance": number, "sensitivity"?: "normal"|"sensitive", "entities"?: string[]}]}`;

// ─────────────────────────────── abstraction reply ────────────────────────────────

const text = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().slice(0, max))
    .pipe(z.string().min(1));
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const SummarySchema = z.object({ label: text(300), content: text(10_000), importance: opt(z.number().refine(Number.isFinite).transform(clamp01)) });
const FactSchema = z.object({
  kind: z.enum(['fact', 'preference', 'skill', 'goal']),
  label: text(300),
  content: text(10_000),
  importance: opt(z.number().refine(Number.isFinite).transform(clamp01)),
  sensitivity: opt(z.enum(['normal', 'sensitive'])),
  entities: opt(
    z.array(z.unknown()).transform((a) => a.filter((x): x is string => typeof x === 'string').map((s) => s.trim().slice(0, 120)).filter(Boolean).slice(0, 20)),
  ),
});
type Summary = z.infer<typeof SummarySchema>;
type Fact = z.infer<typeof FactSchema>;

/** Parse the abstraction reply; null when it does not have the documented shape. */
export function parseAbstraction(reply: string): { summary: Summary | null; facts: Fact[] } | null {
  const raw = parseLenientJson(reply);
  if (!raw || !('summary' in raw || Array.isArray(raw['facts']))) return null;
  const summary = raw['summary'] ? SummarySchema.safeParse(raw['summary']) : null;
  const facts: Fact[] = [];
  for (const f of Array.isArray(raw['facts']) ? (raw['facts'] as unknown[]) : []) {
    const parsed = FactSchema.safeParse(f);
    if (parsed.success) facts.push(parsed.data);
  }
  return { summary: summary?.success ? summary.data : null, facts };
}

// ─────────────────────────────── helpers ────────────────────────────────

function quoteExamples(labels: string[]): string {
  return labels
    .slice(0, 3)
    .map((l) => `'${l.length > 60 ? `${l.slice(0, 59)}…` : l}'`)
    .join(', ');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ─────────────────────────────── steps ────────────────────────────────

/** Archive faded and expired memories. Returns the ids archived. */
function fade(ctx: MemoryContext, now: number, report: ConsolidationReport, changed: Set<string>): Set<string> {
  const archived = new Set<string>();
  const rows = ctx.db
    .prepare(
      `SELECT id, label, importance, stability, last_accessed_at, created_at, pinned, valid_until FROM memory_nodes
       WHERE status = 'active' AND kind != 'entity'`,
    )
    .all() as { id: string; label: string; importance: number; stability: number; last_accessed_at: number | bigint | null; created_at: number | bigint; pinned: number | bigint; valid_until: number | bigint | null }[];
  const faded: { id: string; label: string }[] = [];
  const expired: { id: string; label: string }[] = [];
  ctx.db.transaction(() => {
    const archive = ctx.db.prepare(`UPDATE memory_nodes SET status = 'archived', updated_at = ? WHERE id = ?`);
    for (const r of rows) {
      if (r.valid_until !== null && toNum(r.valid_until) < now) {
        archive.run(now, r.id);
        expired.push({ id: r.id, label: r.label });
        changed.add(r.id);
        archived.add(r.id);
        continue;
      }
      const pinned = toNum(r.pinned) === 1;
      if (pinned || r.importance >= C.archiveMaxImportance) continue;
      const R = retention({ stability: r.stability, lastAccessedAt: r.last_accessed_at === null ? null : toNum(r.last_accessed_at), createdAt: toNum(r.created_at), pinned }, now);
      if (R < C.archiveRetention) {
        archive.run(now, r.id);
        faded.push({ id: r.id, label: r.label });
        changed.add(r.id);
        archived.add(r.id);
      }
    }
  });
  report.archived = faded.length + expired.length;
  const examples = (list: { id: string; label: string }[]) => list.slice(0, 3);
  if (faded.length) {
    addNote(report, `Archived ${plural(faded.length, 'faded memory', 'faded memories')}, e.g. ${quoteExamples(examples(faded).map((f) => f.label))}`, examples(faded).map((f) => f.id));
  }
  if (expired.length) {
    addNote(report, `Archived ${plural(expired.length, 'expired memory', 'expired memories')}, e.g. ${quoteExamples(examples(expired).map((f) => f.label))}`, examples(expired).map((f) => f.id));
  }
  return archived;
}

function prune(ctx: MemoryContext, now: number, report: ConsolidationReport): void {
  const structural = STRUCTURAL_EDGE_TYPES.map(() => '?').join(',');
  const rows = ctx.db
    .prepare(`SELECT id, type, weight, last_reinforced_at FROM memory_edges WHERE type NOT IN (${structural})`)
    .all(...STRUCTURAL_EDGE_TYPES) as { id: string; type: string; weight: number; last_reinforced_at: number | bigint }[];
  let pruned = 0;
  let decayed = 0;
  ctx.db.transaction(() => {
    const del = ctx.db.prepare('DELETE FROM memory_edges WHERE id = ?');
    for (const r of rows) {
      const w = effectiveEdgeWeight(r.type, r.weight, toNum(r.last_reinforced_at), now);
      if (w < C.edgeFloor) {
        del.run(r.id);
        pruned++;
      } else if (w < r.weight * 0.999) decayed++;
    }
  });
  report.edgesPruned = pruned;
  report.edgesDecayed = decayed;
  if (pruned) report.notes.push(`Let go of ${plural(pruned, 'faded link', 'faded links')} between memories`);
}

async function discoverLinks(ctx: MemoryContext, now: number, lastRun: number, report: ConsolidationReport, signal: AbortSignal | undefined): Promise<void> {
  const { db } = ctx;
  const changedIds = (
    db.prepare(`SELECT id FROM memory_nodes WHERE status = 'active' AND updated_at >= ? AND id != ? ORDER BY updated_at DESC LIMIT 500`).all(lastRun, SELF_MEMORY_ID) as { id: string }[]
  ).map((r) => r.id);
  if (!changedIds.length) return;
  const vectorOf = (id: string) => ctx.vectors.find(ctx.embedder.id, ctx.localEmbedder.id, id);
  // The self node links by meaning ("about the user"), never by similarity.
  const targets = (db.prepare(`SELECT id FROM memory_nodes WHERE status = 'active' AND id != ?`).all(SELF_MEMORY_ID) as { id: string }[])
    .map((r) => ({ id: r.id, v: vectorOf(r.id) }))
    .filter((t): t is { id: string; v: Float32Array } => !!t.v);
  const linkedStmt = db.prepare(`SELECT dst AS other FROM memory_edges WHERE src = ? UNION SELECT src AS other FROM memory_edges WHERE dst = ?`);
  let created = 0;
  for (let n = 0; n < changedIds.length; n++) {
    // Cancelled: stop, but still report the links already created (they are kept and journaled).
    if (signal?.aborted) break;
    if (n % 10 === 9) await yieldToEventLoop(); // keep the server responsive
    const id = changedIds[n]!;
    const v = vectorOf(id);
    if (!v) continue;
    const linked = new Set((linkedStmt.all(id, id) as { other: string }[]).map((r) => r.other));
    const hits: { id: string; sim: number }[] = [];
    for (const t of targets) {
      if (t.id === id || linked.has(t.id) || !sameSpace(v, t.v)) continue;
      const sim = dot(v, t.v);
      if (sim >= C.similarLinkThreshold) hits.push({ id: t.id, sim });
    }
    hits.sort((a, b) => b.sim - a.sim);
    db.transaction(() => {
      for (const h of hits.slice(0, C.similarLinksPerNode)) {
        if (getNode(db, h.id)?.status !== 'active') continue;
        if (addEdge(db, id, h.id, 'similar', Math.min(1, h.sim), now)) created++;
      }
    });
  }
  report.linksCreated = created;
  if (created) report.notes.push(`Noticed ${plural(created, 'new similarity', 'new similarities')} between memories`);
}

/** Combine `edge` (moving from the merged node) into an existing parallel edge: max effective weight. */
function combineEdge(ctx: MemoryContext, keep: EdgeRow, drop: EdgeRow, now: number): void {
  const a = rowToEdge(keep);
  const b = rowToEdge(drop);
  const structural = isStructural(a.type);
  const wa = effectiveEdgeWeight(a.type, a.weight, a.lastReinforcedAt, now);
  const wb = effectiveEdgeWeight(b.type, b.weight, b.lastReinforcedAt, now);
  ctx.db
    .prepare('UPDATE memory_edges SET weight = ?, last_reinforced_at = ?, updated_at = ?, coactivations = ? WHERE id = ?')
    .run(Math.max(wa, wb), structural ? Math.max(a.lastReinforcedAt, b.lastReinforcedAt) : now, now, a.coactivations + b.coactivations, a.id);
  ctx.db.prepare('DELETE FROM memory_edges WHERE id = ?').run(b.id);
}

function isPlaceholder(node: MemoryNode): boolean {
  return !node.content.trim() || normalizeText(node.content) === normalizeText(`Entity: ${node.label}`);
}

/** Merge entity `b` into the older entity `a`: edges moved (duplicates combined, self-loops dropped), fields united, `b` deleted. */
function mergeEntity(ctx: MemoryContext, a: MemoryNode, b: MemoryNode, now: number): MemoryNode {
  const { db } = ctx;
  const rows = db.prepare('SELECT * FROM memory_edges WHERE src = ? OR dst = ?').all(b.id, b.id) as unknown as EdgeRow[];
  for (const e of rows) {
    const src = e.src === b.id ? a.id : e.src;
    const dst = e.dst === b.id ? a.id : e.dst;
    if (src === dst) {
      db.prepare('DELETE FROM memory_edges WHERE id = ?').run(e.id);
      continue;
    }
    const existing = findEdge(db, src, dst, e.type);
    if (existing && existing.id !== e.id) {
      combineEdge(ctx, db.prepare('SELECT * FROM memory_edges WHERE id = ?').get(existing.id) as unknown as EdgeRow, e, now);
    } else {
      db.prepare('UPDATE memory_edges SET src = ?, dst = ?, updated_at = ? WHERE id = ?').run(src, dst, now, e.id);
    }
  }
  const seen = new Set([normalizeText(a.label)]);
  const aliases: string[] = [];
  for (const alias of [...a.aliases, b.label, ...b.aliases]) {
    const key = normalizeText(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias.trim().slice(0, 120));
  }
  let content = a.content;
  if (isPlaceholder(a)) content = b.content;
  else if (!isPlaceholder(b) && !normalizeText(a.content).includes(normalizeText(b.content))) content = `${a.content}\n${b.content}`.slice(0, 10_000);
  const merged = updateNode(
    db,
    a.id,
    {
      aliases: aliases.slice(0, 20),
      content,
      entityType: a.entityType ?? b.entityType,
      tags: [...new Set([...a.tags, ...b.tags])].slice(0, 20),
      importance: Math.max(a.importance, b.importance),
      confidence: Math.max(a.confidence, b.confidence),
      stability: Math.max(a.stability, b.stability),
      accessCount: a.accessCount + b.accessCount,
      lastAccessedAt: Math.max(a.lastAccessedAt ?? 0, b.lastAccessedAt ?? 0) || null,
      pinned: a.pinned || b.pinned,
      // Privacy wins: if either was sensitive, the merged entity is.
      sensitivity: a.sensitivity === 'sensitive' || b.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
      status: a.status === 'active' || b.status === 'active' ? 'active' : a.status,
    },
    now,
  )!;
  deleteNodes(db, [b.id]);
  return merged;
}

async function mergeEntities(ctx: MemoryContext, now: number, report: ConsolidationReport, changed: Set<string>, signal: AbortSignal | undefined): Promise<void> {
  const { db } = ctx;
  const entities = (
    // The self node is never merged into (or with) a named entity.
    db.prepare(`SELECT * FROM memory_nodes WHERE kind = 'entity' AND status = 'active' AND id != ? ORDER BY created_at ASC, rowid ASC`).all(SELF_MEMORY_ID) as unknown as NodeRow[]
  ).map(rowToNode);
  if (entities.length < 2) return;
  const vectors = ctx.vectors.all(ctx.embedder.id);
  const names = (e: MemoryNode) => new Set([e.label, ...e.aliases].map(normalizeText).filter(Boolean));
  const gone = new Set<string>();
  const toEmbed = new Map<string, MemoryNode>();
  let merges = 0;
  for (let i = 0; i < entities.length; i++) {
    if (gone.has(entities[i]!.id)) continue;
    if (signal?.aborted) break;
    if (i % 25 === 24) await yieldToEventLoop();
    let a = entities[i]!;
    for (let j = i + 1; j < entities.length; j++) {
      const b = entities[j]!;
      if (gone.has(b.id)) continue;
      if (a.entityType && b.entityType && normalizeText(a.entityType) !== normalizeText(b.entityType)) continue;
      const na = names(a);
      const sameName = [...names(b)].some((n) => na.has(n));
      const va = vectors.get(a.id);
      const vb = vectors.get(b.id);
      if (!sameName && !(va && vb && dot(va, vb) >= C.entityMergeSimilarity)) continue;
      const from = b.label;
      const mergedId = b.id;
      db.transaction(() => {
        a = mergeEntity(ctx, a, b, now);
      });
      gone.add(b.id);
      ctx.vectors.drop(b.id);
      toEmbed.delete(b.id);
      toEmbed.set(a.id, a);
      changed.add(a.id);
      changed.add(b.id);
      merges++;
      addNote(report, `Merged '${from}' into '${a.label}'`, [a.id, mergedId]);
    }
  }
  report.entitiesMerged = merges;
  // Aliases and content changed: refresh the survivors' vectors.
  const survivors = [...toEmbed.values()];
  const vecs = await embedTexts(
    ctx,
    survivors.map((n) => nodeEmbedText(n.kind, n.label, n.content, n.aliases)),
    survivors.map((n) => ctx.keepLocal(n)),
  );
  survivors.forEach((n, i) => {
    const v = vecs[i];
    const current = getNode(db, n.id);
    // Skip it when the node changed place meanwhile (e.g. became sensitive): it is re-embedded later.
    if (v && current && ctx.keepLocal(current) === ctx.keepLocal(n)) ctx.vectors.put(vectorModel(v) ?? ctx.embedder.id, n.id, v);
  });
}

interface Cluster {
  episodes: MemoryNode[];
  centroid: Float32Array | null;
  entities: Set<string>;
}

/**
 * Abstract clusters of unconsolidated episodes into summaries and facts.
 * Like sleep, consolidation learns from active and newly faded episodes,
 * and retries unconsolidated episodes archived in previous runs.
 */
async function abstractEpisodes(
  ctx: MemoryContext,
  now: number,
  report: ConsolidationReport,
  changed: Set<string>,
  fadedNow: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const llm = ctx.llm();
  const policy = ctx.policy();
  if (!llm) return;
  const { db } = ctx;
  // Sensitive episodes only go to a model on the user's own infrastructure (or when allowed).
  const allowSensitive = llm.isLocal || policy.sendSensitiveToCloud;
  const episodes = (
    db
      .prepare(
        `SELECT * FROM memory_nodes WHERE kind = 'episode' AND status IN ('active', 'archived') AND consolidated_at IS NULL
         ${allowSensitive ? '' : `AND sensitivity = 'normal'`} ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as unknown as NodeRow[]
  ).map(rowToNode);
  if (!episodes.length) return;

  // Greedy clustering in time order: centroid similarity or a shared entity. Every episode
  // hangs on the self node, so it is not an entity episodes can share.
  const vectors = ctx.vectors.all(ctx.embedder.id);
  const mentionStmt = db.prepare(`SELECT dst FROM memory_edges WHERE src = ? AND type IN ('mentions', 'about') AND dst != ?`);
  const clusters: Cluster[] = [];
  for (const ep of episodes) {
    const v = vectors.get(ep.id);
    const ents = new Set((mentionStmt.all(ep.id, SELF_MEMORY_ID) as { dst: string }[]).map((r) => r.dst));
    const home = clusters.find((c) => {
      if (v && c.centroid) {
        let norm = 0;
        for (const x of c.centroid) norm += x * x;
        if (norm > 0 && dot(v, c.centroid) / Math.sqrt(norm) >= C.consolidationClusterThreshold) return true;
      }
      return [...ents].some((e) => c.entities.has(e));
    });
    if (home) {
      home.episodes.push(ep);
      for (const e of ents) home.entities.add(e);
      if (v) {
        if (home.centroid) for (let d = 0; d < v.length; d++) home.centroid[d]! += v[d]!;
        else home.centroid = Float32Array.from(v);
      }
    } else {
      clusters.push({ episodes: [ep], centroid: v ? Float32Array.from(v) : null, entities: ents });
    }
  }
  const due = clusters
    .filter((c) => c.episodes.length >= 2 || now - c.episodes[0]!.createdAt > C.singleEpisodeAbstractDays * DAY_MS)
    .slice(0, C.maxClustersPerRun);

  const refused = (...texts: string[]) => texts.some((t) => hasCredentials(t));
  let consolidated = 0;
  let learned = 0;
  for (const cluster of due) {
    if (signal?.aborted) break;
    const sensitive = cluster.episodes.some((e) => e.sensitivity === 'sensitive');
    const user = [
      `Allowed memory kinds: ${policy.allowedKinds.join(', ')}`,
      `Episodes:\n${cluster.episodes.map((e) => `- [${new Date(e.createdAt).toISOString().slice(0, 10)}] ${e.label}: ${e.content.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}`,
    ].join('\n\n');
    let parsed: ReturnType<typeof parseAbstraction> = null;
    try {
      parsed = parseAbstraction(await callModel(llm.model, { model: llm.name, system: CONSOLIDATION_PROMPT, user, maxTokens: 1000, purpose: 'memory-consolidate', signal }));
    } catch (err) {
      ctx.logger.warn('memory: episode abstraction failed', { error: String(err) });
      continue;
    }
    if (!parsed) {
      ctx.logger.warn('memory: episode abstraction reply was not usable; episodes stay for the next run');
      continue;
    }
    if (signal?.aborted) break;

    const allowed = new Set<MemoryKind>(policy.allowedKinds);
    const summary = parsed.summary && allowed.has('summary') && !refused(parsed.summary.label, parsed.summary.content) ? parsed.summary : null;
    const facts = parsed.facts.filter((f) => allowed.has(f.kind) && !refused(f.label, f.content, ...(f.entities ?? [])));
    const items: { kind: MemoryKind; label: string; content: string; importance: number; sensitive: boolean; entities: string[] }[] = [];
    if (summary) items.push({ kind: 'summary', label: summary.label, content: summary.content, importance: summary.importance ?? 0.5, sensitive, entities: [] });
    for (const f of facts) items.push({ kind: f.kind, label: f.label, content: f.content, importance: f.importance ?? 0.5, sensitive: sensitive || f.sensitivity === 'sensitive', entities: f.entities ?? [] });

    // Sensitive knowledge is embedded on the device only.
    const onDevice = items.map((it) => ctx.keepLocal({ sensitivity: it.sensitive ? 'sensitive' : 'normal' }));
    const vecs = await embedTexts(ctx, items.map((it) => nodeEmbedText(it.kind, it.label, it.content, [])), onDevice);
    const entityVectors = new Map<string, Float32Array | null>();
    const localNames = new Set(items.flatMap((it, i) => (onDevice[i] ? it.entities : [])).map(normalizeText));
    await prepareEntityVectors(ctx, items.flatMap((it) => it.entities), entityVectors, (name) => localNames.has(normalizeText(name)));
    const n = cluster.episodes.length;
    const from = n === 1 ? 'from 1 conversation' : `from ${n} conversations`;
    try {
      runWrite(ctx, now, (s) => {
        for (const ep of cluster.episodes) {
          if (!getNode(ctx.db, ep.id)) {
            ctx.logger.warn('memory: source episode was forgotten; skipping abstraction', { episodeId: ep.id });
            return;
          }
        }
        for (const [k, v] of entityVectors) s.entityVectors.set(k, v);
        items.forEach((it, i) => {
          const { node, merged } = createOrMerge(s, {
            kind: it.kind,
            label: it.label,
            content: it.content,
            importance: it.importance,
            confidence: C.extractionConfidence,
            sensitivity: it.sensitive ? 'sensitive' : 'normal',
            pinned: false,
            source: { by: 'consolidation', note: `Abstracted ${from}` },
            entities: it.entities,
            tags: [],
            vector: vecs[i] ?? null,
          });
          for (const ep of cluster.episodes) {
            if (getNode(ctx.db, ep.id)) addEdge(ctx.db, node.id, ep.id, 'derived_from', it.kind === 'summary' ? 0.7 : 0.5, now);
          }
          changed.add(node.id);
          if (!merged) {
            if (it.kind !== 'summary') learned++;
            addNote(report, `Learned: ${node.label} (${from})`, [node.id]);
          }
        });
        const mark = ctx.db.prepare('UPDATE memory_nodes SET consolidated_at = ? WHERE id = ?');
        for (const ep of cluster.episodes) {
          mark.run(now, ep.id);
          changed.add(ep.id);
        }
        consolidated += n;
      });
    } catch (err) {
      ctx.logger.warn('memory: could not store abstracted knowledge', { error: String(err) });
    }
  }
  report.episodesConsolidated = consolidated;
  report.factsCreated = learned;
  if (consolidated) report.notes.push(`Consolidated ${plural(consolidated, 'episode', 'episodes')} into ${plural(learned, 'new fact', 'new facts')}`);
}

// ─────────────────────────────── run ────────────────────────────────

export async function runConsolidation(
  ctx: MemoryContext,
  opts: { now?: number; signal?: AbortSignal },
): Promise<{ report: ConsolidationReport; changed: Set<string>; completed: boolean }> {
  const now = opts.now ?? ctx.clock();
  const startedMs = performance.now();
  const { signal } = opts;
  const changed = new Set<string>();
  const report: ConsolidationReport = {
    id: newId('cons', now),
    startedAt: now,
    finishedAt: now,
    archived: 0,
    edgesDecayed: 0,
    edgesPruned: 0,
    episodesConsolidated: 0,
    factsCreated: 0,
    linksCreated: 0,
    entitiesMerged: 0,
    notes: [],
  };
  if (signal?.aborted) {
    report.notes.push('Stopped before starting: consolidation was cancelled');
    return { report, changed, completed: false };
  }
  const lastRunMeta = getMeta(ctx.db, LAST_RUN_KEY);
  const lastRun = lastRunMeta ? Number(lastRunMeta) || 0 : 0;

  let fadedNow: ReadonlySet<string> = new Set();
  const steps: (() => void | Promise<void>)[] = [
    async () => {
      await ctx.vectors.reembedStale(ctx.embedder);
    },
    () => {
      fadedNow = fade(ctx, now, report, changed);
    },
    () => prune(ctx, now, report),
    () => discoverLinks(ctx, now, lastRun, report, signal),
    () => mergeEntities(ctx, now, report, changed, signal),
    () => abstractEpisodes(ctx, now, report, changed, fadedNow, signal),
  ];
  let completed = true;
  for (const step of steps) {
    if (signal?.aborted) {
      completed = false;
      break;
    }
    await step();
  }
  if (signal?.aborted) completed = false;
  if (!completed) report.notes.push('Stopped early: consolidation was cancelled');
  if (!report.notes.length) report.notes.push('Nothing needed tidying up — your memory is in good shape');

  report.finishedAt = now + Math.max(0, Math.round(performance.now() - startedMs));
  ctx.db.prepare('INSERT INTO memory_journal (id, started_at, finished_at, report) VALUES (?, ?, ?, ?)').run(report.id, report.startedAt, report.finishedAt, journalJson(report));
  if (completed) setMeta(ctx.db, LAST_RUN_KEY, String(now));
  return { report, changed, completed };
}

export function lastConsolidationAt(ctx: Pick<MemoryContext, 'db'>): number | null {
  const v = getMeta(ctx.db, LAST_RUN_KEY);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

