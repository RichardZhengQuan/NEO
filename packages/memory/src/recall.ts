/**
 * Read path: recall(query) — docs/MEMORY.md "Read path".
 *
 * seeds (vector + lexical + entity + profile + pinned core + assistant style) → 2-hop spreading
 * activation over effective edge weights with fan normalization → score =
 * A × strength × pinnedBoost → minScore → MMR under the token budget.
 * Pure read: reinforcement is applied by the caller (write.ts).
 */
import type { EdgeType, Embedder, MemoryKind, MemoryNode, RecallQuery, RecallResult, RecalledMemory } from '@neo/protocol';
import { NeoError, SELF_MEMORY_ID } from '@neo/protocol';
import { fromJson, toNum, type SqlValue } from '@neo/storage';
import { MEMORY_CONSTANTS } from './constants.js';
import { ASSISTANT_STYLE_TAG } from './assistant-style.js';
import type { MemoryContext } from './context.js';
import { getNodes } from './db-helpers.js';
import { containsTerm, estimateTokens, hasCJK, isBroadSelfQuery, normalizeText, recallTerms, wordMatchExpression } from './text.js';
import { dot, effectiveEdgeWeight, normalized, retention } from './utils.js';
import { sameSpace } from './vectors.js';

const C = MEMORY_CONSTANTS;

type SeedSource = 'vector' | 'lexical' | 'entity' | 'profile' | 'pinned' | 'style';

interface Seed {
  a0: number;
  source: SeedSource;
  /** Cosine similarity to the query (vector seeds only). */
  sim: number;
}

interface Neighbor {
  other: string;
  type: EdgeType;
  w: number;
}

/** Kinds that describe the user themselves, seeded for broad "about me" questions. */
const PROFILE_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'goal', 'entity'];
/** Seeds that the query itself activated; only these take part in Hebbian learning. */
const QUERY_SOURCES = new Set<SeedSource>(['vector', 'lexical', 'entity']);

export interface RecallOutcome {
  result: RecallResult;
  /** Ids of the selected memories, for reinforcement. */
  selectedIds: string[];
  /** Selected memories the query itself activated (best first), for Hebbian co-activation. */
  querySeedIds: string[];
}

/**
 * Candidate predicate: active (+ archived with includeArchived), not expired,
 * kind filter, and sensitive excluded unless allowSensitive. Superseded
 * memories and the self node (linked to everything about the user, so it
 * would spread activation everywhere) are never candidates. With a conversationId, that
 * conversation's own episodes are left out: they are already in the transcript
 * (working memory). Facts learned in it stay recallable.
 */
function candidateWhere(query: RecallQuery, now: number, alias = ''): { sql: string; params: SqlValue[] } {
  const a = alias ? `${alias}.` : '';
  const conds = [
    query.includeArchived ? `${a}status IN ('active', 'archived')` : `${a}status = 'active'`,
    `(${a}valid_until IS NULL OR ${a}valid_until > ?)`,
    `${a}id != ?`,
  ];
  const params: SqlValue[] = [now, SELF_MEMORY_ID];
  if (!query.allowSensitive) conds.push(`${a}sensitivity = 'normal'`);
  if (query.kinds?.length) {
    conds.push(`${a}kind IN (${query.kinds.map(() => '?').join(',')})`);
    params.push(...query.kinds);
  }
  if (query.conversationId) {
    conds.push(`(${a}kind != 'episode' OR json_extract(${a}source, '$.conversationId') IS NOT ?)`);
    params.push(query.conversationId);
  }
  return { sql: conds.join(' AND '), params };
}

/** The query in one embedding space: what the user said, and the optional context. */
interface QuerySpace {
  text: Float32Array;
  context: Float32Array | null;
}

/**
 * The query in the main embedding space and, when the main embedder is remote,
 * in the on-device space too (memories kept on the device have local vectors).
 * The context (NEO's previous reply) can carry sensitive memories a local chat
 * model used: it only goes to a remote embedder when sensitive memories are not
 * in play (allowSensitive false) or the user allowed them in the cloud.
 */
