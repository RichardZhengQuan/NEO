/** Read-only entry into tomorrow's contextual planning scene. */
import { z } from 'zod';
import { defineTool, type ProductivityStores, type UIBlock } from '@neo/protocol';
import { assertTimeZone, dayNumber, fromDayNumber, utcToZoned, zonedTimeToUtc } from '../time.js';
import { clip, friendlyTime, localIso } from './format.js';

const TASK_LIMIT = 1000;
const REMINDER_LIMIT = 500;

export function createPlanTomorrowTool(stores: ProductivityStores) {
  return defineTool({
    name: 'plan_tomorrow',
    title: 'Plan tomorrow',
    description: 'Open a contextual plan for tomorrow using existing unfinished tasks and scheduled reminders. ' +
      'Read-only: returns a concise preview and an Open plan button; it does not create, schedule, complete or change anything. ' +
      'Tomorrow is the next calendar day in the user timezone. Reminder counts use their actual next due time; repeating occurrences are not expanded. ' +
      'Use when the user asks to plan or organize tomorrow. Do not invent task durations or calendar availability.',
    inputSchema: z.object({}),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(_input, ctx) {
      const timezone = assertTimeZone(ctx.timezone);
      const now = ctx.now();
      const today = utcToZoned(now, timezone);
      const tomorrowNumber = dayNumber(today.year, today.month, today.day) + 1;
      const tomorrow = fromDayNumber(tomorrowNumber);
      const following = fromDayNumber(tomorrowNumber + 1);
      const start = zonedTimeToUtc({ ...tomorrow, hour: 0, minute: 0 }, timezone);
      const end = zonedTimeToUtc({ ...following, hour: 0, minute: 0 }, timezone);
      const date = `${String(tomorrow.year).padStart(4, '0')}-${String(tomorrow.month).padStart(2, '0')}-${String(tomorrow.day).padStart(2, '0')}`;
      const zh = /^zh(?:-|$)/i.test(ctx.locale);
      const tasks = stores.tasks.list({ done: false, limit: TASK_LIMIT });
      const taskCounts = {
        dueTomorrow: tasks.filter(task => task.dueAt !== null && task.dueAt >= start && task.dueAt < end).length,
        carryOver: tasks.filter(task => task.dueAt !== null && task.dueAt < start).length,
        overdueNow: tasks.filter(task => task.dueAt !== null && task.dueAt < now).length,
        undated: tasks.filter(task => task.dueAt === null).length,
      };
      const totalTasks = taskCounts.dueTomorrow + taskCounts.carryOver + taskCounts.undated;
      const reminders = stores.reminders.list({ status: ['scheduled'], from: start, to: end - 1, limit: REMINDER_LIMIT });
      const firstReminder = reminders[0];
      const nextReminder = firstReminder ? {
        id: firstReminder.id, title: firstReminder.title, nextDueAt: firstReminder.dueAt,
        nextDueLocal: localIso(firstReminder.dueAt, timezone), timezone, reminderTimezone: firstReminder.timezone,
        repeating: firstReminder.recurrence !== null,
      } : null;
      const partial = tasks.length === TASK_LIMIT || reminders.length === REMINDER_LIMIT;
      const taskSummary = zh
        ? `${taskCounts.dueTomorrow} 项明日到期 · ${taskCounts.carryOver} 项待结转 · ${taskCounts.undated} 项未定日期`
        : `${taskCounts.dueTomorrow} due tomorrow · ${taskCounts.carryOver} carried over · ${taskCounts.undated} without a date`;
      const reminderSummary = zh
        ? `${reminders.length} 项提醒下次触发于明日`
        : `${reminders.length} reminder${reminders.length === 1 ? '' : 's'} next due tomorrow`;
      const summary = zh ? `明日计划：${totalTasks} 项待办 · ${reminderSummary}` : `Tomorrow: ${totalTasks} task${totalTasks === 1 ? '' : 's'} · ${reminderSummary}`;
      const nextSummary = firstReminder
        ? `${zh ? '首项提醒' : 'First reminder'}: ${clip(firstReminder.title, 120)} · ${friendlyTime(firstReminder.dueAt, timezone, ctx.locale)}`
        : zh ? '没有下次触发于明日的提醒。' : 'No reminders next due tomorrow.';
      const footer = zh
        ? `任务和提醒尚未更改。重复提醒仅显示下次触发时间。${partial ? '此预览已达到条目上限，数量可能不完整。' : ''}`
        : `Tasks and reminders are unchanged. Repeating reminders show only their next due time.${partial ? ' This preview reached its item limit; counts may be incomplete.' : ''}`;
      const ui: UIBlock[] = [{
        type: 'card', title: zh ? '明日计划' : 'Plan tomorrow', subtitle: date,
        children: [{ type: 'text', text: taskSummary }, { type: 'text', text: `${reminderSummary}\n\n${nextSummary}` }],
        actions: [{ id: 'open-plan-tomorrow', kind: 'link', label: zh ? '打开计划' : 'Open plan', style: 'primary', url: `neo://plan-tomorrow?date=${date}` }],
        footer,
      }];
      return {
        output: { date, timezone, range: { start, end }, taskCounts: { ...taskCounts, total: totalTasks },
          scheduledRemindersNextDueTomorrow: reminders.length, nextReminder, reminderScope: 'scheduled_next_due_only',
          countsMayBeIncomplete: partial, changed: false },
        ui, summary,
      };
    },
  });
}
