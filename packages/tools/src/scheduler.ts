/**
 * ReminderScheduler: fires reminders on time with a single unref'd timer.
 *
 * - start(): tick(now) immediately (catch-up; late firings are flagged
 *   `missed`), subscribe to store changes, then arm().
 * - arm(): one setTimeout until the next dueAt, capped at maxTimerMs so the
 *   schedule self-corrects after sleep or clock changes.
 * - tick(now): markFired every due reminder (recurring ones advance past `now`
 *   in one step, so a long downtime fires them once), notify listeners, re-arm.
 * - Store changes re-arm through a microtask debounce (one re-arm per burst).
 *
 * Failures never escape into timer callbacks: they are logged, and the next
 * attempt is delayed (failureBackoffMs) so a broken row or database can't spin the CPU.
 */
import { silentLogger, type Clock, type Logger, type ReminderFiring, type ReminderScheduler, type ReminderStore } from '@neo/protocol';

export interface SchedulerOptions {
  reminders: ReminderStore;
  clock?: Clock;
  logger?: Logger;
  /** Firings later than this after their occurrence are flagged `missed`. Default 15 min. */
  graceMs?: number;
  /** Longest single setTimeout before re-checking (guards clock drift / sleep). Default 60 s. */
  maxTimerMs?: number;
  /** Delay before retrying after a store failure or a reminder that failed to fire. Default 10 s. */
  failureBackoffMs?: number;
}

/** setTimeout fires immediately for delays above 2^31-1 ms. */
const MAX_SET_TIMEOUT = 2 ** 31 - 1;

