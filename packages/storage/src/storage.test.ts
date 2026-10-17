import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, toChatMessages, type Message } from '@neo/protocol';
import {
  blobToVector,
  createConversationStore,
  createDeviceStore,
  createProviderConfigStore,
  createPushSubscriptionStore,
  createSecretStore,
  createSettingsStore,
  ftsQuery,
  loadOrCreateKey,
  migrate,
  openDatabase,
  openNeoDatabase,
  storageMigrations,
  vectorToBlob,
  type NeoDatabase,
} from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('database', () => {
  it('retires the stored default demo and every active model reference without changing transcript bytes', () => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter(migration => migration.version <= 3));
    const ref = { provider: 'demo', model: 'neo-demo' };
    createProviderConfigStore(db).upsert({ id: 'demo', kind: 'mock', enabled: true, defaultModel: 'neo-demo' });
    createProviderConfigStore(db).upsert({ id: 'test-double', kind: 'mock', enabled: false });
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('settings', JSON.stringify({ defaultModel: ref, memoryModel: ref, titleModel: ref, embedding: ref }), 1);
    const conversations = createConversationStore(db);
    const conversation = conversations.create({ model: ref });
    conversations.appendMessage({
      id: 'old_demo_answer', conversationId: conversation.id, role: 'assistant', createdAt: 1, status: 'complete', model: ref,
      parts: [{ type: 'text', text: 'A historical answer' }, { type: 'reasoning', text: 'Original thinking', provider: 'mock', model: 'neo-demo' }],
    });
    const transcript = db.prepare('SELECT * FROM messages').all();
    expect(migrate(db, 'storage', storageMigrations).applied).toEqual([4, 5, 6, 7]);
    expect(createProviderConfigStore(db).get('demo')).toBeNull();
    expect(createProviderConfigStore(db).get('test-double')).toMatchObject({ id: 'test-double', kind: 'mock' });
    const migrated = JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string }).value);
    expect(migrated).toMatchObject({ defaultModel: null, memoryModel: null, titleModel: null, embedding: null });
    expect(conversations.get(conversation.id)?.model).toBeNull();
    expect(db.prepare('SELECT * FROM messages').all()).toEqual(transcript);
    expect(migrate(db, 'storage', storageMigrations).applied).toEqual([]);
  });

  it('retains real providers and their model references even when their id is demo', () => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter(migration => migration.version <= 3));
    const ref = { provider: 'demo', model: 'neo-demo' };
    createProviderConfigStore(db).upsert({ id: 'demo', kind: 'ollama', enabled: true, defaultModel: 'neo-demo' });
    createSettingsStore(db).update({ defaultModel: ref, memoryModel: ref });
    const store = createConversationStore(db);
    const conversation = store.create({ model: ref });
    migrate(db, 'storage', storageMigrations);
    expect(createProviderConfigStore(db).get('demo')?.kind).toBe('ollama');
    expect(createSettingsStore(db).get()).toMatchObject({ defaultModel: ref, memoryModel: ref });
    expect(store.get(conversation.id)?.model).toEqual(ref);
  });

  it('migrates idempotently and supports nested transactions', () => {
    db = openNeoDatabase(':memory:');
    const again = migrate(db, 'storage', []);
    expect(again.applied).toEqual([]);
    db.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        try {
          db.transaction(() => {
            db.prepare('INSERT INTO t VALUES (2)').run();
            throw new Error('inner');
          });
        } catch {
          /* inner rolled back */
        }
        db.prepare('INSERT INTO t VALUES (3)').run();
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (2)').run();
          throw new Error('inner');
        });
      } catch {
        /* ignore */
      }
    });
    expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 1 }]);
  });

  it('rolls back and stays usable when the outer COMMIT fails', () => {
    db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED
      );
    `);
    let error: unknown;
    try {
      db.transaction(() => db.prepare('INSERT INTO child VALUES (?, ?)').run(1, 99));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('FOREIGN');
    expect(db.prepare('SELECT * FROM child').all()).toEqual([]);
    expect(() => db.transaction(() => db.prepare('INSERT INTO parent VALUES (?)').run(99))).not.toThrow();
    expect(db.prepare('SELECT * FROM parent').all()).toEqual([{ id: 99 }]);
  });

  it('preserves the original error when transaction cleanup also fails', () => {
    db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    let original: unknown;
    let error: unknown;
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run(1);
        try {
          db.prepare('INSERT OR ROLLBACK INTO t VALUES (?)').run(1);
        } catch (err) {
          original = err;
          throw err;
        }
      });
    } catch (err) {
      error = err;
    }
    expect(original).toBeInstanceOf(Error);
    expect((original as Error).message).toContain('UNIQUE');
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain('transaction cleanup failed');
    expect((error as AggregateError).cause).toBe(original);
    expect((error as AggregateError).errors).toEqual([
      original,
      expect.objectContaining({ message: expect.stringContaining('no transaction is active') }),
    ]);
    expect(db.prepare('SELECT * FROM t').all()).toEqual([]);
    db.transaction(() => db.prepare('INSERT INTO t VALUES (?)').run(2));
    expect(db.prepare('SELECT * FROM t').all()).toEqual([{ id: 2 }]);
  });

  it('round-trips vectors and builds safe fts queries', () => {
    const v = new Float32Array([0.5, -1.25, 3]);
    expect(Array.from(blobToVector(vectorToBlob(v)))).toEqual([0.5, -1.25, 3]);
    expect(ftsQuery('Hello "world" a')).toBe('"hello" OR "world"');
    expect(ftsQuery('!!')).toBeNull();
  });
});

describe('conversation store', () => {
  it('backfills private-derived legacy answers from flagged context and results without changing transcript parts', () => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter((m) => m.version === 1));
    const store = createConversationStore(db);
    const contextConversation = store.create();
    const toolConversation = store.create();
    const normalConversation = store.create();
    const secret = 'private-orchid-729';
    const messages: Message[] = [
      { id: 'old_context', conversationId: contextConversation.id, role: 'user', createdAt: 1, status: 'complete', parts: [{ type: 'context', text: secret, sensitive: true }] },
      { id: 'old_answer', conversationId: contextConversation.id, role: 'assistant', createdAt: 2, status: 'complete', parts: [{ type: 'text', text: `I remember ${secret}` }, { type: 'reasoning', text: secret }] },
      { id: 'old_tool', conversationId: toolConversation.id, role: 'assistant', createdAt: 1, status: 'complete', parts: [{ type: 'tool_call', id: 'old_call', name: 'recall', input: {} }, { type: 'tool_result', toolCallId: 'old_call', name: 'recall', output: secret, sensitive: true }] },
      { id: 'later_answer', conversationId: toolConversation.id, role: 'assistant', createdAt: 2, status: 'complete', parts: [{ type: 'text', text: secret }] },
      { id: 'normal_answer', conversationId: normalConversation.id, role: 'assistant', createdAt: 1, status: 'complete', parts: [{ type: 'text', text: 'A normal answer' }] },
    ];
    for (const message of messages) {
      db.prepare('INSERT INTO messages (id, conversation_id, role, parts, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(message.id, message.conversationId, message.role, JSON.stringify(message.parts), message.createdAt, message.status);
    }
    migrate(db, 'storage', storageMigrations);
    for (const id of ['old_answer', 'old_tool', 'later_answer']) expect(store.getMessage(id)?.sensitive).toBe(true);
    for (const message of messages) expect(store.getMessage(message.id)?.parts).toEqual(message.parts);
    expect(store.getMessage('normal_answer')?.sensitive).toBeUndefined();
    expect(JSON.stringify(toChatMessages(store.messages(contextConversation.id), { omitSensitiveContext: true }))).not.toContain(secret);
    expect(JSON.stringify(toChatMessages(store.messages(toolConversation.id), { omitSensitiveContext: true }))).not.toContain(secret);
  });

  it('backfills databases that already added the sensitivity column before the backfill existed', () => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter((m) => m.version <= 2));
    const store = createConversationStore(db);
    const conversation = store.create();
    const secret = 'private-orchid-729';
    db.prepare('INSERT INTO messages (id, conversation_id, role, parts, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v2_context', conversation.id, 'user', JSON.stringify([{ type: 'context', text: secret, sensitive: true }]), 1, 'complete');
    db.prepare('INSERT INTO messages (id, conversation_id, role, parts, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v2_answer', conversation.id, 'assistant', JSON.stringify([{ type: 'text', text: `I remember ${secret}` }]), 2, 'complete');
    expect(migrate(db, 'storage', storageMigrations).applied).toEqual([3, 4, 5, 6, 7]);
    expect(store.getMessage('v2_answer')?.sensitive).toBe(true);
    expect(JSON.stringify(toChatMessages(store.messages(conversation.id), { omitSensitiveContext: true }))).not.toContain(secret);
  });

  it('infers legacy recall sensitivity from existing memory ids while retaining ordinary recall history', () => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter((m) => m.version === 1));
    db.exec("CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, sensitivity TEXT); INSERT INTO memory_nodes VALUES ('private_node', 'sensitive'), ('normal_node', 'normal');");
    const store = createConversationStore(db);
    const privateConversation = store.create();
    const normalConversation = store.create();
    for (const [conversation, id, content] of [[privateConversation, 'private_node', 'private-orchid-729'], [normalConversation, 'normal_node', 'Likes tea']] as const) {
      const parts: Message['parts'] = [
        { type: 'tool_call', id: `call_${id}`, name: 'recall', input: { query: 'memories' } },
        { type: 'tool_result', toolCallId: `call_${id}`, name: 'recall', output: { memories: [{ id, content }] } },
        { type: 'text', text: content },
      ];
      db.prepare('INSERT INTO messages (id, conversation_id, role, parts, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`msg_${id}`, conversation.id, 'assistant', JSON.stringify(parts), 1, 'complete');
    }
    migrate(db, 'storage', storageMigrations);
    expect(store.getMessage('msg_private_node')?.sensitive).toBe(true);
    expect(store.getMessage('msg_normal_node')?.sensitive).toBeUndefined();
    expect(JSON.stringify(toChatMessages(store.messages(privateConversation.id), { omitSensitiveContext: true }))).not.toContain('private-orchid-729');
    expect(JSON.stringify(toChatMessages(store.messages(normalConversation.id), { omitSensitiveContext: true }))).toContain('Likes tea');
  });

  it.each([
    { scenario: 'missing recall id', name: 'recall', output: { memories: [{ id: 'missing_node', content: 'private-orchid-729' }] } },
    { scenario: 'deleted remember id', name: 'remember', output: { id: 'deleted_node', label: 'private-orchid-729' } },
    { scenario: 'successful forget labels', name: 'forget', output: { forgotten: ['private-orchid-729'] } },
  ])('withholds legacy memory output with unknown provenance: $scenario', ({ name, output }) => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter((m) => m.version === 1));
    db.exec("CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, sensitivity TEXT); INSERT INTO memory_nodes VALUES ('deleted_node', 'sensitive'); DELETE FROM memory_nodes WHERE id = 'deleted_node';");
    const store = createConversationStore(db);
    const conversation = store.create();
    const parts: Message['parts'] = [
      { type: 'tool_call', id: 'legacy_call', name, input: {} },
      { type: 'tool_result', toolCallId: 'legacy_call', name, output },
      { type: 'text', text: 'I found private-orchid-729' },
    ];
    db.prepare('INSERT INTO messages (id, conversation_id, role, parts, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy_msg', conversation.id, 'assistant', JSON.stringify(parts), 1, 'complete');
    migrate(db, 'storage', storageMigrations);
    expect(store.getMessage('legacy_msg')?.sensitive).toBe(true);
    expect(store.getMessage('legacy_msg')?.parts).toEqual(parts);
    expect(JSON.stringify(toChatMessages(store.messages(conversation.id), { omitSensitiveContext: true }))).not.toContain('private-orchid-729');
  });

  it('retains legacy empty and generic no-memory results without sensitivity flags', () => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter((m) => m.version === 1));
    const store = createConversationStore(db);
    const conversation = store.create();
    const parts: Message['parts'] = [
      { type: 'tool_call', id: 'empty_recall', name: 'recall', input: {} },
      { type: 'tool_result', toolCallId: 'empty_recall', name: 'recall', output: { memories: [], note: 'Memory recall is turned off' } },
      { type: 'tool_call', id: 'empty_forget', name: 'forget', input: {} },
      { type: 'tool_result', toolCallId: 'empty_forget', name: 'forget', output: { forgotten: [], note: 'No memories match' } },
      { type: 'text', text: 'Nothing to recall or forget' },
    ];
    db.prepare('INSERT INTO messages (id, conversation_id, role, parts, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('empty_msg', conversation.id, 'assistant', JSON.stringify(parts), 1, 'complete');
    migrate(db, 'storage', storageMigrations);
    expect(store.getMessage('empty_msg')?.sensitive).toBeUndefined();
    expect(JSON.stringify(toChatMessages(store.messages(conversation.id), { omitSensitiveContext: true }))).toContain('Nothing to recall or forget');
  });

  it.each([false, true])('round-trips sensitive messages and tool results (upgraded=%s)', (upgraded) => {
    db = upgraded ? openDatabase(':memory:') : openNeoDatabase(':memory:');
    if (upgraded) {
      migrate(db, 'storage', storageMigrations.filter((m) => m.version === 1));
      db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('old_conv', 'Old', 1, 1);
      db.prepare('INSERT INTO messages (id, conversation_id, role, parts, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run('old_msg', 'old_conv', 'assistant', JSON.stringify([{ type: 'text', text: 'Old answer' }]), 1, 'complete');
      expect(migrate(db, 'storage', storageMigrations).applied).toEqual([2, 3, 4, 5, 6, 7]);
    }
    const store = createConversationStore(db);
    if (upgraded) {
      expect(store.getMessage('old_msg')).toMatchObject({ parts: [{ type: 'text', text: 'Old answer' }] });
      expect(store.getMessage('old_msg')?.sensitive).toBeUndefined();
      expect(migrate(db, 'storage', storageMigrations).applied).toEqual([]);
    }
    const c = store.create();
    const message: Message = {
      id: 'private_msg', conversationId: c.id, role: 'assistant', createdAt: 2, status: 'complete', sensitive: true,
      parts: [
        { type: 'tool_call', id: 'recall_call', name: 'recall', input: { query: 'private' } },
        { type: 'tool_result', toolCallId: 'recall_call', name: 'recall', output: { memories: ['private fact'] }, sensitive: true },
        { type: 'text', text: 'A private answer' },
      ],
    };
    store.appendMessage(message);
    expect(store.getMessage(message.id)).toMatchObject(message);
    expect(createConversationStore(db).messages(c.id)[0]).toMatchObject(message);
    store.updateMessage(message.id, { status: 'error' });
    expect(store.getMessage(message.id)).toMatchObject({ sensitive: true, parts: message.parts, status: 'error' });
    store.updateMessage(message.id, { sensitive: false, parts: [{ type: 'text', text: 'A normal answer' }] });
    expect(store.getMessage(message.id)?.sensitive).not.toBe(true);
    store.updateMessage(message.id, { sensitive: true });
    expect(createConversationStore(db).getMessage(message.id)?.sensitive).toBe(true);
  });

  it('creates, appends, paginates, searches and deletes', () => {
    db = openNeoDatabase(':memory:');
    let t = 1000;
    const store = createConversationStore(db, { clock: () => t++ });
    const c = store.create({ title: 'Kyoto trip' });
    const mk = (i: number, text: string): Message => ({
      id: newId('msg'),
      conversationId: c.id,
      role: i % 2 ? 'assistant' : 'user',
      parts: [{ type: 'text', text }],
      createdAt: 2000 + i,
      status: 'complete',
    });
    for (let i = 0; i < 5; i++) store.appendMessage(mk(i, `message ${i}`));
    expect(store.messages(c.id)).toHaveLength(5);
    const last2 = store.messages(c.id, { limit: 2 });
    expect(last2.map((m) => m.parts[0])).toEqual([
      { type: 'text', text: 'message 3' },
      { type: 'text', text: 'message 4' },
    ]);
    expect(store.get(c.id)?.preview).toBe('message 4');
    const m = store.messages(c.id)[0]!;
    store.updateMessage(m.id, { status: 'error', error: { code: 'internal', message: 'x' } });
    expect(store.getMessage(m.id)?.error?.code).toBe('internal');
    expect(store.list({ query: 'kyoto' })).toHaveLength(1);
    expect(store.list({ query: '100%' })).toHaveLength(0);
    store.update(c.id, { pinned: true, toolset: ['a'] });
    expect(store.get(c.id)).toMatchObject({ pinned: true, toolset: ['a'] });
    expect(store.delete(c.id)).toBe(true);
    expect(store.messages(c.id)).toHaveLength(0);
  });

  it('updating an older message preserves the episode preview and the completion-time last-message bump', () => {
    db = openNeoDatabase(':memory:');
    let t = 1000;
    const store = createConversationStore(db, { clock: () => t++ });
    const c = store.create();
    const a: Message = {
      id: newId('msg'), conversationId: c.id, role: 'assistant', parts: [{ type: 'text', text: 'First answer' }], createdAt: 1000, status: 'complete',
    };
    const b: Message = {
      id: newId('msg'), conversationId: c.id, role: 'assistant', parts: [{ type: 'text', text: 'Latest answer' }], createdAt: 2000, status: 'complete',
    };
    store.appendMessage(a);
    store.appendMessage(b);
    // Simulate TurnRunner.finish bumping last_message_at to the completion clock, which can be well after any message's createdAt.
    store.update(c.id, { lastMessageAt: 9_000 });
    expect(store.get(c.id)?.preview).toBe('Latest answer');
    expect(store.get(c.id)?.lastMessageAt).toBe(9_000);
    store.updateMessage(a.id, { parts: [{ type: 'text', text: 'First answer (edited)' }] });
    expect(store.get(c.id)?.preview).toBe('Latest answer');
    expect(store.get(c.id)?.lastMessageAt).toBe(9_000);
  });

  it('deleting the latest message restores the previous episode preview and timestamp', () => {
    db = openNeoDatabase(':memory:');
    let t = 3000;
    const store = createConversationStore(db, { clock: () => t++ });
    const episode = store.createEpisode();
    const first = store.appendMessage({
      id: 'msg-a', conversationId: episode.id, role: 'user', parts: [{ type: 'text', text: 'first message' }], createdAt: 1000, status: 'complete',
    });
    store.appendMessage({
      id: 'msg-b', conversationId: episode.id, role: 'user', parts: [{ type: 'text', text: 'second message' }], createdAt: 2000, status: 'complete',
    });
    expect(store.get(episode.id)?.preview).toBe('second message');

    expect(store.deleteMessage('msg-b')).toBe(true);
    expect(store.get(episode.id)?.preview).toBe('first message');
    expect(store.get(episode.id)?.lastMessageAt).toBe(first.createdAt);
  });

  it('deleting both messages clears the episode preview and timestamp', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    for (const [id, createdAt, text] of [['msg-a', 1000, 'first message'], ['msg-b', 2000, 'second message']] as const) {
      store.appendMessage({ id, conversationId: episode.id, role: 'user', parts: [{ type: 'text', text }], createdAt, status: 'complete' });
    }

    expect(store.deleteMessage('msg-a')).toBe(true);
    expect(store.deleteMessage('msg-b')).toBe(true);
    expect(store.get(episode.id)?.preview).toBeNull();
    expect(store.get(episode.id)?.lastMessageAt).toBeNull();
  });

  it('deleting a range refreshes every affected episode and preserves unaffected episodes', () => {
    db = openNeoDatabase(':memory:');
    let t = 6000;
    const store = createConversationStore(db, { clock: () => t++ });
    const append = (episodeId: string, id: string, createdAt: number, text: string) => store.appendMessage({
      id, conversationId: episodeId, role: 'user', parts: [{ type: 'text', text }], createdAt, status: 'complete',
    });
    const first = store.createEpisode();
    append(first.id, 'kept', 1000, 'kept message');
    append(first.id, 'deleted-latest', 2000, 'deleted preview');
    const second = store.createEpisode();
    append(second.id, 'deleted-first', 2500, 'first deleted message');
    append(second.id, 'deleted-last', 3000, 'last deleted message');
    const third = store.createEpisode();
    append(third.id, 'unaffected', 4000, 'unaffected message');
    const unaffected = store.get(third.id);

    expect(store.deleteRange({ from: 2000, to: 3000 }).map(message => message.id)).toEqual(['deleted-latest', 'deleted-first', 'deleted-last']);
    expect(store.get(first.id)?.preview).toBe('kept message');
    expect(store.get(first.id)?.lastMessageAt).toBe(1000);
    expect(store.get(second.id)?.preview).toBeNull();
    expect(store.get(second.id)?.lastMessageAt).toBeNull();
    expect(store.get(third.id)).toEqual(unaffected);
  });

  it('deleting messages retains older previewable content behind messages without previews', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    for (const [id, text] of [['msg-z', 'earlier text'], ['msg-a', 'latest text at the same timestamp']] as const) {
      store.appendMessage({ id, conversationId: episode.id, role: 'user', parts: [{ type: 'text', text }], createdAt: 0, status: 'complete' });
    }
    for (let i = 1; i <= 51; i++) {
      store.appendMessage({ id: `empty-${i}`, conversationId: episode.id, role: 'assistant', parts: [], createdAt: i, status: 'complete' });
    }
    store.appendMessage({
      id: 'deleted', conversationId: episode.id, role: 'user', parts: [{ type: 'text', text: 'deleted preview' }], createdAt: 52, status: 'complete',
    });

    store.deleteMessage('deleted');
    expect(store.get(episode.id)?.preview).toBe('latest text at the same timestamp');
    expect(store.get(episode.id)?.lastMessageAt).toBe(51);

    store.deleteRange({ from: 1 });
    expect(store.get(episode.id)?.preview).toBe('latest text at the same timestamp');
    expect(store.get(episode.id)?.lastMessageAt).toBe(0);
  });
});

describe('settings, secrets, devices, push, providers', () => {
  it.each(['auto', 'approve', 'off'])('loads legacy %s memory settings as automatic memory', (mode) => {
    db = openNeoDatabase(':memory:');
    const stored = {
      persona: { avatar: '🌟', name: 'Nova' },
      memory: { mode, blockedTopics: ['health', 'money'], recall: false, sendSensitiveToCloud: true, recallLimit: 7 },
    };
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('settings', JSON.stringify(stored), 1);
    const settings = createSettingsStore(db);
    expect(settings.get().persona).toEqual({ avatar: '🌟' });
    expect(settings.get().memory).toMatchObject({ recall: false, sendSensitiveToCloud: true, recallLimit: 7, storeEpisodes: true });
    expect(settings.get().memory).not.toHaveProperty('mode');
    expect(settings.get().memory).not.toHaveProperty('blockedTopics');
    settings.update({ theme: 'dark' });
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string };
    expect(JSON.parse(row.value).memory).toEqual(settings.get().memory);
    expect(createSettingsStore(db).get()).toEqual(settings.get());
  });

  it('persists settings with defaults and validates patches', () => {
    db = openNeoDatabase(':memory:');
    const s = createSettingsStore(db);
    let seen = '';
    s.onChange((v) => (seen = v.persona.avatar ?? ''));
    s.update({ persona: { avatar: '🌟' } });
    expect(seen).toBe('🌟');
    expect(createSettingsStore(db).get().persona).toEqual({ avatar: '🌟' });
    expect(() => s.update({ agent: { maxSteps: -1 } })).toThrow(/Invalid settings/);
  });

  it('encrypts secrets with a persisted key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-'));
    try {
      const key = loadOrCreateKey(join(dir, 'key'));
      expect(loadOrCreateKey(join(dir, 'key')).equals(key)).toBe(true);
      db = openNeoDatabase(join(dir, 'neo.db'));
      const secrets = createSecretStore(db, key);
      secrets.set('provider:anthropic', 'sk-test-123');
      expect(secrets.get('provider:anthropic')).toBe('sk-test-123');
      const raw = db.prepare('SELECT data FROM secrets').get() as { data: Uint8Array };
      expect(Buffer.from(raw.data).toString()).not.toContain('sk-test');
      expect(secrets.list()).toEqual(['provider:anthropic']);
      expect(() => createSecretStore(db, Buffer.alloc(32, 1)).get('provider:anthropic')).toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies and revokes device tokens', () => {
    db = openNeoDatabase(':memory:');
    const devices = createDeviceStore(db);
    const owner = devices.create({ name: 'Owner', platform: 'desktop', owner: true, token: 'owner-token-0123456789' });
    const phone = devices.create({ name: 'Phone', platform: 'ios' });
    expect(devices.verify('owner-token-0123456789')?.id).toBe(owner.device.id);
    expect(devices.verify(phone.token)?.name).toBe('Phone');
    expect(devices.verify('nope')).toBeNull();
    expect(devices.revoke(owner.device.id)).toBe(false);
    expect(devices.revoke(phone.device.id)).toBe(true);
    expect(devices.verify(phone.token)).toBeNull();
    const push = createPushSubscriptionStore(db);
    push.add({ endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } });
    push.add({ endpoint: 'https://push.example.com/1', keys: { p256dh: 'c', auth: 'd' } });
    expect(push.list()).toHaveLength(1);
    expect(push.list()[0]!.subscription.keys.p256dh).toBe('c');
    const providers = createProviderConfigStore(db);
    providers.upsert({ id: 'ollama', kind: 'ollama', enabled: true });
    expect(providers.list()[0]!.kind).toBe('ollama');
    expect(providers.delete('ollama')).toBe(true);
  });
});
