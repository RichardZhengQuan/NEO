import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModel, ChatRequest, ChatStreamEvent, Embedder, ObservedTurn, ProviderAdapter } from '@neo/protocol';
import { DEFAULT_MEMORY_POLICY, newId, silentLogger } from '@neo/protocol';
import { openNeoDatabase, type NeoDatabase } from '@neo/storage';
import { createMemoryService, HashingEmbedder } from './index.js';
import { createProviderEmbedder } from './embedder.js';

const databases: NeoDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(embedder: Embedder & { isLocal?: boolean }) {
  const db = openNeoDatabase(':memory:');
  databases.push(db);
  return { db, memory: createMemoryService({ db, embedder, logger: silentLogger, clock: () => 1_800_000_000_000 }) };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('live embedding changes', () => {
  it('discards an old in-flight batch and re-embeds all nodes with the latest adapter without sending more old batches', async () => {
    const { db, memory } = setup({
      id: 'original-model', dimensions: 2, isLocal: true,
      embed: async texts => texts.map(() => new Float32Array(2)),
    });
    for (let index = 0; index < 70; index++) {
      await memory.remember({ kind: 'entity', label: `Place ${index}`, content: `Independent place number ${index}`, source: { by: 'user' } });
    }
    expect((await memory.stats()).total).toBe(70);
    const gate = deferred();
    const embed = vi.fn(async (texts: string[]) => {
      await gate.promise;
      return texts.map(() => new Float32Array([1, 0]));
    });
    const retired = { id: 'retired-cloud', dimensions: 2, isLocal: false, embed };
    memory.setEmbedder(retired);
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(embed.mock.calls[0]?.[0]).toHaveLength(64);
    memory.setEmbedder(new HashingEmbedder(64));
    gate.release();
    await vi.waitFor(() => {
      const models = db.prepare('SELECT DISTINCT model FROM memory_vectors').all();
      expect(models).toEqual([{ model: 'hash2-64' }]);
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect((await memory.stats()).embeddingModel).toBe('hash2-64');
  });

  it('never compares old-model vectors to new-model queries while re-embedding is waiting', async () => {
    const initial: Embedder & { isLocal: boolean } = { id: 'old-model', dimensions: 2, isLocal: true, embed: async texts => texts.map(() => new Float32Array([1, 0])) };
    const { db, memory } = setup(initial);
    const node = await memory.remember({ kind: 'fact', label: 'Cardinal record', content: 'A distinct stored fact', source: { by: 'user' } });
    expect((await memory.recall({ text: 'constellation', reinforce: false })).items.map(item => item.node.id)).toContain(node.id);
    const gate = deferred();
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some(text => text.startsWith('fact: Cardinal record.'))) {
        await gate.promise;
        return texts.map(() => new Float32Array([0, 1]));
      }
      return texts.map(() => new Float32Array([1, 0]));
    });
    const next = { id: 'new-model', dimensions: 2, isLocal: true, embed };
    memory.setEmbedder(next);
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(db.prepare('SELECT model FROM memory_vectors WHERE node_id = ?').get(node.id)).toEqual({ model: 'old-model' });
    expect((await memory.recall({ text: 'constellation', reinforce: false })).items).toEqual([]);
    gate.release();
    await vi.waitFor(() => expect(db.prepare('SELECT model FROM memory_vectors WHERE node_id = ?').get(node.id)).toEqual({ model: 'new-model' }));
    expect((await memory.recall({ text: 'constellation', reinforce: false })).items).toEqual([]);
    expect((await memory.recall({ text: 'Cardinal', reinforce: false })).items.map(item => item.node.id)).toContain(node.id);
  });
});

