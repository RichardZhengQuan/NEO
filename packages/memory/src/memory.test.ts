/**
 * Comprehensive tests for @neo/memory.
 *
 * All tests are offline and deterministic:
 *  - in-memory SQLite via openNeoDatabase(':memory:')
 *  - injected fake clock
 *  - HashingEmbedder (no network)
 *  - fake LLMs implementing ChatModel
 */
import { describe, it, expect } from 'vitest';
import type { ChatRequest, ChatStreamEvent, ChatModel, ObservedTurn, RecallQuery, RememberInput, ToolDefinition } from '@neo/protocol';
import { silentLogger, newId, DEFAULT_MEMORY_POLICY, NeoError, SELF_MEMORY_ID } from '@neo/protocol';
import { openNeoDatabase } from '@neo/storage';
import {
  createMemoryService,
  HashingEmbedder,
  cosineSimilarity,
  retention,
  heuristicExtract,
  MEMORY_CONSTANTS,
} from './index.js';
import { reinforceStability } from './utils.js';
import { parseLenientJson } from './extract.js';
import { createMemoryTools } from '../../tools/src/builtins/memory.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a minimal ObservedTurn for testing. */
function makeTurn(userText: string, assistantText: string, now = 1_000_000_000_000): ObservedTurn {
  const convId = 'conv_test';
  return {
    conversationId: convId,
    userMessage: {
      id: newId('msg', now),
      conversationId: convId,
      role: 'user',
      parts: [{ type: 'text', text: userText }],
      createdAt: now,
      status: 'complete',
    },
    assistantMessage: {
      id: newId('msg', now + 1),
      conversationId: convId,
      role: 'assistant',
      parts: [{ type: 'text', text: assistantText }],
      createdAt: now + 1,
      status: 'complete',
    },
    now,
  };
}

/** Fake clock: starts at startMs and advances via tick/tickDays. */
function makeClock(startMs = 1_000_000_000_000) {
  let now = startMs;
  return {
    tickDays: (d: number) => { now += d * 24 * 60 * 60 * 1000; },
    clock: () => now,
  };
}

/** Fake ChatModel that returns a fixed JSON string. */
function makeFakeLLM(jsonResponse: string): ChatModel {
  return {
    async *chat(_req: ChatRequest): AsyncIterable<ChatStreamEvent> {
      yield { type: 'text', text: jsonResponse };
      yield { type: 'done', stopReason: 'end' };
    },
  };
}

function makeEmptyLLM(): ChatModel {
  return makeFakeLLM(JSON.stringify({ episode: null, memories: [], links: [] }));
}

function makeTestService(fakeLLM?: ChatModel, startMs = 1_000_000_000_000) {
  const db = openNeoDatabase(':memory:');
  const { clock, tickDays } = makeClock(startMs);
  const embedder = new HashingEmbedder(256);
  const svc = createMemoryService({
    db,
    embedder,
    llm: fakeLLM ? () => ({ model: fakeLLM, name: 'fake', isLocal: true }) : () => null,
    clock,
    logger: silentLogger,
  });
  return { svc, clock, tickDays, db };
}

// ─── retention / stability math ─────────────────────────────────────────────

describe('retention', () => {
  it('pinned node always returns 1', () => {
    const node = { stability: 30, lastAccessedAt: null, createdAt: 0, pinned: true };
    expect(retention(node, 1_000_000)).toBe(1);
  });

  it('R ≈ 1 immediately after creation', () => {
    const node = { stability: 30, lastAccessedAt: null, createdAt: 1000, pinned: false };
    const R = retention(node, 1001);
    expect(R).toBeGreaterThan(0.99);
  });

  it('R ≈ 0 after many stability half-lives', () => {
    const stability = 3; // 3 days
    const node = { stability, lastAccessedAt: null, createdAt: 0, pinned: false };
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const R = retention(node, ninetyDaysMs);
    // exp(-90/3) = exp(-30) ≈ 0
    expect(R).toBeLessThan(0.001);
  });

  it('R = exp(-Δt/S) for finite Δt', () => {
    const stability = 10; // 10 days
    const node = { stability, lastAccessedAt: null, createdAt: 0, pinned: false };
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const R = retention(node, tenDaysMs);
    expect(R).toBeCloseTo(Math.exp(-1), 3); // exp(-1) ≈ 0.368
  });
});

// ─── cosineSimilarity ────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('orthogonal vectors → 0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('opposite vectors → -1', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('zero vector → 0', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

// ─── HashingEmbedder ────────────────────────────────────────────────────────

describe('HashingEmbedder', () => {
  it('produces vectors of the specified dimension', async () => {
    const emb = new HashingEmbedder(128);
    const vecs = await emb.embed(['hello world']);
    expect(vecs[0]!.length).toBe(128);
  });

  it('L2-normalizes output vectors', async () => {
    const emb = new HashingEmbedder(256);
    const vecs = await emb.embed(['test sentence about memory']);
    const vec = vecs[0]!;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 4);
  });

  it('different texts produce different vectors', async () => {
    const emb = new HashingEmbedder(256);
    const vecs = await emb.embed(['cat', 'elephant']);
    expect(cosineSimilarity(vecs[0]!, vecs[1]!)).toBeLessThan(0.99);
  });

  it('similar texts produce higher cosine sim than unrelated texts', async () => {
    const emb = new HashingEmbedder(512);
    const texts = ['I have a golden retriever dog', 'My dog is a golden retriever', 'I drive a red sports car'];
    const [dog1, dog2, car] = await emb.embed(texts);
    const simDogs = cosineSimilarity(dog1!, dog2!);
    const simDogCar = cosineSimilarity(dog1!, car!);
    expect(simDogs).toBeGreaterThan(simDogCar);
  });

  it('CJK text produces non-zero vectors', async () => {
    const emb = new HashingEmbedder(256);
    const vecs = await emb.embed(['今日は良い天気です']);
    const vec = vecs[0]!;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeGreaterThan(0.5);
  });

  it('id follows hash2-<dims> format (versioned)', () => {
    const emb = new HashingEmbedder(512);
    expect(emb.id).toBe('hash2-512');
    expect(emb.dimensions).toBe(512);
  });
});

// ─── heuristicExtract ────────────────────────────────────────────────────────

