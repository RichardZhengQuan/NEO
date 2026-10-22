import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@neo/protocol';
import { createConversationStore, createSettingsStore, migrate, openDatabase, openNeoDatabase, storageMigrations, type NeoDatabase } from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

const message = (id: string, episodeId: string, createdAt: number, text = id): Message => ({
  id, conversationId: episodeId, role: 'user', createdAt, status: 'complete', parts: [{ type: 'text', text }],
});

describe('timeline migration', () => {
  it('keeps overlapping legacy conversations as contiguous past episodes without changing transcript bytes', () => {
    db = openDatabase(':memory:');
    migrate(db, 'storage', storageMigrations.filter((migration) => migration.version <= 4));
    const store = createConversationStore(db, { clock: () => 1000 });
    const a = store.create({ title: 'Pinned' });
    const b = store.create({ title: 'Archived' });
    const privateEpisode = store.create({ incognito: true });
    const empty = store.create();
    store.update(a.id, { pinned: true, systemPrompt: 'frozen', toolset: ['get_datetime'] });
    store.update(b.id, { archived: true });
    for (const item of [message('a_first', a.id, 100), message('b_first', b.id, 200), message('a_last', a.id, 300), message('b_last', b.id, 400), message('private', privateEpisode.id, 500)]) store.appendMessage(item);
    const transcript = db.prepare('SELECT * FROM messages ORDER BY rowid').all();
    expect(migrate(db, 'storage', storageMigrations).applied).toEqual([5, 6, 7, 8]);
    expect(db.prepare('SELECT * FROM messages ORDER BY rowid').all()).toEqual(transcript);
    expect(store.currentEpisode()).toBeNull();
    expect(store.get(a.id)).toMatchObject({ kind: 'episode', startedAt: 100, closedAt: 300, pinned: true, systemPrompt: 'frozen', toolset: ['get_datetime'] });
    expect(store.get(b.id)).toMatchObject({ startedAt: 200, closedAt: 400, archived: true });
    expect(store.get(privateEpisode.id)).toMatchObject({ offRecord: true, ephemeral: false, closedAt: 500 });
    expect(store.get(empty.id)).toMatchObject({ startedAt: 1000, closedAt: 1000 });
    expect(store.timeline().items.map((item) => item.id)).toEqual(['a_first', 'a_last', 'b_first', 'b_last', 'private']);
    expect(store.timeline().episodes.map((item) => item.episodeId)).toEqual([a.id, b.id, privateEpisode.id]);
    expect(store.searchMessages('first')).toHaveLength(2);
    expect(store.purgeOffRecord(100_000_000)).toBe(0);
    expect(store.getMessage('private')).not.toBeNull();
    expect(migrate(db, 'storage', storageMigrations).applied).toEqual([]);
  });
});

