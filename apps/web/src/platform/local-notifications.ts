/**
 * Planning on-device reminder notifications (Capacitor).
 *
 * The OS limits how many notifications an app may schedule (iOS: 64), so we
 * schedule the next 64 upcoming reminders and re-plan whenever reminders
 * change, the app reconnects or comes back to the foreground. Notification ids
 * must be 31-bit integers; they are a stable hash of the reminder id so a
 * re-plan replaces instead of duplicating.
 */
import type { Reminder } from '@neo/protocol';

export const MAX_LOCAL_NOTIFICATIONS = 64;

/** Stable positive 31-bit id (FNV-1a) for a reminder id; never 0. */
export function notificationIdFor(reminderId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < reminderId.length; i++) {
    h ^= reminderId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const id = (h >>> 0) & 0x7fffffff;
  return id === 0 ? 1 : id;
}

export interface PlannedNotification {
  id: number;
  reminderId: string;
  title: string;
  body: string;
  /** Epoch ms. */
  at: number;
  /** Deep link opened on tap. */
  url: string;
}

/**
 * Upcoming scheduled reminders → notifications, soonest first, at most `max`.
 * Past, completed and cancelled reminders are skipped. Hash collisions (very
 * unlikely) are resolved by probing so ids stay unique within a plan.
 */
export function planReminderNotifications(
  reminders: readonly Reminder[],
  now: number,
  options: { max?: number; defaultBody?: string } = {},
): PlannedNotification[] {
  const max = options.max ?? MAX_LOCAL_NOTIFICATIONS;
  const upcoming = reminders
    .filter((r) => r.status === 'scheduled' && Number.isFinite(r.dueAt) && r.dueAt > now)
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
    .slice(0, max);
  const used = new Set<number>();
  return upcoming.map((r) => {
    let id = notificationIdFor(r.id);
    while (used.has(id)) id = id >= 0x7fffffff ? 1 : id + 1;
    used.add(id);
    return {
      id,
      reminderId: r.id,
      title: r.title,
      body: r.notes?.trim() || options.defaultBody || '',
      at: r.dueAt,
      url: `neo://reminders/${r.id}`,
    };
  });
}

/** Pending notification ids that are no longer part of the plan. */
export function staleNotificationIds(pending: readonly { id: number }[], plan: readonly PlannedNotification[]): number[] {
  const keep = new Set(plan.map((p) => p.id));
  return pending.map((p) => p.id).filter((id) => !keep.has(id));
}
