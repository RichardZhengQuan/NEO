/** Review tests for the productivity stores and their migrations. */
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NeoDatabase } from '@neo/storage';
import { INBOX_LIST_ID, NeoError, type ProductivityStores } from '@neo/protocol';
import { createProductivityStores, toolsMigrations } from './stores/index.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

function setup(start = utc(2026, 10, 10, 8)) {
  const db = openDatabase(':memory:');
  migrate(db, 'tools', toolsMigrations);
  let now = start;
  const clock = () => now;
  const stores = createProductivityStores(db, { clock, defaultTimezone: 'UTC' });
  return { db, stores, setNow: (t: number) => (now = t), get now() { return now; } };
}

function expectNeoError(fn: () => unknown, code: string, message?: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(NeoError);
    expect((err as NeoError).code).toBe(code);
    if (message) expect((err as NeoError).message).toMatch(message);
    return;
  }
  throw new Error(`expected NeoError(${code})`);
}

// ───────────────────────────── reminders ─────────────────────────────

describe('ReminderStore', () => {
  let t: ReturnType<typeof setup>;
  let stores: ProductivityStores;
  beforeEach(() => {
    t = setup();
    stores = t.stores;
  });

  it('validates input with bad_request errors', () => {
    const r = stores.reminders;
    expectNeoError(() => r.create({ title: '', dueAt: t.now }), 'bad_request');
    expectNeoError(() => r.create({ title: '   ', dueAt: t.now }), 'bad_request');
    expectNeoError(() => r.create({ title: 'x', dueAt: Number.NaN }), 'bad_request');
    expectNeoError(() => r.create({ title: 'x', dueAt: t.now, timezone: 'Not/AZone' }), 'bad_request', /timezone/i);
    expectNeoError(() => r.create({ title: 'x', dueAt: t.now, recurrence: { freq: 'weekly', byWeekday: [9] } }), 'bad_request');
    expectNeoError(() => r.create({ title: 'x', dueAt: t.now, recurrence: { freq: 'secondly' as 'daily' } }), 'bad_request');
    const ok = r.create({ title: 'ok', dueAt: t.now });
    expectNeoError(() => r.update(ok.id, { title: '' }), 'bad_request');
    expectNeoError(() => r.update(ok.id, { timezone: 'Nope/Nope' }), 'bad_request');
    expectNeoError(() => r.update('rem_missing', { title: 'y' }), 'not_found');
    expectNeoError(() => r.snooze(ok.id, 0), 'bad_request');
    expectNeoError(() => r.snooze(ok.id, -5), 'bad_request');
    expectNeoError(() => r.snooze(ok.id, Number.NaN), 'bad_request');
  });

  it('update ignores unknown keys and returns exactly what is stored', () => {
    const rem = stores.reminders.create({ title: 'a', dueAt: t.now + 60_000 });
    const updated = stores.reminders.update(rem.id, { title: 'b', id: 'hijack', firedCount: 99 } as never);
    expect(updated).toEqual(stores.reminders.get(rem.id));
    expect(updated.id).toBe(rem.id);
    expect(updated.firedCount).toBe(0);
  });

  it('snooze keeps the recurrence anchor; updating dueAt re-anchors', () => {
    const r = stores.reminders;
    const daily = r.create({ title: 'standup', dueAt: utc(2026, 10, 10, 9), recurrence: { freq: 'daily' } });
    t.setNow(utc(2026, 10, 10, 9));
    r.markFired(daily.id, t.now); // → 10-11 09:00
    t.setNow(utc(2026, 10, 10, 9, 1));
    r.snooze(daily.id, 10); // → 10-10 09:11
    t.setNow(utc(2026, 10, 10, 9, 11));
    const after = r.markFired(daily.id, t.now);
    expect(after.reminder.dueAt).toBe(utc(2026, 10, 11, 9)); // still at 09:00

    r.update(daily.id, { dueAt: utc(2026, 10, 12, 18) }); // re-anchor at 18:00
    t.setNow(utc(2026, 10, 12, 18));
    expect(r.markFired(daily.id, t.now).reminder.dueAt).toBe(utc(2026, 10, 13, 18));
  });

  it('markFired: one-shot, recurring, exhausted and long-downtime collapse', () => {
    const r = stores.reminders;
    const once = r.create({ title: 'once', dueAt: utc(2026, 10, 10, 8) });
    const f1 = r.markFired(once.id, utc(2026, 10, 10, 8));
    expect(f1).toMatchObject({ occurrenceAt: utc(2026, 10, 10, 8), nextDueAt: null });
    expect(f1.reminder).toMatchObject({ status: 'fired', firedCount: 1, lastFiredAt: utc(2026, 10, 10, 8) });

    const twice = r.create({ title: 'twice', dueAt: utc(2026, 10, 10, 8), recurrence: { freq: 'daily', count: 2 } });
    expect(r.markFired(twice.id, utc(2026, 10, 10, 8)).reminder.status).toBe('scheduled');
    const last = r.markFired(twice.id, utc(2026, 10, 11, 8));
    expect(last.reminder.status).toBe('fired');
    expect(last.nextDueAt).toBeNull();

    const old = r.create({ title: 'old', dueAt: utc(2026, 9, 1, 7), recurrence: { freq: 'daily' } });
    const collapsed = r.markFired(old.id, utc(2026, 10, 10, 8));
    expect(collapsed.occurrenceAt).toBe(utc(2026, 9, 1, 7));
    expect(collapsed.reminder.dueAt).toBe(utc(2026, 10, 11, 7));
    expect(collapsed.reminder.firedCount).toBe(1);
  });

  it('markFired refuses reminders that are not scheduled (no resurrection of a completed series)', () => {
    const r = stores.reminders;
    const series = r.create({ title: 'daily', dueAt: utc(2026, 10, 10, 8), recurrence: { freq: 'daily' } });
    r.complete(series.id);
    expectNeoError(() => r.markFired(series.id, utc(2026, 10, 10, 8)), 'conflict');
    expect(r.get(series.id)?.status).toBe('completed');
    expect(r.due(utc(2030, 1, 1))).toEqual([]);
    expect(r.nextDue()).toBeNull();
  });

  it('changing the time of a fired reminder schedules it again', () => {
    const r = stores.reminders;
    const once = r.create({ title: 'once', dueAt: utc(2026, 10, 10, 8) });
    r.markFired(once.id, utc(2026, 10, 10, 8));
    const moved = r.update(once.id, { dueAt: utc(2026, 10, 11, 8) });
    expect(moved.status).toBe('scheduled');
    expect(r.nextDue()?.id).toBe(once.id);
  });

  it('emits onChange after every mutation', () => {
    const r = stores.reminders;
    const events: string[] = [];
    r.onChange((e) => events.push(e.type === 'upsert' ? `upsert:${e.reminder.status}` : 'delete'));
    const rem = r.create({ title: 'a', dueAt: t.now });
    r.update(rem.id, { title: 'b' });
    r.snooze(rem.id, 5);
    r.markFired(rem.id, t.now + 300_000);
    r.complete(rem.id);
    r.delete(rem.id);
    expect(events).toEqual(['upsert:scheduled', 'upsert:scheduled', 'upsert:scheduled', 'upsert:fired', 'upsert:completed', 'delete']);
  });

  it('list tolerates odd limits', () => {
    stores.reminders.create({ title: 'a', dueAt: t.now });
    stores.reminders.create({ title: 'b', dueAt: t.now + 1 });
    expect(stores.reminders.list({ limit: Number.NaN })).toHaveLength(2);
    expect(stores.reminders.list({ limit: -3 })).toHaveLength(1);
    expect(stores.reminders.list({ limit: 1.7 })).toHaveLength(1);
    expect(stores.reminders.list({ status: [] })).toHaveLength(2);
  });
});

