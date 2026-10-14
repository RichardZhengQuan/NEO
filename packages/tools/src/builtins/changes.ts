/** Proposed productivity edits, reviewed and applied through a stored changes widget. */
import { z } from 'zod';
import {
  ChangeItemSchema, NeoError, defineTool, newId,
  type ChangeItem, type ProductivityStores, type ReminderFields, type TaskFields,
} from '@neo/protocol';
import { parseDateTime } from '../time.js';
import { clip, friendlyTime } from './format.js';
import { parseFuture, WHEN_HELP } from './future.js';
import { reminderOutput } from './reminders.js';
import { DUE_HELP, taskOutput } from './tasks.js';

const ChangeInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task.update'),
    taskId: z.string().min(1).max(64),
    due: z.union([z.string().min(1).max(100), z.number()]).nullable().optional().describe(`${DUE_HELP} null clears it.`),
    title: z.string().trim().min(1).max(1000).optional(),
    priority: z.number().int().min(0).max(3).optional().describe('0 none, 1 low, 2 medium, 3 high.'),
    done: z.boolean().optional(),
  }).refine((input) => input.due !== undefined || input.title !== undefined || input.priority !== undefined || input.done !== undefined,
    'Provide at least one task field to change.'),
  z.object({
    kind: z.literal('reminder.create'),
    title: z.string().trim().min(1).max(500),
    when: z.union([z.string().min(1).max(100), z.number()]).describe(WHEN_HELP),
    notes: z.string().max(5000).optional().describe('Optional details shown with the notification.'),
  }),
  z.object({
    kind: z.literal('reminder.update'),
    reminderId: z.string().min(1).max(64),
    when: z.union([z.string().min(1).max(100), z.number()]).optional().describe(WHEN_HELP),
    title: z.string().trim().min(1).max(500).optional(),
  }).refine((input) => input.when !== undefined || input.title !== undefined, 'Provide at least one reminder field to change.'),
]);

function sameFields(current: object, fields: object): boolean {
  const values = current as Record<string, unknown>;
  return Object.entries(fields).every(([key, value]) => values[key] === value);
}

