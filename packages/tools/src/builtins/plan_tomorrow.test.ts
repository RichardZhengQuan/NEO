import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase } from '@neo/storage';
import { silentLogger, validateUIBlocks, type ToolContext } from '@neo/protocol';
import { createProductivityStores, toolsMigrations } from '../stores/index.js';
import { createPlanTomorrowTool } from './plan_tomorrow.js';
import { createToolRegistry } from '../registry.js';
import { parseDateTime } from '../time.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(timezone = 'Asia/Singapore', now = Date.parse('2026-10-12T08:00:00Z'), locale = 'en') {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db, 'tools', toolsMigrations);
  const stores = createProductivityStores(db, { clock: () => now, defaultTimezone: timezone });
  const tool = createPlanTomorrowTool(stores);
  const registry = createToolRegistry();
  registry.register(tool);
  const ctx: ToolContext = { toolCallId: 'preview', conversationId: 'episode', messageId: 'message', signal: new AbortController().signal,
    now: () => now, timezone, locale, allowSensitive: false, origin: 'model', logger: silentLogger };
  const run = (overrides: Partial<ToolContext> = {}) => registry.execute({ id: 'preview', name: tool.name, input: {} }, { ...ctx, ...overrides });
  return { stores, tool, run, now, timezone, at: (input: string) => parseDateTime(input, now, timezone) };
}

function outputOf(result: Awaited<ReturnType<ReturnType<typeof setup>['run']>>) {
  return result.output as { date: string; timezone: string; range: { start: number; end: number };
    taskCounts: { dueTomorrow: number; carryOver: number; overdueNow: number; undated: number; total: number };
    scheduledRemindersNextDueTomorrow: number; nextReminder: { id: string; title: string; nextDueAt: number; nextDueLocal: string; timezone: string; reminderTimezone: string; repeating: boolean } | null;
    reminderScope: string; countsMayBeIncomplete: boolean; changed: boolean };
}

