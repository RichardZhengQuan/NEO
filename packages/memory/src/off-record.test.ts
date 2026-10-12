import { expect, it, vi } from 'vitest';
import { silentLogger } from '@neo/protocol';
import { openNeoDatabase } from '@neo/storage';
import { createMemoryService, HashingEmbedder } from './index.js';

it('an aborted remember cannot commit after embedding completes', async () => {
  const db = openNeoDatabase(':memory:');
  const embedder = new HashingEmbedder(256);
  const memory = createMemoryService({ db, embedder, logger: silentLogger });
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const embed = embedder.embed.bind(embedder);
  vi.spyOn(embedder, 'embed').mockImplementation(async texts => {
    started();
    await gate;
    return embed(texts);
  });
  const controller = new AbortController();
  try {
    const pending = memory.remember({ content: 'The user enjoys gardening.' }, controller.signal);
    const outcome = pending.catch(error => error);
    await ready;
    controller.abort();
    release();
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_nodes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_edges').get()).toEqual({ n: 0 });
    await expect(memory.remember({ content: 'Another private fact.' }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  } finally {
    release();
    db.close();
  }
});

it('a recall becoming private during embedding skips reinforcement and association writes', async () => {
  const db = openNeoDatabase(':memory:');
  const embedder = new HashingEmbedder(256);
  const memory = createMemoryService({ db, embedder, logger: silentLogger });
  try {
    const first = await memory.remember({ content: 'The user enjoys gardening.', label: 'Gardening' });
    await memory.remember({ content: 'The user grows roses in the garden.', label: 'Roses' });
    const nodes = db.prepare('SELECT id, access_count, last_accessed_at FROM memory_nodes ORDER BY id').all();
    const edges = db.prepare('SELECT * FROM memory_edges ORDER BY id').all();
    let privateMode = false;
    const embed = embedder.embed.bind(embedder);
    vi.spyOn(embedder, 'embed').mockImplementation(async texts => {
      privateMode = true;
      return embed(texts);
    });
    const result = await memory.recall({ text: 'gardening roses', get reinforce() { return privateMode ? false : undefined; } });
    expect(result.items.some(item => item.node.id === first.id)).toBe(true);
    expect(db.prepare('SELECT id, access_count, last_accessed_at FROM memory_nodes ORDER BY id').all()).toEqual(nodes);
    expect(db.prepare('SELECT * FROM memory_edges ORDER BY id').all()).toEqual(edges);
  } finally {
    db.close();
  }
});
