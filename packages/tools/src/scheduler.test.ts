/** Review tests for the reminder scheduler. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase } from '@neo/storage';
import type { Logger, ReminderFiring, ReminderStore } from '@neo/protocol';
import { createProductivityStores, toolsMigrations } from './stores/index.js';
import { createReminderScheduler } from './scheduler.js';

const START = Date.UTC(2026, 9, 10, 8, 0);
const MIN = 60_000;

function makeStore(db = openDatabase(':memory:')) {
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

  it('firing survives a notifier failure', () => {
    const store = makeStore();
    const r = store.create({ title: 'ping', dueAt: START });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    let deliveries = 0;
    scheduler.onFire(firing => {
      deliveries++;
      // Simulate a failed notification by leaving the first delivery pending.
      if (deliveries === 1) return;
      if (firing.pendingFiringId) {
        store.clearPendingFiring?.(firing.pendingFiringId);
        store.clearPendingFiring?.(firing.pendingFiringId); // Clearing twice is harmless.
      }
    });
    scheduler.start();
    expect(store.get(r.id)!.firedCount).toBe(1);
    expect(store.pendingFirings?.()?.length, 'a failed notification must leave a pending firing for restart').toBe(1);
    scheduler.stop();

    scheduler.start();
    expect(deliveries, 'restart must re-deliver the uncleared firing').toBe(2);
    expect(store.get(r.id)!.firedCount, 're-delivery must not advance the reminder again').toBe(1);
    expect(store.pendingFirings?.()?.length).toBe(0);
    scheduler.stop();
  });

  it('replays recurring firing metadata without changing reminder state or emitting a change', () => {
    const store = makeStore();
    const r = store.create({ title: 'daily', dueAt: START - 2 * MIN, recurrence: { freq: 'daily' } });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now(), graceMs: MIN });
    const fired = scheduler.tick();
    expect(fired[0]).toMatchObject({ occurrenceAt: START - 2 * MIN, firedAt: START, missed: true });
    expect(store.pendingFirings?.()).toEqual(fired);
    const state = store.get(r.id);
    const change = vi.fn();
    store.onChange(change);
    vi.setSystemTime(START + MIN);

    // A fresh scheduler has no in-memory firing state, and may use a different grace period.
    const restarted = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const replayed: ReminderFiring[] = [];
    restarted.onFire(firing => {
      replayed.push(firing);
      store.clearPendingFiring?.(firing.pendingFiringId!);
    });
    restarted.start();
    expect(replayed).toEqual(fired);
    expect(store.get(r.id)).toEqual(state);
    expect(change).not.toHaveBeenCalled();
    expect(store.pendingFirings?.()).toEqual([]);
    restarted.stop();
  });

  it('records and replays a snoozed recurring firing without consuming another occurrence', () => {
    const store = makeStore();
    const r = store.create({ title: 'daily', dueAt: START, recurrence: { freq: 'daily' } });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const first = scheduler.tick()[0]!;
    store.clearPendingFiring?.(first.pendingFiringId!);
    store.snooze(r.id, 10);
    vi.setSystemTime(START + 10 * MIN);
    const snoozed = scheduler.tick()[0]!;
    expect(snoozed).toMatchObject({ occurrenceAt: START + 10 * MIN, nextDueAt: START + 24 * 60 * MIN });
    expect(store.get(r.id)?.firedCount).toBe(1);
    expect(store.pendingFirings?.()).toEqual([snoozed]);
    const state = store.get(r.id);
    const replayed: ReminderFiring[] = [];
    scheduler.onFire(firing => {
      replayed.push(firing);
      store.clearPendingFiring?.(firing.pendingFiringId!);
    });
    scheduler.start();
    expect(replayed).toEqual([snoozed]);
    expect(store.get(r.id)).toEqual(state);
    expect(store.pendingFirings?.()).toEqual([]);
    scheduler.stop();
  });

  it('retains older pending recurring firings after a later occurrence fires', () => {
    const store = makeStore();
    const r = store.create({ title: 'daily', dueAt: START, recurrence: { freq: 'daily' } });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const first = scheduler.tick()[0]!;
    vi.setSystemTime(START + 24 * 60 * MIN);
    const second = scheduler.tick()[0]!;
    expect(store.pendingFirings?.()?.map(f => f.pendingFiringId)).toEqual([first.pendingFiringId, second.pendingFiringId]);
    const state = store.get(r.id);
    const replayed: ReminderFiring[] = [];
    scheduler.onFire(firing => {
      replayed.push(firing);
      store.clearPendingFiring?.(firing.pendingFiringId!);
    });
    scheduler.start();
    expect(replayed.map(f => f.occurrenceAt)).toEqual([START, START + 24 * 60 * MIN]);
    // Each replayed firing carries the firedCount at the time it was recorded, not the
    // current (post-all-firings) count — this is what allows the handler to deduplicate.
    expect(replayed[0]!.reminder.firedCount).toBe(1);
    expect(replayed[0]!.reminder.lastFiredAt).toBe(START);
    expect(replayed[1]!.reminder.firedCount).toBe(2);
    expect(replayed[1]!.reminder.lastFiredAt).toBe(START + 24 * 60 * MIN);
    expect(store.get(r.id)).toEqual(state);
    expect(store.get(r.id)?.firedCount).toBe(2);
    expect(store.pendingFirings?.()).toEqual([]);
    scheduler.stop();
  });

  it.each(['deleted', 'completed', 'cancelled'] as const)('discards pending firings for a %s reminder', status => {
    const db = openDatabase(':memory:');
    const store = makeStore(db);
    const r = store.create({ title: 'ping', dueAt: START });
    store.markFired(r.id, START);
    if (status === 'deleted') store.delete(r.id);
    else if (status === 'completed') store.complete(r.id);
    else store.update(r.id, { status });

    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    const listener = vi.fn();
    scheduler.onFire(listener);
    scheduler.start();
    expect(listener).not.toHaveBeenCalled();
    expect(store.pendingFirings?.()).toEqual([]);
    expect(db.prepare('SELECT * FROM pending_firings').all()).toEqual([]);
    scheduler.stop();
    db.close();
  });

  it.each([false, true])('rolls back the status advance if the pending write fails (snoozed: %s)', snoozed => {
    const db = openDatabase(':memory:');
    const store = makeStore(db);
    const r = store.create({ title: 'daily', dueAt: START, recurrence: { freq: 'daily' } });
    if (snoozed) {
      const firing = store.markFired(r.id, START);
      store.clearPendingFiring?.(firing.pendingFiringId!);
      store.snooze(r.id, 10);
      vi.setSystemTime(START + 10 * MIN);
    }
    const state = store.get(r.id);
    const change = vi.fn();
    store.onChange(change);
    db.exec(`CREATE TRIGGER fail_pending BEFORE INSERT ON pending_firings BEGIN SELECT RAISE(ABORT, 'pending write failed'); END;`);

    expect(() => store.markFired(r.id, Date.now())).toThrow('pending write failed');
    expect(store.get(r.id)).toEqual(state);
    expect(change).not.toHaveBeenCalled();
    expect(store.pendingFirings?.()).toEqual([]);
    db.close();
  });

  it('markFired with missed=true returns a firing with missed set to true', () => {
    const store = makeStore();
    const r = store.create({ title: 'late', dueAt: START - 60 * MIN });
    const firing = store.markFired(r.id, START, true);
    expect(firing.missed).toBe(true);
    const notMissed = store.create({ title: 'on-time', dueAt: START });
    const firing2 = store.markFired(notMissed.id, START, false);
    expect(firing2.missed).toBe(false);
  });

  it('retries pending firing replay on the next tick after backoff when the store was initially broken', async () => {
    const store = makeStore();
    // Fire a one-time reminder but do not clear the pending firing so it waits for replay.
    const r = store.create({ title: 'ping', dueAt: START - MIN });
    const seeder = createReminderScheduler({ reminders: store, clock: () => Date.now() });
    seeder.onFire(() => {}); // don't clear — leave firing pending
    seeder.tick();
    seeder.stop();
    expect(store.pendingFirings?.()).toHaveLength(1);

    // Wrap the store so pendingFirings() fails on the first call only.
    let pendingCallCount = 0;
    const flaky: ReminderStore = {
      ...store,
      pendingFirings: () => {
        pendingCallCount++;
        if (pendingCallCount === 1) throw new Error('database is locked');
        return store.pendingFirings!();
      },
    };
    const { logger, errors } = recordingLogger();
    const scheduler = createReminderScheduler({ reminders: flaky, clock: () => Date.now(), failureBackoffMs: MIN, logger });
    const replayed: ReminderFiring[] = [];
    scheduler.onFire(firing => {
      replayed.push(firing);
      store.clearPendingFiring?.(firing.pendingFiringId!);
    });

    scheduler.start();
    expect(replayed).toHaveLength(0); // not yet — pendingFirings() failed
    expect(errors).toContain('reminder pending firing re-delivery failed');

    // Advance past the backoff; the next tick retries pendingFirings() which now succeeds.
    await vi.advanceTimersByTimeAsync(MIN + 1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.reminder.id).toBe(r.id);
    expect(store.pendingFirings?.()).toHaveLength(0);
    scheduler.stop();
  });

  it('logs a pending read failure and still fires due reminders on start', () => {
    const store = makeStore();
    store.create({ title: 'ping', dueAt: START });
    const broken: ReminderStore = { ...store, pendingFirings: () => { throw new Error('database is locked'); } };
    const { logger, errors } = recordingLogger();
    const scheduler = createReminderScheduler({ reminders: broken, clock: () => Date.now(), logger });
    const listener = vi.fn();
    scheduler.onFire(listener);
    expect(() => scheduler.start()).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(errors).toContain('reminder pending firing re-delivery failed');
    scheduler.stop();
  });

  it('logs async listener failures and keeps the firing pending for restart', async () => {
    const store = makeStore();
    store.create({ title: 'ping', dueAt: START });
    const { logger } = recordingLogger();
    const failed = new Promise<void>(resolve => {
      vi.spyOn(logger, 'error').mockImplementation(() => resolve());
    });
    const scheduler = createReminderScheduler({ reminders: store, clock: () => Date.now(), logger });
    let deliveries = 0;
    scheduler.onFire(async firing => {
      deliveries++;
      if (deliveries === 1) throw new Error('notification failed');
      store.clearPendingFiring?.(firing.pendingFiringId!);
    });
    const other = vi.fn();
    scheduler.onFire(other);
    scheduler.start();
    await failed;
    expect(other).toHaveBeenCalledOnce();
    expect(store.pendingFirings?.()).toHaveLength(1);
    scheduler.stop();
    scheduler.start();
    expect(deliveries).toBe(2);
    expect(store.pendingFirings?.()).toEqual([]);
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

  it('a failing markFired on A does not delay reminder B due inside the retry window', async () => {
    const store = makeStore();
    const a = store.create({ title: 'A', dueAt: START });
    store.create({ title: 'B', dueAt: START + 1000 });
    const flaky: ReminderStore = {
      ...store,
      markFired: (id, firedAt, missed) => {
        if (id === a.id) throw new Error('corrupt row');
        return store.markFired(id, firedAt, missed);
      },
    };
    const { logger } = recordingLogger();
    const scheduler = createReminderScheduler({
      reminders: flaky,
      clock: () => Date.now(),
      failureBackoffMs: 10_000,
      logger,
    });
    const fired: string[] = [];
    scheduler.onFire((f) => fired.push(f.reminder.title));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toContain('B');
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

  it('arm() does not spin when nextDue() ignores excludeIds and returns a retrying reminder', async () => {
    // A store whose nextDue() ignores the excludeIds argument simulates a third-party
    // or legacy implementation. When reminder A is in retry state (retryAfter map),
    // arm() must not use A.dueAt (past) as the next deadline — doing so produces a 0 ms
    // delay and a CPU spin. The guard `!(retryIds?.has(next.id))` prevents this.
    const store = makeStore();
    const a = store.create({ title: 'A', dueAt: START });
    store.create({ title: 'B', dueAt: START + 30_000 });
    let armCount = 0;
    const ignoringExclude: ReminderStore = {
      ...store,
      nextDue: (_excludeIds?: ReadonlySet<string>) => store.nextDue(), // intentionally ignores excludeIds
      markFired: (id, firedAt, missed) => {
        if (id === a.id) throw new Error('corrupt row');
        return store.markFired(id, firedAt, missed);
      },
    };
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { logger } = recordingLogger();
    const scheduler = createReminderScheduler({
      reminders: ignoringExclude,
      clock: () => Date.now(),
      failureBackoffMs: 10_000,
      logger,
    });
    scheduler.start();
    armCount = setTimeoutSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    // With the spin the timer would have fired hundreds of times; with the fix it fires at most a handful.
    expect(setTimeoutSpy.mock.calls.length - armCount).toBeLessThan(20);
    scheduler.stop();
    setTimeoutSpy.mockRestore();
  });
});