// ───────────────────────────── tasks ─────────────────────────────

describe('TaskStore', () => {
  let t: ReturnType<typeof setup>;
  let stores: ProductivityStores;
  beforeEach(() => {
    t = setup();
    stores = t.stores;
  });

  it('the inbox is created by the migration itself', () => {
    const db = openDatabase(':memory:');
    migrate(db, 'tools', toolsMigrations);
    expect(db.prepare('SELECT name FROM task_lists WHERE id = ?').get(INBOX_LIST_ID)).toEqual({ name: 'Inbox' });
  });

  it('the inbox cannot be deleted; unknown lists return false', () => {
    expectNeoError(() => stores.tasks.deleteList(INBOX_LIST_ID), 'forbidden');
    expect(stores.tasks.deleteList('list_missing')).toBe(false);
  });

  it('unknown destination lists become NeoErrors, not raw SQLite FOREIGN KEY errors', () => {
    expectNeoError(() => stores.tasks.create({ title: 'x', listId: 'list_nope' }), 'not_found', /task list/i);
    const task = stores.tasks.create({ title: 'x' });
    expectNeoError(() => stores.tasks.update(task.id, { listId: 'list_nope' }), 'not_found', /task list/i);
    expect(stores.tasks.get(task.id)?.listId).toBe(INBOX_LIST_ID);
    expectNeoError(() => stores.tasks.create({ title: 'child', parentId: 'task_nope' }), 'not_found', /parent/i);
  });

  it('validates input with bad_request errors', () => {
    expectNeoError(() => stores.tasks.create({ title: '  ' }), 'bad_request');
    expectNeoError(() => stores.tasks.create({ title: 'x', priority: 7 }), 'bad_request');
    expectNeoError(() => stores.tasks.createList({ name: '' }), 'bad_request');
    const task = stores.tasks.create({ title: 'x' });
    expectNeoError(() => stores.tasks.update(task.id, { title: '' }), 'bad_request');
    expectNeoError(() => stores.tasks.update(task.id, { priority: -1 }), 'bad_request');
    expectNeoError(() => stores.tasks.update('task_missing', { done: true }), 'not_found');
  });

  it('done/doneAt stay consistent', () => {
    const task = stores.tasks.create({ title: 'x' });
    t.setNow(t.now + 1000);
    const done = stores.tasks.update(task.id, { done: true });
    expect(done.doneAt).toBe(t.now);
    t.setNow(t.now + 1000);
    expect(stores.tasks.update(task.id, { done: true, title: 'y' }).doneAt).toBe(done.doneAt);
    expect(stores.tasks.update(task.id, { done: false }).doneAt).toBeNull();
  });

  it('deleteList moves tasks to the inbox, bumps updatedAt and emits an upsert per moved task', () => {
    const list = stores.tasks.createList({ name: 'Groceries' });
    const ids = [stores.tasks.create({ title: 'milk', listId: list.id }).id, stores.tasks.create({ title: 'eggs', listId: list.id }).id];
    const other = stores.tasks.create({ title: 'unrelated' });
    t.setNow(t.now + 5000);
    const events: { type: string; id: string; listId?: string }[] = [];
    stores.tasks.onChange((e) => events.push(e.type === 'upsert' ? { type: 'upsert', id: e.task.id, listId: e.task.listId } : { type: 'delete', id: e.id }));

    expect(stores.tasks.deleteList(list.id)).toBe(true);
    expect(stores.tasks.lists().some((l) => l.id === list.id)).toBe(false);
    expect(events).toEqual(ids.map((id) => ({ type: 'upsert', id, listId: INBOX_LIST_ID })));
    for (const id of ids) expect(stores.tasks.get(id)).toMatchObject({ listId: INBOX_LIST_ID, updatedAt: t.now });
    expect(stores.tasks.get(other.id)?.updatedAt).toBe(t.now - 5000);
  });

  it('deleteList stays fast with thousands of tasks', () => {
    const list = stores.tasks.createList({ name: 'Big' });
    t.db.transaction(() => {
      for (let i = 0; i < 2000; i++) stores.tasks.create({ title: `task ${i}`, listId: list.id });
    });
    let upserts = 0;
    stores.tasks.onChange(() => upserts++);
    const started = performance.now();
    stores.tasks.deleteList(list.id);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(upserts).toBe(2000);
    expect(stores.tasks.list({ listId: INBOX_LIST_ID, limit: 5000 })).toHaveLength(1000); // list() caps at 1000
  });

  it('list tolerates odd limits and searches notes too', () => {
    stores.tasks.create({ title: 'Call mom', notes: 'about the trip' });
    stores.tasks.create({ title: 'Buy milk' });
    expect(stores.tasks.list({ limit: Number.NaN })).toHaveLength(2);
    expect(stores.tasks.list({ query: 'trip' }).map((x) => x.title)).toEqual(['Call mom']);
    expect(stores.tasks.list({ query: '50%_' })).toEqual([]);
  });
});

