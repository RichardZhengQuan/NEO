import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@neo/protocol';
import { createConversationStore, migrate, openNeoDatabase, storageMigrations, type NeoDatabase } from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('list', () => {
  it('list() does not skip rows when paginating across a pinned/unpinned boundary', () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'storage', storageMigrations);
    let now = 1;
    const store = createConversationStore(db, { clock: () => now });
    const a = store.createEpisode();
    now = 100;
    store.update(a.id, { pinned: true });
    now = 200;
    const b = store.createEpisode();
    const page1 = store.list({ limit: 1 });
    expect(page1).toHaveLength(1);
    expect(page1[0]).toMatchObject({ id: a.id, pinned: true, updatedAt: 100 });
    expect(store.get(b.id)?.updatedAt).toBe(200);
    const page2 = store.list({ limit: 1, before: page1[0]!.updatedAt, beforePinned: page1[0]!.pinned });
    expect(page2.map(c => c.id)).toContain(b.id);
  });

  it('list() returns only strictly older unpinned rows after an unpinned cursor', () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'storage', storageMigrations);
    let now = 50;
    const store = createConversationStore(db, { clock: () => now });
    const pinned = store.createEpisode();
    store.update(pinned.id, { pinned: true });
    now = 100;
    const older = store.createEpisode();
    now = 200;
    store.createEpisode();
    now = 300;
    store.createEpisode();
    const page = store.list({ before: 200, beforePinned: false });
    expect(page.map(c => c.id)).toEqual([older.id]);
  });

  it('list() preserves timestamp-only pagination when beforePinned is omitted', () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'storage', storageMigrations);
    let now = 50;
    const store = createConversationStore(db, { clock: () => now });
    const older = store.createEpisode();
    now = 100;
    const pinned = store.createEpisode();
    store.update(pinned.id, { pinned: true });
    now = 200;
    store.createEpisode();
    const page = store.list({ before: 100 });
    expect(page.map(c => c.id)).toEqual([older.id]);
  });
});

describe('searchMessages', () => {
  it('searchMessages finds Turkish dotted-I words through their lowercase expansion', () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'storage', storageMigrations);
    const store = createConversationStore(db);
    const conv = store.createEpisode();
    store.appendMessage({
      id: 'istanbul-msg-id',
      conversationId: conv.id,
      role: 'user',
      createdAt: 1,
      status: 'complete',
      parts: [{ type: 'text', text: 'İstanbul' }],
    });
    expect(store.searchMessages('İstanbul').map(h => h.messageId)).toEqual(['istanbul-msg-id']);
  });

  it('finds words from both text parts of a split-part assistant message', () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'storage', storageMigrations);
    const store = createConversationStore(db);
    const conv = store.createEpisode();
    store.appendMessage({
      id: newId('msg'),
      conversationId: conv.id,
      role: 'assistant',
      createdAt: Date.now(),
      status: 'complete',
      parts: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_call', id: 't1', name: 'web_search', input: { q: 'x' } },
        { type: 'text', text: 'Done' },
      ],
    });
    expect(store.searchMessages('check')).toHaveLength(1);
    expect(store.searchMessages('Done')).toHaveLength(1);
  });
});
