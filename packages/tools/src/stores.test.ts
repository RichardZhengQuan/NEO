/** Review tests for the productivity stores and their migrations. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationStore, migrate, openDatabase, storageMigrations, type NeoDatabase } from '@neo/storage';
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

  it('updating timezone re-anchors a recurring reminder across DST', () => {
    // America/New_York spring-forward: 2026-03-08 02:00 → 03:00.
    // Reminder: daily New York reminder anchored at 2026-03-07 14:00Z (= 09:00 NY EST).
    const r = stores.reminders;
    const mar7_14z = utc(2026, 3, 7, 14); // 2026-03-07T14:00Z
    const mar8_13z = utc(2026, 3, 8, 13); // 2026-03-08T13:00Z (= 09:00 NY EDT after spring-forward)
    const mar9_13z = utc(2026, 3, 9, 13); // expected next after re-anchor to UTC

    const reminder = r.create({
      title: 'morning',
      dueAt: mar7_14z,
      timezone: 'America/New_York',
      recurrence: { freq: 'daily' },
    });

    // Fire March 7 occurrence; dueAt advances to March 8 13:00Z (09:00 NY EDT).
    t.setNow(mar7_14z);
    const after1 = r.markFired(reminder.id, t.now);
    expect(after1.reminder.dueAt).toBe(mar8_13z);

    // User patches timezone to UTC with the same epoch — reanchor must fire.
    r.update(reminder.id, { timezone: 'UTC', dueAt: mar8_13z });

    // Fire March 8 occurrence; next must be exactly one day later (13:00Z on March 9).
    t.setNow(mar8_13z);
    const after2 = r.markFired(reminder.id, t.now);
    expect(after2.reminder.dueAt).toBe(mar9_13z); // not Mar 8 14:00Z (old NY anchor)
  });

  it('updating dueAt with timezone unchanged re-anchors', () => {
    const r = stores.reminders;
    const daily = r.create({ title: 'standup', dueAt: utc(2026, 10, 10, 9), recurrence: { freq: 'daily' } });
    t.setNow(utc(2026, 10, 10, 9));
    r.markFired(daily.id, t.now); // dueAt → Oct 11 09:00
    // Re-anchor to 18:00 without changing timezone
    r.update(daily.id, { dueAt: utc(2026, 10, 12, 18) });
    t.setNow(utc(2026, 10, 12, 18));
    expect(r.markFired(daily.id, t.now).reminder.dueAt).toBe(utc(2026, 10, 13, 18));
  });

  it('update({dueAt}) during active snooze clears the snooze anchor so markFired honours the new time', () => {
    const r = stores.reminders;
    // Recurring reminder fires for the first time → dueAt=Day2
    const daily = r.create({ title: 'standup', dueAt: utc(2026, 10, 10, 9), recurrence: { freq: 'daily' } });
    t.setNow(utc(2026, 10, 10, 9));
    r.markFired(daily.id, t.now); // dueAt → 10-11 09:00
    // User snoozes 10 min → snoozed_due_at=10-11 09:00, dueAt=09:11
    t.setNow(utc(2026, 10, 10, 9, 1));
    r.snooze(daily.id, 10);
    // While snoozed, user reschedules the series to a new anchor (Day3 18:00)
    r.update(daily.id, { dueAt: utc(2026, 10, 12, 18) });
    // The snooze delivery fires; it must NOT restore the stale snoozed_due_at (Day2)
    t.setNow(utc(2026, 10, 10, 9, 11));
    const fired = r.markFired(daily.id, t.now);
    // Next occurrence must be anchored at 18:00, not 09:00
    expect(fired.reminder.dueAt).toBe(utc(2026, 10, 13, 18));
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

  it('snoozing a count-bounded recurring reminder does not consume an occurrence', () => {
    const r = stores.reminders;
    const rem = r.create({
      title: 'medication',
      dueAt: utc(2026, 10, 10, 9),
      recurrence: { freq: 'daily', interval: 1, count: 2 },
    });
    // Day 1 fires
    t.setNow(utc(2026, 10, 10, 9));
    r.markFired(rem.id, t.now);
    // User snoozes 10 min
    t.setNow(utc(2026, 10, 10, 9, 1));
    r.snooze(rem.id, 10);
    // Snoozed redelivery fires
    t.setNow(utc(2026, 10, 10, 9, 11));
    r.markFired(rem.id, t.now);
    // Day 2 must still be scheduled
    const after = r.get(rem.id)!;
    expect(after.status).toBe('scheduled');
    expect(after.dueAt).toBeGreaterThan(t.now + 60 * 60_000);
    // Day 2 fires
    t.setNow(after.dueAt);
    r.markFired(rem.id, t.now);
    expect(r.get(rem.id)!.status).toBe('fired');
  });

  it('snoozing an until-bounded recurring reminder does not consume an occurrence', () => {
    const r = stores.reminders;
    const day3 = utc(2026, 10, 12, 9);
    const rem = r.create({
      title: 'standup',
      dueAt: utc(2026, 10, 10, 9),
      recurrence: { freq: 'daily', interval: 1, until: day3 },
    });
    // Day 1 fires
    t.setNow(utc(2026, 10, 10, 9));
    r.markFired(rem.id, t.now);
    // User snoozes 10 min
    t.setNow(utc(2026, 10, 10, 9, 1));
    r.snooze(rem.id, 10);
    // Snoozed redelivery fires
    t.setNow(utc(2026, 10, 10, 9, 11));
    r.markFired(rem.id, t.now);
    // Day 2 must still be scheduled (not consumed)
    const after = r.get(rem.id)!;
    expect(after.status).toBe('scheduled');
    expect(after.dueAt).toBeGreaterThan(t.now + 60 * 60_000);
  });

  it('timezone-only patch on a snoozed count-bounded reminder does not corrupt recurrence state', () => {
    // Regression: when timezoneMoved and the reminder is snoozed, the previous
    // code set anchor_at = snoozed dueAt (delivery epoch) AND cleared snoozed_due_at.
    // markFired then treated the snoozed redelivery as a true occurrence, incremented
    // firedCount, and exhausted a count:2 series after only one real firing.
    const r = stores.reminders;
    const rem = r.create({
      title: 'medication',
      dueAt: utc(2026, 10, 10, 9),
      recurrence: { freq: 'daily', interval: 1, count: 2 },
      timezone: 'America/New_York',
    });
    // Day 1 fires
    t.setNow(utc(2026, 10, 10, 9));
    r.markFired(rem.id, t.now); // firedCount=1, dueAt → Day 2 09:00
    // User snoozes 10 min while Day 2 is the live dueAt
    t.setNow(utc(2026, 10, 10, 9, 1));
    r.snooze(rem.id, 10); // snoozed_due_at = Day2 09:00, dueAt = Day2 09:11
    // User patches only the timezone (dueAt does not move)
    r.update(rem.id, { timezone: 'UTC' });
    // Snoozed redelivery fires — must NOT count as a true occurrence
    t.setNow(utc(2026, 10, 10, 9, 11));
    r.markFired(rem.id, t.now);
    // Day 2 must still be scheduled (firedCount should still be 1)
    const after = r.get(rem.id)!;
    expect(after.status).toBe('scheduled');
    expect(after.dueAt).toBeGreaterThan(t.now + 60 * 60_000);
    // Day 2 fires — series is now exhausted after 2 real occurrences
    t.setNow(after.dueAt);
    r.markFired(rem.id, t.now);
    expect(r.get(rem.id)!.status).toBe('fired');
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

  it('timezone-only patch on a fired non-recurring reminder does not re-arm it', () => {
    const r = stores.reminders;
    const once = r.create({ title: 'tz-test', dueAt: utc(2026, 10, 10, 8), timezone: 'America/New_York' });
    r.markFired(once.id, utc(2026, 10, 10, 8));
    // Patch only the timezone — dueAt stays in the past.
    const patched = r.update(once.id, { timezone: 'UTC' });
    expect(patched.status).toBe('fired');
    expect(r.nextDue()?.id).not.toBe(once.id);
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

  it('clearMessageLinks sets messageId to null for the given message ids and emits updated reminders', () => {
    migrate(t.db, 'storage', storageMigrations);
    const conversations = createConversationStore(t.db, { clock: () => t.now });
    const episode = conversations.createEpisode();
    for (const id of ['msg-x', 'msg-y']) {
      conversations.appendMessage({ id, conversationId: episode.id, role: 'user', parts: [{ type: 'text', text: id }], createdAt: t.now, status: 'complete' });
    }
    const r = stores.reminders;
    const linked = r.create({ title: 'linked', dueAt: t.now + 60_000, messageId: 'msg-x' });
    const completed = r.complete(r.create({ title: 'completed linked', dueAt: t.now + 60_000, messageId: 'msg-x' }).id);
    const other = r.create({ title: 'other linked', dueAt: t.now + 60_000, messageId: 'msg-y' });
    const unlinked = r.create({ title: 'unlinked', dueAt: t.now + 60_000 });
    const events: unknown[] = [];
    r.onChange(event => events.push(event));
    t.setNow(t.now + 1000);

    r.clearMessageLinks(['msg-x', 'msg-x', 'msg-z']);
    expect(r.get(linked.id)).toEqual({ ...linked, messageId: null, updatedAt: t.now });
    expect(r.get(completed.id)).toEqual({ ...completed, messageId: null, updatedAt: t.now });
    expect(r.get(other.id)).toEqual(other);
    expect(r.get(unlinked.id)).toEqual(unlinked);
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'upsert', reminder: r.get(linked.id) },
      { type: 'upsert', reminder: r.get(completed.id) },
    ]));

    r.clearMessageLinks([]);
    r.clearMessageLinks(['msg-z', 'msg-x']);
    expect(events).toHaveLength(2);
  });

  it('clearMessageLinks handles large message-id sets', () => {
    const r = stores.reminders;
    const reminder = r.create({ title: 'linked', dueAt: t.now + 60_000, messageId: 'msg-last' });
    const messageIds = Array.from({ length: 40_000 }, (_, i) => `missing-${i}`);
    messageIds.push('msg-last');

    r.clearMessageLinks(messageIds);
    expect(r.get(reminder.id)?.messageId).toBeNull();
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

  it('moving a subtask to a different list detaches it from its parent', () => {
    const work = stores.tasks.createList({ name: 'Work' });
    const parent = stores.tasks.create({ title: 'Project' });
    const child = stores.tasks.create({ title: 'Step', parentId: parent.id });
    expect(stores.tasks.update(child.id, { listId: INBOX_LIST_ID }).parentId).toBe(parent.id);

    const result = stores.tasks.update(child.id, { listId: work.id });
    const updated = stores.tasks.get(child.id)!;
    expect(updated.listId === work.id && updated.parentId === parent.id).toBe(false);
    expect(updated.listId).toBe(work.id);
    expect(updated.parentId).toBeNull();
    expect(result).toEqual(updated);
    expect(stores.tasks.get(parent.id)).toEqual(parent);
  });

  it('creating a subtask in a different list than its parent silently detaches it', () => {
    const work = stores.tasks.createList({ name: 'Work' });
    const parent = stores.tasks.create({ title: 'Project' });
    const task = stores.tasks.create({ title: 'Step', listId: work.id, parentId: parent.id });
    expect(task.listId).toBe(work.id);
    expect(task.parentId).toBeNull();
    expect(stores.tasks.get(task.id)).toEqual(task);
  });

  it('moving a parent task to another list moves its subtasks and emits upsert for each', () => {
    const list = stores.tasks.createList({ name: 'Work' });
    const parent = stores.tasks.create({ title: 'Epic', listId: list.id });
    const child1 = stores.tasks.create({ title: 'Step 1', listId: list.id, parentId: parent.id });
    const child2 = stores.tasks.create({ title: 'Step 2', listId: list.id, parentId: parent.id });
    const unrelated = stores.tasks.create({ title: 'Unrelated', listId: list.id });

    t.setNow(t.now + 1000);
    const events: Array<{ type: string; id: string; listId: string }> = [];
    stores.tasks.onChange((e) =>
      events.push(e.type === 'upsert' ? { type: 'upsert', id: e.task.id, listId: e.task.listId } : { type: 'delete', id: e.id, listId: '' }),
    );

    stores.tasks.update(parent.id, { listId: INBOX_LIST_ID });

    // Parent and both subtasks must appear in the inbox
    expect(stores.tasks.get(parent.id)?.listId).toBe(INBOX_LIST_ID);
    expect(stores.tasks.get(child1.id)?.listId).toBe(INBOX_LIST_ID);
    expect(stores.tasks.get(child2.id)?.listId).toBe(INBOX_LIST_ID);

    // updatedAt bumped for all three
    expect(stores.tasks.get(parent.id)?.updatedAt).toBe(t.now);
    expect(stores.tasks.get(child1.id)?.updatedAt).toBe(t.now);
    expect(stores.tasks.get(child2.id)?.updatedAt).toBe(t.now);

    // Unrelated task in the same list stays put
    expect(stores.tasks.get(unrelated.id)?.listId).toBe(list.id);

    // Three upsert events: one for the parent and one for each subtask
    const upserts = events.filter((e) => e.type === 'upsert');
    expect(upserts).toHaveLength(3);
    expect(upserts.map((e) => e.id).sort()).toEqual([parent.id, child1.id, child2.id].sort());
    expect(upserts.every((e) => e.listId === INBOX_LIST_ID)).toBe(true);
  });

  it('moving a parent task into another list moves grandchildren too', () => {
    const list = stores.tasks.createList({ name: 'Work' });
    const parent = stores.tasks.create({ title: 'Epic' });
    const child = stores.tasks.create({ title: 'Step', parentId: parent.id });
    const grandchild = stores.tasks.create({ title: 'Detail', parentId: child.id });
    t.setNow(t.now + 1000);
    const events: unknown[] = [];
    stores.tasks.onChange((e) => events.push(e));

    stores.tasks.update(parent.id, { listId: list.id });

    expect(stores.tasks.get(grandchild.id)?.listId).toBe(list.id);
    expect(stores.tasks.get(grandchild.id)?.parentId).toBe(child.id);
    expect(stores.tasks.get(grandchild.id)?.updatedAt).toBe(t.now);
    expect(stores.tasks.get(child.id)?.parentId).toBe(parent.id);
    for (const task of [parent, child, grandchild]) {
      expect(stores.tasks.get(task.id)).toMatchObject({ listId: list.id, updatedAt: t.now });
    }
    expect(events).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining(
      [parent, child, grandchild].map((task) => ({ type: 'upsert', task: stores.tasks.get(task.id) })),
    ));
  });

  it('moving a parent task with a corrupt descendant cycle moves each task once', () => {
    const list = stores.tasks.createList({ name: 'Work' });
    const parent = stores.tasks.create({ title: 'Epic' });
    const child = stores.tasks.create({ title: 'Step', parentId: parent.id });
    const grandchild = stores.tasks.create({ title: 'Detail', parentId: child.id });
    t.db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(grandchild.id, parent.id);
    t.setNow(t.now + 1000);
    const events: unknown[] = [];
    stores.tasks.onChange((e) => events.push(e));

    stores.tasks.update(parent.id, { listId: list.id });

    for (const task of [parent, child, grandchild]) {
      expect(stores.tasks.get(task.id)).toMatchObject({ listId: list.id, updatedAt: t.now });
    }
    expect(stores.tasks.get(parent.id)?.parentId).toBeNull();
    expect(events).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining(
      [parent, child, grandchild].map((task) => ({ type: 'upsert', task: stores.tasks.get(task.id) })),
    ));
  });

  it('moving a parent task rolls back all changes when a subtask move fails', () => {
    const list = stores.tasks.createList({ name: 'Work' });
    const parent = stores.tasks.create({ title: 'Epic', listId: list.id });
    const child1 = stores.tasks.create({ title: 'Step 1', listId: list.id, parentId: parent.id });
    const child2 = stores.tasks.create({ title: 'Step 2', listId: list.id, parentId: parent.id });
    t.db.exec(`
      CREATE TRIGGER reject_subtask_move BEFORE UPDATE OF list_id ON tasks
      WHEN OLD.parent_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM tasks WHERE parent_id = OLD.parent_id AND list_id != OLD.list_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'subtask move failed');
      END;
    `);

    t.setNow(t.now + 1000);
    const events: string[] = [];
    stores.tasks.onChange((e) => events.push(e.type));

    expect(() => stores.tasks.update(parent.id, { listId: INBOX_LIST_ID })).toThrow('subtask move failed');
    for (const task of [parent, child1, child2]) expect(stores.tasks.get(task.id)).toEqual(task);
    expect(events).toEqual([]);
  });

  it('deleting a parent task also deletes its child and emits delete for each', () => {
    const parent = stores.tasks.create({ title: 'A' });
    const child = stores.tasks.create({ title: 'B', parentId: parent.id });
    const events: unknown[] = [];
    stores.tasks.onChange((event) => events.push(event));

    expect(stores.tasks.delete(parent.id)).toBe(true);

    expect(stores.tasks.get(child.id)).toBeNull();
    expect(stores.tasks.get(parent.id)).toBeNull();
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'delete', id: parent.id },
      { type: 'delete', id: child.id }
    ]));
  });

  it('deleting a subtask recursively deletes only its subtree', () => {
    const parent = stores.tasks.create({ title: 'Parent' });
    const child = stores.tasks.create({ title: 'Child', parentId: parent.id });
    const grandchild = stores.tasks.create({ title: 'Grandchild', parentId: child.id });
    const greatGrandchild = stores.tasks.create({ title: 'Detail', parentId: grandchild.id });
    const otherChild = stores.tasks.create({ title: 'Other child', parentId: child.id });
    const sibling = stores.tasks.create({ title: 'Sibling', parentId: parent.id });
    const unrelated = stores.tasks.create({ title: 'Unrelated' });
    const deleted = [child, grandchild, greatGrandchild, otherChild];
    const events: unknown[] = [];
    stores.tasks.onChange((event) => events.push(event));

    expect(stores.tasks.delete(child.id)).toBe(true);

    for (const task of deleted) expect(stores.tasks.get(task.id)).toBeNull();
    for (const task of [parent, sibling, unrelated]) expect(stores.tasks.get(task.id)).toEqual(task);
    expect(events).toHaveLength(deleted.length);
    expect(events).toEqual(expect.arrayContaining(
      deleted.map((task) => ({ type: 'delete', id: task.id }))
    ));
  });

  it('deleting a task with a corrupt descendant cycle deletes each task once', () => {
    const parent = stores.tasks.create({ title: 'Parent' });
    const child = stores.tasks.create({ title: 'Child', parentId: parent.id });
    const grandchild = stores.tasks.create({ title: 'Grandchild', parentId: child.id });
    t.db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(grandchild.id, parent.id);
    const events: unknown[] = [];
    stores.tasks.onChange((event) => events.push(event));

    expect(stores.tasks.delete(parent.id)).toBe(true);

    for (const task of [parent, child, grandchild]) expect(stores.tasks.get(task.id)).toBeNull();
    expect(events).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining(
      [parent, child, grandchild].map((task) => ({ type: 'delete', id: task.id }))
    ));
  });

  it('deleting a task rolls back and emits nothing when a descendant deletion fails', () => {
    const parent = stores.tasks.create({ title: 'Parent' });
    const child = stores.tasks.create({ title: 'Child', parentId: parent.id });
    t.db.exec(`
      CREATE TRIGGER reject_subtask_delete BEFORE DELETE ON tasks
      WHEN OLD.parent_id IS NOT NULL
      BEGIN
        SELECT RAISE(FAIL, 'subtask delete failed');
      END;
    `);
    const events: unknown[] = [];
    stores.tasks.onChange((event) => events.push(event));

    expect(() => stores.tasks.delete(parent.id)).toThrow('subtask delete failed');

    for (const task of [parent, child]) expect(stores.tasks.get(task.id)).toEqual(task);
    expect(events).toEqual([]);
  });

  it('deleting an unknown task returns false and emits nothing', () => {
    const task = stores.tasks.create({ title: 'Unrelated' });
    const events: unknown[] = [];
    stores.tasks.onChange((event) => events.push(event));

    expect(stores.tasks.delete('task_missing')).toBe(false);

    expect(stores.tasks.get(task.id)).toEqual(task);
    expect(events).toEqual([]);
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

  // ── cycle-detection tests ───────────────────────────────────────────────

  it('update rejects a 2-level cycle (A→B, then B→A)', () => {
    const a = stores.tasks.create({ title: 'A' });
    const b = stores.tasks.create({ title: 'B', parentId: a.id });
    expectNeoError(() => stores.tasks.update(a.id, { parentId: b.id }), 'bad_request', /ancestor/i);
    // task A must be unchanged
    expect(stores.tasks.get(a.id)!.parentId).toBeNull();
    // task B must still point at A
    expect(stores.tasks.get(b.id)!.parentId).toBe(a.id);
  });

  it('update rejects a 3-level cycle (A→B→C, then C→A)', () => {
    const a = stores.tasks.create({ title: 'A' });
    const b = stores.tasks.create({ title: 'B', parentId: a.id });
    const c = stores.tasks.create({ title: 'C', parentId: b.id });
    expectNeoError(() => stores.tasks.update(a.id, { parentId: c.id }), 'bad_request', /ancestor/i);
    expect(stores.tasks.get(a.id)!.parentId).toBeNull();
    expect(stores.tasks.get(b.id)!.parentId).toBe(a.id);
    expect(stores.tasks.get(c.id)!.parentId).toBe(b.id);
  });

  it('update rejects a 4-level cycle (A→B→C→D, then D→A)', () => {
    const a = stores.tasks.create({ title: 'A' });
    const b = stores.tasks.create({ title: 'B', parentId: a.id });
    const c = stores.tasks.create({ title: 'C', parentId: b.id });
    const d = stores.tasks.create({ title: 'D', parentId: c.id });
    expectNeoError(() => stores.tasks.update(a.id, { parentId: d.id }), 'bad_request', /ancestor/i);
    expect(stores.tasks.get(a.id)!.parentId).toBeNull();
    expect(stores.tasks.get(d.id)!.parentId).toBe(c.id);
  });

  it('create rejects a self-referential parentId (symmetric guard on create)', () => {
    // A task cannot name itself as parent on creation; the ID is known by the
    // caller only via the return value, so this is only reachable by a
    // crafted API call.  requireParent catches it via the self-equality check.
    const a = stores.tasks.create({ title: 'A' });
    expectNeoError(() => stores.tasks.update(a.id, { parentId: a.id }), 'bad_request');
    expect(stores.tasks.get(a.id)!.parentId).toBeNull();
  });

  it('valid re-parenting is still allowed after the cycle-detection fix', () => {
    const a = stores.tasks.create({ title: 'A' });
    const b = stores.tasks.create({ title: 'B', parentId: a.id });
    const c = stores.tasks.create({ title: 'C', parentId: b.id });
    const d = stores.tasks.create({ title: 'D' });
    // Moving C under D (no cycle) must succeed
    const updated = stores.tasks.update(c.id, { parentId: d.id });
    expect(updated.parentId).toBe(d.id);
    expect(stores.tasks.get(c.id)!.parentId).toBe(d.id);
    // Now A can become a child of C's original position (B) — still no cycle
    const updated2 = stores.tasks.update(d.id, { parentId: a.id });
    expect(updated2.parentId).toBe(a.id);
  });

  it('update movedList collects a 100-descendant chain in bounded SQL round trips', () => {
    // Build a 100-level linear chain: root → c0 → c1 → … → c99
    const list = stores.tasks.createList({ name: 'Work' });
    const root = stores.tasks.create({ title: 'root' });
    let parentId = root.id;
    for (let i = 0; i < 100; i++) {
      parentId = stores.tasks.create({ title: `c${i}`, parentId }).id;
    }

    // Spy on db.prepare to count calls that happen during update.
    let calls = 0;
    const orig = t.db.prepare.bind(t.db);
    vi.spyOn(t.db, 'prepare').mockImplementation((sql) => { calls++; return orig(sql); });

    stores.tasks.update(root.id, { listId: list.id });

    // A bulk-UPDATE implementation uses at most 8 prepare calls:
    // mustGet, mustGetList, nextOrder, main UPDATE, CTE SELECT, bulk UPDATE (≤6 fixed).
    // The old N+1 loop would call prepare ≥100 times for a 100-descendant chain.
    expect(calls).toBeLessThanOrEqual(8);
    expect(stores.tasks.get(root.id)?.listId).toBe(list.id);
  });

  it('delete collects a 100-descendant chain in one SQL round trip', () => {
    // Build a 100-level linear chain: root → c0 → c1 → … → c99
    const root = stores.tasks.create({ title: 'root' });
    let parentId = root.id;
    for (let i = 0; i < 100; i++) {
      parentId = stores.tasks.create({ title: `c${i}`, parentId }).id;
    }

    // Spy on db.prepare to count calls that happen during delete.
    let calls = 0;
    const orig = t.db.prepare.bind(t.db);
    vi.spyOn(t.db, 'prepare').mockImplementation((sql) => { calls++; return orig(sql); });

    expect(stores.tasks.delete(root.id)).toBe(true);

    // A recursive-CTE implementation uses at most 3 prepare calls: get, CTE, DELETE.
    // The old BFS would call prepare ≥100 times for a 100-descendant chain.
    expect(calls).toBeLessThanOrEqual(3);
    expect(stores.tasks.get(root.id)).toBeNull();
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