// ───────────────────────────── notes ─────────────────────────────

describe('NoteStore', () => {
  let stores: ProductivityStores;
  let db: NeoDatabase;
  beforeEach(() => {
    const t = setup();
    stores = t.stores;
    db = t.db;
  });

  it('keeps the full-text index in sync on update and delete', () => {
    const n = stores.notes.create({ title: 'Trip', content: 'pack the passport' });
    expect(stores.notes.list({ query: 'passport' }).map((x) => x.id)).toEqual([n.id]);
    stores.notes.update(n.id, { content: 'pack the sunscreen' });
    expect(stores.notes.list({ query: 'passport' })).toEqual([]);
    expect(stores.notes.list({ query: 'sunscreen' }).map((x) => x.id)).toEqual([n.id]);
    stores.notes.delete(n.id);
    expect(stores.notes.list({ query: 'sunscreen' })).toEqual([]);
  });

  it('full-text search covers tags', () => {
    const n = stores.notes.create({ title: 'List', content: 'milk, eggs', tags: ['groceries'] });
    expect(stores.notes.list({ query: 'groceries' }).map((x) => x.id)).toEqual([n.id]);
  });

  it('query and tag filters combine', () => {
    stores.notes.create({ title: 'a', content: 'budget plan', tags: ['work'] });
    const b = stores.notes.create({ title: 'b', content: 'budget plan', tags: ['home'] });
    expect(stores.notes.list({ query: 'budget', tag: 'home' }).map((x) => x.id)).toEqual([b.id]);
  });

  it('tag filter returns each note once, case-insensitively', () => {
    const n = stores.notes.create({ content: 'x', tags: ['work', 'work'] });
    expect(stores.notes.list({ tag: 'Work' }).map((x) => x.id)).toEqual([n.id]);
  });

  it('ranks search results by relevance', () => {
    stores.notes.create({ title: 'misc', content: 'one mention of rust here among many other words in a long note' });
    const best = stores.notes.create({ title: 'Rust', content: 'rust rust rust' });
    expect(stores.notes.list({ query: 'rust' })[0]?.id).toBe(best.id);
  });

  it('finds CJK text and single characters (no word segmentation in FTS5 unicode61)', () => {
    const n = stores.notes.create({ title: '周末计划', content: '我喜欢猫和狗' });
    stores.notes.create({ title: '购物', content: '牛奶和鸡蛋' });
    expect(stores.notes.list({ query: '猫' }).map((x) => x.id)).toEqual([n.id]);
    expect(stores.notes.list({ query: '计划' }).map((x) => x.id)).toEqual([n.id]);
  });

  it('a query with no searchable tokens matches nothing instead of everything', () => {
    stores.notes.create({ content: 'hello world' });
    expect(stores.notes.list({ query: '!!!' })).toEqual([]);
  });

  it('migration 5 re-indexes notes of an existing database (title, content and tags)', () => {
    const old = openDatabase(':memory:');
    migrate(old, 'tools', toolsMigrations.filter((m) => m.version < 5));
    old.prepare("INSERT INTO notes (id, title, content, tags, pinned, created_at, updated_at) VALUES ('note_1', 'Old', 'legacy text', '[\"archive\"]', 0, 1, 1)").run();
    migrate(old, 'tools', toolsMigrations);
    const upgraded = createProductivityStores(old, { clock: () => 2 });
    expect(upgraded.notes.list({ query: 'legacy' }).map((x) => x.id)).toEqual(['note_1']);
    expect(upgraded.notes.list({ query: 'archive' }).map((x) => x.id)).toEqual(['note_1']);
    upgraded.notes.update('note_1', { content: 'renewed' });
    expect(upgraded.notes.list({ query: 'legacy' })).toEqual([]);
    expect(upgraded.notes.list({ query: 'renewed' }).map((x) => x.id)).toEqual(['note_1']);
  });

  it('search survives VACUUM (index is keyed by note id, not rowid)', () => {
    const a = stores.notes.create({ content: 'alpha' });
    stores.notes.create({ content: 'bravo' });
    const c = stores.notes.create({ content: 'charlie' });
    stores.notes.delete(a.id);
    db.exec('VACUUM');
    expect(stores.notes.list({ query: 'charlie' }).map((x) => x.id)).toEqual([c.id]);
  });

  it('validates input and emits onChange', () => {
    expectNeoError(() => stores.notes.create({ content: 'x'.repeat(200_001) }), 'bad_request');
    expectNeoError(() => stores.notes.create({ title: 't'.repeat(301), content: 'x' }), 'bad_request');
    expectNeoError(() => stores.notes.update('note_missing', { content: 'x' }), 'not_found');
    const events: string[] = [];
    stores.notes.onChange((e) => events.push(e.type));
    const n = stores.notes.create({ content: 'x' });
    stores.notes.update(n.id, { pinned: true });
    stores.notes.delete(n.id);
    expect(events).toEqual(['upsert', 'upsert', 'delete']);
  });
});

describe('NotificationStore', () => {
  it('validates kind and tolerates odd limits', () => {
    const { stores } = setup();
    expectNeoError(() => stores.notifications.create({ kind: 'spam' as 'system', title: 't', body: 'b', data: null }), 'bad_request');
    stores.notifications.create({ kind: 'system', title: 't', body: 'b', data: null });
    expect(stores.notifications.list({ limit: Number.NaN })).toHaveLength(1);
    expect(stores.notifications.markRead('all')).toBe(1);
    expect(stores.notifications.list({ unread: true })).toEqual([]);
  });
});
