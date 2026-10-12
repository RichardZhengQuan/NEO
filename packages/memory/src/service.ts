/**
 * The MemoryService: composes the read path, the write path, consolidation,
 * search/graph/export/import, the policy and change notifications.
 */
import type {
  ConsolidationReport,
  EdgeType,
  GraphQuery,
  ImportReport,
  MemoryChangeEvent,
  MemoryEdge,
  MemoryExport,
  MemoryGraph,
  MemoryKind,
  MemoryNode,
  MemoryNodeDetail,
  MemoryNodePatch,
  MemoryPolicy,
  MemorySearchQuery,
  MemoryService,
  MemoryStats,
  MemoryStatus,
  MemoryWriteResult,
  ObservedTurn,
  RecallQuery,
  RecallResult,
  RememberInput,
} from '@neo/protocol';
import {
  DEFAULT_MEMORY_POLICY,
  MemoryExportSchema,
  MemoryNodePatchSchema,
  MemoryPolicySchema,
  NeoError,
  silentLogger,
  summarizeNode,
} from '@neo/protocol';
import type { Clock, Embedder, Logger } from '@neo/protocol';
import { blobToVector, fromJson, migrate, toNum, vectorToBlob, type SqlValue } from '@neo/storage';
import { MEMORY_CONSTANTS, type MemoryLLM, type MemoryServiceOptions } from './constants.js';
import { lastConsolidationAt, runConsolidation } from './consolidate.js';
import type { MemoryContext } from './context.js';
import {
  chunked,
  getNode,
  getNodeEdges,
  getNodes,
  insertNode,
  rowToEdge,
  rowToNode,
  updateNode,
  type EdgeRow,
  type NodeRow,
} from './db-helpers.js';
import { HashingEmbedder, isLocalEmbedder, LocalFallbackEmbedder, nodeEmbedText } from './embedder.js';
import { parseJournal } from './journal.js';
import { recall as runRecall } from './recall.js';
import { memoryMigrations } from './schema.js';
import { containsTerm, hasCJK, hasCredentials, lexicalQuery, normalizeText } from './text.js';
import { dot, normalized, retention } from './utils.js';
import { VectorCache } from './vectors.js';
import {
  embedTexts,
  forget as runForget,
  link as runLink,
  observe as runObserve,
  reinforceRecall,
  remember as runRemember,
  runWrite,
  unlink as runUnlink,
} from './write.js';

const C = MEMORY_CONSTANTS;

/** Words that only phrase a forget request ("forget everything about …"). */
const FORGET_FILLER = new Set(['forget', 'forgot', 'delete', 'erase', 'remove', 'everything', 'anything', 'all', 'memories', 'memory', 'stuff', 'things', 'thing', 'info', 'information']);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a policy one field at a time (docs/MEMORY.md, policy): each valid
 * field is kept and each invalid one falls back to its default. In a nested
 * object (`consolidation`) every sub-field is checked on its own, and in a list
 * (`allowedKinds`) invalid entries are dropped. Unknown keys are dropped.
 */
export function parsePolicyFields(input: unknown): MemoryPolicy {
  const raw = isPlainObject(input) ? input : {};
  const defaults = MemoryPolicySchema.parse({});
  const out: Record<string, unknown> = {};
  // Every field has a default, so a policy with only `key` set parses iff that field is valid.
  const check = (key: string, value: unknown): { ok: true; value: unknown } | { ok: false } => {
    const r = MemoryPolicySchema.safeParse({ [key]: value });
    return r.success ? { ok: true, value: (r.data as Record<string, unknown>)[key] } : { ok: false };
  };
  for (const key of Object.keys(defaults)) {
    const value = raw[key];
    const fallback = (defaults as Record<string, unknown>)[key];
    const whole = check(key, value);
    if (whole.ok) {
      out[key] = whole.value;
    } else if (Array.isArray(value) && Array.isArray(fallback)) {
      const kept = value.filter((item) => check(key, [item]).ok);
      const list = check(key, kept);
      out[key] = list.ok ? list.value : fallback;
    } else if (isPlainObject(value) && isPlainObject(fallback)) {
      const sub: Record<string, unknown> = {};
      for (const k of Object.keys(fallback)) {
        const one = check(key, { [k]: value[k] });
        sub[k] = one.ok ? (one.value as Record<string, unknown>)[k] : fallback[k];
      }
      const nested = check(key, sub);
      out[key] = nested.ok ? nested.value : fallback;
    } else {
      out[key] = fallback;
    }
  }
  const parsed = MemoryPolicySchema.safeParse(out);
  return parsed.success ? parsed.data : defaults;
}

