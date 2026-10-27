import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Embedder, MemoryChangeEvent, RememberInput } from '@neo/protocol';
import { openNeoDatabase, type NeoDatabase } from '@neo/storage';
import { createMemoryService, HashingEmbedder } from './index.js';

const databases: NeoDatabase[] = [];
const clock = () => 1_800_000_000_000;
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function fixture(embedder?: Embedder) {
  const db = openNeoDatabase(':memory:');
  databases.push(db);
  const memory = createMemoryService({ db, clock, embedder });
  const events: MemoryChangeEvent[] = [];
  memory.onChange(event => events.push(event));
  return { db, memory, events };
}
const tone: RememberInput = { kind: 'preference', content: 'The user wants me to use a playful tone', tags: ['assistant-style', 'assistant-style:tone'], source: { by: 'user' } };
const serious: RememberInput = { ...tone, content: 'Be more serious.' };
const rows = (db: NeoDatabase) => ({ nodes: db.prepare('SELECT * FROM memory_nodes ORDER BY id').all(), edges: db.prepare('SELECT * FROM memory_edges ORDER BY id').all(), vectors: db.prepare('SELECT * FROM memory_vectors ORDER BY node_id, model').all() });

describe('atomic remember receipts', () => {
  it('rechecks the receipt after concurrent embeddings and mutates only once', async () => {
    const local = new HashingEmbedder(512);
    let entered = 0;
    let ready!: () => void;
    let release!: () => void;
    const both = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const embedder: Embedder & { isLocal: true } = { id: local.id, dimensions: 512, isLocal: true, async embed(texts) {
      if (++entered === 2) ready();
      await gate;
      return local.embed(texts);
    } };
    const f = fixture(embedder);
    const calls = [f.memory.rememberOnce(tone, 'test:concurrent'), f.memory.rememberOnce(tone, 'test:concurrent')];
    await both; release();
    await Promise.all(calls);
    expect(entered).toBe(2);
    expect((await f.memory.search({ kinds: ['preference'] })).items).toHaveLength(1);
    expect(f.events.map(event => event.type)).toEqual(['created']);
    const snapshot = rows(f.db);
    f.events.length = 0;
    await f.memory.rememberOnce(tone, 'test:concurrent');
    expect(rows(f.db)).toEqual(snapshot);
    expect(f.events).toEqual([]);
  });

  it('never replays an earlier tone after a later instruction committed', async () => {
    const f = fixture();
    await f.memory.rememberOnce(tone, 'test:tone');
    await f.memory.rememberOnce(serious, 'test:instruction');
    const snapshot = rows(f.db);
    f.events.length = 0;
    await f.memory.rememberOnce(tone, 'test:tone');
    expect(rows(f.db)).toEqual(snapshot);
    expect((await f.memory.search({ kinds: ['preference'], status: ['active'] })).items.map(node => node.content)).toEqual(['Be more serious.']);
    expect(f.events).toEqual([]);
  });

  it('preserves an existing receipt even after its referenced node was deleted', async () => {
    const f = fixture();
    f.db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)').run('test:deleted', 'mem_already_deleted');
    await f.memory.rememberOnce(tone, 'test:deleted');
    expect((await f.memory.stats()).total).toBe(0);
    expect(f.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('test:deleted')).toEqual({ value: 'mem_already_deleted' });
    expect(f.events).toEqual([]);
  });

  it('rolls back real memory/vector writes when receipt insertion fails, then retries cleanly', async () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON memory_meta WHEN NEW.key = 'test:rollback' BEGIN SELECT RAISE(ABORT, 'receipt denied'); END");
    await expect(f.memory.rememberOnce(tone, 'test:rollback')).rejects.toThrow('receipt denied');
    expect(rows(f.db)).toEqual({ nodes: [], edges: [], vectors: [] });
    expect(f.db.prepare('SELECT 1 FROM memory_meta WHERE key = ?').get('test:rollback')).toBeUndefined();
    expect(f.events).toEqual([]);
    expect((await f.memory.recall({ text: tone.content, reinforce: false })).items).toEqual([]);
    f.db.exec('DROP TRIGGER deny_receipt');
    await f.memory.rememberOnce(tone, 'test:rollback');
    expect(rows(f.db).vectors.length).toBeGreaterThan(0);
    expect((await f.memory.search({ kinds: ['preference'] })).items).toHaveLength(1);
    expect(f.events.map(event => event.type)).toEqual(['created']);
  });

  it('survives loss of the caller after commit without replaying memory or events', async () => {
    const f = fixture();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, 'transaction').mockImplementationOnce(fn => { transaction(fn); throw new Error('caller lost after commit'); });
    await expect(f.memory.rememberOnce(tone, 'test:committed')).rejects.toThrow('caller lost after commit');
    vi.restoreAllMocks();
    const snapshot = rows(f.db);
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(f.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('test:committed')).toBeDefined();
    expect(f.events).toEqual([]);
    const restarted = createMemoryService({ db: f.db, clock });
    restarted.onChange(event => f.events.push(event));
    await restarted.rememberOnce(tone, 'test:committed');
    expect(rows(f.db)).toEqual(snapshot);
    expect(f.events).toEqual([]);
  });

  it('keeps sensitive embedding local and publishes only after the receipt committed', async () => {
    const local = new HashingEmbedder(512);
    const remote = { id: 'remote-receipt-fixture', dimensions: 512, isLocal: false, embed: vi.fn((texts: string[]) => local.embed(texts)) };
    const f = fixture(remote);
    const receiptsAtEvent: unknown[] = [];
    f.memory.onChange(() => receiptsAtEvent.push(f.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('test:private')));
    await f.memory.rememberOnce({ kind: 'preference', content: 'Always consider my diabetes when suggesting meals.', source: { by: 'user' } }, 'test:private');
    expect(remote.embed).not.toHaveBeenCalled();
    expect((await f.memory.search({ kinds: ['preference'] })).items[0]?.sensitivity).toBe('sensitive');
    expect(f.db.prepare("SELECT embedding_model FROM memory_nodes WHERE kind = 'preference'").get()).toEqual({ embedding_model: 'local-hash2-512' });
    expect(receiptsAtEvent).not.toEqual([]);
    expect(receiptsAtEvent.every(Boolean)).toBe(true);
  });

  it('leaves ordinary remember dedupe/reinforcement and credential rejection unchanged', async () => {
    const f = fixture();
    const first = await f.memory.remember(tone);
    const second = await f.memory.remember(tone);
    expect(second.id).toBe(first.id);
    expect(f.events.map(event => event.type)).toEqual(['created', 'updated']);
    expect(f.db.prepare("SELECT key FROM memory_meta WHERE key LIKE 'test:%'").all()).toEqual([]);
    await expect(f.memory.rememberOnce({ content: 'My password is fixture-secret-123.' }, 'test:secret')).rejects.toThrow('NEO never stores secrets in memory');
    expect(f.db.prepare('SELECT 1 FROM memory_meta WHERE key = ?').get('test:secret')).toBeUndefined();
    expect(JSON.stringify(rows(f.db))).not.toContain('fixture-secret-123');
  });
});
