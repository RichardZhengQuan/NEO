/**
 * Reminder tools: create, list, update, snooze, complete, cancel.
 * Times are parsed in the user's timezone; outputs carry epoch ms plus local time.
 */
import { z } from 'zod';
import { NeoError, RecurrenceSchema, defineTool, describeRecurrence, type ProductivityStores, type Reminder, type ReminderPatch, type ReminderStatus, type UIBlock } from '@neo/protocol';
import type { Clock } from '@neo/protocol';
import { clip, friendlyTime, localIso, weekdayName } from './format.js';
import { parseFuture, WHEN_HELP } from './future.js';

const RecurrenceInput = RecurrenceSchema.describe(
  'Repeat rule. freq: hourly|daily|weekly|monthly|yearly; interval (every N periods, default 1); byWeekday (0=Sunday … 6=Saturday, ' +
    'for weekly, or with daily to limit days, e.g. weekdays [1,2,3,4,5]); byMonthDay (1-31, -1 = last day, for monthly); ' +
    'count (total occurrences); until (epoch ms). The first occurrence is `when`; it fixes the time of day.',
);

export function reminderOutput(r: Reminder) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    dueAt: r.dueAt,
    dueLocal: localIso(r.dueAt, r.timezone),
    weekday: weekdayName(r.dueAt, r.timezone),
    timezone: r.timezone,
    recurrence: r.recurrence,
    repeats: r.recurrence ? describeRecurrence(r.recurrence) : null,
    status: r.status,
    firedCount: r.firedCount,
  };
}

export function reminderBlock(r: Reminder): UIBlock {
  return {
    type: 'reminder',
    reminderId: r.id,
    title: clip(r.title, 300),
    ...(r.notes !== null ? { notes: r.notes } : {}),
    dueAt: r.dueAt,
    timezone: r.timezone,
    ...(r.recurrence ? { recurrenceText: clip(describeRecurrence(r.recurrence), 200) } : {}),
    status: r.status,
  };
}

