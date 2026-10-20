import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase } from '@neo/storage';
import { NeoError, type ReminderInput } from '@neo/protocol';
import { createProductivityStores, toolsMigrations } from './stores/index.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db, 'tools', toolsMigrations);
  let now = Date.parse('2026-10-12T08:00:00Z');
  const stores = createProductivityStores(db, { clock: () => now, defaultTimezone: 'UTC' });
  return { db, reminders: stores.reminders, setNow: (next: number) => { now = next; } };
}
const input = (): ReminderInput => ({ title: 'Prepare proposal', dueAt: Date.parse('2026-10-13T09:00:00Z'), notes: null,
  timezone: 'UTC', recurrence: null, creationKey: 'fdd8d6cb-021a-4fa6-9c8f-8c56704086cc' });

function expectConflict(action: () => unknown) {
  try { action(); throw new Error('Expected a creation key conflict'); }
  catch (error) { expect(error).toBeInstanceOf(NeoError); expect((error as NeoError).code).toBe('conflict'); }
}

describe('reminder creation keys', () => {
  it('replays one normalized creation without another row, timestamp change or event', () => {
    const h = setup();
    const changed = vi.fn();
    h.reminders.onChange(changed);
    const original = h.reminders.create(input());
    h.setNow(Date.parse('2026-10-12T09:00:00Z'));
    const replay = h.reminders.create({ ...input(), title: '  Prepare proposal  ', dueAt: input().dueAt + 0.2, timezone: undefined, notes: undefined, recurrence: undefined });
    expect(replay).toEqual(original);
    expect(h.reminders.list()).toEqual([original]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(original.notes).toBeNull();
    expect(original.creationKey).toBe(input().creationKey);
  });

  it.each([
    { title: 'Different proposal' }, { notes: 'Different notes' }, { dueAt: Date.parse('2026-10-13T10:00:00Z') },
    { timezone: 'Asia/Singapore' }, { recurrence: { freq: 'daily' as const } }, { messageId: 'different-source' },
  ])('rejects reuse with different creation values: %j', (patch) => {
    const h = setup();
    const original = h.reminders.create(input());
    const changed = vi.fn();
    h.reminders.onChange(changed);
    expectConflict(() => h.reminders.create({ ...input(), ...patch }));
    expect(h.reminders.list()).toEqual([original]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('compares normalized recurrence days and defaults rather than object property order', () => {
    const h = setup();
    const original = h.reminders.create({ ...input(), recurrence: { freq: 'weekly', byWeekday: [3, 1, 3] } });
    expect(h.reminders.create({ ...input(), recurrence: { byWeekday: [1, 3], interval: 1, freq: 'weekly' } })).toEqual(original);
    expect(h.reminders.list()).toHaveLength(1);
  });

  it('preserves accepted creation identity after editing, snoozing, completing and reconstructing the store', () => {
    const h = setup();
    const original = h.reminders.create(input());
    h.reminders.update(original.id, { title: 'Updated by the user', notes: 'Human notes only' });
    h.reminders.snooze(original.id, 10);
    h.reminders.complete(original.id);
    const current = h.reminders.get(original.id)!;
    const reopened = createProductivityStores(h.db, { clock: () => Date.parse('2026-10-14T08:00:00Z'), defaultTimezone: 'UTC' }).reminders;
    const changed = vi.fn();
    reopened.onChange(changed);
    expect(reopened.create(input())).toEqual(current);
    expect(reopened.list()).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps retry identity after a recurring reminder advances its next due time', () => {
    const h = setup();
    const request = { ...input(), recurrence: { freq: 'daily' as const } };
    const original = h.reminders.create(request);
    h.reminders.markFired(original.id, original.dueAt);
    const advanced = h.reminders.get(original.id)!;
    expect(advanced.dueAt).toBeGreaterThan(original.dueAt);
    expect(h.reminders.create(request)).toEqual(advanced);
    expect(h.reminders.list()).toHaveLength(1);
  });

  it('keeps a deleted creation key consumed across store reconstruction while a fresh key can intentionally create again', () => {
    const h = setup();
    const changed = vi.fn();
    h.reminders.onChange(changed);
    const original = h.reminders.create(input());
    h.setNow(Date.parse('2026-10-12T09:00:00Z'));
    expect(h.reminders.delete(original.id)).toBe(true);
    expect(h.reminders.delete(original.id)).toBe(false);
    expectConflict(() => h.reminders.create(input()));
    expectConflict(() => h.reminders.create({ ...input(), title: 'Changed deleted reminder' }));
    const reopened = createProductivityStores(h.db, { clock: () => Date.parse('2026-10-14T08:00:00Z') }).reminders;
    expectConflict(() => reopened.create(input()));
    expect(reopened.list()).toEqual([]);
    expect(h.db.prepare('SELECT * FROM reminder_creation_tombstones').all()).toEqual([
      { creation_key: input().creationKey, deleted_at: Date.parse('2026-10-12T09:00:00Z') },
    ]);
    expect(changed.mock.calls.map(([event]) => event.type)).toEqual(['upsert', 'delete']);
    const replacement = reopened.create({ ...input(), creationKey: '7f54c0c3-5b1e-4e77-bc2a-148cacb13f5c' });
    expect(replacement.id).not.toBe(original.id);
    expect(reopened.list()).toEqual([replacement]);
  });

  it('rolls deletion back if its consumed-key record cannot be saved', () => {
    const h = setup();
    const original = h.reminders.create(input());
    const changed = vi.fn();
    h.reminders.onChange(changed);
    h.db.exec(`CREATE TRIGGER reject_reminder_tombstone BEFORE INSERT ON reminder_creation_tombstones
      BEGIN SELECT RAISE(ABORT, 'Tombstone unavailable'); END`);
    expect(() => h.reminders.delete(original.id)).toThrow('Tombstone unavailable');
    expect(h.reminders.get(original.id)).toEqual(original);
    expect(h.reminders.create(input())).toEqual(original);
    expect(h.db.prepare('SELECT * FROM reminder_creation_tombstones').all()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('allows unkeyed clients to create again after deletion without consuming a key', () => {
    const h = setup();
    const { creationKey: _key, ...unkeyed } = input();
    const original = h.reminders.create(unkeyed);
    expect(h.reminders.delete(original.id)).toBe(true);
    const replacement = h.reminders.create(unkeyed);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement).not.toHaveProperty('creationKey');
    expect(h.reminders.list()).toEqual([replacement]);
    expect(h.db.prepare('SELECT * FROM reminder_creation_tombstones').all()).toEqual([]);
  });

  it('retains legacy unkeyed creation behavior and rejects unusable keys', () => {
    const h = setup();
    const { creationKey: _key, ...unkeyed } = input();
    const one = h.reminders.create(unkeyed);
    const two = h.reminders.create(unkeyed);
    expect(one.id).not.toBe(two.id);
    expect(one).not.toHaveProperty('creationKey');
    expect(h.reminders.list()).toHaveLength(2);
    for (const key of ['', '   ', 'x'.repeat(257)]) expect(() => h.reminders.create({ ...input(), creationKey: key })).toThrow(/creationKey/);
  });

  it('upgrades an already applied creation-key migration and retains an existing keyed reminder', () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    migrate(db, 'tools', toolsMigrations.filter((migration) => migration.version <= 7));
    const request = input();
    db.prepare(`INSERT INTO reminders
      (id,title,notes,due_at,anchor_at,timezone,creation_key,creation_fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('keyed-v7', request.title, null, request.dueAt, request.dueAt, 'UTC', request.creationKey!, 'existing-v7-fingerprint', 1, 1);
    expect(migrate(db, 'tools', toolsMigrations).applied).toEqual([8, 9]);
    expect(migrate(db, 'tools', toolsMigrations).applied).toEqual([]);
    const reminders = createProductivityStores(db, { clock: () => 200 }).reminders;
    expect(reminders.get('keyed-v7')).toMatchObject({ id: 'keyed-v7', creationKey: request.creationKey, title: request.title });
    expect(reminders.delete('keyed-v7')).toBe(true);
    expectConflict(() => reminders.create(request));
    expect(reminders.list()).toEqual([]);
    expect(db.prepare('SELECT * FROM reminder_creation_tombstones').all()).toEqual([{ creation_key: request.creationKey, deleted_at: 200 }]);
  });

  it('migrates existing reminders without inventing keys and applies the migration only once', () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    migrate(db, 'tools', toolsMigrations.filter((migration) => migration.version < 7));
    db.prepare('INSERT INTO reminders (id,title,notes,due_at,anchor_at,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('legacy', 'Existing', 'Human note', 100, 100, 'UTC', 1, 1);
    migrate(db, 'tools', toolsMigrations);
    migrate(db, 'tools', toolsMigrations);
    const reminders = createProductivityStores(db, { clock: () => 200 }).reminders;
    expect(reminders.get('legacy')).toMatchObject({ id: 'legacy', notes: 'Human note' });
    expect(reminders.get('legacy')).not.toHaveProperty('creationKey');
    const first = reminders.create(input());
    expect(reminders.create(input()).id).toBe(first.id);
    expect(db.prepare('SELECT creation_key FROM reminders WHERE id = ?').get('legacy')).toEqual({ creation_key: null });
    expect(() => db.prepare('UPDATE reminders SET creation_key = ? WHERE id = ?').run(input().creationKey!, 'legacy')).toThrow(/UNIQUE/);
  });
});
