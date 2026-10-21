import { afterEach, describe, expect, it } from 'vitest';
import { newId, type Message } from '@neo/protocol';
import { createConversationStore, migrate, openNeoDatabase, storageMigrations, type NeoDatabase } from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('messages', () => {
  it('messages() returns boundary-tied rows when paging', () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'storage', storageMigrations);
    const store = createConversationStore(db);
    const conv = store.createEpisode();
    const base: Omit<Message, 'id' | 'episodeId'> = {
      conversationId: conv.id,
      role: 'user',
      createdAt: 1000,
      status: 'complete',
      parts: [{ type: 'text', text: 'x' }],
    };
    store.appendMessage({ ...base, id: 'm1' });
    store.appendMessage({ ...base, id: 'm2' });
    store.appendMessage({ ...base, id: 'm3' });
    const page1 = store.messages(conv.id, { limit: 2 });
    expect(page1.map(m => m.id)).toEqual(['m2', 'm3']);
    const page2 = store.messages(conv.id, { limit: 2, before: page1[0]!.createdAt, beforeId: page1[0]!.id });
    expect(page2.map(m => m.id)).toEqual(['m1']);
  });

  it('preserves timestamp-only filtering and unlimited chronological order', () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'storage', storageMigrations);
    const store = createConversationStore(db);
    const conv = store.createEpisode();
    const append = (id: string, createdAt: number) => store.appendMessage({
      id,
      conversationId: conv.id,
      role: 'user',
      createdAt,
      status: 'complete',
      parts: [{ type: 'text', text: 'x' }],
    });
    append('m1', 1000);
    append('m2', 1000);
    append('older', 999);
    append('newer', 1001);
    expect(store.messages(conv.id, { limit: 2, before: 1000 }).map(m => m.id)).toEqual(['older']);
    expect(store.messages(conv.id, { before: 1000 }).map(m => m.id)).toEqual(['older']);
    expect(store.messages(conv.id, { before: 1000, beforeId: 'm2' }).map(m => m.id)).toEqual(['older', 'm1']);
    expect(store.messages(conv.id, { beforeId: 'm2' }).map(m => m.id)).toEqual(['older', 'm1', 'm2', 'newer']);
    expect(store.messages(conv.id, { limit: 2, beforeId: 'm2' }).map(m => m.id)).toEqual(['m2', 'newer']);
    expect(store.messages(conv.id).map(m => m.id)).toEqual(['older', 'm1', 'm2', 'newer']);
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