export function createReminderScheduler(options: SchedulerOptions): ReminderScheduler {
  const { reminders } = options;
  const clock: Clock = options.clock ?? (() => Date.now());
  const logger: Logger = options.logger ?? silentLogger;
  const graceMs = options.graceMs ?? 15 * 60_000;
  const maxTimerMs = Math.min(Math.max(options.maxTimerMs ?? 60_000, 1), MAX_SET_TIMEOUT);
  const failureBackoffMs = Math.min(Math.max(options.failureBackoffMs ?? 10_000, 1), MAX_SET_TIMEOUT);

  const listeners = new Set<(firing: ReminderFiring) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let rearmQueued = false;
  let ticking = false;
  let unsubscribe: (() => void) | null = null;
  /** Reminder id → time before which a failed markFired is not retried. */
  const retryAfter = new Map<string, number>();
  /** Set when the store itself failed; arm() waits at least this long. */
  let storeFailedUntil = 0;
  /** True once pending firings from before the last crash have been re-delivered. */
  let pendingFiringsReplayed = false;
  /** Earliest time tick() may retry pendingFirings() after a failure. */
  let pendingFiringsRetryAt = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emit = (firing: ReminderFiring) => {
    for (const listener of [...listeners]) {
      try {
        const result = listener(firing);
        if (result != null && typeof (result as { catch?: unknown }).catch === 'function') {
          (result as Promise<void>).catch(err => {
            logger.error('reminder onFire listener failed', { reminderId: firing.reminder.id, error: String(err) });
          });
        }
      } catch (err) {
        logger.error('reminder onFire listener failed', { reminderId: firing.reminder.id, error: String(err) });
      }
    }
  };

  const tick = (at?: number): ReminderFiring[] => {
    // A listener calling tick() re-entrantly gets nothing: the outer tick owns this batch.
    if (ticking) return [];
    ticking = true;
    const now = at ?? clock();
    const firings: ReminderFiring[] = [];
    try {
      // Retry pending firings replay if the startup attempt failed.
      // pendingFiringsRetryAt ensures we respect the backoff and do not re-attempt
      // in the same synchronous tick that start() triggers immediately after the failure.
      if (!pendingFiringsReplayed && reminders.pendingFirings && now >= pendingFiringsRetryAt) {
        try {
          const pending = reminders.pendingFirings();
          pendingFiringsReplayed = true;
          for (const firing of pending) {
            try {
              emit(firing);
            } catch (err) {
              logger.error('reminder pending firing re-delivery failed', { reminderId: firing.reminder.id, error: String(err) });
            }
          }
        } catch (err) {
          pendingFiringsRetryAt = clock() + failureBackoffMs;
          storeFailedUntil = clock() + failureBackoffMs;
          logger.error('reminder pending firing re-delivery failed', { error: String(err) });
          // Fall through to due() — a different query may still work.
        }
      }
      let due;
      try {
        due = reminders.due(now);
      } catch (err) {
        storeFailedUntil = clock() + failureBackoffMs;
        logger.error('reminder scheduler could not read due reminders', { error: String(err) });
        return firings;
      }
      // Forget failures of reminders that are no longer due (deleted, completed, rescheduled).
      const dueIds = new Set(due.map((r) => r.id));
      for (const id of retryAfter.keys()) if (!dueIds.has(id)) retryAfter.delete(id);
      for (const candidate of due) {
        const retry = retryAfter.get(candidate.id);
        if (retry !== undefined && retry > now) continue;
        try {
          // Re-read: an earlier listener in this batch may have snoozed, completed or deleted it.
          const current = reminders.get(candidate.id);
          if (!current || current.status !== 'scheduled' || current.dueAt > now) continue;
          const missed = now - current.dueAt > graceMs;
          const firing = reminders.markFired(current.id, now, missed);
          retryAfter.delete(current.id);
          const final: ReminderFiring = { ...firing, missed };
          firings.push(final);
          emit(final);
        } catch (err) {
          retryAfter.set(candidate.id, now + failureBackoffMs);
          logger.error('reminder could not be fired', { reminderId: candidate.id, error: String(err) });
        }
      }
      return firings;
    } finally {
      ticking = false;
      if (started) arm();
    }
  };

  const arm = () => {
    clearTimer();
    if (!started) return;
    const now = clock();
    let nextDeadline = Infinity;
    try {
      const retryIds = retryAfter.size > 0 ? new Set(retryAfter.keys()) : undefined;
      const next = reminders.nextDue(retryIds);
      if (next) nextDeadline = Math.min(nextDeadline, next.dueAt);
      for (const retryAt of retryAfter.values()) {
        nextDeadline = Math.min(nextDeadline, retryAt);
      }
    } catch (err) {
      storeFailedUntil = now + failureBackoffMs;
      logger.error('reminder scheduler could not read the next reminder', { error: String(err) });
    }
    let delay = nextDeadline === Infinity ? maxTimerMs : Math.max(0, nextDeadline - now);
    if (storeFailedUntil > now) delay = Math.max(delay, storeFailedUntil - now);
    timer = setTimeout(onTimer, Math.min(delay, maxTimerMs));
    (timer as { unref?: () => void }).unref?.();
  };

  function onTimer() {
    timer = null;
    if (!started) return;
    try {
      tick();
    } catch (err) {
      logger.error('reminder scheduler tick failed', { error: String(err) });
      if (started && timer === null) arm();
    }
  }

  const reschedule = () => {
    if (!started || rearmQueued) return;
    rearmQueued = true;
    queueMicrotask(() => {
      rearmQueued = false;
      // A tick in progress re-arms when it finishes.
      if (started && !ticking) arm();
    });
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribe = reminders.onChange(() => reschedule());
      // Re-deliver any firings committed before the last crash but not yet acknowledged.
      pendingFiringsReplayed = false;
      pendingFiringsRetryAt = 0;
      if (reminders.pendingFirings) {
        try {
          const pending = reminders.pendingFirings();
          pendingFiringsReplayed = true;
          for (const firing of pending) {
            try {
              emit(firing);
            } catch (err) {
              logger.error('reminder pending firing re-delivery failed', { reminderId: firing.reminder.id, error: String(err) });
            }
          }
        } catch (err) {
          logger.error('reminder pending firing re-delivery failed', { error: String(err) });
          pendingFiringsRetryAt = clock() + failureBackoffMs;
          storeFailedUntil = clock() + failureBackoffMs; // arm() delays until retry is due
        }
      } else {
        pendingFiringsReplayed = true;
      }
      tick(clock()); // catch-up; re-arms when done
    },

    stop() {
      started = false;
      rearmQueued = false;
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;
    },

    reschedule,

    tick,

    onFire(listener: (firing: ReminderFiring) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