async function querySpaces(ctx: MemoryContext, query: RecallQuery, text: string, context: string): Promise<Map<string, QuerySpace>> {
  const spaces = new Map<string, QuerySpace>();
  const remote = ctx.localEmbedder !== ctx.embedder;
  const contextMayLeave = !remote || !query.allowSensitive || ctx.policy().sendSensitiveToCloud;
  const embedIn = async (embedder: Embedder, withContext: boolean) => {
    try {
      const ctxText = withContext ? context : '';
      const vectors = await embedder.embed(ctxText ? [text, ctxText] : [text], query.signal);
      const t = vectors[0] ? normalized(vectors[0]) : null;
      if (!t) return;
      const c = ctxText && vectors[1] ? normalized(vectors[1]) : null;
      spaces.set(embedder.id, { text: t, context: c && c.length === t.length ? c : null });
    } catch (err) {
      ctx.logger.warn('memory: query embedding failed; recalling by keywords and names only', { error: String(err), embedder: embedder.id });
    }
  };
  await embedIn(ctx.embedder, contextMayLeave);
  if (remote) await embedIn(ctx.localEmbedder, true);
  return spaces;
}

/**
 * Similarity of a memory to the query. The context can only nudge it up, towards
 * the conversation's topic: sim = s_text + w·max(0, s_context − s_text) with
 * w = recallContextWeight (0.2). So sim ≤ w + (1 − w)·s_text, and a memory that
 * has nothing in common with what the user said (s_text ≈ 0) stays at or below
 * seedSimilarityFloor (0.2): NEO's own wording alone never recalls anything.
 */
function blendedSimilarity(q: QuerySpace, v: Float32Array): number {
  if (v.length !== q.text.length) return 0;
  const st = dot(q.text, v);
  if (!q.context) return st;
  return st + C.recallContextWeight * Math.max(0, dot(q.context, v) - st);
}

/**
 * Keyword relevance of memories to what the user said (never the context):
 * IDF-weighted overlap of meaningful terms (see {@link recallTerms}). A term's
 * weight is idf(df) / idf(1) (1 for a term only one memory contains), terms found
 * in most memories of a large net are ignored, and a memory's relevance is the
 * sum of the weights of the terms it contains. Words match whole FTS tokens (plus plural forms); CJK bigrams
 * match as substrings.
 */