describe('same-id embedder settings change', () => {
  it('re-embeds all nodes when same id but settings (base URL) change', async () => {
    const initial = {
      id: 'provider:model', dimensions: 2, isLocal: true,
      settingsFingerprint: JSON.stringify({ baseUrl: 'https://old.example/v1' }),
      embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(2))),
    };
    const { db, memory } = setup(initial);
    for (const label of ['Cardinal record', 'Harbour record']) {
      await memory.remember({ kind: 'entity', label, content: `A distinct stored entity: ${label}`, source: { by: 'user' } });
    }
    await vi.waitFor(() => {
      expect(db.prepare('SELECT embedding_model FROM memory_nodes WHERE kind = ?').all('entity')).toEqual([
        { embedding_model: initial.id }, { embedding_model: initial.id },
      ]);
    });
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([0, 1])));
    const next = {
      id: initial.id, dimensions: 2, isLocal: true,
      settingsFingerprint: JSON.stringify({ baseUrl: 'https://new.example/v1' }),
      embed,
    };
    memory.setEmbedder(next);
    await vi.waitFor(() => {
      expect(embed).toHaveBeenCalled();
      expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2);
      expect(db.prepare('SELECT embedding_model FROM memory_nodes WHERE kind = ?').all('entity')).toEqual([
        { embedding_model: initial.id }, { embedding_model: initial.id },
      ]);
    });
  });

  it('does not re-embed when same id and same settings', async () => {
    const initial = {
      id: 'provider:model', dimensions: 2, isLocal: true,
      settingsFingerprint: JSON.stringify({ baseUrl: 'https://old.example/v1' }),
      embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(2))),
    };
    const { db, memory } = setup(initial);
    for (const label of ['Cardinal record', 'Harbour record']) {
      await memory.remember({ kind: 'entity', label, content: `A distinct stored entity: ${label}`, source: { by: 'user' } });
    }
    await vi.waitFor(() => {
      expect(db.prepare('SELECT embedding_model FROM memory_nodes WHERE kind = ?').all('entity')).toEqual([
        { embedding_model: initial.id }, { embedding_model: initial.id },
      ]);
    });
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(2)));
    memory.setEmbedder({ ...initial, embed });
    await memory.stats();
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('provider embedder settings fingerprint', () => {
  it('captures vector settings with stable nested key ordering at creation time', () => {
    const config: ProviderAdapter['config'] = {
      id: 'provider', kind: 'openai-compatible', enabled: true,
      baseUrl: 'https://old.example/v1',
      options: { dimensions: 2, routing: [{ region: 'east', version: 1 }] },
      headers: { 'x-region': 'east', 'x-version': '1' },
    };
    const embed = vi.fn<NonNullable<ProviderAdapter['embed']>>();
    const adapter = { id: config.id, kind: config.kind, config, embed } as unknown as ProviderAdapter;
    const initial = createProviderEmbedder(adapter, 'model');
    const reordered = createProviderEmbedder({ ...adapter, config: {
      ...config,
      options: { routing: [{ version: 1, region: 'east' }], dimensions: 2 },
      headers: { 'x-version': '1', 'x-region': 'east' },
    } }, 'model');
    expect(reordered.settingsFingerprint).toBe(initial.settingsFingerprint);
    for (const changed of [
      { ...config, baseUrl: 'https://new.example/v1' },
      { ...config, options: { ...config.options, dimensions: 3 } },
      { ...config, headers: { ...config.headers, 'x-region': 'west' } },
    ]) {
      const next = createProviderEmbedder({ ...adapter, config: changed }, 'model');
      expect(next.id).toBe(initial.id);
      expect(next.settingsFingerprint).not.toBe(initial.settingsFingerprint);
    }
    const fingerprint = initial.settingsFingerprint;
    config.baseUrl = 'https://new.example/v1';
    expect(initial.settingsFingerprint).toBe(fingerprint);
    expect(createProviderEmbedder(adapter, 'model').settingsFingerprint).not.toBe(fingerprint);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('recall privacy under concurrent writes', () => {
  it('does not admit a memory that flipped to sensitive during the embedding gap', async () => {
    const gate = deferred();
    let gated = false;
    let gateCalled = false;
    const { memory: svc } = setup({
      id: 'recall-privacy-local', dimensions: 2, isLocal: true,
      embed: async texts => {
        if (gated && texts.includes('Kyoto')) {
          gated = false;
          gateCalled = true;
          await gate.promise;
        }
        return texts.map(() => new Float32Array([0, 0]));
      },
    });
    const E = await svc.remember({
      kind: 'entity', label: 'Kyoto', content: 'A city in Japan', importance: 1,
      sensitivity: 'normal', source: { by: 'user' },
    });
    const M = await svc.remember({
      kind: 'fact', label: 'Tuesday meeting', content: 'Online planning meeting.', importance: 1,
      sensitivity: 'normal', source: { by: 'user' },
    });
    await svc.link(M.id, E.id, 'about', 1);

    gated = true;
    const pending = svc.recall({ text: 'Kyoto', allowSensitive: false, reinforce: false, limit: 10, tokenBudget: 1500 });
    await vi.waitFor(() => expect(gateCalled).toBe(true));
    const flipped = await svc.update(M.id, { sensitivity: 'sensitive', content: 'Confidential: room Juniper.' });
    expect(flipped.sensitivity).toBe('sensitive');
    gate.release();
    const result = await pending;

    expect(result.items.map(it => it.node.id)).toContain(E.id);
    expect(result.items.map(it => it.node.id)).not.toContain(M.id);
  });

  it('does not leak a flipped-to-sensitive label via a two-hop via chain', async () => {
    const gate = deferred();
    let gated = false;
    let gateCalled = false;
    const { memory: svc } = setup({
      id: 'recall-privacy-local-twohop', dimensions: 2, isLocal: true,
      embed: async texts => {
        if (gated && texts.includes('Osaka')) {
          gated = false;
          gateCalled = true;
          await gate.promise;
        }
        return texts.map(() => new Float32Array([0, 0]));
      },
    });
    const E = await svc.remember({
      kind: 'entity', label: 'Osaka', content: 'A city in Japan', importance: 1,
      sensitivity: 'normal', source: { by: 'user' },
    });
    const M = await svc.remember({
      kind: 'fact', label: 'Lunch with Alex', content: 'Lunch plan.', importance: 1,
      sensitivity: 'normal', source: { by: 'user' },
    });
    const N = await svc.remember({
      kind: 'fact', label: 'Open venue list', content: 'Public venues to try.', importance: 1,
      sensitivity: 'normal', source: { by: 'user' },
    });
    await svc.link(M.id, E.id, 'about', 1);
    await svc.link(N.id, M.id, 'about', 1);

    gated = true;
    const pending = svc.recall({ text: 'Osaka', allowSensitive: false, reinforce: false, limit: 10, tokenBudget: 1500 });
    await vi.waitFor(() => expect(gateCalled).toBe(true));
    const sensitiveLabel = 'Confidential: Project Juniper roster';
    const flipped = await svc.update(M.id, { sensitivity: 'sensitive', label: sensitiveLabel, content: 'Confidential: redacted.' });
    expect(flipped.sensitivity).toBe('sensitive');
    expect(flipped.label).toBe(sensitiveLabel);
    gate.release();
    const result = await pending;

    const ids = result.items.map(it => it.node.id);
    expect(ids).not.toContain(M.id);
    // N was only reachable through M; keeping it would still signal M's content
    // (its sensitivity, and the fact that M was a relevant hop) to a cloud caller.
    expect(ids).not.toContain(N.id);
    for (const item of result.items) {
      expect(item.node.label).not.toBe(sensitiveLabel);
      expect(item.node.content).not.toContain('Confidential');
      for (const hop of item.via) {
        expect(hop.nodeId).not.toBe(M.id);
        expect(hop.label).not.toBe(sensitiveLabel);
      }
      expect(item.reason).not.toContain(sensitiveLabel);
    }
  });
});

describe('stale-vector on failed update', () => {
  it('cleared embedding_model does not surface the stale vector in semantic recall', async () => {
    const { db, memory: svc } = setup(new HashingEmbedder(64));

    // 1. Remember a fact with a known embedding.
    // Label 'Zeta' is chosen deliberately: it does not contain any non-stopword
    // from the recall query 'alpha only' (only non-stopword is 'alpha'), so that
    // after the vector is cleared, FTS cannot resurrect the node via its label.
    const node = await svc.remember({
      kind: 'fact', label: 'Zeta', content: 'alpha only', source: { by: 'user' },
    });
    const id = node.id;

    // Precondition: the node has an embedding_model and a vector row.
    expect(db.prepare('SELECT embedding_model FROM memory_nodes WHERE id = ?').get(id)).toMatchObject({ embedding_model: expect.stringContaining('hash') });
    expect(db.prepare('SELECT * FROM memory_vectors WHERE node_id = ?').get(id)).not.toBeUndefined();

    // 2. Wrap the embedder so that embedding 'beta only' returns an empty array,
    //    causing embedTexts to produce a null vector and writeVector to clear embedding_model.
    const inner = new HashingEmbedder(64);
    const failing: Embedder = {
      id: inner.id,
      dimensions: inner.dimensions,
      embed: async (texts: string[]) => {
        if (texts.some(t => t.includes('beta only'))) return [];
        return inner.embed(texts);
      },
    };
    svc.setEmbedder(failing);

    // 3. Update the node's content — the new embedding will fail.
    await svc.update(id, { content: 'beta only' });

    // 4. Assert embedding_model was cleared.
    expect(db.prepare('SELECT embedding_model FROM memory_nodes WHERE id = ?').get(id)).toEqual({ embedding_model: null });

    // 5. Assert the stale vector row was deleted from memory_vectors.
    expect(db.prepare('SELECT * FROM memory_vectors WHERE node_id = ?').get(id)).toBeUndefined();

    // 6. Assert recall for the old text does NOT return this node.
    const result = await svc.recall({ text: 'alpha only', reinforce: false });
    expect(result.items.map(item => item.node.id)).not.toContain(id);
  });

  // Sibling of the above (Codex P2 on bdac9fd): one extraction may apply several writes to the
  // same node. An earlier failed embedding adds the id to `vectorClears`; a later successful
  // `writeVector()` on the same id in the same transaction must cancel that clear, or the
  // post-transaction drop evicts the valid vector from the cache. The DB row then has the
  // current `embedding_model` set, so background re-embedding skips it and recall misses
  // the node via the semantic path until service restart.
  it('a later successful write cancels an earlier pending vector-clear on the same node', async () => {
    const db = openNeoDatabase(':memory:');
    databases.push(db);

    // Controlled embedder with hand-picked vectors. Mapping the "fail" text to a zero-length
    // vector makes `writeVector()` take the failure path (vectors.write rejects empty
    // vectors). Mapping "gamma only" and the lexically-disjoint recall query "xenon" to the
    // SAME vector lets the semantic path alone decide whether the updated node surfaces.
    let failUpdate = false;
    const embedder: Embedder & { isLocal: true } = {
      id: 'test-embedder',
      dimensions: 4,
      isLocal: true,
      embed: async (texts: string[]): Promise<Float32Array[]> =>
        texts.map((t) => {
          if (failUpdate && t.includes('beta only')) return new Float32Array(0);
          if (t.includes('gamma only') || t.includes('xenon')) return new Float32Array([1, 0, 0, 0]);
          return new Float32Array([0, 1, 0, 0]);
        }),
    };

    // Scripted extraction: returns two update ops for the same target id in one `memories`
    // array (one extraction, one runWrite transaction). The LLM runs locally so sensitive
    // routing cannot change the picture.
    let targetId = '';
    const llm: ChatModel = {
      async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
        if (req.metadata?.['purpose'] === 'memory-consolidate') {
          yield { type: 'text', text: '{"summary":null,"facts":[]}' };
          yield { type: 'done', stopReason: 'end' };
          return;
        }
        yield {
          type: 'text',
          text: JSON.stringify({
            episode: null,
            memories: [
              { op: 'update', id: targetId, content: 'beta only' },
              { op: 'update', id: targetId, content: 'gamma only' },
            ],
            links: [],
          }),
        };
        yield { type: 'done', stopReason: 'end' };
      },
    };

    const svc = createMemoryService({
      db,
      embedder,
      llm: () => ({ model: llm, name: 'fake', isLocal: true }),
      policy: { ...DEFAULT_MEMORY_POLICY },
      clock: () => 1_800_000_000_000,
      logger: silentLogger,
    });

    // Seed: a node whose initial content embeds fine (fail flag not set yet).
    const node = await svc.remember({
      kind: 'fact', label: 'Zeta', content: 'alpha only', source: { by: 'user' },
    });
    targetId = node.id;

    // Flip the embedder: only `beta only` texts now return an unusable vector; everything
    // else (extraction's own embeddings, "gamma only", "xenon") still embeds.
    failUpdate = true;

    const now = 1_800_000_000_000;
    const observedTurn: ObservedTurn = {
      conversationId: 'conv',
      userMessage: { id: newId('msg', now), conversationId: 'conv', role: 'user', parts: [{ type: 'text', text: 'something new' }], createdAt: now, status: 'complete' },
      assistantMessage: { id: newId('msg', now + 1), conversationId: 'conv', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], createdAt: now + 1, status: 'complete' },
      now,
    };
    const observeResult = await svc.observe(observedTurn);
    // Premise check: the extraction's two update ops reach the single runWrite transaction.
    expect(observeResult.updated.map((n) => n.id)).toEqual([node.id]);
    expect(observeResult.skipped).toBeUndefined();

    // The second update wins. Its text (`gamma only`) embeds fine, so the final DB row is
    // consistent: content is `gamma only`, `embedding_model` is the test embedder's id, and
    // `memory_vectors` has a row for it.
    expect(db.prepare('SELECT content FROM memory_nodes WHERE id = ?').get(node.id)).toEqual({ content: 'gamma only' });
    expect(db.prepare('SELECT embedding_model FROM memory_nodes WHERE id = ?').get(node.id)).toEqual({ embedding_model: 'test-embedder' });
    expect(db.prepare('SELECT * FROM memory_vectors WHERE node_id = ?').get(node.id)).not.toBeUndefined();

    // The real check: recall with text that only matches semantically — `xenon` shares no
    // non-stopword with the node's label (`Zeta`) or final content (`gamma only`), so FTS
    // cannot seed it. The embedder maps `xenon` to the same vector as `gamma only`, so a
    // present vector cache entry seeds the node with maximum cosine. On unfixed code the
    // second write stages the vector but the first write's leftover `vectorClears` entry
    // drops it from the cache after the transaction, so the semantic seed is missing.
    const result = await svc.recall({ text: 'xenon', reinforce: false });
    expect(result.items.map((item) => item.node.id)).toContain(node.id);
  });
});
