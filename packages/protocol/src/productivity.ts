/** Reminders, tasks, notes and notifications — NEO's built-in productivity data. */
import { z } from 'zod';

// ───────────────────────────── reminders ─────────────────────────────

/**
 * Recurrence rule (a pragmatic RRULE subset), evaluated in the reminder's
 * IANA timezone so "every day at 9:00" survives DST changes.
 */
export const RecurrenceSchema = z.object({
  freq: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(1000).default(1),
  /** Weekly: 0=Sunday … 6=Saturday. */
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  /** Monthly: 1..31, or -1 for the last day of the month. */
  byMonthDay: z.array(z.number().int().min(-1).max(31).refine((d) => d !== 0)).max(31).optional(),
  /** Stop after this many occurrences in total. */
  count: z.number().int().min(1).optional(),
  /** Stop after this instant (epoch ms). */
  until: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15).optional(),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;
export type RecurrenceInput = z.input<typeof RecurrenceSchema>;

export const ReminderStatusSchema = z.enum(['scheduled', 'fired', 'completed', 'cancelled']);
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;

export const ReminderSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(500),
  notes: z.string().max(5000).nullable(),
  /** Next time it should fire (epoch ms). */
  dueAt: z.number(),
  timezone: z.string(),
  recurrence: RecurrenceSchema.nullable(),
  status: ReminderStatusSchema,
  firedCount: z.number().int().nonnegative(),
  lastFiredAt: z.number().nullable(),
  messageId: z.string().nullable(),
  /** Opaque caller key for retrying the same creation without making a duplicate. */
  creationKey: z.string().min(1).max(256).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Reminder = z.infer<typeof ReminderSchema>;

export const ReminderInputSchema = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(5000).nullable().optional(),
  dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15),
  timezone: z.string().optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  messageId: z.string().nullable().optional(),
  creationKey: z.string().trim().min(1).max(256).optional(),
});
export type ReminderInput = z.input<typeof ReminderInputSchema>;

export const ReminderPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  notes: z.string().max(5000).nullable().optional(),
  dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15).optional(),
  timezone: z.string().optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  status: ReminderStatusSchema.optional(),
});
export type ReminderPatch = z.input<typeof ReminderPatchSchema>;

/** Emitted by the scheduler each time a reminder fires. */
export interface ReminderFiring {
  /** State after firing (recurring reminders are already advanced to the next dueAt). */
  reminder: Reminder;
  /** The occurrence that fired (epoch ms). */
  occurrenceAt: number;
  firedAt: number;
  /** Fired later than the grace period (e.g. the device was asleep / server was down). */
  missed: boolean;
  nextDueAt: number | null;
  /** ID of the pending_firings durability row written atomically with the status advance. */
  pendingFiringId?: string;
}

// ───────────────────────────── tasks ─────────────────────────────

export const TaskSchema = z.object({
  id: z.string(),
  listId: z.string(),
  title: z.string().min(1).max(1000),
  notes: z.string().max(10_000).nullable(),
  done: z.boolean(),
  doneAt: z.number().nullable(),
  dueAt: z.number().nullable(),
  /** 0 none · 1 low · 2 medium · 3 high */
  priority: z.number().int().min(0).max(3),
  tags: z.array(z.string().max(60)),
  order: z.number(),
  parentId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskInputSchema = z.object({
  title: z.string().min(1).max(1000),
  listId: z.string().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15).nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  parentId: z.string().nullable().optional(),
});
export type TaskInput = z.input<typeof TaskInputSchema>;

export const TaskPatchSchema = TaskInputSchema.partial().extend({
  done: z.boolean().optional(),
  order: z.number().optional(),
});
export type TaskPatch = z.input<typeof TaskPatchSchema>;

export const TaskListSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  color: z.string().max(20).nullable(),
  icon: z.string().max(40).nullable(),
  order: z.number(),
  createdAt: z.number(),
});
export type TaskList = z.infer<typeof TaskListSchema>;

export const TaskListInputSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(20).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
});
export type TaskListInput = z.input<typeof TaskListInputSchema>;

/** Every install has this list; it cannot be deleted. */
export const INBOX_LIST_ID = 'list_inbox';

// ───────────────────────────── notes ─────────────────────────────

export const NoteSchema = z.object({
  id: z.string(),
  title: z.string().max(300),
  /** Markdown. */
  content: z.string().max(200_000),
  tags: z.array(z.string().max(60)),
  pinned: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Note = z.infer<typeof NoteSchema>;

export const NoteInputSchema = z.object({
  title: z.string().max(300).optional(),
  content: z.string().max(200_000),
  tags: z.array(z.string().max(60)).max(30).optional(),
  pinned: z.boolean().optional(),
});
export type NoteInput = z.input<typeof NoteInputSchema>;
export const NotePatchSchema = NoteInputSchema.partial();
export type NotePatch = z.input<typeof NotePatchSchema>;

// ───────────────────────────── notifications ─────────────────────────────

export const NotificationSchema = z.object({
  id: z.string(),
  kind: z.enum(['reminder', 'memory', 'task', 'system']),
  title: z.string(),
  body: z.string(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
  /** Deep-link target and ids, e.g. { reminderId, url: 'neo://reminders/rem_…' }. */
  data: z.record(z.string(), z.unknown()).nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationInput = Omit<Notification, 'id' | 'createdAt' | 'readAt'> & { createdAt?: number };

// ───────────────────────────── devices & push ─────────────────────────────

export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string().max(100),
  platform: z.enum(['web', 'desktop', 'ios', 'android', 'cli', 'other']),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  /** The owner device is created at first boot and cannot be revoked. */
  owner: z.boolean(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscriptionJSON = z.infer<typeof PushSubscriptionSchema>;

// ───────────────────────────── human formatting ─────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "every day", "every 2 weeks on Mon, Wed", "every month on the last day". */
export function describeRecurrence(r: RecurrenceInput | null | undefined): string {
  if (!r) return 'once';
  const n = r.interval ?? 1;
  const unit = { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  let s = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  if ((r.freq === 'weekly' || r.freq === 'daily') && r.byWeekday?.length) s += ` on ${[...r.byWeekday].sort().map((d) => WEEKDAYS[d]).join(', ')}`;
  if (r.freq === 'monthly' && r.byMonthDay?.length)
    s += ` on ${r.byMonthDay.map((d) => (d === -1 ? 'the last day' : `day ${d}`)).join(', ')}`;
  if (r.count) s += `, ${r.count} times`;
  if (r.until != null) {
    const iso = new Date(r.until).toISOString();
    s += `, until ${iso.slice(0, iso.indexOf('T'))}`;
  }
  return s;
}
