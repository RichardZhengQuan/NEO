import { expect, it } from 'vitest';
import { openNeoDatabase } from '@neo/storage';
import { createMemoryService, HashingEmbedder } from './index.js';

it('finds all source statuses and transitive derived memories, and forgets them without affecting other sources', async () => {
  const db = openNeoDatabase(':memory:');
  try {
    const memory = createMemoryService({ db, embedder: new HashingEmbedder(64), clock: () => 1000 });
    const fact = await memory.remember({ kind: 'fact', content: 'The user grows orchids.', source: { by: 'extraction', conversationId: 'episode', messageId: 'deleted-message' } });
    const archived = await memory.remember({ kind: 'goal', content: 'The user plans a greenhouse.', source: { by: 'tool', messageId: 'deleted-message' } });
    await memory.update(archived.id, { status: 'archived' });
    const summary = await memory.remember({ kind: 'summary', content: 'The user practices horticulture.', source: { by: 'consolidation' } });
    const indirect = await memory.remember({ kind: 'summary', content: 'The user spends time on botanical projects.', source: { by: 'consolidation' } });
    await memory.link(summary.id, fact.id, 'derived_from');
    await memory.link(indirect.id, summary.id, 'derived_from');
    await memory.link(summary.id, indirect.id, 'derived_from');
    const retained = await memory.remember({ kind: 'fact', content: 'The user reads astronomy books.', source: { by: 'user', messageId: 'other-message' } });
    expect((await memory.findBySource(['deleted-message', 'deleted-message'])).map(node => node.id).sort()).toEqual([fact.id, archived.id, summary.id, indirect.id].sort());
    expect(await memory.forgetBySource(['deleted-message'])).toBe(4);
    expect(await memory.get(retained.id)).not.toBeNull();
    expect(await memory.findBySource(['deleted-message'])).toEqual([]);
    expect(await memory.forgetBySource(['deleted-message'])).toBe(0);
    expect(await memory.findBySource([])).toEqual([]);
  } finally { db.close(); }
});

it('waits for queued extraction before reporting or forgetting source memories', async () => {
  const db = openNeoDatabase(':memory:');
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const extractionStarted = new Promise<void>(resolve => { started = resolve; });
  try {
    const memory = createMemoryService({
      db, embedder: new HashingEmbedder(64), clock: () => 1000,
      llm: () => ({ name: 'fixture', isLocal: true, model: {
        async *chat() {
          started();
          await gate;
          yield { type: 'text' as const, text: JSON.stringify({ episode: null, memories: [{ op: 'create', kind: 'fact', label: 'Cycling', content: 'The user cycles on Sundays.' }], links: [] }) };
          yield { type: 'done' as const, stopReason: 'end' as const };
        },
      } }),
    });
    const observation = memory.observe({ conversationId: 'episode', now: 1000,
      userMessage: { id: 'source', conversationId: 'episode', role: 'user', parts: [{ type: 'text', text: 'I cycle on Sundays.' }], createdAt: 1000, status: 'complete' },
      assistantMessage: { id: 'reply', conversationId: 'episode', role: 'assistant', parts: [{ type: 'text', text: 'Understood.' }], createdAt: 1000, status: 'complete' },
    });
    await extractionStarted;
    let resolved = false;
    const found = memory.findBySource(['source']).then(nodes => { resolved = true; return nodes; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release();
    await observation;
    expect(await found).toHaveLength(1);
    expect(await memory.forgetBySource(['source'])).toBe(1);
  } finally { release(); db.close(); }
});