export function createReminderTools(stores: ProductivityStores, _clock?: Clock) {
  const { reminders } = stores;

  const mustGet = (id: string): Reminder => {
    const r = reminders.get(id);
    if (!r) throw new NeoError('not_found', `No reminder with id "${id}". Use list_reminders to find it.`);
    return r;
  };

  const createReminder = defineTool({
    name: 'create_reminder',
    title: 'Create reminder',
    description:
      'Set a reminder: NEO notifies the user at that time on all their devices. Use it whenever the user asks to be ' +
      'reminded of something. The user sees a live reminder card with Snooze/Done controls, so keep your reply short. ' +
      'Repeating reminders take a `recurrence`, e.g. {"freq":"daily"}, {"freq":"weekly","byWeekday":[1,3]} or {"freq":"monthly","byMonthDay":[-1]}.',
    inputSchema: z.object({
      title: z.string().min(1).max(500).describe('What to remind about, short and actionable ("Call mom").'),
      when: z.union([z.string().min(1).max(100), z.number()]).describe(WHEN_HELP),
      recurrence: RecurrenceInput.optional(),
      notes: z.string().max(5000).optional().describe('Optional details shown with the notification.'),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      const now = ctx.now();
      const dueAt = parseFuture(input.when, now, ctx.timezone);
      const reminder = reminders.create({
        title: input.title,
        dueAt,
        timezone: ctx.timezone,
        recurrence: input.recurrence ?? null,
        notes: input.notes ?? null,
        messageId: ctx.messageId ?? null,
      });
      const repeats = reminder.recurrence ? `, ${describeRecurrence(reminder.recurrence)}` : '';
      return {
        output: { reminder: reminderOutput(reminder) },
        ui: [reminderBlock(reminder)],
        summary: `Reminder “${clip(reminder.title, 60)}” for ${friendlyTime(reminder.dueAt, reminder.timezone, ctx.locale)}${repeats}`,
      };
    },
  });

  const listReminders = defineTool({
    name: 'list_reminders',
    title: 'List reminders',
    description:
      'List the user\'s reminders, soonest first. status: "upcoming" (default, still scheduled), "fired", "completed" or "all". ' +
      'Use it to answer "what are my reminders?" or to find the id of a reminder to change.',
    inputSchema: z.object({
      status: z.enum(['upcoming', 'fired', 'completed', 'all']).optional().describe('Default "upcoming".'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
    }),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(input) {
      const status = input.status ?? 'upcoming';
      const filter: Record<typeof status, ReminderStatus[] | undefined> = { upcoming: ['scheduled'], fired: ['fired'], completed: ['completed'], all: undefined };
      const list = reminders.list({ status: filter[status], limit: input.limit ?? 20 });
      const ui = list.slice(0, 10).map(reminderBlock);
      if (list.length > 10) ui.push({ type: 'link', url: 'neo://reminders', title: `Show all ${list.length} reminders` });
      return {
        output: { reminders: list.map(reminderOutput), total: list.length },
        ui,
        summary: list.length ? `${list.length} ${status === 'all' ? '' : `${status} `}reminder${list.length === 1 ? '' : 's'}` : `No ${status === 'all' ? '' : `${status} `}reminders`,
      };
    },
  });

  const updateReminder = defineTool({
    name: 'update_reminder',
    title: 'Update reminder',
    description:
      'Change a reminder\'s title, time, repeat rule or notes (by id, from create_reminder or list_reminders). A new `when` ' +
      'also re-arms a reminder that already fired; `recurrence: null` makes it one-time.',
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      title: z.string().min(1).max(500).optional(),
      when: z.union([z.string().min(1).max(100), z.number()]).optional().describe(WHEN_HELP),
      recurrence: RecurrenceInput.nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      const existing = mustGet(input.id);
      const patch: ReminderPatch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.recurrence !== undefined) patch.recurrence = input.recurrence;
      if (input.when !== undefined) {
        // The new time is spoken in the user's current zone, which also becomes the reminder's zone.
        patch.dueAt = parseFuture(input.when, ctx.now(), ctx.timezone);
        if (ctx.timezone !== existing.timezone) patch.timezone = ctx.timezone;
        if (existing.status !== 'scheduled') patch.status = 'scheduled';
      }
      const reminder = reminders.update(existing.id, patch);
      return {
        output: { reminder: reminderOutput(reminder) },
        ui: [reminderBlock(reminder)],
        summary: `Updated “${clip(reminder.title, 60)}” (${friendlyTime(reminder.dueAt, reminder.timezone, ctx.locale)})`,
      };
    },
  });

  const snoozeReminder = defineTool({
    name: 'snooze_reminder',
    title: 'Snooze reminder',
    description: 'Postpone a reminder by a number of minutes from now (1 minute to 1 week). Used by the Snooze buttons on reminder cards.',
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      minutes: z.number().int().min(1).max(10_080).describe('Minutes from now, e.g. 10 or 60.'),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      const reminder = reminders.snooze(mustGet(input.id).id, input.minutes);
      return {
        output: { reminder: reminderOutput(reminder) },
        summary: `Snoozed “${clip(reminder.title, 60)}” until ${friendlyTime(reminder.dueAt, reminder.timezone, ctx.locale)}`,
      };
    },
  });

  const completeReminder = defineTool({
    name: 'complete_reminder',
    title: 'Complete reminder',
    description: 'Mark a reminder as done. For a repeating reminder this ends the whole series. Used by the Done button on reminder cards.',
    inputSchema: z.object({ id: z.string().min(1).max(64) }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input) {
      const reminder = reminders.complete(mustGet(input.id).id);
      return { output: { reminder: reminderOutput(reminder) }, summary: `Done: “${clip(reminder.title, 60)}”` };
    },
  });

  const cancelReminder = defineTool({
    name: 'cancel_reminder',
    title: 'Cancel reminder',
    description: 'Cancel a reminder so it never fires (repeating reminders: the whole series). The reminder stays in history as cancelled.',
    inputSchema: z.object({ id: z.string().min(1).max(64) }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input) {
      const reminder = reminders.update(mustGet(input.id).id, { status: 'cancelled' });
      return { output: { reminder: reminderOutput(reminder), status: 'cancelled' }, summary: `Cancelled “${clip(reminder.title, 60)}”` };
    },
  });

  return [createReminder, listReminders, updateReminder, snoozeReminder, completeReminder, cancelReminder];
}