export function createChangeTools(stores: ProductivityStores) {
  const proposeChanges = defineTool({
    name: 'propose_changes',
    title: 'Propose changes',
    description:
      'Propose several concrete edits to the user\'s tasks and reminders at once, for planning ("plan tomorrow", ' +
      '"move my overdue tasks to next week"). The user sees a review card with each change before → after and applies it; ' +
      'nothing changes until then. For one edit the user asked for directly, use update_task, update_reminder or ' +
      'create_reminder instead. Don\'t invent durations or calendar availability.',
    inputSchema: z.object({
      title: z.string().max(200).optional(),
      note: z.string().max(500).optional(),
      changes: z.array(ChangeInputSchema).min(1).max(20),
    }),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      const now = ctx.now();
      const items: ChangeItem[] = [];
      for (const change of input.changes) {
        if (change.kind === 'task.update') {
          const task = stores.tasks.get(change.taskId);
          if (!task) throw new NeoError('not_found', `No task with id "${change.taskId}". Use list_tasks to find it.`);
          const before: TaskFields = {};
          const after: TaskFields = {};
          if (change.due !== undefined) {
            before.dueAt = task.dueAt;
            after.dueAt = change.due === null ? null : parseDateTime(change.due, now, ctx.timezone);
          }
          if (change.title !== undefined) { before.title = task.title; after.title = change.title; }
          if (change.priority !== undefined) { before.priority = task.priority; after.priority = change.priority; }
          if (change.done !== undefined) { before.done = task.done; after.done = change.done; }
          if (!sameFields(before, after)) {
            items.push({ id: newId('chg', now), status: 'pending', kind: change.kind, taskId: task.id, title: clip(task.title, 500), before, after });
          }
        } else if (change.kind === 'reminder.update') {
          const reminder = stores.reminders.get(change.reminderId);
          if (!reminder) throw new NeoError('not_found', `No reminder with id "${change.reminderId}". Use list_reminders to find it.`);
          if (reminder.status !== 'scheduled') throw new NeoError('conflict', 'This reminder is no longer scheduled. Use list_reminders to find an upcoming reminder.');
          const before: ReminderFields = {};
          const after: ReminderFields = {};
          if (change.when !== undefined) {
            before.dueAt = reminder.dueAt;
            after.dueAt = parseFuture(change.when, now, ctx.timezone);
            if (ctx.timezone !== reminder.timezone) {
              before.timezone = reminder.timezone;
              after.timezone = ctx.timezone;
            }
          }
          if (change.title !== undefined) { before.title = reminder.title; after.title = change.title; }
          if (!sameFields(before, after)) {
            items.push({ id: newId('chg', now), status: 'pending', kind: change.kind, reminderId: reminder.id, title: clip(reminder.title, 500), before, after });
          }
        } else {
          items.push({
            id: newId('chg', now), status: 'pending', kind: change.kind, title: change.title,
            dueAt: parseFuture(change.when, now, ctx.timezone), timezone: ctx.timezone,
            ...(change.notes !== undefined ? { notes: change.notes } : {}), creationKey: globalThis.crypto.randomUUID(),
          });
        }
      }
      if (items.length === 0) throw new NeoError('bad_request', 'Nothing would change. Ask for different task or reminder edits.');
      return {
        output: {
          proposed: items.length,
          changes: items.map((item) => item.kind === 'reminder.create'
            ? { id: item.id, kind: item.kind, title: item.title, dueAt: item.dueAt, when: friendlyTime(item.dueAt, ctx.timezone, ctx.locale) }
            : { id: item.id, kind: item.kind, title: item.title, before: item.before, after: item.after }),
        },
        ui: [{ type: 'changes' as const, ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}), timezone: ctx.timezone, items }],
        summary: `Proposed ${items.length} change${items.length === 1 ? '' : 's'}`,
      };
    },
  });

  const applyChange = defineTool({
    name: 'apply_change',
    title: 'Apply change',
    description:
      'Apply one proposed task or reminder edit from the app\'s review card, using its stored before/after snapshot. ' +
      'Reject stale proposals when the original fields have changed, and create reminders idempotently with their creation key.',
    inputSchema: z.object({ item: ChangeItemSchema }),
    uiOnly: true,
    risk: 'write',
    defaultPermission: 'auto',
    async execute({ item }, ctx) {
      if (item.kind === 'task.update') {
        const task = stores.tasks.get(item.taskId);
        if (!task) throw new NeoError('not_found', 'This task was deleted. Ask NEO for a fresh plan.');
        if (!sameFields(task, item.before)) throw new NeoError('conflict', 'This task changed after NEO proposed this. Ask NEO for a fresh plan.');
        const updated = stores.tasks.update(task.id, item.after);
        return { output: { change: { id: item.id, status: 'applied' }, task: taskOutput(updated, ctx.timezone, stores) }, summary: `Updated “${clip(updated.title, 60)}”` };
      }
      if (item.kind === 'reminder.update') {
        const reminder = stores.reminders.get(item.reminderId);
        if (!reminder) throw new NeoError('not_found', 'This reminder was deleted. Ask NEO for a fresh plan.');
        if (reminder.status !== 'scheduled' || !sameFields(reminder, item.before)) {
          throw new NeoError('conflict', 'This reminder changed after NEO proposed this. Ask NEO for a fresh plan.');
        }
        const updated = stores.reminders.update(reminder.id, item.after);
        return { output: { change: { id: item.id, status: 'applied' }, reminder: reminderOutput(updated) }, summary: `Updated “${clip(updated.title, 60)}”` };
      }
      const timezone = item.timezone ?? ctx.timezone;
      const dueAt = parseFuture(item.dueAt, ctx.now(), timezone);
      const reminder = stores.reminders.create({
        title: item.title, dueAt, timezone, recurrence: null, notes: item.notes ?? null,
        messageId: ctx.messageId ?? null, creationKey: item.creationKey,
      });
      return {
        output: { change: { id: item.id, status: 'applied', reminderId: reminder.id }, reminder: reminderOutput(reminder) },
        summary: `Reminder “${clip(reminder.title, 60)}” for ${friendlyTime(reminder.dueAt, reminder.timezone, ctx.locale)}`,
      };
    },
  });

  return [proposeChanges, applyChange];
}
