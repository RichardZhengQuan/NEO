import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@neo/protocol';
import { createConversationStore, migrate, openNeoDatabase, storageMigrations, type NeoDatabase } from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('searchMessages', () => {
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