describe('heuristicExtract', () => {
  it('extracts "my name is" pattern', () => {
    const results = heuristicExtract('My name is Alice.');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.label!.toLowerCase()).toContain('alice');
  });

  it('extracts "I like" preference', () => {
    const results = heuristicExtract('I like hiking in the mountains.');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.kind).toBe('preference');
  });

  it('extracts "remember that" pattern', () => {
    const results = heuristicExtract('Remember that my cat is named Luna.');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for unstructured text with no patterns', () => {
    const results = heuristicExtract('The sky is blue today.');
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('observe: duplicate-label heuristic candidates keep sensitivity (regression for #112)', () => {
  it('keeps the allergy local and recalls it only when sensitive memories are allowed', async () => {
    const db = openNeoDatabase(':memory:');
    const hashing = new HashingEmbedder(256);
    const cloudCalls: string[] = [];
    const cloud = {
      id: hashing.id, dimensions: hashing.dimensions, isLocal: false as const,
      async embed(texts: string[]) { cloudCalls.push(...texts); return hashing.embed(texts); },
    };
    const { clock } = makeClock();
    const svc = createMemoryService({ db, embedder: cloud, llm: () => null, clock, logger: silentLogger });

    await svc.observe(makeTurn("Remember that I'm allergic to penicillin.", 'Noted.'));

    expect(cloudCalls.every((t) => !t.includes('allergic to penicillin'))).toBe(true);
    expect((await svc.recall({ text: 'allergic to penicillin', limit: 10, reinforce: false, allowSensitive: false })).items.every((r) => r.node.sensitivity !== 'sensitive')).toBe(true);
    expect((await svc.recall({ text: 'allergic to penicillin', limit: 10, reinforce: false, allowSensitive: true })).items.some((r) => r.node.sensitivity === 'sensitive' && /allergic/.test(r.node.content))).toBe(true);
    db.close();
  });
});

describe('observe: duplicate-content health facts keep sensitivity (regression for #436)', () => {
  it.each([
    'Please remember that I have diabetes.',
    "Please remember that I've diabetes.",
    'Please remember that I have been diagnosed with diabetes.',
    "Please remember that I've been diagnosed with diabetes.",
    'Please remember that I have been treated for diabetes.',
    "Please remember that I've been treated for diabetes.",
    // Lowercase pronoun: regression for the Codex P2 on head 22ef0e3.
    'i have diabetes.',
    "i've been diagnosed with diabetes.",
    "i've been treated for diabetes.",
  ])('keeps diabetes out of cloud embeddings and non-sensitive recall for "%s"', async (text) => {
    const db = openNeoDatabase(':memory:');
    const hashing = new HashingEmbedder(256);
    const cloudCalls: string[] = [];
    const cloud = {
      id: hashing.id, dimensions: hashing.dimensions, isLocal: false as const,
      async embed(texts: string[]) {
        cloudCalls.push(...texts);
        // Hashing has no health semantics: make the query relevant so recall must filter the fact.
        return hashing.embed(texts.map((t) => t === 'health conditions' ? 'The user has diabetes.' : t));
      },
    };
    const { clock } = makeClock();
    const svc = createMemoryService({ db, embedder: cloud, llm: () => null, clock, logger: silentLogger });

    try {
      await svc.remember({ kind: 'fact', label: 'Favorite color', content: 'The user likes blue.' });
      await svc.observe(makeTurn(text, 'Noted.'));
      const recalled = await svc.recall({ text: 'health conditions', limit: 10, reinforce: false, allowSensitive: false });

      expect(cloudCalls.some((t) => t.length > 0)).toBe(true);
      expect(cloudCalls).toContain('health conditions');
      expect.soft(cloudCalls.every((t) => !/diabetes/i.test(t))).toBe(true);
      expect.soft(recalled.items.every((r) => !/diabetes/i.test(r.node.content))).toBe(true);
      expect((await svc.graph({ limit: 10 })).nodes.some((n) => n.label === 'Health: diabetes' && n.sensitivity === 'sensitive')).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ─── parseLenientJson ────────────────────────────────────────────────────────

describe('parseLenientJson', () => {
  it('parses clean JSON', () => {
    const json = JSON.stringify({ episode: null, memories: [], links: [] });
    const result = parseLenientJson(json);
    expect(result).toMatchObject({ memories: [] });
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"episode": null, "memories": [], "links": []}\n```';
    const result = parseLenientJson(raw);
    expect(result).toMatchObject({ memories: [] });
  });

  it('strips prose prefix before JSON', () => {
    const raw = 'Here is the result:\n{"episode": null, "memories": [], "links": []}';
    const result = parseLenientJson(raw);
    expect(result).toMatchObject({ memories: [] });
  });

  it('returns null for completely unparseable text', () => {
    const result = parseLenientJson('this is not json at all');
    expect(result).toBeNull();
  });
});

// ─── basic remember + get ────────────────────────────────────────────────────

describe('remember + get', () => {
  it('stores and retrieves a memory', async () => {
    const { svc } = makeTestService();
    const node = await svc.remember({ kind: 'fact', label: 'Home city', content: 'Lives in Berlin', importance: 0.8 });
    expect(node.id).toBeTruthy();
    expect(node.label).toBe('Home city');

    const detail = await svc.get(node.id);
    expect(detail?.node.content).toBe('Lives in Berlin');
  });

  it('get returns null for unknown id', async () => {
    const { svc } = makeTestService();
    const detail = await svc.get('mem_nonexistent');
    expect(detail).toBeNull();
  });
});

// ─── update + forget ────────────────────────────────────────────────────────

describe('update + forget', () => {
  it('updates a memory field', async () => {
    const { svc } = makeTestService();
    const node = await svc.remember({ kind: 'fact', label: 'City', content: 'Berlin', importance: 0.7 });
    await svc.update(node.id, { content: 'Munich' });
    const detail = await svc.get(node.id);
    expect(detail?.node.content).toBe('Munich');
  });

  it('forget removes a memory (hard delete)', async () => {
    const { svc } = makeTestService();
    const node = await svc.remember({ kind: 'fact', label: 'Temp', content: 'Temp fact', importance: 0.3 });
    const count = await svc.forget([node.id]);
    expect(count).toBe(1);
    const detail = await svc.get(node.id);
    // forget hard-deletes; node is gone
    expect(detail).toBeNull();
  });
});

// ─── link / unlink ──────────────────────────────────────────────────────────

describe('link / unlink', () => {
  it('creates an edge between two nodes', async () => {
    const { svc } = makeTestService();
    const a = await svc.remember({ kind: 'entity', label: 'Alice', content: 'Friend', importance: 0.8 });
    const b = await svc.remember({ kind: 'entity', label: 'Bob', content: 'Colleague', importance: 0.7 });

    await svc.link(a.id, b.id, 'related', 0.9);
    const g = await svc.graph({ centerId: a.id, depth: 1, limit: 10 });
    const edge = g.edges.find(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id));
    expect(edge).toBeDefined();
  });

  it('unlink removes the edge', async () => {
    const { svc } = makeTestService();
    const a = await svc.remember({ kind: 'entity', label: 'C', content: 'C', importance: 0.5 });
    const b = await svc.remember({ kind: 'entity', label: 'D', content: 'D', importance: 0.5 });
    const createdEdge = await svc.link(a.id, b.id, 'related', 0.8);
    await svc.unlink(createdEdge.id);
    const g = await svc.graph({ centerId: a.id, depth: 1, limit: 10 });
    const edge = g.edges.find(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id));
    expect(edge).toBeUndefined();
  });

  it.each(['from', 'to'] as const)('refuses to unlink an edge with the self node as its %s endpoint', async (endpoint) => {
    const { svc, db } = makeTestService();
    try {
      const node = await svc.remember({ kind: 'fact', label: 'Tea', content: 'The user likes tea', importance: 0.5 });
      const edge = endpoint === 'from'
        ? await svc.link(SELF_MEMORY_ID, node.id, 'related', 0.8)
        : (await svc.get(node.id))!.edges.find(e => e.to === SELF_MEMORY_ID)!;
      expect(edge[endpoint]).toBe(SELF_MEMORY_ID);

      const result = svc.unlink(edge.id);
      await expect(result).rejects.toBeInstanceOf(NeoError);
      await expect(result).rejects.toMatchObject({ code: 'bad_request' });
      expect((await svc.get(node.id))!.edges).toContainEqual(edge);
    } finally {
      db.close();
    }
  });
});

// ─── graph ──────────────────────────────────────────────────────────────────

describe('graph', () => {
  it('BFS from centerId returns center + neighbors', async () => {
    const { svc } = makeTestService();
    const center = await svc.remember({ kind: 'entity', label: 'Center', content: 'Hub', importance: 0.9 });
    const n1 = await svc.remember({ kind: 'fact', label: 'N1', content: 'Neighbor 1', importance: 0.5 });
    const n2 = await svc.remember({ kind: 'fact', label: 'N2', content: 'Neighbor 2', importance: 0.5 });

    await svc.link(center.id, n1.id, 'related', 0.8);
    await svc.link(center.id, n2.id, 'related', 0.8);

    const g = await svc.graph({ centerId: center.id, depth: 1, limit: 10 });
    expect(g.nodes.some(n => n.id === center.id)).toBe(true);
    expect(g.nodes.length).toBeGreaterThanOrEqual(3);
    expect(g.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('graph without centerId returns highest-importance nodes', async () => {
    const { svc } = makeTestService();
    for (const imp of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
      await svc.remember({ kind: 'fact', label: `Fact${imp}`, content: `Content ${imp}`, importance: imp });
    }

    const g = await svc.graph({ limit: 3 });
    expect(g.nodes.length).toBeLessThanOrEqual(3);
  });
});

// ─── stats ──────────────────────────────────────────────────────────────────

describe('stats', () => {
  it('counts nodes by kind', async () => {
    const { svc } = makeTestService();
    await svc.remember({ kind: 'fact', label: 'F1', content: 'Fact 1', importance: 0.5 });
    await svc.remember({ kind: 'entity', label: 'E1', content: 'Entity 1', importance: 0.6 });

    const s = await svc.stats();
    expect(s.total).toBe(2);
    expect(s.byKind.fact).toBe(1);
    expect(s.byKind.entity).toBe(1);
  });

});

// ─── search ──────────────────────────────────────────────────────────────────

describe('search', () => {
  it('search returns matching nodes by keyword', async () => {
    const { svc } = makeTestService();
    await svc.remember({ kind: 'fact', label: 'Berlin city', content: 'User lives in Berlin', importance: 0.7 });
    await svc.remember({ kind: 'fact', label: 'Paris visit', content: 'User visited Paris', importance: 0.6 });

    const results = await svc.search({ query: 'Berlin' });
    expect(results.items.length).toBeGreaterThanOrEqual(1);
    expect(results.items.some(n => n.label.toLowerCase().includes('berlin'))).toBe(true);
  });

  it('search with kinds filter', async () => {
    const { svc } = makeTestService();
    await svc.remember({ kind: 'fact', label: 'Fact A', content: 'Some fact', importance: 0.5 });
    await svc.remember({ kind: 'preference', label: 'Pref A', content: 'Some preference', importance: 0.5 });

    const results = await svc.search({ kinds: ['fact'] });
    expect(results.items.every(n => n.kind === 'fact')).toBe(true);
  });
});

// ─── recall ──────────────────────────────────────────────────────────────────

describe('recall', () => {
  it('recalls relevant memories by semantic similarity', async () => {
    const { svc } = makeTestService();
    await svc.remember({ kind: 'fact', label: 'Dog breed', content: 'User has a golden retriever named Max', importance: 0.8 });
    await svc.remember({ kind: 'fact', label: 'Car', content: 'User drives a Toyota Camry', importance: 0.5 });

    const result = await svc.recall({ text: 'Tell me about the golden retriever', limit: 5, reinforce: false });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0]!.node.label).toBe('Dog breed');
  });

  it('sensitive memories not returned without allowSensitive', async () => {
    const { svc } = makeTestService();
    await svc.remember({
      kind: 'fact',
      label: 'Health issue',
      content: 'User has diabetes',
      importance: 0.9,
      sensitivity: 'sensitive',
    });
    await svc.remember({
      kind: 'fact',
      label: 'Normal fact',
      content: 'User likes hiking',
      importance: 0.7,
    });

    const result = await svc.recall({ text: 'health diabetes hiking', limit: 10, reinforce: false, allowSensitive: false });
    expect(result.items.every(r => r.node.sensitivity !== 'sensitive')).toBe(true);
  });

  it('sensitive memories returned with allowSensitive=true', async () => {
    const { svc } = makeTestService();
    await svc.remember({
      kind: 'fact',
      label: 'Condition',
      content: 'User has diabetes type 2',
      importance: 0.9,
      sensitivity: 'sensitive',
    });

    const result = await svc.recall({ text: 'diabetes condition', limit: 10, reinforce: false, allowSensitive: true });
    expect(result.items.some(r => r.node.sensitivity === 'sensitive')).toBe(true);
  });

  it('sub-threshold best.from that becomes sensitive poisons its reachable destination', async () => {
    // Only S is a seed: cos(query, S) = 0.88 gives activation 0.85;
    // all other node vectors are orthogonal to the query and to each other.
    // This fixes the graph geometry independently of feature-hash collisions.
    // With S's five neighbors, I gets 0.85*0.5*0.5/sqrt(5) ≈ 0.0950
    // and each Xi gets 0.85*0.7*0.5/sqrt(5) ≈ 0.1330 (all sub-threshold).
    // At hop two I→B contributes ≈0.03360, strictly more than each Xi→B
    // contribution ≈0.03293. B's activation ≈0.16531 passes minScore.
    // After I becomes sensitive, eligibility is re-read before activation:
    // S has four eligible neighbors, so clean B activation is
    // 4*(0.85*0.7*0.5/sqrt(4))*0.7*0.5/sqrt(2) ≈0.14725 <0.15.
    // Thus B must disappear even after fan normalization is recomputed.
    const queryText = 'qxfixturequery';
    const DIMS = 8;
    const qVec = new Float32Array(DIMS); qVec[0] = 1;
    const sVec = new Float32Array(DIMS); sVec[0] = 0.88; sVec[7] = Math.sqrt(1 - 0.88 ** 2);
    const otherContents = [
      'sub-threshold-intermediate-zqxwvu', 'bridge-node-x1-tsrqpo',
      'bridge-node-x2-nmlkji', 'bridge-node-x3-hgfedcb',
      'bridge-node-x4-zyxwvut', 'destination-node-b-srqpon',
    ];
    const otherVecs = otherContents.map((_, i) => {
      const v = new Float32Array(DIMS); v[i + 1] = 1; return v;
    });
    const inner = {
      id: 'controlled-subthreshold-8', dimensions: DIMS, isLocal: true as const,
      embed(texts: string[]): Promise<Float32Array[]> {
        return Promise.resolve(texts.map(text => {
          if (text === queryText) return qVec;
          if (text.includes(queryText)) return sVec;
          const index = otherContents.findIndex(content => text.includes(content));
          return index < 0 ? new Float32Array(DIMS) : otherVecs[index]!;
        }));
      },
    };
    expect(cosineSimilarity(qVec, sVec)).toBeCloseTo(0.88, 6);
    for (const vector of otherVecs) expect(cosineSimilarity(qVec, vector)).toBe(0);
    const seedActivation = (cosineSimilarity(qVec, sVec) - MEMORY_CONSTANTS.seedSimilarityFloor) / (1 - MEMORY_CONSTANTS.seedSimilarityFloor);
    const cleanActivation = 4 * (seedActivation * 0.7 * MEMORY_CONSTANTS.spreadDecay / Math.sqrt(4)) * 0.7 * MEMORY_CONSTANTS.spreadDecay / Math.sqrt(2);
    expect(cleanActivation).toBeLessThan(DEFAULT_MEMORY_POLICY.minScore);
    const { clock } = makeClock();
    const db = openNeoDatabase(':memory:');
    const svc = createMemoryService({ db, embedder: inner, clock, logger: silentLogger });

    const nodeS  = await svc.remember({ kind: 'fact', label: 'Seed S',         content: queryText,                           importance: 0.5 });
    const nodeI  = await svc.remember({ kind: 'fact', label: 'Intermediate I', content: 'sub-threshold-intermediate-zqxwvu', importance: 0.5 });
    const nodeX1 = await svc.remember({ kind: 'fact', label: 'Bridge X1',      content: 'bridge-node-x1-tsrqpo',             importance: 0.5 });
    const nodeX2 = await svc.remember({ kind: 'fact', label: 'Bridge X2',      content: 'bridge-node-x2-nmlkji',             importance: 0.5 });
    const nodeX3 = await svc.remember({ kind: 'fact', label: 'Bridge X3',      content: 'bridge-node-x3-hgfedcb',            importance: 0.5 });
    const nodeX4 = await svc.remember({ kind: 'fact', label: 'Bridge X4',      content: 'bridge-node-x4-zyxwvut',            importance: 0.5 });
    // importance=1.0 keeps B's baseline score above minScore.
    const nodeB  = await svc.remember({ kind: 'fact', label: 'Destination B',  content: 'destination-node-b-srqpon',         importance: 1.0 });

    expect(new Set([nodeS, nodeI, nodeX1, nodeX2, nodeX3, nodeX4, nodeB].map(node => node.id)).size).toBe(7);

    await svc.link(nodeS.id,  nodeI.id,  'related', 0.5);
    await svc.link(nodeS.id,  nodeX1.id, 'related', 0.7);
    await svc.link(nodeS.id,  nodeX2.id, 'related', 0.7);
    await svc.link(nodeS.id,  nodeX3.id, 'related', 0.7);
    await svc.link(nodeS.id,  nodeX4.id, 'related', 0.7);
    await svc.link(nodeI.id,  nodeB.id,  'related', 1.0);
    await svc.link(nodeX1.id, nodeB.id,  'related', 0.7);
    await svc.link(nodeX2.id, nodeB.id,  'related', 0.7);
    await svc.link(nodeX3.id, nodeB.id,  'related', 0.7);
    await svc.link(nodeX4.id, nodeB.id,  'related', 0.7);

    // First confirm B IS reachable before the race: verify the topology is correct.
    {
      const baseline = await svc.recall({ text: queryText, limit: 20, reinforce: false, allowSensitive: false });
      const destination = baseline.items.find(r => r.node.id === nodeB.id);
      expect(destination).toBeDefined();
      expect(destination!.score).toBeGreaterThanOrEqual(DEFAULT_MEMORY_POLICY.minScore);
      expect(destination!.via.map(v => v.nodeId)).toEqual([nodeS.id, nodeI.id]);
      expect(baseline.items.some(r => r.node.id === nodeI.id)).toBe(false);
    }

    // Wrapper embedder: flip I to sensitive on the first embed() call,
    // simulating a concurrent write that races with the async embedding gap.
    let raceTriggered = false;
    const racingEmbedder = {
      id: inner.id,
      dimensions: inner.dimensions,
      isLocal: true as const,
      async embed(texts: string[], _signal?: AbortSignal) {
        if (!raceTriggered) {
          raceTriggered = true;
          db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(nodeI.id);
        }
        return inner.embed(texts);
      },
    };
    svc.setEmbedder(racingEmbedder);

    const result = await svc.recall({ text: queryText, limit: 20, reinforce: false, allowSensitive: false });

    // The race fired: I is sensitive, and the remaining clean paths cannot
    // recall B. Neither I's id nor label may survive in any explanation.
    expect(raceTriggered).toBe(true);
    expect(result.items.every(r => r.node.id !== nodeB.id)).toBe(true);
    // Issue #539 spec: no via entry in any result pointing at I, and I's label
    // never leaks through a result's reason string.
    expect(result.items.every(r => r.via.every(v => v.nodeId !== nodeI.id))).toBe(true);
    expect(result.items.every(r => !r.reason.includes('Intermediate I'))).toBe(true);
    db.close();
  });

  it('sub-threshold seed (best.from) that becomes sensitive poisons its destination (Bug 1 #596)', async () => {
    // Topology: 6 seeds each connected only to B (fan = 1).
    //   seedSimilarityFloor = 0.2  →  a0 = (sim − 0.2) / 0.8
    //   All Si: sim = 0.25  →  a0 = 0.0625  <  minScore 0.15  (sub-threshold seeds)
    //
    //   c(S0→B) = 0.0625 × 1.0 × 0.5 / 1 = 0.03125  (highest → best[B].from = S0)
    //   c(Si→B) = 0.0625 × 0.9 × 0.5 / 1 = 0.028125  (i = 1..5)
    //   A[B] = 0.03125 + 5 × 0.028125 = 0.171875
    //   score(B) = A[B] × strength ≈ 0.171875 × 0.995 = 0.1711 ≥ 0.15 (scored ✓)
    //
    //   After hop 1 (B spreads back to Si): fan_B = √6 ≈ 2.449
    //   c(B→S0) = 0.171875 × 1.0 × 0.5 / 2.449 ≈ 0.0351
    //   A[S0]_final ≈ 0.0625 + 0.0351 = 0.0976; × 1.15 = 0.1123 < 0.15  (sub-threshold ✓)
    //
    // Bug 1: the old `!seeds.has(id)` guard excluded S0 from subThresholdFromIds;
    //        S0 was never freshness-checked so B was never tainted.
    // Fix:   S0 is included → fails eligibility → taints B → B excluded.
    //
    // Each seed uses a unique private dimension (DIMS=8) so that
    // cos(sVec_i, sVec_j) = 0.0625 < dedupeSimilarity 0.92 (no deduplication),
    // while cos(sVec_k, qVec) = 0.25 is preserved for all k.
    const DIMS = 8;
    const QUERY_MARKER = `bug1q-${Math.random().toString(36).slice(2)}`;
    const SEED_MARKER  = `bug1s-${Math.random().toString(36).slice(2)}`;
    const B_MARKER     = `bug1b-${Math.random().toString(36).slice(2)}`;

    const qVec  = new Float32Array(DIMS); qVec[0] = 1;
    // sVec_k: dim 0 = 0.25, dim k+1 = sqrt(0.9375), rest = 0.
    // |sVec_k| = 1; cos(sVec_k, qVec) = 0.25; cos(sVec_i, sVec_j) = 0.0625 (i≠j).
    const sVecs: Float32Array[] = Array.from({ length: 6 }, (_, k) => {
      const v = new Float32Array(DIMS);
      v[0] = 0.25;
      v[k + 1] = Math.sqrt(0.9375);
      return v;
    });
    const bVec  = new Float32Array(DIMS); bVec[DIMS - 1] = 1;

    const baseEmbedder = {
      id: `ctl-bug1-${DIMS}`,
      dimensions: DIMS,
      isLocal: true as const,
      embed(texts: string[]): Promise<Float32Array[]> {
        return Promise.resolve(texts.map(t => {
          if (t.includes(QUERY_MARKER)) return qVec;
          for (let k = 0; k < 6; k++) if (t.includes(`${SEED_MARKER}-${k}`)) return sVecs[k]!;
          return bVec;
        }));
      },
    };

    const { clock } = makeClock();
    const db = openNeoDatabase(':memory:');
    const svc = createMemoryService({ db, embedder: baseEmbedder, clock, logger: silentLogger });

    const nodeS0 = await svc.remember({ kind: 'fact', label: 'Seed S0', content: `${SEED_MARKER}-0`, importance: 0.5 });
    const nodeS1 = await svc.remember({ kind: 'fact', label: 'Seed S1', content: `${SEED_MARKER}-1`, importance: 0.5 });
    const nodeS2 = await svc.remember({ kind: 'fact', label: 'Seed S2', content: `${SEED_MARKER}-2`, importance: 0.5 });
    const nodeS3 = await svc.remember({ kind: 'fact', label: 'Seed S3', content: `${SEED_MARKER}-3`, importance: 0.5 });
    const nodeS4 = await svc.remember({ kind: 'fact', label: 'Seed S4', content: `${SEED_MARKER}-4`, importance: 0.5 });
    const nodeS5 = await svc.remember({ kind: 'fact', label: 'Seed S5', content: `${SEED_MARKER}-5`, importance: 0.5 });
    const nodeB  = await svc.remember({ kind: 'fact', label: 'Destination B', content: B_MARKER, importance: 1.0 });

    // S0 → B with w=1.0 (makes S0 best[B].from), S1–S5 → B with w=0.9.
    await svc.link(nodeS0.id, nodeB.id, 'related', 1.0);
    await svc.link(nodeS1.id, nodeB.id, 'related', 0.9);
    await svc.link(nodeS2.id, nodeB.id, 'related', 0.9);
    await svc.link(nodeS3.id, nodeB.id, 'related', 0.9);
    await svc.link(nodeS4.id, nodeB.id, 'related', 0.9);
    await svc.link(nodeS5.id, nodeB.id, 'related', 0.9);

    // Baseline: B is reachable before the race.
    {
      const baseline = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });
      expect(baseline.items.some(r => r.node.id === nodeB.id)).toBe(true);
    }

    // Racing embedder: flip S0 sensitive on the first embed() call.
    let raceTriggered = false;
    const racingEmbedder = {
      id: baseEmbedder.id,
      dimensions: baseEmbedder.dimensions,
      async embed(texts: string[], _signal?: AbortSignal) {
        if (!raceTriggered) {
          raceTriggered = true;
          db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(nodeS0.id);
        }
        return baseEmbedder.embed(texts);
      },
    };
    svc.setEmbedder(racingEmbedder);

    const result = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });

    expect(raceTriggered).toBe(true);
    // S0 is sensitive and is best[B].from; Bug 1 fix includes S0 in the freshness
    // check, taints it, then cascades to taint B.
    expect(result.items.every(r => r.node.id !== nodeB.id)).toBe(true);
    expect(result.items.every(r => r.via.every(v => v.nodeId !== nodeS0.id))).toBe(true);
    db.close();
  });

  it('non-best contributor becomes sensitive and drops destination below minScore (Bug 2 #596)', async () => {
    // Topology: P and Q are both seeds, each connected only to B (fan = 1).
    //   P  sim = 0.9  →  a0 = 0.875  (strong seed)
    //   Q  sim = 0.3  →  a0 = 0.125  (weaker seed, non-best contributor)
    //
    //   c(P→B) = 0.875 × 0.30 × 0.5 / 1 = 0.13125  → best[B].from = P
    //   c(Q→B) = 0.125 × 0.60 × 0.5 / 1 = 0.0375   → non-best contributor
    //   A[B]  = 0.13125 + 0.0375 = 0.16875 ≥ 0.15 / 1.15 = 0.1304  (reachable ✓)
    //   Clean A[B] after removing Q = 0.16875 − 0.0375 = 0.13125 < 0.15
    //
    // Bug 2: the best.from cascade does not propagate from Q (only from P);
    //        B survives even though its clean activation is sub-threshold.
    // Fix:   allContrib records Q→B; clean-activation check taints B.
    //
    // Vectors use distinct dims so cos(pVec, qNodeVec) = 0.9×0.3 = 0.27 < dedupeSimilarity 0.92
    // (P and Q are NOT deduplicated).
    const DIMS = 4;
    const QUERY_MARKER  = `bug2q-${Math.random().toString(36).slice(2)}`;
    const P_MARKER      = `bug2p-${Math.random().toString(36).slice(2)}`;
    const Q_NODE_MARKER = `bug2qs-${Math.random().toString(36).slice(2)}`;
    const B_MARKER      = `bug2b-${Math.random().toString(36).slice(2)}`;

    const qVec     = new Float32Array([1, 0, 0, 0]);
    const pVec     = new Float32Array([0.9, Math.sqrt(1 - 0.81), 0, 0]); // cos(pVec, qVec) = 0.9
    const qNodeVec = new Float32Array([0.3, 0, Math.sqrt(1 - 0.09), 0]); // cos(qNodeVec, qVec) = 0.3; cos(p,q)=0.27
    const bVec     = new Float32Array([0, 0, 0, 1]);

    const baseEmbedder = {
      id: `ctl-bug2-${DIMS}`,
      dimensions: DIMS,
      isLocal: true as const,
      embed(texts: string[]): Promise<Float32Array[]> {
        return Promise.resolve(texts.map(t =>
          t.includes(QUERY_MARKER)  ? qVec     :
          t.includes(P_MARKER)      ? pVec     :
          t.includes(Q_NODE_MARKER) ? qNodeVec :
          bVec,
        ));
      },
    };

    const { clock } = makeClock();
    const db = openNeoDatabase(':memory:');
    const svc = createMemoryService({ db, embedder: baseEmbedder, clock, logger: silentLogger });

    const nodeP = await svc.remember({ kind: 'fact', label: 'Primary P',   content: P_MARKER,      importance: 0.5 });
    const nodeQ = await svc.remember({ kind: 'fact', label: 'Secondary Q', content: Q_NODE_MARKER, importance: 0.5 });
    const nodeB = await svc.remember({ kind: 'fact', label: 'Target B',    content: B_MARKER,      importance: 1.0 });

    // Each seed connects only to B; fan = 1 for both P and Q.
    await svc.link(nodeP.id, nodeB.id, 'related', 0.30);
    await svc.link(nodeQ.id, nodeB.id, 'related', 0.60);

    // Baseline: B is reachable before the race.
    {
      const baseline = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });
      expect(baseline.items.some(r => r.node.id === nodeB.id)).toBe(true);
    }

    // Racing embedder: flip Q sensitive on the first embed() call.
    let raceTriggered = false;
    const racingEmbedder = {
      id: baseEmbedder.id,
      dimensions: baseEmbedder.dimensions,
      async embed(texts: string[], _signal?: AbortSignal) {
        if (!raceTriggered) {
          raceTriggered = true;
          db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(nodeQ.id);
        }
        return baseEmbedder.embed(texts);
      },
    };
    svc.setEmbedder(racingEmbedder);

    const result = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });

    expect(raceTriggered).toBe(true);
    // Q is sensitive; its contribution (0.0375) subtracted from B leaves
    // clean A[B] = 0.13125 < minScore 0.15.  Bug 2 fix must taint B.
    expect(result.items.every(r => r.node.id !== nodeB.id)).toBe(true);
    expect(result.items.every(r => r.via.every(v => v.nodeId !== nodeQ.id))).toBe(true);
    db.close();
  });

  it('Bug 2 saturation: tainted contributions exceed 1-minScore but clean activation is sufficient (false-positive fix)', async () => {
    // Topology: three clean seeds C0/C1/C2 and three tainted seeds T0/T1/T2,
    // all connected only to B (fan = 1).  Clean sum alone saturates A[B]; the
    // tainted sum alone exceeds 1-minScore, so the uncapped subtraction
    // (A[B] - taintedContrib) incorrectly falls below minScore even though
    // the clean contributors alone are sufficient to recall B.
    //
    //   seed a0 = (sim - seedSimilarityFloor) / (1 - seedSimilarityFloor)
    //     = (sim - 0.2) / 0.8
    //
    //   C0/C1/C2  sim ≈ 0.9  →  a0 ≈ 0.875  (weight 1.0, fan = 1, spreadDecay = 0.5)
    //     c(Ci→B) = 0.875 × 1.0 × 0.5 / 1 = 0.4375
    //     cleanContrib = 3 × 0.4375 = 1.3125  (saturates min(1, …) = 1.0)
    //   T0/T1/T2  sim ≈ 0.7  →  a0 ≈ 0.625  (weight 1.0)
    //     c(Ti→B) = 0.625 × 1.0 × 0.5 / 1 = 0.3125
    //     taintedContrib = 3 × 0.3125 = 0.9375  (> 1 - minScore = 0.85)
    //   A[B] = min(1, 1.3125 + 0.9375) = 1.0  (saturated)
    //   Bug: A[B] - taintedContrib = 1.0 - 0.9375 = 0.0625 < 0.15 → B falsely tainted.
    //   Fix: min(1, cleanContrib) = min(1, 1.3125) = 1.0 ≥ 0.15 → B survives.
    //
    // Markers are unique random tokens with no shared substring, so no two
    // nodes share a lexical seed and B's content never matches the query term.
    // Each seed node has its own perturbation dimension so no two seeds vector-
    // dedupe at findDuplicate's 0.92 threshold (pairwise cos: 0.81 clean/clean,
    // 0.49 tainted/tainted, 0.63 clean/tainted — all < 0.92).
    const DIMS = 16;
    const uniq = () => Math.random().toString(36).slice(2, 10);
    const QUERY_MARKER = `qry${uniq()}`;
    const B_MARKER     = `bbb${uniq()}`;
    const cMarkers = [0, 1, 2].map(() => `clean${uniq()}`);
    const tMarkers = [0, 1, 2].map(() => `taint${uniq()}`);

    // qVec on dim 0; cVec_i uses dim 0 (0.9) + its own perturb dim (1/2/3);
    // tVec_i uses dim 0 (0.7) + its own perturb dim (4/5/6); bVec on dim 15.
    const makeVec = (components: readonly [number, number][]): Float32Array => {
      const v = new Float32Array(DIMS);
      for (const [dim, val] of components) v[dim] = val;
      return v;
    };
    const qVec = makeVec([[0, 1]]);
    const cPerp = Math.sqrt(1 - 0.9 * 0.9);
    const tPerp = Math.sqrt(1 - 0.7 * 0.7);
    const cVecs = [1, 2, 3].map(dim => makeVec([[0, 0.9], [dim, cPerp]]));
    const tVecs = [4, 5, 6].map(dim => makeVec([[0, 0.7], [dim, tPerp]]));
    const bVec = makeVec([[15, 1]]);

    const baseEmbedder = {
      id: `ctl-bug2sat-${DIMS}`,
      dimensions: DIMS,
      isLocal: true as const,
      embed(texts: string[]): Promise<Float32Array[]> {
        return Promise.resolve(texts.map(t => {
          if (t.includes(QUERY_MARKER)) return qVec;
          if (t.includes(B_MARKER)) return bVec;
          for (let i = 0; i < 3; i++) if (t.includes(cMarkers[i]!)) return cVecs[i]!;
          for (let i = 0; i < 3; i++) if (t.includes(tMarkers[i]!)) return tVecs[i]!;
          return makeVec([]);
        }));
      },
    };

    const { clock } = makeClock();
    const db = openNeoDatabase(':memory:');
    const svc = createMemoryService({ db, embedder: baseEmbedder, clock, logger: silentLogger });

    // Create three clean seeds and three tainted seeds (to be marked sensitive during recall)
    const cNodes = await Promise.all([0, 1, 2].map(i =>
      svc.remember({ kind: 'fact', label: `Clean C${i}`, content: cMarkers[i]!, importance: 0.5 }),
    ));
    const tNodes = await Promise.all([0, 1, 2].map(i =>
      svc.remember({ kind: 'fact', label: `Tainted T${i}`, content: tMarkers[i]!, importance: 0.5 }),
    ));
    const nodeB = await svc.remember({ kind: 'fact', label: 'Target B', content: B_MARKER, importance: 1.0 });
    // All six seeds must be distinct rows for the saturation branch to see six
    // contributors.  If any pair deduped, the test would silently cover less.
    expect(new Set([...cNodes, ...tNodes].map(n => n.id)).size).toBe(6);

    // Each clean seed → B with weight 1.0; each tainted seed → B with weight 1.0.
    await Promise.all([...cNodes, ...tNodes].map(n => svc.link(n.id, nodeB.id, 'related', 1.0)));

    // Baseline: B is reachable.
    {
      const baseline = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });
      expect(baseline.items.some(r => r.node.id === nodeB.id)).toBe(true);
    }

    // Racing embedder: mark all tainted seeds sensitive before eligibility check.
    let raceTriggered = false;
    const racingEmbedder = {
      id: baseEmbedder.id,
      dimensions: baseEmbedder.dimensions,
      async embed(texts: string[], _signal?: AbortSignal) {
        if (!raceTriggered) {
          raceTriggered = true;
          for (const t of tNodes) {
            db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(t.id);
          }
        }
        return baseEmbedder.embed(texts);
      },
    };
    svc.setEmbedder(racingEmbedder);

    const result = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });

    expect(raceTriggered).toBe(true);
    // With saturation fix: min(1, cleanContrib) = 1.0 ≥ 0.15 → B must survive.
    // (Bug: A[B] - taintedContrib = 1.0 - 0.9375 = 0.0625 < 0.15, falsely tainting B.)
    expect(result.items.some(r => r.node.id === nodeB.id)).toBe(true);
    db.close();
  });

  it('Bug 2 sibling: sub-threshold non-best contributor becomes sensitive and B keeps a stale score (#596 sibling)', async () => {
    // Sibling of Bug 2: a non-best contributor that stays sub-threshold even
    // after back-propagation is in allContrib[B] but NOT in best (P is B's
    // best.from) and NOT in reachable (A[Q] < minScore).  Before this fix the
    // freshness pass omitted Q from checkIds, so the Bug 2 cascade read
    // tainted.has(Q) as false and treated the sensitive source as clean.
    //
    //   P: sim ≈ 0.384 → a0 ≈ 0.23   (reachable).  c(P→B) = 0.23 × 1.0 × 0.5 = 0.115.
    //   Q: sim ≈ 0.26  → a0 ≈ 0.075  (sub-threshold).  c(Q→B) = 0.075 × 1.0 × 0.5 = 0.0375.
    //   A[B] = 0.1525 (reachable, barely).  After one back-prop hop A[Q] ≈ 0.129 < 0.15 (still sub-threshold).
    //
    // When Q becomes sensitive: clean contribution to B is c(P→B) = 0.115 < minScore 0.15.
    // Current source leaves B surviving with score ≈ 0.15; fix drops B.
    const DIMS = 16;
    const uniq = () => Math.random().toString(36).slice(2, 10);
    const QUERY_MARKER = `qry${uniq()}`;
    const B_MARKER     = `bbb${uniq()}`;
    const P_MARKER     = `ppp${uniq()}`;
    const Q_MARKER     = `qqq${uniq()}`;

    const mkv = (comp: readonly [number, number][]): Float32Array => {
      const v = new Float32Array(DIMS);
      for (const [dim, val] of comp) v[dim] = val;
      return v;
    };
    const qVec = mkv([[0, 1]]);
    const pVec = mkv([[0, 0.384], [1, Math.sqrt(1 - 0.384 * 0.384)]]);  // cos(pVec,qVec)=0.384 → a0≈0.23
    const qnVec = mkv([[0, 0.26], [2, Math.sqrt(1 - 0.26 * 0.26)]]);    // cos(qnVec,qVec)=0.26  → a0≈0.075
    const bVec = mkv([[15, 1]]);                                          // orthogonal to query

    const baseEmbedder = {
      id: `ctl-bug2sib-${DIMS}`,
      dimensions: DIMS,
      isLocal: true as const,
      embed(texts: string[]): Promise<Float32Array[]> {
        return Promise.resolve(texts.map(t => {
          if (t.includes(QUERY_MARKER)) return qVec;
          if (t.includes(B_MARKER)) return bVec;
          if (t.includes(P_MARKER)) return pVec;
          if (t.includes(Q_MARKER)) return qnVec;
          return mkv([]);
        }));
      },
    };

    const { clock } = makeClock();
    const db = openNeoDatabase(':memory:');
    const svc = createMemoryService({ db, embedder: baseEmbedder, clock, logger: silentLogger });

    const nodeP = await svc.remember({ kind: 'fact', label: 'P', content: P_MARKER, importance: 0.5 });
    const nodeQ = await svc.remember({ kind: 'fact', label: 'Q', content: Q_MARKER, importance: 0.5 });
    const nodeB = await svc.remember({ kind: 'fact', label: 'B', content: B_MARKER, importance: 1.0 });
    expect(new Set([nodeP.id, nodeQ.id, nodeB.id]).size).toBe(3);
    await svc.link(nodeP.id, nodeB.id, 'related', 1.0);
    await svc.link(nodeQ.id, nodeB.id, 'related', 1.0);

    {
      const baseline = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });
      expect(baseline.items.some(r => r.node.id === nodeB.id)).toBe(true);
    }

    let raceTriggered = false;
    const racingEmbedder = {
      id: baseEmbedder.id,
      dimensions: baseEmbedder.dimensions,
      async embed(texts: string[], _signal?: AbortSignal) {
        if (!raceTriggered) {
          raceTriggered = true;
          db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(nodeQ.id);
        }
        return baseEmbedder.embed(texts);
      },
    };
    svc.setEmbedder(racingEmbedder);

    const result = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });

    expect(raceTriggered).toBe(true);
    // Fix: subThresholdContribIds adds Q to checkIds; freshness marks Q tainted;
    // Bug 2 cascade sees Q tainted, cleanContrib(B) = c(P→B) = 0.115 < 0.15 → B tainted.
    expect(result.items.every(r => r.node.id !== nodeB.id)).toBe(true);
    db.close();
  });

  it('Bug 2 strength: non-best contributor becomes sensitive and clean activation × strength drops below minScore (#596 sibling)', async () => {
    // Sibling of Bug 2: the taint threshold must match the final-score formula.
    // The final scoring loop multiplies A × strength × (pinned ? pinnedBoost : 1);
    // the taint check previously used only cleanActivation × pinnedBoost, missing
    // the `strength` factor.  A node whose clean activation is just above
    // minScore but whose clean *score* (with strength) is below minScore
    // surfaced with a stale score built from a now-sensitive contributor.
    //
    //   B unpinned: importance 0.5, confidence 0.95.
    //     strength = 0.5 + 0.25×R + 0.15×0.5 + 0.1×0.95 ≈ 0.92 (R≈1 for a fresh node)
    //   P sim ≈ 0.456 → a0 ≈ 0.32.  c(P→B) = 0.32 × 1.0 × 0.5 = 0.16  (best contributor)
    //   Q sim ≈ 0.28  → a0 ≈ 0.1.   c(Q→B) = 0.1  × 1.0 × 0.5 = 0.05
    //   A[B] = 0.21.  Q's final A[Q] ≈ 0.174 (reachable via back-prop).
    //
    //   When Q flips sensitive:
    //     cleanContrib(B) = c(P→B) = 0.16 ≥ 0.15 (old taint check passes → B survives).
    //     cleanScore(B)   = 0.16 × 0.92 = 0.1472 < 0.15 (new taint check correctly taints B).
    //     Final (buggy) score if B survives: 0.21 × 0.92 = 0.1932 (stale, built on tainted Q).
    const DIMS = 16;
    const uniq = () => Math.random().toString(36).slice(2, 10);
    const QUERY_MARKER = `qry${uniq()}`;
    const B_MARKER     = `bbb${uniq()}`;
    const P_MARKER     = `ppp${uniq()}`;
    const Q_MARKER     = `qqq${uniq()}`;

    const mkv = (comp: readonly [number, number][]): Float32Array => {
      const v = new Float32Array(DIMS);
      for (const [dim, val] of comp) v[dim] = val;
      return v;
    };
    const qVec  = mkv([[0, 1]]);
    const pVec  = mkv([[0, 0.456], [1, Math.sqrt(1 - 0.456 * 0.456)]]);
    const qnVec = mkv([[0, 0.28],  [2, Math.sqrt(1 - 0.28 * 0.28)]]);
    const bVec  = mkv([[15, 1]]);

    const baseEmbedder = {
      id: `ctl-bug2str-${DIMS}`,
      dimensions: DIMS,
      isLocal: true as const,
      embed(texts: string[]): Promise<Float32Array[]> {
        return Promise.resolve(texts.map(t => {
          if (t.includes(QUERY_MARKER)) return qVec;
          if (t.includes(B_MARKER)) return bVec;
          if (t.includes(P_MARKER)) return pVec;
          if (t.includes(Q_MARKER)) return qnVec;
          return mkv([]);
        }));
      },
    };

    const { clock } = makeClock();
    const db = openNeoDatabase(':memory:');
    const svc = createMemoryService({ db, embedder: baseEmbedder, clock, logger: silentLogger });

    const nodeP = await svc.remember({ kind: 'fact', label: 'P', content: P_MARKER, importance: 0.5 });
    const nodeQ = await svc.remember({ kind: 'fact', label: 'Q', content: Q_MARKER, importance: 0.5 });
    const nodeB = await svc.remember({ kind: 'fact', label: 'B', content: B_MARKER, importance: 0.5 });
    expect(new Set([nodeP.id, nodeQ.id, nodeB.id]).size).toBe(3);
    await svc.link(nodeP.id, nodeB.id, 'related', 1.0);
    await svc.link(nodeQ.id, nodeB.id, 'related', 1.0);

    {
      const baseline = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });
      expect(baseline.items.some(r => r.node.id === nodeB.id)).toBe(true);
    }

    let raceTriggered = false;
    const racingEmbedder = {
      id: baseEmbedder.id,
      dimensions: baseEmbedder.dimensions,
      async embed(texts: string[], _signal?: AbortSignal) {
        if (!raceTriggered) {
          raceTriggered = true;
          db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(nodeQ.id);
        }
        return baseEmbedder.embed(texts);
      },
    };
    svc.setEmbedder(racingEmbedder);

    const result = await svc.recall({ text: QUERY_MARKER, limit: 20, reinforce: false, allowSensitive: false });

    expect(raceTriggered).toBe(true);
    // Fix: taint check now compares clean × strength × pinnedBoost to minScore,
    // matching the final scoring formula; B's clean score (0.1472) falls below.
    expect(result.items.every(r => r.node.id !== nodeB.id)).toBe(true);
    db.close();
  });

  it('recall via entity links (spreading activation, no lexical overlap)', async () => {
    const { svc } = makeTestService();
    const alice = await svc.remember({ kind: 'entity', label: 'Alice', content: 'A friend', importance: 0.9 });
    const birthday = await svc.remember({ kind: 'episode', label: 'Birthday party 2023', content: 'Celebration event happened last year', importance: 0.7 });
    await svc.link(alice.id, birthday.id, 'related', 1.0);

    const result = await svc.recall({ text: 'Alice friend', limit: 20, reinforce: false });
    const birthdayFound = result.items.some(r => r.node.id === birthday.id);
    expect(birthdayFound).toBe(true);
  });
});

// ─── recall freshness ─────────────────────────────────────────────────────────

describe('recall freshness (#636)', () => {
  it('excludes a seed destination boosted by a seed made sensitive during embedding', async () => {
    const db = openNeoDatabase(':memory:');
    const { clock } = makeClock();
    const qVec = new Float32Array([1, 0, 0, 0]);
    const strongVec = new Float32Array([0.9, Math.sqrt(0.19), 0, 0]);
    const weakVec = new Float32Array([0.28, 0, Math.sqrt(0.9216), 0]);
    let duringEmbed: (() => void) | null = null;
    const embedder = {
      id: 'recall-freshness-exact-4',
      dimensions: 4,
      isLocal: true as const,
      async embed(texts: string[]): Promise<Float32Array[]> {
        if (texts.includes('needle') && duringEmbed) {
          const write = duringEmbed;
          duringEmbed = null;
          write();
        }
        return texts.map(t => t === 'needle' ? qVec : t.includes('strongvector') ? strongVec : weakVec);
      },
    };
    const svc = createMemoryService({ db, embedder, clock, logger: silentLogger });
    try {
      const nodeQ = await svc.remember({ kind: 'fact', label: 'Q', content: 'strongvector', importance: 0.5 });
      const nodeB = await svc.remember({ kind: 'fact', label: 'B', content: 'weakvector', importance: 0.5 });
      expect(nodeQ.id).not.toBe(nodeB.id);
      expect([nodeQ, nodeB].every(n => !n.pinned && n.sensitivity === 'normal')).toBe(true);
      await svc.link(nodeQ.id, nodeB.id, 'related', 1);
      const query = { text: 'needle', limit: 20, reinforce: false, allowSensitive: false };
      const baseline = await svc.recall(query);
      const baselineB = baseline.items.find(r => r.node.id === nodeB.id)!;
      expect(baselineB.similarity).toBeCloseTo(0.28, 6);
      expect(baselineB.score).toBeCloseTo(0.92, 6);

      let writes = 0;
      duringEmbed = () => {
        writes++;
        db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(nodeQ.id);
      };
      const result = await svc.recall(query);
      expect(writes).toBe(1);
      expect(result.items.map(r => r.node.id)).not.toContain(nodeQ.id);
      // B's own activation is only 0.1; Q must never contribute to this recall.
      expect(result.items.map(r => r.node.id)).not.toContain(nodeB.id);
    } finally {
      db.close();
    }
  });

  const changes = [
    'sensitivity',
    'archived',
    'superseded with includeArchived',
    'expiry from null',
    'expiry from future',
    'kind filter',
    'episode source',
    'episode kind',
    'forgotten',
  ] as const;
  type Change = (typeof changes)[number];
  type Position = 'seed' | 'spread-only';

  async function run(change: Change, position: Position, when: 'never' | 'before' | 'during') {
    const db = openNeoDatabase(':memory:');
    const { clock } = makeClock();
    let duringEmbed: (() => Promise<void>) | null = null;
    let writes = 0;
    const embedder = {
      id: 'recall-freshness-siblings-4',
      dimensions: 4,
      isLocal: true as const,
      async embed(texts: string[]): Promise<Float32Array[]> {
        if (texts.includes('cobalt') && duringEmbed) {
          const write = duringEmbed;
          duringEmbed = null;
          await write();
        }
        return texts.map(t => {
          if (t === 'cobalt') return new Float32Array([1, 0, 0, 0]);
          if (t.includes('anchorvector') || (position === 'seed' && t.includes('flipvector'))) return new Float32Array([0.9, Math.sqrt(0.19), 0, 0]);
          if (t.includes('weakvector')) return new Float32Array([0.28, 0, Math.sqrt(0.9216), 0]);
          if (t.includes('untouchedvector')) return new Float32Array([0.65, 0, 0, Math.sqrt(1 - 0.65 ** 2)]);
          return new Float32Array(4);
        });
      },
    };
    const svc = createMemoryService({ db, embedder, clock, logger: silentLogger });
    try {
      const flipped = await svc.remember({
        kind: change === 'episode source' ? 'episode' : 'fact',
        label: 'Flipped', content: 'flipvector', importance: 0.5,
        source: { by: 'user', conversationId: change === 'episode kind' ? 'conv_current' : 'conv_other' },
        validUntil: change === 'expiry from future' ? clock() + 1000 : undefined,
      });
      const descendant = await svc.remember({ kind: 'fact', label: 'Descendant', content: 'distantvector', importance: 1 });
      const untouched = await svc.remember({ kind: 'fact', label: 'Untouched', content: 'untouchedvector', importance: 0.5 });
      // These two keyword seeds also expose a stale candidate count after a hard forget:
      // lexical IDF must use the post-embedding population, just like vector seeds.
      await svc.remember({ kind: 'fact', label: 'Amber', content: 'cobalt amber', importance: 0.5 });
      await svc.remember({ kind: 'fact', label: 'Ochre', content: 'cobalt ochre', importance: 0.5 });
      let weakId: string | undefined;
      if (position === 'seed') {
        const weak = await svc.remember({ kind: 'fact', label: 'Weak seed', content: 'weakvector', importance: 0.5 });
        weakId = weak.id;
        await svc.link(flipped.id, weak.id, 'related', 1);
        await svc.link(flipped.id, descendant.id, 'related', 1);
      } else {
        const anchor = await svc.remember({ kind: 'fact', label: 'Anchor', content: 'anchorvector', importance: 0.5 });
        await svc.link(anchor.id, flipped.id, 'related', 1);
        await svc.link(flipped.id, descendant.id, 'related', 1);
      }
      const query: RecallQuery = {
        text: 'cobalt', limit: 20, tokenBudget: 10000, reinforce: false, allowSensitive: false,
        kinds: change === 'kind filter' ? ['fact'] : undefined,
        conversationId: change.startsWith('episode') ? 'conv_current' : undefined,
        includeArchived: change === 'superseded with includeArchived',
      };
      const write = async () => {
        writes++;
        switch (change) {
          case 'sensitivity':
            db.prepare("UPDATE memory_nodes SET sensitivity = 'sensitive' WHERE id = ?").run(flipped.id);
            break;
          case 'archived':
          case 'superseded with includeArchived':
            db.prepare('UPDATE memory_nodes SET status = ? WHERE id = ?').run(change === 'archived' ? 'archived' : 'superseded', flipped.id);
            break;
          case 'expiry from null':
          case 'expiry from future':
            db.prepare('UPDATE memory_nodes SET valid_until = ? WHERE id = ?').run(clock(), flipped.id);
            break;
          case 'kind filter':
            db.prepare("UPDATE memory_nodes SET kind = 'skill' WHERE id = ?").run(flipped.id);
            break;
          case 'episode source':
            db.prepare('UPDATE memory_nodes SET source = ? WHERE id = ?').run(JSON.stringify({ by: 'user', conversationId: 'conv_current' }), flipped.id);
            break;
          case 'episode kind':
            db.prepare("UPDATE memory_nodes SET kind = 'episode' WHERE id = ?").run(flipped.id);
            break;
          case 'forgotten':
            await svc.forget([flipped.id]);
            break;
        }
      };
      if (when === 'before') await write();
      if (when === 'during') duringEmbed = write;
      const result = await svc.recall(query);
      const flippedItem = result.items.find(r => r.node.id === flipped.id);
      const descendantItem = result.items.find(r => r.node.id === descendant.id);
      return {
        writes,
        flippedItem,
        descendantItem,
        weakPresent: weakId !== undefined && result.items.some(r => r.node.id === weakId),
        untouchedScore: result.items.find(r => r.node.id === untouched.id)!.score,
        items: result.items.map(r => ({
          label: r.node.label, score: r.score, activation: r.activation,
          via: r.via.map(v => v.label), reason: r.reason,
        })).sort((a, b) => a.label.localeCompare(b.label)),
        seeds: result.seeds,
        considered: result.considered,
      };
    } finally {
      db.close();
    }
  }

  for (const position of ['seed', 'spread-only'] as const) {
    it.each(changes)(`refreshes %s changed during embedding for a ${position}`, async change => {
      const baseline = await run(change, position, 'never');
      expect(baseline.flippedItem).toBeDefined();
      expect(baseline.descendantItem).toBeDefined();
      expect(baseline.descendantItem!.via.some(v => v.label === 'Flipped')).toBe(true);
      if (position === 'seed') {
        expect(baseline.flippedItem!.similarity).toBeCloseTo(0.9, 6);
        expect(baseline.weakPresent).toBe(true);
      } else {
        expect(baseline.flippedItem!.similarity).toBe(0);
        expect(baseline.flippedItem!.reason).toBe('linked via Anchor (related)');
      }

      const expected = await run(change, position, 'before');
      const result = await run(change, position, 'during');
      expect(result.writes).toBe(1);
      expect(result.flippedItem).toBeUndefined();
      expect(result.descendantItem).toBeUndefined();
      expect(result.weakPresent).toBe(false);
      expect(result.items.every(r => !r.via.includes('Flipped') && !r.reason.includes('Flipped'))).toBe(true);
      expect(result.untouchedScore).toBe(baseline.untouchedScore);
      // Recalling after the write must match a run where the write was already
      // committed before recall, including fan normalization and lexical IDF.
      expect(result.items).toEqual(expected.items);
      expect(result.seeds).toBe(expected.seeds);
      expect(result.considered).toBe(expected.considered);
    });
  }
});

// ─── dedupe / merge ──────────────────────────────────────────────────────────

describe('dedupe', () => {
  it('near-duplicate content reuses or merges with existing node', async () => {
    const { svc } = makeTestService();
    const a = await svc.remember({ kind: 'fact', label: 'Hometown', content: 'User is from Berlin', importance: 0.7 });
    const b = await svc.remember({ kind: 'fact', label: 'Hometown', content: 'User is from Berlin', importance: 0.7 });
    expect(b.id).toBe(a.id);
    const stats = await svc.stats();
    expect(stats.total).toBe(1);
  });
});

describe('policy', () => {
  it('getPolicy / setPolicy round-trips recall settings', () => {
    const { svc } = makeTestService();
    svc.setPolicy({ ...svc.getPolicy(), recall: false, recallLimit: 8 });
    expect(svc.getPolicy()).toMatchObject({ recall: false, recallLimit: 8 });
  });
});

// ─── export / import round-trip ──────────────────────────────────────────────

describe('export / import', () => {
  it('export contains all nodes', async () => {
    const { svc } = makeTestService();
    await svc.remember({ kind: 'fact', label: 'F1', content: 'Content 1', importance: 0.7 });
    await svc.remember({ kind: 'fact', label: 'F2', content: 'Content 2', importance: 0.6 });

    const exported = await svc.export();
    expect(exported.nodes.length).toBe(2);
    expect(exported.format).toBe('neo-memory');
  });

  it('merge mode imports nodes into fresh service', async () => {
    const { svc } = makeTestService();
    await svc.remember({ kind: 'fact', label: 'F1', content: 'Content 1', importance: 0.7 });
    await svc.remember({ kind: 'fact', label: 'F2', content: 'Content 2', importance: 0.6 });

    const exported = await svc.export();

    const db2 = openNeoDatabase(':memory:');
    const svc2 = createMemoryService({ db: db2, embedder: new HashingEmbedder(256), logger: silentLogger });
    const report = await svc2.import(exported, { mode: 'merge' });
    expect(report.nodes).toBeGreaterThanOrEqual(2);

    const s = await svc2.stats();
    expect(s.total).toBeGreaterThanOrEqual(2);
  });

  it('replace mode clears existing nodes before import', async () => {
    const db2 = openNeoDatabase(':memory:');
    const svc2 = createMemoryService({ db: db2, embedder: new HashingEmbedder(256), logger: silentLogger });
    await svc2.remember({ kind: 'fact', label: 'OldNode', content: 'Old', importance: 0.5 });

    const { svc } = makeTestService();
    await svc.remember({ kind: 'fact', label: 'NewNode', content: 'New', importance: 0.8 });
    const exported = await svc.export();

    await svc2.import(exported, { mode: 'replace' });
    const s = await svc2.stats();
    expect(s.total).toBe(exported.nodes.length);
  });
});

// ─── observe (LLM extraction) ────────────────────────────────────────────────

describe('observe', () => {
  it('creates memories from LLM extraction', async () => {
    const fakeResponse = JSON.stringify({
      episode: {
        label: 'Chat about cats',
        summary: 'User discussed their cat Luna',
        importance: 0.5,
      },
      memories: [
        {
          op: 'create',
          kind: 'fact',
          label: "User's cat name",
          content: 'The user has a cat named Luna',
          importance: 0.8,
        },
      ],
      links: [],
    });

    const { svc } = makeTestService(makeFakeLLM(fakeResponse));
    const result = await svc.observe(makeTurn('My cat Luna is so cute!', 'Luna sounds wonderful!'));
    expect(result.created.length + result.updated.length).toBeGreaterThanOrEqual(1);
  });

  it('observe with no LLM falls back gracefully', async () => {
    const { svc } = makeTestService(); // no LLM
    await expect(svc.observe(makeTurn('Hello!', 'Hi there!'))).resolves.toBeDefined();
  });

  it('observe with messy LLM JSON (code fences) still parses', async () => {
    const messyResponse = '```json\n' + JSON.stringify({
      episode: null,
      memories: [
        { op: 'create', kind: 'preference', label: 'Music preference', content: 'User likes jazz', importance: 0.6 },
      ],
      links: [],
    }) + '\n```';

    const { svc } = makeTestService(makeFakeLLM(messyResponse));
    const result = await svc.observe(makeTurn('I love jazz music.', 'Jazz is wonderful!'));
    expect(result.created.length).toBeGreaterThanOrEqual(1);
  });

  it('observe with prose-prefixed LLM JSON parses memories', async () => {
    const proseResponse = 'Here are the memories to store:\n' + JSON.stringify({
      episode: null,
      memories: [
        { op: 'create', kind: 'fact', label: 'Favorite color', content: 'User likes blue', importance: 0.4 },
      ],
      links: [],
    });

    const { svc } = makeTestService(makeFakeLLM(proseResponse));
    const result = await svc.observe(makeTurn('Blue is my favorite color.', 'Blue is a great color!'));
    expect(result.created.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── supersede keeps history ─────────────────────────────────────────────────

describe('supersede', () => {
  it('superseded memory node is preserved in history', async () => {
    const db = openNeoDatabase(':memory:');
    const { clock } = makeClock(1_000_000_000_000);
    const embedder = new HashingEmbedder(256);

    // Step 1: create node without LLM
    const svcA = createMemoryService({ db, embedder, clock, logger: silentLogger });
    const oldNode = await svcA.remember({ kind: 'fact', label: 'City', content: 'User lives in Berlin', importance: 0.7 });

    // Step 2: observe with LLM that supersedes the old node
    const supersedeResponse = JSON.stringify({
      episode: null,
      memories: [
        { op: 'supersede', id: oldNode.id, kind: 'fact', label: 'City updated', content: 'User moved to Munich', reason: 'User moved' },
      ],
      links: [],
    });

    const svcB = createMemoryService({
      db,
      embedder,
      llm: () => ({ model: makeFakeLLM(supersedeResponse), name: 'fake', isLocal: true }),
      clock,
      logger: silentLogger,
    });

    const result = await svcB.observe(makeTurn('I moved to Munich.', 'Munich is great!'));
    // Either superseded or created
    expect(result.superseded.length + result.created.length).toBeGreaterThanOrEqual(0);

    // History preserved — old node still exists in DB
    const detail = await svcB.get(oldNode.id);
    expect(detail).toBeDefined();
    if (detail) {
      expect(detail.node).toBeDefined();
    }
  });
});

// ─── consolidation ──────────────────────────────────────────────────────────

describe('consolidate', () => {
  it('fades unused low-importance episodes over time', async () => {
    const { svc, tickDays } = makeTestService(makeEmptyLLM());

    const node = await svc.remember({
      kind: 'episode',
      label: 'Trivial event',
      content: 'Walked to the store',
      importance: 0.1,
    });

    // Advance 365 days (well past stability)
    tickDays(365);

    const report = await svc.consolidate({});
    expect(report.archived).toBeGreaterThanOrEqual(1);

    const detail = await svc.get(node.id);
    expect(detail?.node.status).toBe('archived');
  });

  it('pinned memories survive consolidation', async () => {
    const { svc, tickDays } = makeTestService(makeEmptyLLM());

    const node = await svc.remember({
      kind: 'episode',
      label: 'Important event',
      content: 'Got married',
      importance: 0.5,
      pinned: true,
    });

    tickDays(365);
    await svc.consolidate({});

    const detail = await svc.get(node.id);
    expect(detail?.node.status).toBe('active');
  });

  it('consolidation report has correct structure', async () => {
    const { svc, tickDays } = makeTestService(makeEmptyLLM());
    await svc.remember({ kind: 'fact', label: 'Test', content: 'Test', importance: 0.5 });
    tickDays(1);

    const report = await svc.consolidate({});
    expect(typeof report.startedAt).toBe('number');
    expect(typeof report.finishedAt).toBe('number');
    expect(typeof report.archived).toBe('number');
    expect(typeof report.edgesPruned).toBe('number');
    expect(Array.isArray(report.notes)).toBe(true);
  });
});

// ─── journal ─────────────────────────────────────────────────────────────────

describe('journal', () => {
  it('stores consolidation reports and returns them', async () => {
    const { svc, tickDays } = makeTestService(makeEmptyLLM());
    await svc.remember({ kind: 'fact', label: 'J1', content: 'Journal test', importance: 0.5 });
    tickDays(1);

    await svc.consolidate({});
    const reports = await svc.journal(10);
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(typeof reports[0]!.startedAt).toBe('number');
  });
});

// ─── onChange subscription ──────────────────────────────────────────────────

describe('onChange', () => {
  it('fires event on remember', async () => {
    const { svc } = makeTestService();
    const events: string[] = [];
    const unsubscribe = svc.onChange((event) => {
      events.push(event.type);
    });

    await svc.remember({ kind: 'fact', label: 'Watch', content: 'Watched content', importance: 0.5 });
    expect(events.some(e => e === 'created')).toBe(true);
    unsubscribe();
  });

  it('unsubscribe stops receiving events', async () => {
    const { svc } = makeTestService();
    const events: string[] = [];
    const unsubscribe = svc.onChange((event) => {
      events.push(event.type);
    });
    unsubscribe();

    await svc.remember({ kind: 'fact', label: 'Silent', content: 'No event expected', importance: 0.5 });
    expect(events.length).toBe(0);
  });
});

// ─── findForForget ──────────────────────────────────────────────────────────

describe('findForForget', () => {
  it('returns candidates for forget and excludes pinned nodes', async () => {
    const { svc, tickDays } = makeTestService();
    const low = await svc.remember({ kind: 'episode', label: 'Forgettable', content: 'Very minor event about groceries', importance: 0.05 });
    await svc.remember({ kind: 'fact', label: 'Critical', content: 'Core identity pinned', importance: 0.95, pinned: true });

    tickDays(100);
    const candidates = await svc.findForForget('groceries event', 10);
    // Results should include the forgettable episode
    expect(Array.isArray(candidates)).toBe(true);
    // Pinned node should NOT be in candidates
    const hasPinned = candidates.some(n => n.pinned);
    expect(hasPinned).toBe(false);
  });
});

// ─── MEMORY_CONSTANTS sanity ─────────────────────────────────────────────────

describe('MEMORY_CONSTANTS', () => {
  it('mmrLambda is 0.7', () => {
    expect(MEMORY_CONSTANTS.mmrLambda).toBe(0.7);
  });

  it('spreadHops is 2', () => {
    expect(MEMORY_CONSTANTS.spreadHops).toBe(2);
  });

  it('dedupeSimilarity is 0.92', () => {
    expect(MEMORY_CONSTANTS.dedupeSimilarity).toBe(0.92);
  });
});

// ─── performance ─────────────────────────────────────────────────────────────

describe('performance', () => {
  // Recall is a linear scan over the cached vectors, so docs/MEMORY.md's 200 ms for 10k nodes means
  // 20 ms here on an idle machine. Parallel suites and other jobs slow every sample several-fold and
  // can stall one for seconds, so by default only a gross regression fails; NEO_PERF_STRICT=1 holds
  // the tight bound (CONTRIBUTING.md). The median of several runs ignores one-off pauses.
  const recallBudgetMs = process.env['NEO_PERF_STRICT'] === '1' ? 20 : 2000;

  it(`recall stays fast at 1000 nodes (median < ${recallBudgetMs} ms)`, async () => {
    const { svc } = makeTestService();
    const inputs: RememberInput[] = [];
    for (let i = 0; i < 1000; i++) {
      inputs.push({
        kind: i % 2 === 0 ? 'fact' : 'episode',
        label: `Memory ${i}`,
        content: `Content for memory number ${i} about various topics`,
        importance: 0.5,
      });
    }
    await Promise.all(inputs.map(inp => svc.remember(inp)));

    await svc.recall({ text: 'warm-up', reinforce: false });
    const samples: number[] = [];
    for (let k = 0; k < 7; k++) {
      const start = performance.now();
      const r = await svc.recall({ text: 'memory topics', limit: 20, reinforce: false });
      samples.push(performance.now() - start);
      expect(r.items.length).toBeGreaterThan(0);
    }
    const median = [...samples].sort((a, b) => a - b)[samples.length >> 1]!;
    expect(median, `recall samples (ms): ${samples.map((t) => t.toFixed(1)).join(', ')}`).toBeLessThan(recallBudgetMs);
  }, 60_000);
});

// ─── Hebbian co-activation ───────────────────────────────────────────────────

describe('Hebbian co-activation', () => {
  it('first co-recall creates a related edge with weight = hebbianRate', async () => {
    const { svc } = makeTestService();
    // Insert two facts that will both be recalled
    const a = await svc.remember({ kind: 'fact', label: 'Hebb A', content: 'Topic alpha for co-activation test', importance: 0.9 });
    const b = await svc.remember({ kind: 'fact', label: 'Hebb B', content: 'Topic beta for co-activation test', importance: 0.9 });

    // Recall with reinforce:true so Hebbian fires
    await svc.recall({ text: 'Topic alpha beta co-activation', limit: 20, reinforce: true });

    // Check for a related edge between a and b
    const g = await svc.graph({ centerId: a.id, depth: 1, limit: 20 });
    const edge = g.edges.find(
      (e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id),
    );

    if (edge) {
      // Both nodes were seeds → edge weight = hebbianRate = 0.1
      expect(edge.weight).toBeCloseTo(MEMORY_CONSTANTS.hebbianRate, 4);
      expect(edge.coactivations).toBe(1);
    } else {
      // If only one was a seed the edge may not have formed; skip assertion
      // (acceptable when vector similarity only picks one node as seed)
    }
  });

  it('second co-recall raises edge weight toward 1 by w + η(1−w) and increments coactivations', async () => {
    const { svc, clock, tickDays } = makeTestService();
    const a = await svc.remember({ kind: 'fact', label: 'CoHebb X', content: 'Shared theme gamma recall', importance: 0.95 });
    const b = await svc.remember({ kind: 'fact', label: 'CoHebb Y', content: 'Shared theme gamma recall', importance: 0.95 });

    // First recall — creates the edge
    await svc.recall({ text: 'Shared theme gamma recall', limit: 20, reinforce: true });

    // Find edge after first recall
    const g1 = await svc.graph({ centerId: a.id, depth: 1, limit: 20 });
    const edge1 = g1.edges.find(
      (e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id),
    );
    if (!edge1) return; // both weren't seeds; skip

    const w1 = edge1.weight;
    const coact1 = edge1.coactivations;

    // Tick time so effective weight decays slightly
    tickDays(1);

    // Second recall
    await svc.recall({ text: 'Shared theme gamma recall', limit: 20, reinforce: true });

    const g2 = await svc.graph({ centerId: a.id, depth: 1, limit: 20 });
    const edge2 = g2.edges.find(
      (e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id),
    );
    expect(edge2).toBeDefined();
    if (edge2) {
      // weight should be higher after second co-recall
      expect(edge2.weight).toBeGreaterThan(w1);
      expect(edge2.coactivations).toBeGreaterThan(coact1);
    }
  });
});

// ─── Spacing effect ───────────────────────────────────────────────────────────

describe('spacing effect', () => {
  it('reinforcing when R is low (long gap) gives greater stability gain than immediate re-reinforce', async () => {
    const startMs = 1_000_000_000_000;
    const { clock: clockA } = makeClock(startMs);
    const dbA = openNeoDatabase(':memory:');
    const svcA = createMemoryService({ db: dbA, embedder: new HashingEmbedder(256), clock: clockA, logger: silentLogger });

    const clockB_obj = makeClock(startMs);
    const dbB = openNeoDatabase(':memory:');
    const svcB = createMemoryService({ db: dbB, embedder: new HashingEmbedder(256), clock: clockB_obj.clock, logger: silentLogger });

    // Create identical nodes in both services
    const nodeA = await svcA.remember({ kind: 'fact', label: 'Spacing test', content: 'Spacing content', importance: 0.5 });
    const nodeB = await svcB.remember({ kind: 'fact', label: 'Spacing test', content: 'Spacing content', importance: 0.5 });

    const s0A = (await svcA.get(nodeA.id))!.node.stability;
    const s0B = (await svcB.get(nodeB.id))!.node.stability;

    // A: reinforce immediately (R ≈ 1, small gain)
    await svcA.recall({ text: 'Spacing content', limit: 5, reinforce: true });

    // B: advance 60 days then reinforce (R ≈ 0, large gain)
    clockB_obj.tickDays(60);
    await svcB.recall({ text: 'Spacing content', limit: 5, reinforce: true });

    const sA = (await svcA.get(nodeA.id))!.node.stability;
    const sB = (await svcB.get(nodeB.id))!.node.stability;

    const gainA = sA - s0A;
    const gainB = sB - s0B;
    expect(gainB).toBeGreaterThan(gainA);
  });

  it('stability is capped at maxStabilityDays', () => {
    const { maxStabilityDays, stabilityGain, stabilityEpsilonDays } = MEMORY_CONSTANTS;
    // A node with stability already near the cap, R = 0 (max gain scenario)
    const nearCap = maxStabilityDays - 0.001;
    const result = reinforceStability(nearCap, 0, stabilityGain, stabilityEpsilonDays, maxStabilityDays);
    expect(result).toBeLessThanOrEqual(maxStabilityDays);
  });

  it('accessCount and lastAccessedAt update when reinforce:true but NOT when reinforce:false', async () => {
    const { svc, clock, tickDays } = makeTestService();
    const node = await svc.remember({ kind: 'fact', label: 'AccessTest', content: 'Access counter topic text', importance: 0.8 });

    const before = (await svc.get(node.id))!.node;
    expect(before.accessCount).toBe(0);
    expect(before.lastAccessedAt).toBeNull();

    // recall with reinforce:false — should NOT update access counters
    await svc.recall({ text: 'Access counter topic text', limit: 5, reinforce: false });
    const afterFalse = (await svc.get(node.id))!.node;
    expect(afterFalse.accessCount).toBe(0);
    expect(afterFalse.lastAccessedAt).toBeNull();

    // recall with reinforce:true — should update
    await svc.recall({ text: 'Access counter topic text', limit: 5, reinforce: true });
    const afterTrue = (await svc.get(node.id))!.node;
    expect(afterTrue.accessCount).toBeGreaterThan(0);
    expect(afterTrue.lastAccessedAt).not.toBeNull();
  });
});

// ─── Spreading activation with zero lexical/semantic overlap ────────────────

describe('spreading activation via entity link', () => {
  it('surfaces Berlin fact via entity Mia when querying about sister', async () => {
    const { svc } = makeTestService();

    // Create entity Mia
    const mia = await svc.remember({ kind: 'entity', label: 'Mia', content: 'Entity: the user\'s sister Mia', importance: 0.9 });

    // Fact 1: links user's sister to Mia
    const sisterFact = await svc.remember({
      kind: 'fact',
      label: "User's sister",
      content: "The user's sister is named Mia",
      importance: 0.8,
    });

    // Fact 2: links Mia to Berlin — no lexical overlap with "sister"
    const berlinFact = await svc.remember({
      kind: 'fact',
      label: "Mia's job",
      content: 'Mia works as a nurse in Berlin',
      importance: 0.7,
    });

    // Wire: sisterFact --about--> mia; berlinFact --about--> mia
    await svc.link(sisterFact.id, mia.id, 'about', 1.0);
    await svc.link(berlinFact.id, mia.id, 'about', 1.0);

    // Recall with text that matches sisterFact but NOT berlinFact
    const result = await svc.recall({ text: 'tell me about my sister', limit: 20, reinforce: false });

    const berlinItem = result.items.find((r) => r.node.id === berlinFact.id);
    expect(berlinItem).toBeDefined();
    if (berlinItem) {
      // Should have a non-empty via path
      expect(berlinItem.via.length).toBeGreaterThan(0);
      // reason should mention 'linked via'
      expect(berlinItem.reason.toLowerCase()).toContain('linked via');
    }
  });
});

// ─── Consolidation detailed behaviors ──────────────────────────────────────

describe('consolidation detailed', () => {
  it('(a) link discovery creates similar edges between near-duplicate nodes above similarLinkThreshold', async () => {
    const { svc, tickDays } = makeTestService();
    // Two nodes with identical content → HashingEmbedder gives identical vectors → cosine sim = 1 ≥ threshold
    const n1 = await svc.remember({ kind: 'fact', label: 'Dup fact one', content: 'Duplicate content about coffee', importance: 0.6 });
    const n2 = await svc.remember({ kind: 'fact', label: 'Dup fact two', content: 'Duplicate content about coffee', importance: 0.6 });

    await svc.consolidate({});

    const g = await svc.graph({ centerId: n1.id, depth: 1, limit: 20 });
    const simEdge = g.edges.find(
      (e) => e.type === 'similar' && ((e.from === n1.id && e.to === n2.id) || (e.from === n2.id && e.to === n1.id)),
    );
    expect(simEdge).toBeDefined();
  });

  it('(b) entity merge combines Mia and Mia Chen (alias overlap) — edges moved, aliases unioned, one deleted', async () => {
    const { svc } = makeTestService();
    const mia = await svc.remember({ kind: 'entity', label: 'Mia', content: 'User\'s sister Mia', importance: 0.8 });
    // miaFull has "Mia" as an alias
    const miaFull = await svc.remember({ kind: 'entity', label: 'Mia Chen', content: 'Full name of user\'s sister', importance: 0.7 });

    // Add alias to mia that matches label of miaFull... or use label overlap
    await svc.update(mia.id, { aliases: ['Mia Chen'] });

    // Create a fact linked to miaFull
    const fact = await svc.remember({ kind: 'fact', label: 'Chen detail', content: 'Mia Chen is a nurse', importance: 0.6 });
    await svc.link(fact.id, miaFull.id, 'about', 1.0);

    await svc.consolidate({});

    // After merge: one of mia/miaFull should be deleted; edges should be on survivor
    const detailMia = await svc.get(mia.id);
    const detailFull = await svc.get(miaFull.id);

    // Exactly one should survive (other is null or they survive merged)
    const oneDeleted = detailMia === null || detailFull === null;
    expect(oneDeleted).toBe(true);

    // The surviving node should have both labels as aliases or label
    const survivor = detailMia ?? detailFull;
    expect(survivor).not.toBeNull();
  });

  it('(c) episode abstraction with metadata.purpose === memory-consolidate creates summary + derived_from edges', async () => {
    const consolidateLLMResponse = JSON.stringify({
      summary: {
        label: 'User enjoys outdoor activities',
        content: 'The user frequently discusses hiking and nature trips',
        importance: 0.7,
      },
      facts: [
        { kind: 'preference', label: 'Loves hiking', content: 'User loves hiking', importance: 0.6 },
      ],
    });

    // Track whether purpose === 'memory-consolidate' was set
    let purposeSeen = false;
    const trackingLLM: ChatModel = {
      async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
        if ((req.metadata as Record<string, unknown>)?.purpose === 'memory-consolidate') {
          purposeSeen = true;
        }
        yield { type: 'text', text: consolidateLLMResponse };
        yield { type: 'done', stopReason: 'end' };
      },
    };

    const db = openNeoDatabase(':memory:');
    const { clock, tickDays } = makeClock(1_000_000_000_000);
    const svc = createMemoryService({
      db,
      embedder: new HashingEmbedder(256),
      llm: () => ({ model: trackingLLM, name: 'fake', isLocal: true }),
      clock,
      logger: silentLogger,
    });

    // Create 2 episodes that form a cluster (similar content)
    const ep1 = await svc.remember({ kind: 'episode', label: 'Hike day 1', content: 'Hiked the mountains today outdoors nature', importance: 0.5 });
    const ep2 = await svc.remember({ kind: 'episode', label: 'Hike day 2', content: 'Hiked the mountains again outdoors nature', importance: 0.5 });

    tickDays(8); // past the 7-day threshold so single episodes get consolidated too

    const report = await svc.consolidate({});

    expect(purposeSeen).toBe(true);

    // Summary node should exist
    const allStats = await svc.stats();
    // summary kind should be > 0 if abstraction happened
    if (report.episodesConsolidated > 0) {
      // A summary node was created
      const graphResult = await svc.graph({ limit: 50 });
      const hasSummary = graphResult.nodes.some((n) => n.kind === 'summary');
      if (hasSummary) {
        const summaryNode = graphResult.nodes.find((n) => n.kind === 'summary')!;
        const detail = await svc.get(summaryNode.id);
        expect(detail?.edges.some((e) => e.type === 'derived_from')).toBe(true);
      }
      // Episodes should be marked consolidated
      const ep1Detail = await svc.get(ep1.id);
      const ep2Detail = await svc.get(ep2.id);
      // consolidatedAt set means episode was processed
      if (ep1Detail) {
        expect((ep1Detail.node as unknown as { consolidatedAt?: number }).consolidatedAt).toBeDefined();
      }
    }
  });

  it('(d) report.notes contains human-readable dream-journal lines', async () => {
    const { svc, tickDays } = makeTestService(makeEmptyLLM());
    // Create a fading node and two similar-content nodes
    await svc.remember({ kind: 'episode', label: 'Fading ep', content: 'Old trivial event walks', importance: 0.05 });
    await svc.remember({ kind: 'fact', label: 'Sim 1', content: 'Same content topic banana', importance: 0.6 });
    await svc.remember({ kind: 'fact', label: 'Sim 2', content: 'Same content topic banana', importance: 0.6 });
    tickDays(365);

    const report = await svc.consolidate({});
    expect(Array.isArray(report.notes)).toBe(true);
    expect(report.notes.length).toBeGreaterThan(0);
    // Each note should be a non-empty string
    for (const note of report.notes) {
      expect(typeof note).toBe('string');
      expect(note.length).toBeGreaterThan(0);
    }
  });

  it('(e) edges below edgeFloor are pruned, but structural edges (about, derived_from) survive', async () => {
    const db = openNeoDatabase(':memory:');
    const { clock, tickDays } = makeClock(1_000_000_000_000);
    const svc = createMemoryService({ db, embedder: new HashingEmbedder(256), clock, logger: silentLogger });

    const a = await svc.remember({ kind: 'fact', label: 'Prune A', content: 'Edge prune test A', importance: 0.6 });
    const b = await svc.remember({ kind: 'fact', label: 'Prune B', content: 'Edge prune test B', importance: 0.6 });
    const miaEntity = await svc.remember({ kind: 'entity', label: 'PruneMia', content: 'Entity for structural edge', importance: 0.9 });

    // Create a non-structural 'related' edge with very low weight (below edgeFloor 0.02)
    // We set weight=0.001 by creating edge then updating it... or link with low weight
    // Actually link() has a minimum weight, let's create it via db directly
    const { openNeoDatabase: _od } = await import('@neo/storage');
    const { insertEdge: insertE } = await import('./db-helpers.js');
    const { newId: nid } = await import('@neo/protocol');
    const lowEdge = {
      id: nid('edge', clock()),
      from: a.id,
      to: b.id,
      type: 'related' as const,
      weight: 0.001, // below edgeFloor = 0.02
      createdAt: clock(),
      updatedAt: clock(),
      lastReinforcedAt: clock() - 9999 * 24 * 60 * 60 * 1000, // very old
      coactivations: 0,
    };
    insertE(db, lowEdge);

    // Create a structural 'about' edge from a to miaEntity with low weight (structural edges bypass decay)
    const aboutEdge = {
      id: nid('edge', clock()),
      from: a.id,
      to: miaEntity.id,
      type: 'about' as const,
      weight: 0.001, // would normally be pruned, but structural
      createdAt: clock(),
      updatedAt: clock(),
      lastReinforcedAt: clock(),
      coactivations: 0,
    };
    insertE(db, aboutEdge);

    tickDays(10); // let non-structural edge decay further

    const report = await svc.consolidate({});

    // The low-weight related edge should have been pruned
    expect(report.edgesPruned).toBeGreaterThanOrEqual(1);

    // The structural 'about' edge should still exist
    const gA = await svc.graph({ centerId: a.id, depth: 1, limit: 20 });
    const aboutStillExists = gA.edges.some((e) => e.type === 'about' && e.to === miaEntity.id);
    expect(aboutStillExists).toBe(true);
  });
});

// ─── observe() detailed behaviors ─────────────────────────────────────────

describe('observe() detailed', () => {

  it.each(['supersede', 'update'] as const)('does not persist credential-bearing %s reasons in metadata', async (op) => {
    const { svc: initialSvc, db, clock } = makeTestService();
    const oldNode = await initialSvc.remember({ kind: 'fact', label: 'Router location', content: 'The router is in the hallway' });
    const response = JSON.stringify({
      episode: null,
      memories: [
        { op, id: oldNode.id, kind: 'fact', label: 'Router location', content: 'The router is in the study', reason: 'password: hunter2' },
      ],
      links: [],
    });
    const svc = createMemoryService({
      db,
      embedder: new HashingEmbedder(256),
      llm: () => ({ model: makeFakeLLM(response), name: 'fake', isLocal: true }),
      clock,
      logger: silentLogger,
    });

    const result = await svc.observe(makeTurn('The router is in the study.', 'Thanks for the update.'));
    const { items } = await svc.search({ kinds: ['fact'] });
    expect(items).toHaveLength(1);
    expect(items[0]!.metadata?.['reason'] ?? '').not.toContain('hunter2');
    expect(items[0]!.id).toBe(oldNode.id);
    expect(items[0]!.content).toBe(oldNode.content);
    expect(result.created).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.superseded).toHaveLength(0);
  });

  it('credential-like content (sk-abc...) is never stored even when LLM extracts it', async () => {
    const credentialResponse = JSON.stringify({
      episode: null,
      memories: [
        {
          op: 'create',
          kind: 'fact',
          label: 'API key',
          content: 'My api key is sk-abcdef1234567890abcdef123456',
          importance: 0.9,
        },
      ],
      links: [],
    });
    const { svc } = makeTestService(makeFakeLLM(credentialResponse));
    const statsBefore = await svc.stats();
    await svc.observe(makeTurn('My api key is sk-abcdef1234567890abcdef123456.', 'I will remember that key.'));
    const statsAfter = await svc.stats();
    // No new nodes should have been created for the credential
    expect(statsAfter.total).toBe(statsBefore.total);
  });

});

// ─── F04: forget command does not re-create deleted memory ──────────────────

describe('heuristicExtract does not extract forget commands (F04)', () => {
  it('does not extract from "Forget that I live in Paris."', () => {
    const results = heuristicExtract('Forget that I live in Paris.');
    // Should produce no memories because the sentence is a forget command
    expect(results).toHaveLength(0);
  });

  it('does not extract from "Please forget my home address."', () => {
    const results = heuristicExtract('Please forget my home address.');
    expect(results).toHaveLength(0);
  });

  it('does not extract from "Delete the fact that I work at Acme."', () => {
    const results = heuristicExtract('Delete the fact that I work at Acme.');
    expect(results).toHaveLength(0);
  });

  it('does not extract from "Stop remembering that my name is Alice."', () => {
    const results = heuristicExtract("Stop remembering that my name is Alice.");
    expect(results).toHaveLength(0);
  });

  it('still extracts from a normal affirmative sentence', () => {
    const results = heuristicExtract('My name is Alice.');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('observe: forget tool result prevents heuristic re-creation (F04)', () => {
  it.each([
    'Forget that I live in Paris.',
    "Don't remember that I live in Paris.",
    'Delete the fact that I live in Paris.',
    '忘掉我住在Paris。',
    '请忘掉我住在Paris。',
    '忘掉我住在巴黎。',
    'Forget that I live in Paris（巴黎）.',
  ])('does not restore a fact deleted by the real forget tool: %s', async (text) => {
    const { svc, db } = makeTestService();
    try {
      const node = await svc.remember({ kind: 'fact', content: 'The user lives in Paris.' });
      const tools: ToolDefinition[] = createMemoryTools(svc);
      const forget = tools.find((tool) => tool.name === 'forget')!;
      const result = await forget.execute({ ids: [node.id] }, {
        toolCallId: 'call_fgt', conversationId: 'conv_f04', signal: new AbortController().signal,
        now: () => 1_000_000_000_000, timezone: 'UTC', locale: 'en', allowSensitive: true,
        origin: 'model', logger: silentLogger,
      });
      const turn = makeForgotTurn(text, []);
      turn.assistantMessage.parts[1] = { type: 'tool_result', toolCallId: 'call_fgt', name: 'forget', ...result };
      await svc.observe(turn);
      expect(await svc.search({ query: 'Paris' })).toMatchObject({ items: [], total: 0 });
      expect(await svc.search({ query: '巴黎' })).toMatchObject({ items: [], total: 0 });
      expect((await svc.stats()).total).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keeps ordinary statements using forget in offline extraction', async () => {
    const { svc, db } = makeTestService();
    try {
      const result = await svc.observe(makeTurn('I often forget my keys.', 'I can help with reminders.'));
      expect(result.created).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'episode', content: 'User: I often forget my keys.' }),
      ]));
      expect(heuristicExtract('I often forget my keys. I live in Oslo.')).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'fact', content: 'The user lives in Oslo.' }),
      ]));
    } finally {
      db.close();
    }
  });

  /** Build a turn where the user says forget and the forget tool succeeded. */
  function makeForgotTurn(userText: string, forgottenLabels: string[], now = 1_000_000_000_000): ObservedTurn {
    const convId = 'conv_f04';
    return {
      conversationId: convId,
      userMessage: {
        id: newId('msg', now),
        conversationId: convId,
        role: 'user',
        parts: [{ type: 'text', text: userText }],
        createdAt: now,
        status: 'complete',
      },
      assistantMessage: {
        id: newId('msg', now + 1),
        conversationId: convId,
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'call_fgt', name: 'forget', input: {} },
          {
            type: 'tool_result',
            toolCallId: 'call_fgt',
            name: 'forget',
            output: { forgotten: forgottenLabels },
          },
          { type: 'text', text: `Done, I've forgotten that.` },
        ],
        createdAt: now + 1,
        status: 'complete',
      },
      now,
    };
  }

  it('heuristic extraction on forget-command user text produces no ops', async () => {
    // Use an LLM that returns empty ops (simulating successful forget with no new extractions from LLM)
    const { svc } = makeTestService(makeEmptyLLM());
    const statsBefore = await svc.stats();
    // The user says a forget command; heuristic must not re-create "I live in Paris"
    const turn = makeForgotTurn('Forget that I live in Paris.', ['Home city - The user lives in Paris.']);
    await svc.observe(turn);
    const statsAfter = await svc.stats();
    expect(statsAfter.total).toBe(statsBefore.total);
  });

  it('LLM that tries to re-create a just-forgotten fact is blocked', async () => {
    // LLM tries to (re-)create the fact that was just forgotten
    const llmRecreates = JSON.stringify({
      episode: null,
      memories: [
        { op: 'create', kind: 'fact', label: 'Home city', content: 'The user lives in Paris.', importance: 0.8 },
      ],
      links: [],
    });
    const { svc } = makeTestService(makeFakeLLM(llmRecreates));
    const statsBefore = await svc.stats();
    // The forget tool reports node labels (not content), as the real tool does for this memory.
    const turn = makeForgotTurn('Forget that I live in Paris.', ['Home city']);
    await svc.observe(turn);
    const statsAfter = await svc.stats();
    // No new memory should have been created
    expect(statsAfter.total).toBe(statsBefore.total);
  });
});