function badRequest(message: string, issues: { path: PropertyKey[]; message: string }[]): NeoError {
  return new NeoError('bad_request', `${message}: ${issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ')}`);
}

export function createMemoryServiceImpl(options: MemoryServiceOptions): MemoryService & { setEmbedder(embedder: Embedder): void } {
  const { db } = options;
  const clock: Clock = options.clock ?? (() => Date.now());
  const logger: Logger = options.logger ?? silentLogger;
  let embedder: Embedder = options.embedder ?? new HashingEmbedder(512);
  const llmGetter: () => MemoryLLM | null = options.llm ?? (() => null);

  migrate(db, 'memory', memoryMigrations);

  const vectors = new VectorCache(db, logger);
  let policy: MemoryPolicy = parsePolicy(options.policy ?? DEFAULT_MEMORY_POLICY);
  // Text that must not leave the device is embedded on the device (its vectors keep their own model id).
  let localEmbedder: Embedder = isLocalEmbedder(embedder) ? embedder : new LocalFallbackEmbedder(512);
  let keepLocal = (node: { sensitivity: string }): boolean =>
    localEmbedder !== embedder && node.sensitivity === 'sensitive' && !policy.sendSensitiveToCloud;
  vectors.setRouting({ main: embedder, local: localEmbedder, keepLocal });
  const listeners = new Set<(event: MemoryChangeEvent) => void>();

  function parsePolicy(p: MemoryPolicy): MemoryPolicy {
    const parsed = MemoryPolicySchema.safeParse(p);
    if (parsed.success) return parsed.data;
    logger.warn('memory: invalid policy; using defaults for invalid fields', { error: parsed.error.message });
    return parsePolicyFields(p);
  }

  const ctx: MemoryContext = {
    db,
    embedder,
    localEmbedder,
    keepLocal,
    vectors,
    clock,
    logger,
    policy: () => policy,
    llm: () => {
      try {
        return llmGetter();
      } catch (err) {
        logger.warn('memory: could not resolve the memory model', { error: String(err) });
        return null;
      }
    },
    emit(event) {
      if (!event.nodeIds.length && event.type !== 'consolidated') return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          logger.warn('memory: change listener failed', { error: String(err) });
        }
      }
    },
  };

  // Vectors from another embedder (or none) are re-embedded in the background.
  void vectors.reembedStale(embedder);

  /** observe() calls run one after another: episode order, dedupe and entity upserts stay coherent. */
  let observeQueue: Promise<unknown> = Promise.resolve();
  /** One consolidation at a time; concurrent callers share the running one. */
  let consolidating: Promise<ConsolidationReport> | null = null;

  async function recallImpl(query: RecallQuery): Promise<RecallResult> {
    const outcome = await runRecall(ctx, query);
    if (query.reinforce !== false && outcome.selectedIds.length) {
      try {
        reinforceRecall(ctx, outcome.selectedIds, outcome.querySeedIds, query.now ?? clock());
      } catch (err) {
        logger.warn('memory: reinforcement after recall failed', { error: String(err) });
      }
    }
    return outcome.result;
  }

  // ── hybrid search used by search() and findForForget() ──

  interface Match {
    id: string;
    lexical: number;
    sim: number;
  }

  /** FTS + vector matches among nodes passing `where`, scored 0.5·lexical_norm + 0.5·sim. */
  type Where = (alias?: string) => { sql: string; params: SqlValue[] };

  async function hybridMatches(text: string, where: Where, opts: { minSim: number; extraStopwords?: ReadonlySet<string> }): Promise<Match[]> {
    const matches = new Map<string, Match>();
    const match = lexicalQuery(text, opts.extraStopwords);
    if (match) {
      try {
        const w = where('n');
        const rows = db
          .prepare(
            `SELECT n.id AS id, memory_fts.rank AS rank FROM memory_fts JOIN memory_nodes n ON n.id = memory_fts.node_id
             WHERE memory_fts MATCH ? AND ${w.sql} ORDER BY memory_fts.rank LIMIT 1000`,
          )
          .all(match, ...w.params) as { id: string; rank: number }[];
        // bm25 ranks are negative (lower is better); normalize to 0..1 against the best hit.
        const best = rows.length ? -rows[0]!.rank : 0;
        for (const r of rows) {
          const lexical = best > 0 ? Math.max(0, Math.min(1, -r.rank / best)) : 1;
          const cur = matches.get(r.id);
          if (!cur) matches.set(r.id, { id: r.id, lexical, sim: 0 });
          else cur.lexical = Math.max(cur.lexical, lexical);
        }
      } catch (err) {
        logger.debug('memory: lexical search failed', { error: String(err) });
      }
    }
    // The query in each embedding space: memories kept on the device have local vectors.
    const [q] = await embedTexts(ctx, [text]);
    const [ql] = localEmbedder !== embedder ? await embedTexts(ctx, [text], true) : [q];
    const qv = q ? normalized(q) : null;
    const qlv = ql ? normalized(ql) : null;
    if (qv || qlv) {
      const w = where();
      const ids = (db.prepare(`SELECT id FROM memory_nodes WHERE ${w.sql}`).all(...w.params) as { id: string }[]).map((r) => r.id);
      for (const id of ids) {
        const main = vectors.get(embedder.id, id);
        const v = main ?? (localEmbedder !== embedder ? vectors.get(localEmbedder.id, id) : undefined);
        const query = main ? qv : qlv;
        if (!v || !query || v.length !== query.length) continue;
        const sim = dot(query, v);
        const cur = matches.get(id);
        if (cur) cur.sim = Math.max(cur.sim, sim);
        else if (sim >= opts.minSim) matches.set(id, { id, lexical: 0, sim });
      }
    }
    return [...matches.values()];
  }

  /** Search filters; default status filter is active. Tags match exactly (case-insensitive). */
  function searchWhere(query: MemorySearchQuery): Where {
    return (alias = '') => {
      const a = alias ? `${alias}.` : '';
      const conds: string[] = [];
      const params: SqlValue[] = [];
      const status = query.status?.length ? query.status : (['active'] as MemoryStatus[]);
      conds.push(`${a}status IN (${status.map(() => '?').join(',')})`);
      params.push(...status);
      if (query.kinds?.length) {
        conds.push(`${a}kind IN (${query.kinds.map(() => '?').join(',')})`);
        params.push(...query.kinds);
      }
      if (query.pinned !== undefined) {
        conds.push(`${a}pinned = ?`);
        params.push(query.pinned ? 1 : 0);
      }
      for (const tag of query.tags ?? []) {
        conds.push(`EXISTS (SELECT 1 FROM json_each(${a}tags) AS t WHERE lower(t.value) = lower(?))`);
        params.push(tag.trim());
      }
      return { sql: conds.join(' AND '), params };
    };
  }

  const svc: MemoryService & { setEmbedder(embedder: Embedder): void } = {
    recall: recallImpl,

    observe(turn: ObservedTurn): Promise<MemoryWriteResult> {
      const run = async (): Promise<MemoryWriteResult> => {
        try {
          return await runObserve(ctx, turn, {
            related: async (text, allowSensitive) => (await runRecall(ctx, { text, limit: 10, reinforce: false, allowSensitive, now: turn.now })).result.items,
          });
        } catch (err) {
          logger.error('memory: observe failed', { error: String(err) });
          return { created: [], updated: [], superseded: [], linked: 0, skipped: 'memory error' };
        }
      };
      const result = observeQueue.then(run, run);
      observeQueue = result;
      return result;
    },

    remember: (input: RememberInput, signal?: AbortSignal) => runRemember(ctx, input, signal),

    async findBySource(messageIds: string[]): Promise<MemoryNode[]> {
      if (!messageIds.length) return [];
      await observeQueue;
      const ids = new Set<string>();
      const sources = [...new Set(messageIds)];
      for (let offset = 0; offset < sources.length; offset += 500) {
        const batch = sources.slice(offset, offset + 500);
        const rows = db.prepare(`WITH RECURSIVE derived(id) AS (
          SELECT id FROM memory_nodes WHERE json_extract(source, '$.messageId') IN (${batch.map(() => '?').join(',')})
          UNION
          SELECT e.src FROM memory_edges e JOIN derived d ON e.dst = d.id WHERE e.type = 'derived_from'
        ) SELECT id FROM derived`).all(...batch) as { id: string }[];
        for (const row of rows) ids.add(row.id);
      }
      return getNodes(db, [...ids]);
    },

    async forgetBySource(messageIds: string[]): Promise<number> {
      await observeQueue;
      const nodes = await svc.findBySource(messageIds);
      return runForget(ctx, nodes.map(node => node.id));
    },

    async search(query: MemorySearchQuery): Promise<{ items: MemoryNode[]; total: number }> {
      const limit = Math.max(1, Math.min(500, query.limit ?? 20));
      const offset = Math.max(0, query.offset ?? 0);
      const whereFn = searchWhere(query);
      const where = whereFn();
      const now = clock();
      const text = query.query?.trim();
      const sort = query.sort ?? (text ? 'relevance' : 'recent');

      let ordered: MemoryNode[];
      if (text) {
        const matches = await hybridMatches(text, whereFn, { minSim: C.seedSimilarityFloor });
        const relevance = new Map(matches.map((m) => [m.id, 0.5 * m.lexical + 0.5 * Math.max(0, m.sim)]));
        ordered = getNodes(db, [...relevance.keys()]);
        if (sort === 'relevance') ordered.sort((a, b) => relevance.get(b.id)! - relevance.get(a.id)! || b.updatedAt - a.updatedAt);
      } else {
        const order = sort === 'importance' ? 'importance DESC, updated_at DESC' : 'updated_at DESC, created_at DESC';
        if (sort !== 'strength') {
          const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM memory_nodes WHERE ${where.sql}`).get(...where.params) as { n: number | bigint }).n);
          const rows = db.prepare(`SELECT * FROM memory_nodes WHERE ${where.sql} ORDER BY ${order}, id LIMIT ? OFFSET ?`).all(...where.params, limit, offset) as unknown as NodeRow[];
          return { items: rows.map(rowToNode), total };
        }
        ordered = (db.prepare(`SELECT * FROM memory_nodes WHERE ${where.sql}`).all(...where.params) as unknown as NodeRow[]).map(rowToNode);
      }
      if (sort === 'recent') ordered.sort((a, b) => b.updatedAt - a.updatedAt);
      else if (sort === 'importance') ordered.sort((a, b) => b.importance - a.importance);
      else if (sort === 'strength') ordered.sort((a, b) => b.importance * retention(b, now) - a.importance * retention(a, now));
      return { items: ordered.slice(offset, offset + limit), total: ordered.length };
    },

    async get(id: string): Promise<MemoryNodeDetail | null> {
      const node = getNode(db, id);
      if (!node) return null;
      const edges = getNodeEdges(db, id);
      const neighborIds = [...new Set(edges.map((e) => (e.from === id ? e.to : e.from)))];
      const neighbors = getNodes(db, neighborIds).map(summarizeNode);
      // Older versions, newest first: follow `supersedes` edges down the chain.
      const history: MemoryNode[] = [];
      const seen = new Set([id]);
      let current = id;
      for (let i = 0; i < 50; i++) {
        const row = db.prepare(`SELECT dst FROM memory_edges WHERE src = ? AND type = 'supersedes' ORDER BY created_at DESC LIMIT 1`).get(current) as { dst: string } | undefined;
        if (!row || seen.has(row.dst)) break;
        const older = getNode(db, row.dst);
        if (!older) break;
        history.push(older);
        seen.add(older.id);
        current = older.id;
      }
      return { node, retention: retention(node, clock()), edges, neighbors, history };
    },

    async update(id: string, patch: MemoryNodePatch): Promise<MemoryNode> {
      const parsed = MemoryNodePatchSchema.safeParse(patch);
      if (!parsed.success) throw badRequest('Invalid memory update', parsed.error.issues);
      const p = parsed.data;
      const node = getNode(db, id);
      if (!node) throw new NeoError('not_found', `Memory ${id} not found`);
      const texts = [p.label, p.content, ...(p.aliases ?? []), ...(p.tags ?? [])].filter((t): t is string => typeof t === 'string');
      if (texts.some(hasCredentials)) throw new NeoError('bad_request', 'That looks like a password, key or card number. NEO never stores secrets in memory.');

      const next = { ...node };
      if (p.label !== undefined) next.label = p.label.trim() || node.label;
      if (p.content !== undefined) next.content = p.content;
      if (p.kind !== undefined) next.kind = p.kind;
      if (p.aliases !== undefined) next.aliases = p.aliases.map((a) => a.trim()).filter(Boolean);
      const textChanged = next.label !== node.label || next.content !== node.content || next.kind !== node.kind || next.aliases.join('\u0000') !== node.aliases.join('\u0000');
      // Embedded where the edited memory's privacy allows (sensitive text stays on the device).
      const onDevice = keepLocal({ sensitivity: p.sensitivity ?? node.sensitivity });
      const [vector] = textChanged ? await embedTexts(ctx, [nodeEmbedText(next.kind, next.label, next.content, next.aliases)], onDevice) : [null];

      const now = clock();
      return runWrite(ctx, now, (s) => {
        const current = getNode(db, id);
        if (!current) throw new NeoError('not_found', `Memory ${id} not found`);
        const fields: Partial<MemoryNode> = {};
        if (p.label !== undefined) fields.label = next.label;
        if (p.content !== undefined) fields.content = p.content;
        if (p.kind !== undefined) fields.kind = p.kind;
        if (p.entityType !== undefined) fields.entityType = p.entityType ?? undefined;
        if (p.aliases !== undefined) fields.aliases = next.aliases;
        if (p.tags !== undefined) fields.tags = p.tags.map((t) => t.trim()).filter(Boolean);
        if (p.importance !== undefined) fields.importance = p.importance;
        if (p.confidence !== undefined) fields.confidence = p.confidence;
        if (p.pinned !== undefined) fields.pinned = p.pinned;
        if (p.sensitivity !== undefined) fields.sensitivity = p.sensitivity;
        if (p.validUntil !== undefined) fields.validUntil = p.validUntil ?? undefined;
        if (p.status !== undefined && p.status !== current.status) {
          fields.status = p.status;
          // Restoring an archived memory counts as using it.
          if (p.status === 'active') fields.lastAccessedAt = now;
        }
        let updated = updateNode(db, id, fields, now)!;
        if (textChanged) {
          s.writeVector(id, vector);
          updated = getNode(db, id)!;
        } else {
          s.syncVectorPlace(updated);
        }
        s.updated.add(id);
        return updated;
      });
    },

    forget: async (ids: string[]) => runForget(ctx, ids),

    async findForForget(query: string, limit = 20): Promise<MemoryNode[]> {
      const text = query.trim();
      if (!text) return [];
      const max = Math.max(1, Math.min(500, limit));
      const where: Where = (alias = '') => ({ sql: `${alias ? `${alias}.` : ''}status IN ('active', 'archived')`, params: [] });
      const scored = new Map<string, number>();
      const add = (id: string, score: number) => scored.set(id, Math.max(scored.get(id) ?? 0, score));

      // Entities named in the request, and everything that is about them.
      const normQuery = normalizeText(text);
      const entityRows = db.prepare(`SELECT id, label, aliases FROM memory_nodes WHERE kind = 'entity' AND ${where().sql}`).all() as { id: string; label: string; aliases: string }[];
      for (const row of entityRows) {
        const terms = [row.label, ...fromJson<string[]>(row.aliases, [])].map(normalizeText);
        if (!terms.some((t) => (hasCJK(t) || t.length >= 2) && containsTerm(normQuery, t))) continue;
        add(row.id, 2);
        const about = db
          .prepare(`SELECT n.id FROM memory_edges e JOIN memory_nodes n ON n.id = e.src WHERE e.dst = ? AND e.type = 'about' AND n.status IN ('active', 'archived')`)
          .all(row.id) as { id: string }[];
        for (const a of about) add(a.id, 1.5);
      }
      // Direct matches: an FTS hit on a meaningful word, or similarity ≥ forgetSimilarity.
      for (const m of await hybridMatches(text, where, { minSim: C.forgetSimilarity, extraStopwords: FORGET_FILLER })) {
        if (m.lexical > 0 || m.sim >= C.forgetSimilarity) add(m.id, 0.5 * m.lexical + 0.5 * Math.max(0, m.sim));
      }
      const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max);
      const nodes = new Map(getNodes(db, ranked.map(([id]) => id)).map((n) => [n.id, n]));
      return ranked.map(([id]) => nodes.get(id)).filter((n): n is MemoryNode => !!n);
    },

    link: async (from: string, to: string, type: EdgeType, weight?: number): Promise<MemoryEdge> => runLink(ctx, from, to, type, weight),
    unlink: async (edgeId: string) => runUnlink(ctx, edgeId),

    async graph(query: GraphQuery): Promise<MemoryGraph> {
      const limit = Math.max(1, Math.min(1000, query.limit ?? 150));
      const depth = Math.max(1, Math.min(4, query.depth ?? 2));
      const now = clock();
      const statuses: MemoryStatus[] = query.includeArchived ? ['active', 'archived', 'superseded'] : ['active'];
      const kinds = query.kinds?.length ? new Set<MemoryKind>(query.kinds) : null;
      const visible = (n: MemoryNode) => statuses.includes(n.status) && (!kinds || kinds.has(n.kind));
      let nodes: MemoryNode[];

      if (query.centerId) {
        const center = getNode(db, query.centerId);
        if (!center) return { nodes: [], edges: [] };
        // BFS (both directions) to `depth`, then keep the strongest by importance × R.
        const found = new Map<string, MemoryNode>();
        const seen = new Set([center.id]);
        let frontier = [center.id];
        const edgeStmt = db.prepare('SELECT src, dst FROM memory_edges WHERE src = ? UNION SELECT src, dst FROM memory_edges WHERE dst = ?');
        for (let hop = 0; hop < depth && frontier.length; hop++) {
          const nextIds: string[] = [];
          for (const id of frontier) {
            for (const e of edgeStmt.all(id, id) as { src: string; dst: string }[]) {
              const other = e.src === id ? e.dst : e.src;
              if (seen.has(other)) continue;
              seen.add(other);
              nextIds.push(other);
            }
          }
          const next: string[] = [];
          for (const n of getNodes(db, nextIds)) {
            if (!visible(n)) continue;
            found.set(n.id, n);
            next.push(n.id);
          }
          frontier = next;
        }
        const ranked = [...found.values()].sort((a, b) => b.importance * retention(b, now) - a.importance * retention(a, now)).slice(0, limit - 1);
        nodes = [center, ...ranked];
      } else {
        const ph = statuses.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM memory_nodes WHERE status IN (${ph})`).all(...statuses) as unknown as NodeRow[];
        const degree = new Map(
          (db.prepare(`SELECT id, COUNT(*) AS n FROM (SELECT src AS id FROM memory_edges UNION ALL SELECT dst AS id FROM memory_edges) GROUP BY id`).all() as { id: string; n: number | bigint }[]).map((r) => [r.id, toNum(r.n)]),
        );
        nodes = rows
          .map(rowToNode)
          .filter(visible)
          .map((n) => ({ n, score: n.importance + retention(n, now) + Math.min(degree.get(n.id) ?? 0, 10) / 10 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ n }) => n);
      }
      const ids = nodes.map((n) => n.id);
      const idSet = new Set(ids);
      const edges = chunked(ids, (ph, chunk) => db.prepare(`SELECT * FROM memory_edges WHERE src IN (${ph})`).all(...chunk) as unknown as EdgeRow[])
        .filter((e) => idSet.has(e.dst))
        .map(rowToEdge);
      return { nodes: nodes.map((n) => ({ ...n, retention: retention(n, now) })), edges };
    },

    consolidate(opts?: { now?: number; force?: boolean; signal?: AbortSignal }): Promise<ConsolidationReport> {
      if (consolidating) return consolidating;
      const now = opts?.now ?? clock();
      const skipped = (note: string): ConsolidationReport => ({
        id: 'skipped',
        startedAt: now,
        finishedAt: now,
        archived: 0,
        edgesDecayed: 0,
        edgesPruned: 0,
        episodesConsolidated: 0,
        factsCreated: 0,
        linksCreated: 0,
        entitiesMerged: 0,
        notes: [note],
      });
      if (!opts?.force) {
        if (!policy.consolidation.enabled) return Promise.resolve(skipped('Skipped: consolidation is turned off'));
        const last = lastConsolidationAt(ctx);
        if (last !== null && now - last < policy.consolidation.intervalHours * 60 * 60 * 1000) {
          return Promise.resolve(skipped('Skipped: too soon since the last consolidation'));
        }
      }
      const run = (async () => {
        try {
          const { report, changed } = await runConsolidation(ctx, { now, signal: opts?.signal });
          ctx.emit({ type: 'consolidated', nodeIds: [...changed] });
          return report;
        } finally {
          consolidating = null;
        }
      })();
      consolidating = run;
      return run;
    },

    async journal(limit = 20): Promise<ConsolidationReport[]> {
      const rows = db.prepare(`SELECT report FROM memory_journal ORDER BY started_at DESC, finished_at DESC LIMIT ?`).all(Math.max(1, limit)) as { report: string }[];
      return rows.map((r) => parseJournal(r.report));
    },

    async stats(): Promise<MemoryStats> {
      const count = (sql: string) => Number((db.prepare(sql).get() as { n: number | bigint }).n);
      const byKind: Record<MemoryKind, number> = { episode: 0, fact: 0, entity: 0, preference: 0, skill: 0, goal: 0, summary: 0 };
      for (const r of db.prepare('SELECT kind, COUNT(*) AS n FROM memory_nodes GROUP BY kind').all() as { kind: MemoryKind; n: number | bigint }[]) {
        if (r.kind in byKind) byKind[r.kind] = toNum(r.n);
      }
      const byStatus: Record<MemoryStatus, number> = { active: 0, archived: 0, superseded: 0 };
      for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM memory_nodes GROUP BY status').all() as { status: MemoryStatus; n: number | bigint }[]) {
        if (r.status in byStatus) byStatus[r.status] = toNum(r.n);
      }
      return {
        total: count('SELECT COUNT(*) AS n FROM memory_nodes'),
        byKind,
        byStatus,
        edges: count('SELECT COUNT(*) AS n FROM memory_edges'),
        lastConsolidationAt: lastConsolidationAt(ctx),
        embeddingModel: embedder.id,
      };
    },

    async export(opts?: { includeEmbeddings?: boolean }): Promise<MemoryExport> {
      const nodes = (db.prepare('SELECT * FROM memory_nodes ORDER BY created_at, id').all() as unknown as NodeRow[]).map(rowToNode);
      const edges = (db.prepare('SELECT * FROM memory_edges ORDER BY created_at, id').all() as unknown as EdgeRow[]).map(rowToEdge);
      const out: MemoryExport = { format: 'neo-memory', version: 1, exportedAt: clock(), embeddingModel: embedder.id, nodes, edges };
      if (opts?.includeEmbeddings) {
        const all = vectors.all(embedder.id);
        const embeddings: Record<string, string> = {};
        for (const n of nodes) {
          const v = all.get(n.id);
          if (v) embeddings[n.id] = Buffer.from(vectorToBlob(v)).toString('base64');
        }
        out.embeddings = embeddings;
      }
      return out;
    },

    async import(data: MemoryExport, opts?: { mode?: 'merge' | 'replace' }): Promise<ImportReport> {
      const parsed = MemoryExportSchema.safeParse(data);
      if (!parsed.success) throw badRequest('Invalid memory export', parsed.error.issues);
      const input = parsed.data;
      const mode = opts?.mode ?? 'merge';
      const sameModel = !!input.embeddingModel && input.embeddingModel === embedder.id;
      const report: ImportReport = { nodes: 0, edges: 0, skipped: 0 };
      const imported: string[] = [];

      runWrite(ctx, clock(), (s) => {
        if (mode === 'replace') {
          db.exec('DELETE FROM memory_fts; DELETE FROM memory_edges; DELETE FROM memory_vectors; DELETE FROM memory_nodes;');
          vectors.clear();
        }
        for (const node of input.nodes) {
          if (getNode(db, node.id)) {
            report.skipped++;
            continue;
          }
          // A node keeps its model id only when its vector comes with it; otherwise it is re-embedded.
          let vector: Float32Array | null = null;
          const b64 = sameModel ? input.embeddings?.[node.id] : undefined;
          if (b64) {
            try {
              vector = normalized(blobToVector(new Uint8Array(Buffer.from(b64, 'base64'))));
            } catch {
              vector = null;
            }
          }
          insertNode(db, { ...node, embeddingModel: undefined });
          if (vector) s.writeVector(node.id, vector);
          else s.missingVectors = true;
          imported.push(node.id);
          report.nodes++;
        }
        const exists = db.prepare('SELECT 1 AS x FROM memory_edges WHERE id = ? OR (src = ? AND dst = ? AND type = ?)');
        for (const edge of input.edges) {
          if (edge.from === edge.to || !getNode(db, edge.from) || !getNode(db, edge.to) || exists.get(edge.id, edge.from, edge.to, edge.type)) {
            report.skipped++;
            continue;
          }
          db.prepare(
            `INSERT INTO memory_edges (id, src, dst, type, weight, created_at, updated_at, last_reinforced_at, coactivations) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(edge.id, edge.from, edge.to, edge.type, edge.weight, edge.createdAt, edge.updatedAt, edge.lastReinforcedAt, edge.coactivations);
          report.edges++;
        }
        for (const id of imported) s.created.add(id);
      });
      return report;
    },

    /** Live-swap the embedder without restarting the service.
     *  Updates the routing table and re-embeds any stale vectors in the background. */
    setEmbedder(newEmbedder: Embedder): void {
      const newLocalEmbedder: Embedder = isLocalEmbedder(newEmbedder) ? newEmbedder : new LocalFallbackEmbedder(512);
      const newKeepLocal = (node: { sensitivity: string }): boolean =>
        newLocalEmbedder !== newEmbedder && node.sensitivity === 'sensitive' && !policy.sendSensitiveToCloud;
      embedder = newEmbedder;
      localEmbedder = newLocalEmbedder;
      keepLocal = newKeepLocal;
      ctx.embedder = newEmbedder;
      ctx.localEmbedder = newLocalEmbedder;
      ctx.keepLocal = newKeepLocal;
      vectors.setRouting({ main: newEmbedder, local: newLocalEmbedder, keepLocal: newKeepLocal });
      void vectors.reembedStale(newEmbedder);
    },

    getPolicy(): MemoryPolicy {
      return policy;
    },

    setPolicy(next: MemoryPolicy): void {
      const wasCloudAllowed = policy.sendSensitiveToCloud;
      policy = parsePolicy(next);
      if (localEmbedder === embedder || wasCloudAllowed === policy.sendSensitiveToCloud) return;
      if (policy.sendSensitiveToCloud) {
        // Sensitive memories may now use the main embedder: move their vectors over in the background.
        void vectors.reembedStale(embedder);
        return;
      }
      // Sensitive memories must stay on the device again: their main-model vectors stop being used
      // now, and they are re-embedded by the local embedder (their text never goes to the main one).
      const moved = db.prepare(`SELECT id FROM memory_nodes WHERE sensitivity = 'sensitive' AND embedding_model = ?`).all(embedder.id) as { id: string }[];
      if (!moved.length) return;
      db.prepare(`UPDATE memory_nodes SET embedding_model = NULL WHERE sensitivity = 'sensitive' AND embedding_model = ?`).run(embedder.id);
      for (const { id } of moved) vectors.drop(id);
      void vectors.reembedStale(embedder);
    },

    onChange(listener: (event: MemoryChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return svc;
}