function lexicalRelevance(ctx: MemoryContext, query: RecallQuery, now: number, text: string, candidates: Set<string>): Map<string, number> {
  const { db } = ctx;
  const terms = recallTerms(text);
  const hits = new Map<string, Set<string>>();
  const w = candidateWhere(query, now, 'n');
  for (const word of terms.words) {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT n.id AS id FROM memory_fts JOIN memory_nodes n ON n.id = memory_fts.node_id WHERE memory_fts MATCH ? AND ${w.sql}`)
        .all(wordMatchExpression(word), ...w.params) as { id: string }[];
      hits.set(word, new Set(rows.map((r) => r.id)));
    } catch (err) {
      ctx.logger.debug('memory: lexical search failed', { error: String(err) });
    }
  }
  if (terms.cjk.length) {
    // One pass over the candidates' text for all bigrams (FTS can't look inside a CJK run).
    const where = candidateWhere(query, now);
    const rows = db
      .prepare(
        `SELECT id, txt FROM (SELECT id, label || ' ' || content || ' ' || aliases || ' ' || tags AS txt FROM memory_nodes WHERE ${where.sql})
         WHERE ${terms.cjk.map(() => 'instr(txt, ?) > 0').join(' OR ')}`,
      )
      .all(...where.params, ...terms.cjk) as { id: string; txt: string }[];
    for (const term of terms.cjk) hits.set(term, new Set());
    for (const row of rows) {
      const txt = row.txt.normalize('NFKC').toLowerCase();
      for (const term of terms.cjk) if (txt.includes(term)) hits.get(term)!.add(row.id);
    }
  }
  // BM25-style idf over the candidates plus lexicalIdfPrior pseudo-memories that contain no query
  // term, so a handful of memories that all mention "Kyoto" still match "Kyoto", while in a big
  // net a word that many memories share fades towards 0.
  const N = candidates.size + C.lexicalIdfPrior;
  const idf = (df: number) => Math.log(1 + (N - df + 0.5) / (df + 0.5));
  const ref = idf(1);
  const relevance = new Map<string, number>();
  for (const ids of hits.values()) {
    const df = ids.size;
    if (!df || (candidates.size >= C.lexicalIdfPrior && df > C.lexicalMaxDocShare * candidates.size)) continue; // absent, or too common to mean anything
    const weight = idf(df) / ref;
    for (const id of ids) relevance.set(id, (relevance.get(id) ?? 0) + weight);
  }
  return relevance;
}

function seedReason(source: SeedSource, node: MemoryNode): string {
  switch (source) {
    case 'vector':
      return 'matches what you said';
    case 'lexical':
      return 'shares keywords';
    case 'entity':
      return `mentions ${node.label}`;
    case 'profile':
      return 'part of your profile';
    case 'pinned':
      return 'pinned core memory';
    case 'style':
      return 'assistant-style preference';
  }
}

export async function recall(ctx: MemoryContext, query: RecallQuery): Promise<RecallOutcome> {
  if (query.signal?.aborted) throw new NeoError('cancelled', 'Memory recall was cancelled.');
  const started = performance.now();
  const { db } = ctx;
  const policy = ctx.policy();
  const now = query.now ?? ctx.clock();
  const limit = Math.max(0, Math.floor(query.limit ?? policy.recallLimit));
  const tokenBudget = Math.max(0, query.tokenBudget ?? policy.recallTokenBudget);
  const text = (query.text ?? '').trim();
  const finish = (items: RecalledMemory[], seeds: number, considered: number, selectedIds: string[] = [], querySeedIds: string[] = []): RecallOutcome => ({
    result: { items, tookMs: Math.round((performance.now() - started) * 100) / 100, seeds, considered },
    selectedIds,
    querySeedIds,
  });
  if (limit === 0) return finish([], 0, 0);

  // ── 1. candidates ──
  const initialWhere = candidateWhere(query, now);
  const initialCandidates = new Set((db.prepare(`SELECT id FROM memory_nodes WHERE ${initialWhere.sql}`).all(...initialWhere.params) as { id: string }[]).map((r) => r.id));
  if (!initialCandidates.size) return finish([], 0, 0);

  const spaces = text ? await querySpaces(ctx, query, text, (query.context ?? '').trim()) : new Map<string, QuerySpace>();
  if (query.signal?.aborted) throw new NeoError('cancelled', 'Memory recall was cancelled.');
  // Re-read eligibility after embedding. All node reads and activation work below
  // are synchronous, so an in-process write cannot interleave with this snapshot.
  const where = candidateWhere(query, now);
  const candidates = new Set((db.prepare(`SELECT id FROM memory_nodes WHERE ${where.sql}`).all(...where.params) as { id: string }[]).map((r) => r.id));
  if (!candidates.size) return finish([], 0, 0);

  // ── 2. seeds: a node's seed activation is the max over the sources ──
  const seeds = new Map<string, Seed>();
  const offer = (id: string, a0: number, source: SeedSource, sim = 0) => {
    if (!candidates.has(id)) return;
    const cur = seeds.get(id);
    if (!cur) seeds.set(id, { a0, source, sim });
    else {
      if (a0 > cur.a0) {
        cur.a0 = a0;
        cur.source = source;
      }
      cur.sim = Math.max(cur.sim, sim);
    }
  };

  // Vector: top seedTopK with sim ≥ floor, a₀ = (sim − floor) / (1 − floor).
  if (spaces.size) {
    const main = ctx.vectors.all(ctx.embedder.id);
    const onDevice = ctx.localEmbedder !== ctx.embedder ? ctx.vectors.all(ctx.localEmbedder.id) : null;
    const hits: { id: string; sim: number }[] = [];
    for (const id of candidates) {
      const fromMain = main.get(id);
      const v = fromMain ?? onDevice?.get(id);
      const space = spaces.get(fromMain ? ctx.embedder.id : ctx.localEmbedder.id);
      if (!v || !space) continue; // not embedded (yet), or that query embedding failed
      const sim = blendedSimilarity(space, v);
      if (sim > C.seedSimilarityFloor) hits.push({ id, sim });
    }
    hits.sort((a, b) => b.sim - a.sim);
    for (const { id, sim } of hits.slice(0, C.seedTopK)) offer(id, (sim - C.seedSimilarityFloor) / (1 - C.seedSimilarityFloor), 'vector', sim);
  }

  // Lexical: IDF-weighted keyword overlap with what the user said; relevance ≥ lexicalMinRelevance
  // seeds the top lexicalTopK with a₀ = lexicalMaxActivation × min(1, relevance).
  const lexical = [...lexicalRelevance(ctx, query, now, text, candidates)]
    .filter(([, r]) => r >= C.lexicalMinRelevance)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, C.lexicalTopK);
  for (const [id, r] of lexical) offer(id, C.lexicalMaxActivation * Math.min(1, r), 'lexical');

  // Entity: label or alias occurs in the query as a whole word (substring for CJK) → a₀ = 1.
  if (!query.kinds?.length || query.kinds.includes('entity')) {
    const normQuery = normalizeText(text);
    const w = candidateWhere(query, now);
    const rows = db.prepare(`SELECT id, label, aliases FROM memory_nodes WHERE kind = 'entity' AND ${w.sql}`).all(...w.params) as { id: string; label: string; aliases: string }[];
    for (const row of rows) {
      const terms = [row.label, ...fromJson<string[]>(row.aliases, [])].map(normalizeText);
      if (terms.some((t) => (hasCJK(t) || t.length >= 2) && containsTerm(normQuery, t))) offer(row.id, 1, 'entity');
    }
  }

  // Profile: a broad question about the user ("what do you remember about me?", "你记得我什么")
  // has nothing to match, so it seeds the strongest personal memories (importance × R),
  // bounded by profileSeedLimit and subject to every candidate filter above.
  if (isBroadSelfQuery(text)) {
    const kinds = PROFILE_KINDS.filter((k) => !query.kinds?.length || query.kinds.includes(k));
    if (kinds.length) {
      const w = candidateWhere(query, now);
      const rows = db
        .prepare(
          `SELECT id, importance, stability, last_accessed_at, created_at, pinned FROM memory_nodes
           WHERE status = 'active' AND kind IN (${kinds.map(() => '?').join(',')}) AND ${w.sql}`,
        )
        .all(...kinds, ...w.params) as { id: string; importance: number; stability: number; last_accessed_at: number | bigint | null; created_at: number | bigint; pinned: number | bigint }[];
      const ranked = rows
        .map((r) => ({
          id: r.id,
          strength:
            r.importance *
            retention({ stability: r.stability, lastAccessedAt: r.last_accessed_at === null ? null : toNum(r.last_accessed_at), createdAt: toNum(r.created_at), pinned: toNum(r.pinned) === 1 }, now),
        }))
        .sort((a, b) => b.strength - a.strength || (a.id < b.id ? -1 : 1))
        .slice(0, C.profileSeedLimit);
      for (const r of ranked) offer(r.id, C.profileActivation, 'profile');
    }
  }

  // Core: up to pinnedAlwaysLimit pinned candidates, highest importance first, get at least the floor.
  if (text) {
    const w = candidateWhere(query, now);
    const rows = db
      .prepare(`SELECT id FROM memory_nodes WHERE pinned = 1 AND ${w.sql} ORDER BY importance DESC, id LIMIT ?`)
      .all(...w.params, C.pinnedAlwaysLimit) as { id: string }[];
    for (const row of rows) offer(row.id, C.pinnedActivationFloor, 'pinned');
  }

  // Style: reserve up to five active preferences on every turn, newest then strongest.
  const styleRows = db.prepare(`SELECT id FROM memory_nodes WHERE kind = 'preference' AND ${where.sql} AND EXISTS (SELECT 1 FROM json_each(memory_nodes.tags) WHERE lower(value) = ?)`)
    .all(...where.params, ASSISTANT_STYLE_TAG) as { id: string }[];
  const allStyleIds = new Set(styleRows.map((row) => row.id));
  const styleNodes = getNodes(db, [...allStyleIds]).filter((node) => node.status === 'active');
  styleNodes.sort((a, b) => b.updatedAt - a.updatedAt || b.importance * b.confidence * retention(b, now) - a.importance * a.confidence * retention(a, now) || (a.id < b.id ? -1 : 1));
  const styleIds = new Set(styleNodes.slice(0, C.assistantStyleSeedLimit).map((node) => node.id));
  for (const id of styleIds) {
    const current = seeds.get(id);
    seeds.set(id, { a0: Math.max(C.assistantStyleActivation, current?.a0 ?? 0), source: 'style', sim: current?.sim ?? 0 });
  }

  // ── 3. spreading activation ──
  const A = new Map<string, number>();
  for (const [id, seed] of seeds) A.set(id, seed.a0);
  /** Best single contribution to each non-seed node: its `via` back-pointer. */
  const best = new Map<string, { from: string; type: EdgeType; c: number }>();
  const adjacency = new Map<string, Neighbor[]>();
  const edgeStmt = db.prepare(
    `SELECT src, dst, type, weight, last_reinforced_at FROM memory_edges WHERE src = ?
     UNION ALL SELECT src, dst, type, weight, last_reinforced_at FROM memory_edges WHERE dst = ?`,
  );
  const neighbors = (id: string): Neighbor[] => {
    let list = adjacency.get(id);
    if (!list) {
      list = [];
      const rows = edgeStmt.all(id, id) as { src: string; dst: string; type: string; weight: number; last_reinforced_at: number | bigint }[];
      for (const r of rows) {
        const other = r.src === id ? r.dst : r.src;
        if (other === id || !candidates.has(other)) continue;
        const w = effectiveEdgeWeight(r.type, r.weight, toNum(r.last_reinforced_at), now);
        if (w >= C.minEdgeWeight) list.push({ other, type: r.type as EdgeType, w });
      }
      adjacency.set(id, list);
    }
    return list;
  };

  let frontier = text ? [...seeds.keys()] : [];
  for (let hop = 0; hop < C.spreadHops && frontier.length; hop++) {
    const inc = new Map<string, number>();
    for (const i of frontier) {
      const ai = A.get(i) ?? 0;
      const list = neighbors(i);
      if (ai <= 0 || !list.length) continue;
      const fan = Math.max(1, Math.sqrt(list.length)); // ACT-R fan effect: hubs spread thinner
      for (const n of list) {
        const c = (ai * n.w * C.spreadDecay) / fan;
        inc.set(n.other, (inc.get(n.other) ?? 0) + c);
        if (!seeds.has(n.other)) {
          const b = best.get(n.other);
          if (!b || c > b.c) best.set(n.other, { from: i, type: n.type, c });
        }
      }
    }
    for (const [j, d] of inc) A.set(j, Math.min(1, (A.get(j) ?? 0) + d));
    frontier = [...inc.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, C.frontierLimit)
      .map(([id]) => id);
  }

  // ── 4. score: A × strength × pinnedBoost ──
  const minScore = policy.minScore;
  const reachable = [...A.entries()].filter(([id, a]) => styleIds.has(id) || (a * C.pinnedBoost >= minScore && !allStyleIds.has(id))).map(([id]) => id);
  const nodes = new Map(getNodes(db, reachable).map((n) => [n.id, n]));
  const scored: { node: MemoryNode; score: number; R: number }[] = [];
  for (const node of nodes.values()) {
    const R = retention(node, now);
    const strength = C.strengthBase + C.weightRetention * R + C.weightImportance * node.importance + C.weightConfidence * node.confidence;
    const score = A.get(node.id)! * strength * (node.pinned ? C.pinnedBoost : 1);
    if (styleIds.has(node.id) || score >= minScore) scored.push({ node, score, R });
  }
  scored.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : 1));

  // ── 5. MMR under the item limit and token budget ──
  const styleItems = new Map(scored.filter((item) => styleIds.has(item.node.id)).map((item) => [item.node.id, item]));
  const pool = scored.filter((item) => !allStyleIds.has(item.node.id)).slice(0, Math.max(limit * 8, 64));
  const vectorOf = (id: string) => ctx.vectors.find(ctx.embedder.id, ctx.localEmbedder.id, id);
  const maxSim = new Float64Array(pool.length);
  const remaining = new Set(pool.keys());
  const selected: (typeof pool)[number][] = [];
  let tokens = 0;
  const choose = (item: (typeof pool)[number]): void => {
    selected.push(item);
    tokens += estimateTokens(`${item.node.label} ${item.node.content}`);
    const v = vectorOf(item.node.id);
    if (v) {
      for (const i of remaining) {
        const u = vectorOf(pool[i]!.node.id);
        if (u && sameSpace(u, v)) maxSim[i] = Math.max(maxSim[i]!, dot(u, v));
      }
    }
  };
  for (const id of styleIds) {
    const item = styleItems.get(id);
    if (!item || selected.length >= limit) break;
    if (tokens + estimateTokens(`${item.node.label} ${item.node.content}`) <= tokenBudget) choose(item);
  }
  while (selected.length < limit && remaining.size) {
    let pick = -1;
    let bestMmr = -Infinity;
    for (const i of remaining) {
      const mmr = C.mmrLambda * pool[i]!.score - (1 - C.mmrLambda) * maxSim[i]!;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        pick = i;
      }
    }
    remaining.delete(pick);
    const item = pool[pick]!;
    const cost = estimateTokens(`${item.node.label} ${item.node.content}`);
    if (tokens + cost > tokenBudget) continue; // too big for what is left; smaller ones may still fit
    choose(item);
  }

  // ── 6. explain ──
  const labelOf = (id: string): string =>
    nodes.get(id)?.label ?? (db.prepare('SELECT label FROM memory_nodes WHERE id = ?').get(id) as { label: string } | undefined)?.label ?? id;
  const viaOf = (id: string): RecalledMemory['via'] => {
    const chain: RecalledMemory['via'] = [];
    const seen = new Set([id]);
    let cur = id;
    while (!seeds.has(cur) && chain.length < C.spreadHops + 1) {
      const b = best.get(cur);
      if (!b || seen.has(b.from)) break;
      chain.unshift({ nodeId: b.from, label: labelOf(b.from), edgeType: b.type });
      seen.add(b.from);
      cur = b.from;
    }
    return chain;
  };
  const items: RecalledMemory[] = selected.map(({ node, score, R }) => {
    const seed = seeds.get(node.id);
    const via = seed ? [] : viaOf(node.id);
    const last = via[via.length - 1];
    return {
      node,
      score,
      activation: A.get(node.id)!,
      similarity: seed?.sim ?? 0,
      retention: R,
      via,
      reason: seed ? seedReason(seed.source, node) : last ? `linked via ${last.label} (${last.edgeType})` : 'linked memory',
    };
  });
  const querySeedIds = selected
    .filter(({ node }) => !allStyleIds.has(node.id) && QUERY_SOURCES.has(seeds.get(node.id)?.source as SeedSource))
    .sort((a, b) => b.score - a.score)
    .map(({ node }) => node.id);
  return finish(items, seeds.size, A.size, selected.map((s) => s.node.id), querySeedIds);
}
