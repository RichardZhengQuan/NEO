import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Embedder } from '@neo/protocol';
import { silentLogger } from '@neo/protocol';
import { openNeoDatabase, type NeoDatabase } from '@neo/storage';
import { createMemoryService, HashingEmbedder } from './index.js';

const databases: NeoDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(embedder: Embedder & { isLocal?: boolean }) {
  const db = openNeoDatabase(':memory:');
  databases.push(db);
  return { db, memory: createMemoryService({ db, embedder, logger: silentLogger }) };
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