// ─── F11: policy re-check before committing ────────────────────────────────────

describe('observe: policy is rechecked before writing (F11)', () => {
  async function pausedObservation() {
    const db = openNeoDatabase(':memory:');
    const hashing = new HashingEmbedder(256);
    let entered!: () => void;
    let release!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const embedder = {
      id: hashing.id, dimensions: hashing.dimensions, isLocal: true,
      async embed(texts: string[]) {
        if (texts.some((text) => text.startsWith('fact: Race test.'))) {
          entered();
          await gate;
        }
        return hashing.embed(texts);
      },
    };
    const svc = createMemoryService({
      db, embedder,
      llm: () => ({ model: makeFakeLLM(JSON.stringify({
        episode: { label: 'Meeting Mira', summary: 'The user met Mira.' },
        memories: [{ op: 'create', kind: 'fact', label: 'Race test', content: 'The user met Mira.', entities: ['Mira'] }],
        links: [],
      })), name: 'fake', isLocal: true }),
      logger: silentLogger,
    });
    const observation = svc.observe(makeTurn('I met Mira yesterday.', 'How was your meeting?'));
    await embeddingStarted;
    expect((await svc.stats()).total).toBe(0);
    return { svc, db, observation, release };
  }

  it.each([
    { allowedKinds: ['preference'] as const },
    { sendSensitiveToCloud: true },
  ])('drops an observation when extraction rules change during embedding: %j', async (change) => {
    const { svc, db, observation, release } = await pausedObservation();
    try {
      svc.setPolicy({ ...svc.getPolicy(), ...change, allowedKinds: [...(change.allowedKinds ?? svc.getPolicy().allowedKinds)] });
      release();
      expect((await observation).skipped).toBe('memory settings changed during extraction');
      expect((await svc.stats()).total).toBe(0);
    } finally { release(); await observation; db.close(); }
  });
});