describe('timeline storage', () => {
  it('persists private mode independently of episode closure and expires the whole session', () => {
    db = openNeoDatabase(':memory:');
    let now = 1;
    const store = createConversationStore(db, { clock: () => now });
    expect(store.offRecordState()).toEqual({ active: false, episodeId: null, startedAt: null });
    const first = store.createEpisode({ offRecord: true });
    store.setOffRecordState({ active: true, episodeId: first.id, startedAt: now });
    store.appendMessage(message('private-first', first.id, now));
    store.closeEpisode(first.id);
    expect(createConversationStore(db).offRecordState()).toEqual({ active: true, episodeId: first.id, startedAt: 1 });
    now = 12 * 60 * 60_000;
    const last = store.createEpisode({ offRecord: true });
    store.appendMessage(message('private-last', last.id, now));
    store.setOffRecordState({ active: true, episodeId: last.id, startedAt: 1 });
    expect(store.purgeOffRecord(1)).toBe(0);
    expect(store.offRecordState().active).toBe(true);
    expect(store.purgeOffRecord(2)).toBe(2);
    expect(store.offRecordState()).toEqual({ active: false, episodeId: null, startedAt: null });
    expect(store.timeline().items).toEqual([]);
  });

  const setup = () => {
    db = openNeoDatabase(':memory:');
    let now = 100;
    const store = createConversationStore(db, { clock: () => now });
    const a = store.createEpisode();
    for (const [id, at] of [['a1', 100], ['a2', 100], ['a3', 300]] as const) store.appendMessage(message(id, a.id, at));
    now = 200;
    const b = store.createEpisode();
    for (const [id, at] of [['b1', 200], ['b2', 400], ['b3', 500]] as const) store.appendMessage(message(id, b.id, at));
    return { store, a, b };
  };

  it('paginates in stable episode blocks even with overlapping and identical message timestamps', () => {
    const { store, a, b } = setup();
    const newest = store.timeline({ limit: 2 });
    expect(newest.items.map((item) => item.id)).toEqual(['b2', 'b3']);
    expect(newest.items.map((item) => item.episodeId)).toEqual([b.id, b.id]);
    expect(newest.episodes).toEqual([]);
    const middle = store.timeline({ before: newest.nextCursor!, limit: 2 });
    expect(middle.items.map((item) => item.id)).toEqual(['a3', 'b1']);
    expect(middle.episodes).toEqual([{ episodeId: b.id, startedAt: 200, offRecord: false }]);
    const oldest = store.timeline({ before: middle.nextCursor!, limit: 2 });
    expect(oldest.items.map((item) => item.id)).toEqual(['a1', 'a2']);
    expect(oldest.episodes).toEqual([{ episodeId: a.id, startedAt: 100, offRecord: false }]);
    expect(oldest.nextCursor).toBeNull();
  });

  it('centers around a message or ISO date and provides older pagination', () => {
    const { store } = setup();
    expect(store.timeline({ around: 'b1', limit: 3 }).items.map((item) => item.id)).toEqual(['a3', 'b1', 'b2']);
    const page = store.timeline({ around: new Date(200).toISOString(), limit: 3 });
    expect(page.items.map((item) => item.id)).toEqual(['a3', 'b1', 'b2']);
    expect(store.timeline({ before: page.nextCursor!, limit: 3 }).items.map((item) => item.id)).toEqual(['a1', 'a2']);
    expect(store.timeline({ around: new Date(900).toISOString(), limit: 3 }).items.map((item) => item.id)).toEqual(['b1', 'b2', 'b3']);
    expect(() => store.timeline({ around: 'missing' })).toThrow(/not found/);
    expect(() => store.timeline({ around: '42' })).toThrow(/not found/);
    expect(() => store.timeline({ before: 'invalid' })).toThrow(/cursor/);
    expect(() => store.timeline({ before: page.nextCursor!, around: 'b1' })).toThrow(/either/);
  });

  it('handles empty pages and cursor boundaries after a message is deleted', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    expect(store.timeline()).toEqual({ items: [], episodes: [], nextCursor: null });
    expect(store.timeline({ around: new Date().toISOString() })).toEqual({ items: [], episodes: [], nextCursor: null });
    const episode = store.createEpisode();
    for (let i = 0; i < 4; i++) store.appendMessage(message(`m${i}`, episode.id, i));
    const page = store.timeline({ limit: 2 });
    store.deleteMessage('m2');
    expect(store.timeline({ before: page.nextCursor!, limit: 2 }).items.map((item) => item.id)).toEqual(['m0', 'm1']);
  });

  it('indexes visible text on insert and streaming updates while leaving context and tool data unindexed', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    store.appendMessage({ ...message('search', episode.id, 5, 'Orchid tea'), parts: [
      { type: 'context', text: 'Hidden secret' },
      { type: 'text', text: 'Orchid tea' },
      { type: 'tool_result', name: 'recall', toolCallId: 'call', output: 'Hidden private' },
    ] });
    expect(store.searchMessages('orchid')).toMatchObject([{ messageId: 'search', episodeId: episode.id, createdAt: 5, snippet: { text: 'Orchid tea', highlights: [[0, 6]] } }]);
    expect(store.searchMessages('hidden')).toEqual([]);
    expect(store.searchMessages('" OR (')).toEqual([]);
    store.updateMessage('search', { parts: [{ type: 'text', text: 'Jasmine tea' }] });
    expect(store.searchMessages('orchid')).toEqual([]);
    expect(store.searchMessages('jasmine')).toHaveLength(1);
    store.deleteMessage('search');
    expect(store.searchMessages('jasmine')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_fts').get()).toEqual({ n: 0 });
  });

  it('finds messages regardless of whether the query is NFC- or NFD-normalized', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    store.appendMessage(message('accented', episode.id, 1, 'école'));
    const expected = [{
      messageId: 'accented', episodeId: episode.id, createdAt: 1,
      snippet: { text: 'école', highlights: [[0, 5]] },
    }];
    expect(store.searchMessages('école')).toEqual(expected);
    expect(store.searchMessages('école'.normalize('NFD'))).toEqual(expected);
  });

  it('returns match ranges without consuming literal brackets or changing Unicode text', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    const text = '🪟 Remember that I prefer [window] [seats] beside [brackets] — window seats.';
    store.appendMessage(message('brackets', episode.id, 1, text));
    const snippet = store.searchMessages('window seats')[0]!.snippet;
    expect(snippet).toEqual({
      text,
      highlights: ['window', 'seats', 'window', 'seats'].map((word, index) => {
        const start = index < 2 ? text.indexOf(word) : text.lastIndexOf(word);
        return [start, start + word.length];
      }),
    });
    expect(snippet.highlights.map(([start, end]) => snippet.text.slice(start, end))).toEqual(['window', 'seats', 'window', 'seats']);
  });

  it('preserves literal sentinel characters adjacent to matches and retries colliding delimiters', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    const text = '\uE000\uE000\uE000[window]\uE001\uE001 \uE0000\uE002 literal \uE0010\uE002 markers seats';
    store.appendMessage(message('sentinels', episode.id, 1, text));
    expect(store.searchMessages('window seats')[0]!.snippet).toEqual({
      text,
      highlights: ['window', 'seats'].map((word) => [text.indexOf(word), text.indexOf(word) + word.length]),
    });
  });

  it('measures ranges in the returned ellipsized snippet using UTF-16 offsets', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    const text = `${'prefix '.repeat(40)}🪟 window seats ${'suffix '.repeat(40)}`;
    store.appendMessage(message('long', episode.id, 1, text));
    const snippet = store.searchMessages('window seats')[0]!.snippet;
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(true);
    expect(snippet.text).toContain('🪟 window seats');
    expect(snippet.highlights).toEqual(['window', 'seats'].map((word) => {
      const start = snippet.text.indexOf(word);
      return [start, start + word.length];
    }));
  });

  it('closes the touched episode when deleting a message without changing any surviving parts', () => {
    const { store, a, b } = setup();
    const survivor = store.getMessage('b2');
    expect(store.currentEpisode()?.id).toBe(b.id);
    expect(store.deleteMessage('a1')).toBe(true);
    expect(store.currentEpisode()?.id).toBe(b.id);
    expect(store.get(a.id)?.closedAt).not.toBeNull();
    expect(store.deleteMessage('missing')).toBe(false);
    expect(store.deleteMessage('b1')).toBe(true);
    expect(store.currentEpisode()).toBeNull();
    expect(store.getMessage('b2')).toEqual(survivor);
  });

  it('deletes inclusive timestamp ranges across episodes, their parts and FTS rows', () => {
    const { store, b } = setup();
    expect(store.messagesInRange({ from: 200, to: 400 }).map((item) => item.id)).toEqual(['b1', 'a3', 'b2']);
    expect(store.timeline().items).toHaveLength(6);
    expect(store.deleteRange({ from: 200, to: 400 }).map((item) => item.id)).toEqual(['b1', 'a3', 'b2']);
    expect(store.get(b.id)?.closedAt).not.toBeNull();
    expect(store.timeline().items.map((item) => item.id)).toEqual(['a1', 'a2', 'b3']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_fts').get()).toEqual({ n: 3 });
    expect(store.deleteRange({ from: 800 }).length).toBe(0);
    expect(store.deleteRange({}).length).toBe(3);
    expect(store.timeline().items).toEqual([]);
  });

  it('purges only newly ephemeral off-record episodes strictly older than the cutoff', () => {
    db = openNeoDatabase(':memory:');
    let now = 1;
    const store = createConversationStore(db, { clock: () => now });
    const legacy = store.create({ incognito: true, closedAt: 1 });
    store.appendMessage(message('legacy', legacy.id, 1, 'Private legacy'));
    const normal = store.createEpisode();
    store.appendMessage(message('normal', normal.id, 1));
    const old = store.createEpisode({ offRecord: true });
    store.appendMessage(message('old', old.id, 1, 'Ephemeral older'));
    now = 2;
    const fresh = store.createEpisode({ offRecord: true });
    store.appendMessage(message('fresh', fresh.id, 2, 'Ephemeral newer'));
    expect(store.offRecordEpisodes().map((episode) => episode.id)).toEqual([old.id, fresh.id]);
    expect(store.offRecordEpisodes(2).map((episode) => episode.id)).toEqual([old.id]);
    expect(store.purgeOffRecord(2)).toBe(1);
    expect(store.get(old.id)).toBeNull();
    expect(store.getMessage('old')).toBeNull();
    expect(store.searchMessages('older')).toEqual([]);
    expect(store.get(legacy.id)).toMatchObject({ offRecord: true, ephemeral: false });
    expect(store.get(normal.id)).not.toBeNull();
    expect(store.currentEpisode()?.id).toBe(fresh.id);
    expect(store.purgeOffRecord(3)).toBe(1);
    expect(store.currentEpisode()).toBeNull();
    expect(store.searchMessages('private')).toHaveLength(1);
  });

  it('cascades FTS deletion when an entire episode is hard-deleted', () => {
    const { store, a } = setup();
    expect(store.delete(a.id)).toBe(true);
    expect(store.timeline().items.map((item) => item.id)).toEqual(['b1', 'b2', 'b3']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_fts').get()).toEqual({ n: 3 });
  });

  it('returns the authoritative episode identity when appending a message', () => {
    db = openNeoDatabase(':memory:');
    const store = createConversationStore(db);
    const episode = store.createEpisode();
    const input = message('new-message', episode.id, 1);
    expect(store.appendMessage({ ...input, episodeId: 'incorrect' }).episodeId).toBe(episode.id);
    expect(store.getMessage(input.id)?.episodeId).toBe(episode.id);
    expect(input).not.toHaveProperty('episodeId');
  });
});

describe('timeline settings', () => {
  it('defaults the episode gap to an hour and drops obsolete auto-title settings on load and persistence', () => {
    db = openNeoDatabase(':memory:');
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('settings', JSON.stringify({ agent: { autoTitle: true, maxSteps: 3 } }), 1);
    const store = createSettingsStore(db);
    expect(store.get().timeline).toEqual({ episodeGapMinutes: 60 });
    expect(store.get().agent).toMatchObject({ maxSteps: 3 });
    expect(store.get().agent).not.toHaveProperty('autoTitle');
    store.update({ timeline: { episodeGapMinutes: 30 } });
    expect(createSettingsStore(db).get().timeline).toEqual({ episodeGapMinutes: 30 });
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string };
    expect(JSON.parse(row.value).agent).not.toHaveProperty('autoTitle');
    expect(() => store.update({ timeline: { episodeGapMinutes: -1 } })).toThrow(/Invalid settings/);
  });
});