describe('Plan tomorrow read-only scene entry', () => {
  it('previews relevant existing tasks and actual next-due reminders without changing data', async () => {
    const h = setup();
    const tomorrow = h.stores.tasks.create({ title: 'Tomorrow deadline', dueAt: h.at('2026-10-13T09:00') });
    h.stores.tasks.create({ title: 'Overdue', dueAt: h.at('2026-10-11T10:00') });
    h.stores.tasks.create({ title: 'Later today', dueAt: h.at('2026-10-12T18:00') });
    h.stores.tasks.create({ title: 'Choose a date' });
    h.stores.tasks.create({ title: 'Later deadline', dueAt: h.at('2026-10-14T09:00') });
    const done = h.stores.tasks.create({ title: 'Already finished', dueAt: h.at('2026-10-13T09:00') });
    h.stores.tasks.update(done.id, { done: true });
    const first = h.stores.reminders.create({ title: 'Bring the documents', dueAt: h.at('2026-10-13T08:00') });
    h.stores.reminders.create({ title: 'Later tomorrow', dueAt: h.at('2026-10-13T17:00') });
    h.stores.reminders.create({ title: 'Later day', dueAt: h.at('2026-10-14T08:00') });
    const cancelled = h.stores.reminders.create({ title: 'Cancelled', dueAt: h.at('2026-10-13T07:00') });
    h.stores.reminders.update(cancelled.id, { status: 'cancelled' });
    const completed = h.stores.reminders.create({ title: 'Completed', dueAt: h.at('2026-10-13T06:00') });
    h.stores.reminders.complete(completed.id);
    const before = { tasks: h.stores.tasks.list(), reminders: h.stores.reminders.list() };
    const changes = vi.fn();
    h.stores.tasks.onChange(changes);
    h.stores.reminders.onChange(changes);

    const result = await h.run();

    expect(result.isError).not.toBe(true);
    expect(outputOf(result)).toMatchObject({ date: '2026-10-13', timezone: h.timezone,
      taskCounts: { dueTomorrow: 1, carryOver: 2, overdueNow: 1, undated: 1, total: 4 },
      scheduledRemindersNextDueTomorrow: 2, nextReminder: { id: first.id, nextDueAt: first.dueAt },
      reminderScope: 'scheduled_next_due_only', countsMayBeIncomplete: false, changed: false });
    expect({ tasks: h.stores.tasks.list(), reminders: h.stores.reminders.list() }).toEqual(before);
    expect(h.stores.tasks.get(tomorrow.id)?.dueAt).toBe(tomorrow.dueAt);
    expect(changes).not.toHaveBeenCalled();
    expect(validateUIBlocks(result.ui).ok).toBe(true);
    expect(result.ui?.[0]).toMatchObject({ type: 'card', title: 'Plan tomorrow', actions: [
      { kind: 'link', style: 'primary', label: 'Open plan', url: 'neo://plan-tomorrow?date=2026-10-13' },
    ] });
    expect(JSON.stringify(result.output)).not.toMatch(/duration|availability|freeSlot/);
  });

  it.each([
    ['Europe/Berlin', '2026-03-28T12:00:00Z', '2026-03-29', 23],
    ['Europe/Berlin', '2026-10-24T12:00:00Z', '2026-10-25', 25],
  ])('uses calendar-day boundaries through DST in %s on %s', async (zone, now, date, hours) => {
    const h = setup(zone, Date.parse(now));
    const start = h.at(`${date}T00:00`);
    const dayAfter = date === '2026-03-29' ? '2026-03-30' : '2026-10-26';
    const end = h.at(`${dayAfter}T00:00`);
    h.stores.tasks.create({ title: 'Tomorrow starts', dueAt: start });
    h.stores.tasks.create({ title: 'Before tomorrow ends', dueAt: end - 1 });
    h.stores.tasks.create({ title: 'Following day starts', dueAt: end });
    h.stores.reminders.create({ title: 'Tomorrow starts', dueAt: start });
    h.stores.reminders.create({ title: 'Before tomorrow ends', dueAt: end - 1 });
    h.stores.reminders.create({ title: 'Following day starts', dueAt: end });

    const output = outputOf(await h.run());

    expect(output).toMatchObject({ date, range: { start, end }, taskCounts: { dueTomorrow: 2 }, scheduledRemindersNextDueTomorrow: 2 });
    expect((output.range.end - output.range.start) / 3_600_000).toBe(hours);
  });

  it.each([
    ['Pacific/Auckland', '2026-10-12T11:30:00Z', '2026-10-14'],
    ['Pacific/Honolulu', '2026-10-12T08:30:00Z', '2026-10-12'],
    ['Asia/Singapore', '2026-12-31T08:00:00Z', '2027-01-01'],
  ])('uses the user calendar across UTC and year boundaries in %s', async (zone, now, tomorrow) => {
    expect(outputOf(await setup(zone, Date.parse(now)).run()).date).toBe(tomorrow);
  });

  it('counts only scheduled next due records without projecting repeated occurrences', async () => {
    const h = setup();
    h.stores.reminders.create({ title: 'Hourly tomorrow', dueAt: h.at('2026-10-13T01:00'), recurrence: { freq: 'hourly' } });
    h.stores.reminders.create({ title: 'Daily whose next due is today', dueAt: h.at('2026-10-12T18:00'), recurrence: { freq: 'daily' } });
    const fired = h.stores.reminders.create({ title: 'Already fired', dueAt: h.at('2026-10-13T03:00') });
    h.stores.reminders.update(fired.id, { status: 'fired' });

    const result = await h.run();

    expect(outputOf(result)).toMatchObject({ scheduledRemindersNextDueTomorrow: 1, nextReminder: { title: 'Hourly tomorrow', repeating: true }, reminderScope: 'scheduled_next_due_only' });
    expect(result.ui?.[0]).toMatchObject({ footer: expect.stringContaining('only their next due time') });
  });

  it('shows reminder time in the planning timezone while preserving its recurrence timezone', async () => {
    const h = setup();
    h.stores.reminders.create({ title: 'Reminder in New York', dueAt: h.at('2026-10-13T21:00'), timezone: 'America/New_York' });
    const output = outputOf(await h.run());
    expect(output.nextReminder).toMatchObject({ nextDueLocal: '2026-10-13T21:00:00', timezone: 'Asia/Singapore', reminderTimezone: 'America/New_York' });
  });

  it('localizes the scene entry and reports an empty preview truthfully', async () => {
    const h = setup('Asia/Singapore', Date.parse('2026-10-12T08:00:00Z'), 'zh-CN');
    const result = await h.run();
    expect(outputOf(result)).toMatchObject({ taskCounts: { total: 0 }, scheduledRemindersNextDueTomorrow: 0, nextReminder: null, changed: false });
    expect(result.ui?.[0]).toMatchObject({ title: '明日计划', actions: [{ label: '打开计划', url: 'neo://plan-tomorrow?date=2026-10-13' }] });
    expect(result.summary).toContain('0 项待办');
  });

  it('rejects an invalid context timezone before reading user data', async () => {
    const h = setup();
    const tasksRead = vi.spyOn(h.stores.tasks, 'list');
    const remindersRead = vi.spyOn(h.stores.reminders, 'list');
    const result = await h.run({ timezone: 'Mars/Base' });
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ error: expect.stringContaining('Unknown timezone') });
    expect(result.ui).toBeUndefined();
    expect(tasksRead).not.toHaveBeenCalled();
    expect(remindersRead).not.toHaveBeenCalled();
  });

  it('marks counts as potentially incomplete when the preview reaches a store limit', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Undated' });
    vi.spyOn(h.stores.tasks, 'list').mockReturnValue(Array.from({ length: 1000 }, (_, index) => ({ ...task, id: `task_${index}` })));
    const result = await h.run();
    expect(outputOf(result)).toMatchObject({ taskCounts: { undated: 1000, total: 1000 }, countsMayBeIncomplete: true });
    expect(result.ui?.[0]).toMatchObject({ footer: expect.stringContaining('counts may be incomplete') });
  });
});