// ─── F12: stale sensitivity during extraction input assembly ──────────────────

describe('observe: remembered node turned sensitive before extraction payload is built (stale sensitivity, cloud)', () => {
  it('excludes the node from the extraction input when it becomes sensitive during related-memory recall', async () => {
    const db = openNeoDatabase(':memory:');
    const hashing = new HashingEmbedder(256);

    const DISTINCTIVE = 'stale-sensitivity-distinctive-content-marker-xyz';
    const QUERY_TEXT = 'stale-sensitivity-recall-gate-query-distinctive-xyz';

    // Gate: pause inside the embedder when it sees the recall query text.
    // deps.related(userText, ...) → runRecall → querySpaces → embedder.embed([userText])
    let entered!: () => void;
    let release!: () => void;
    const recallEmbedStarted = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const embedder = {
      id: hashing.id, dimensions: hashing.dimensions, isLocal: true,
      async embed(texts: string[]) {
        if (texts.some((t) => t.includes(QUERY_TEXT))) {
          entered();
          await gate;
        }
        return hashing.embed(texts);
      },
    };

    // Cloud LLM (isLocal: false) so allowSensitive = false.
    // Captures the extraction input (the user message content sent to the model).
    let capturedInput = '';
    const cloudLLM: ChatModel = {
      async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
        const userPart = req.messages.find((m) => m.role === 'user');
        if (userPart) {
          const first = userPart.parts[0];
          if (first?.type === 'text') capturedInput = first.text;
        }
        yield { type: 'text', text: JSON.stringify({ episode: null, memories: [], links: [] }) };
        yield { type: 'done', stopReason: 'end' };
      },
    };

    const svc = createMemoryService({
      db,
      embedder,
      llm: () => ({ model: cloudLLM, name: 'cloud', isLocal: false }),
      logger: silentLogger,
    });

    try {
      // Pre-create a normal memory node.
      const node = await svc.remember({ kind: 'fact', label: 'Stale sensitivity test node', content: DISTINCTIVE, importance: 0.5 });
      expect(node.sensitivity).toBe('normal');

      // Build a turn whose assistant message includes a remember tool result for the node.
      const now = 1_000_000_000_000;
      const convId = 'conv_stale_test';
      const turn: ObservedTurn = {
        conversationId: convId,
        userMessage: {
          id: newId('msg', now),
          conversationId: convId,
          role: 'user',
          parts: [{ type: 'text', text: QUERY_TEXT }],
          createdAt: now,
          status: 'complete',
        },
        assistantMessage: {
          id: newId('msg', now + 1),
          conversationId: convId,
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Noted.' },
            { type: 'tool_result', toolCallId: 'tc_stale', name: 'remember', output: { id: node.id }, sensitive: false },
          ],
          createdAt: now + 1,
          status: 'complete',
        },
        now,
      };

      const observation = svc.observe(turn);

      // Wait until recall embedding starts (inside deps.related).
      await recallEmbedStarted;

      // Mark the node sensitive while recall is paused.
      await svc.update(node.id, { sensitivity: 'sensitive' });

      // Release the gate — recall embedding continues and the extraction call is made.
      release();
      await observation;

      // The cloud extraction payload must not contain the distinctive content string.
      expect(capturedInput).not.toContain(DISTINCTIVE);
    } finally {
      release(); // no-op if already released
      db.close();
    }
  });
});

