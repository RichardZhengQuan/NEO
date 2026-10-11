/** Review tests for the reminder scheduler. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase } from '@neo/storage';
import type { Logger, ReminderFiring, ReminderStore } from '@neo/protocol';
import { createProductivityStores, toolsMigrations } from './stores/index.js';
import { createReminderScheduler } from './scheduler.js';

const START = Date.UTC(2026, 9, 10, 8, 0);
const MIN = 60_000;

function makeStore() {
  const db = openDatabase(':memory:');
  migrate(db, 'tools', toolsMigrations);
  return createProductivityStores(db, { clock: () => Date.now(), defaultTimezone: 'UTC' }).reminders;
}

function recordingLogger() {
  const errors: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (m) => errors.push(m),
    error: (m) => errors.push(m),
    child: () => logger,
  };
  return { logger, errors };
}

describe('ReminderScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('catch-up fires each overdue reminder once, collapses recurring ones and flags missed by grace', () => {
    const store = makeStore();
    const late = store.create({ title: 'late', dueAt: START - 60 * MIN });
    const recent = store.create({ title: 'recent', dueAt: START - 5 * MIN });
    const daily = store.create({ title: 'daily', dueAt: START - 5 * 24 * 60 * MIN, recurrence: { freq: 'daily' } });
    const future = store.create({ title: 'future', dueAt: START + 60 * MIN });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const fired: ReminderFiring[] = [];
    scheduler.onFire((f) => fired.push(f));
    scheduler.start();

    expect(fired.map((f) => f.reminder.id).sort()).toEqual([late.id, recent.id, daily.id].sort());
    const byId = new Map(fired.map((f) => [f.reminder.id, f]));
    expect(byId.get(late.id)?.missed).toBe(true);
    expect(byId.get(recent.id)?.missed).toBe(false);
    expect(byId.get(daily.id)?.missed).toBe(true);
    expect(byId.get(daily.id)?.reminder.dueAt).toBe(START - 5 * 24 * 60 * MIN + 6 * 24 * 60 * MIN); // tomorrow 08:00, past now
    expect(store.get(future.id)?.status).toBe('scheduled');
    scheduler.stop();
  });

  it('arms capped, unref-ed timers and fires on time', async () => {
    const store = makeStore();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now(), maxTimerMs: 30_000 });
    const fired: string[] = [];
    scheduler.onFire((f) => fired.push(f.reminder.title));
    scheduler.start();
    store.create({ title: 'in 2 min', dueAt: START + 2 * MIN });
    await vi.advanceTimersByTimeAsync(0);

    const delays = spy.mock.calls.map((c) => c[1] ?? 0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    for (const r of spy.mock.results) {
      const handle = r.value as { hasRef?: () => boolean };
      expect(handle.hasRef?.()).toBe(false);
    }

    await vi.advanceTimersByTimeAsync(2 * MIN - 1);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(['in 2 min']);
    scheduler.stop();
  });

  it('clamps an oversized maxTimerMs to what setTimeout supports', async () => {
    const store = makeStore();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    store.create({ title: 'far', dueAt: START + 60 * 24 * 60 * MIN });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now(), maxTimerMs: 1e12 });
    scheduler.start();
    expect(Math.max(...spy.mock.calls.map((c) => c[1] ?? 0))).toBeLessThanOrEqual(2 ** 31 - 1);
    scheduler.stop();
  });

  it('re-arms once per burst of store changes (debounced)', async () => {
    const store = makeStore();
    let nextDueCalls = 0;
    const counting: ReminderStore = { ...store, nextDue: () => (nextDueCalls++, store.nextDue()) };
    const scheduler = createReminderScheduler({ reminders: counting, clock: () => Date.now() });
    scheduler.start();
    nextDueCalls = 0;
    for (let i = 0; i < 10; i++) store.create({ title: `r${i}`, dueAt: START + (i + 1) * MIN });
    await vi.advanceTimersByTimeAsync(0);
    expect(nextDueCalls).toBe(1);
    scheduler.stop();
  });

  it('stop() clears every timer and ignores later store changes', async () => {
    const store = makeStore();
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const fired: string[] = [];
    scheduler.onFire((f) => fired.push(f.reminder.title));
    scheduler.start();
    store.create({ title: 'soon', dueAt: START + MIN });
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    store.create({ title: 'later', dueAt: START + 2 * MIN });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(fired).toEqual([]);
  });

  it('listener errors are logged and do not stop other listeners', () => {
    const store = makeStore();
    store.create({ title: 'a', dueAt: START });
    const { logger, errors } = recordingLogger();
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now(), logger });
    const seen: string[] = [];
    scheduler.onFire(() => {
      throw new Error('listener boom');
    });
    scheduler.onFire((f) => seen.push(f.reminder.title));
    scheduler.start();
    expect(seen).toEqual(['a']);
    expect(errors.length).toBeGreaterThan(0);
    scheduler.stop();
  });

  it('never double-fires when tick() re-enters from a listener', () => {
    const store = makeStore();
    store.create({ title: 'a', dueAt: START - 1000 });
    store.create({ title: 'b', dueAt: START - 500 });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const fired: string[] = [];
    scheduler.onFire((f) => {
      fired.push(f.reminder.title);
      scheduler.tick();
    });
    scheduler.tick();
    scheduler.tick();
    expect(fired.sort()).toEqual(['a', 'b']);
  });

  it('skips a reminder that a listener snoozed while the batch was firing', () => {
    const store = makeStore();
    const a = store.create({ title: 'a', dueAt: START - 1000 });
    const b = store.create({ title: 'b', dueAt: START - 500 });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const fired: string[] = [];
    scheduler.onFire((f) => {
      fired.push(f.reminder.title);
      if (f.reminder.id === a.id) store.snooze(b.id, 10);
    });
    scheduler.tick();
    expect(fired).toEqual(['a']);
    expect(store.get(b.id)?.status).toBe('scheduled');
  });

  it('survives a failing store: start() does not throw and the timer does not spin', async () => {
    const store = makeStore();
    store.create({ title: 'a', dueAt: START + MIN });
    let dueCalls = 0;
    const broken: ReminderStore = {
      ...store,
      due: () => {
        dueCalls++;
        throw new Error('database is locked');
      },
    };
    const { logger, errors } = recordingLogger();
    const scheduler = createReminderScheduler({ reminders: broken, clock: () => Date.now(), logger });
    expect(() => scheduler.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(errors.length).toBeGreaterThan(0);
    expect(dueCalls).toBeLessThan(60);
    scheduler.stop();
  });

  it('a reminder that cannot be marked fired does not block the others or spin the timer', async () => {
    const store = makeStore();
    const poison = store.create({ title: 'poison', dueAt: START - 1000 });
    store.create({ title: 'ok', dueAt: START - 500 });
    let attempts = 0;
    const flaky: ReminderStore = {
      ...store,
      markFired: (id, at) => {
        if (id === poison.id) {
          attempts++;
          throw new Error('corrupt row');
        }
        return store.markFired(id, at);
      },
    };
    const { logger } = recordingLogger();
    const scheduler = createReminderScheduler({ reminders: flaky, clock: () => Date.now(), logger });
    const fired: string[] = [];
    scheduler.onFire((f) => fired.push(f.reminder.title));
    scheduler.start();
    expect(fired).toEqual(['ok']);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(attempts).toBeLessThan(60);
    scheduler.stop();
  });
});