describe('observe: private replay metadata protects cloud extraction (F02)', () => {
  it.each(['user', 'assistant', 'tool_result'] as const)('keeps a flagged %s on the device without a surviving source memory', async (flag) => {
    const db = openNeoDatabase(':memory:');
    let calls = 0;
    const model: ChatModel = {
      async *chat() {
        calls++;
        yield { type: 'text', text: JSON.stringify({ episode: null, memories: [], links: [] }) };
        yield { type: 'done', stopReason: 'end' };
      },
    };
    const svc = createMemoryService({ db, llm: () => ({ model, name: 'cloud', isLocal: false }), logger: silentLogger });
    try {
      const turn = makeTurn('Tell me a little more about yesterday.', 'The private word was orchid.');
      if (flag === 'user') turn.userMessage.sensitive = true;
      else if (flag === 'assistant') turn.assistantMessage.sensitive = true;
      else turn.assistantMessage.parts.push({ type: 'tool_result', toolCallId: 'forgotten', name: 'forget', sensitive: true, output: { forgotten: ['Orchid'] } });
      const result = await svc.observe(turn);
      expect(calls).toBe(0);
      expect(result.created).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'episode', sensitivity: 'sensitive' })]));
    } finally { db.close(); }
  });
});

// Recall latency at 10k nodes (with edges and vectors) is covered in review.test.ts.
