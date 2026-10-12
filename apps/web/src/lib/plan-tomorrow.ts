import type { Reminder, Task } from '@neo/protocol';
import { instantOf, toDateInputValue, toLocalInputValue, wallTimeOf } from './time.js';

export interface PlanChoice { include: boolean; time: string; addReminder: boolean }
export type PlanInvalidReason = 'deleted' | 'done' | 'changed' | 'time' | 'past' | 'session' | 'reminder-unknown' | 'source-unavailable';
export interface PlanReceipt {
  id: string; taskId: string; title: string; kind: 'due' | 'reminder'; before: number | null; after: number;
  status: 'pending' | 'saving' | 'saved' | 'error' | 'invalid';
  error?: string; reason?: PlanInvalidReason; reminderId?: string; creationKey?: string;
  /** An uncertain creation must be reconciled, never repeated blindly. */
  uncertain?: boolean;
}
export interface PlanTomorrow {
  key: string; date: string; timezone: string; private: boolean; intent?: string; epoch: number; token: object;
  stage: 'edit' | 'review' | 'saving' | 'saved' | 'partial' | 'error';
  status: 'idle' | 'loading' | 'ready' | 'error'; loadError: string | null; limited: boolean;
  baselines: Record<string, Task>; acceptedTasks: Record<string, Task>; reminderIds: string[];
  suggestedIds: string[]; choices: Record<string, PlanChoice>; operations: PlanReceipt[];
  disclosures: { alternatives: boolean; reminders: boolean };
}

export function assertPlanTimeZone(timezone: string): string {
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  return timezone;
}

export function validPlanDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return Number.isFinite(normalized.getTime()) && normalized.toISOString().slice(0, 10) === date;
}

/** Tomorrow means the next calendar date in the server's timezone, even over DST. */
export function tomorrowDate(now: number, timezone: string): string {
  const wall = wallTimeOf(now, assertPlanTimeZone(timezone));
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1)).toISOString().slice(0, 10);
}

/** Reject missing DST wall times rather than silently approve a different clock time. */
export function planInstant(date: string, time: string, timezone: string): number | null {
  if (!validPlanDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  try {
    assertPlanTimeZone(timezone);
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    const [hour, minute] = time.split(':').map(Number) as [number, number];
    const instant = instantOf(year, month, day, hour, minute, timezone);
    return toLocalInputValue(instant, timezone) === `${date}T${time}` ? instant : null;
  } catch { return null; }
}

export function rankPlanTasks(tasks: Task[], date: string, timezone: string): Task[] {
  const rank = (task: Task) => task.dueAt === null ? 2 : toDateInputValue(task.dueAt, timezone) === date ? 0 : toDateInputValue(task.dueAt, timezone) < date ? 1 : 3;
  return tasks.filter((task) => !task.done).sort((a, b) => rank(a) - rank(b) || b.priority - a.priority || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.order - b.order || a.id.localeCompare(b.id));
}

export function initialPlanChoices(tasks: Task[], date: string, timezone: string): { choices: Record<string, PlanChoice>; suggestedIds: string[] } {
  const ranked = rankPlanTasks(tasks, date, timezone);
  const suggestedIds = ranked.filter((task) => task.dueAt === null || toDateInputValue(task.dueAt, timezone) <= date).slice(0, 3).map((task) => task.id);
  const slots = ['09:00', '11:00', '14:00'];
  return {
    suggestedIds,
    choices: Object.fromEntries(ranked.map((task, index) => [task.id, {
      include: suggestedIds.includes(task.id),
      time: task.dueAt !== null && toDateInputValue(task.dueAt, timezone) === date ? toLocalInputValue(task.dueAt, timezone).slice(11) : slots[index % slots.length]!,
      addReminder: false,
    }])),
  };
}

export function samePlanTask(a: Task, b: Task): boolean {
  return a.updatedAt === b.updatedAt && a.dueAt === b.dueAt && a.title === b.title && a.done === b.done && a.listId === b.listId && a.priority === b.priority && a.notes === b.notes;
}

export function invalidPlanChoices(plan: PlanTomorrow, tasks: Record<string, Task>, now = Date.now()): Record<string, PlanInvalidReason> {
  const invalid: Record<string, PlanInvalidReason> = {};
  for (const [id, choice] of Object.entries(plan.choices)) {
    if (!choice.include) continue;
    const baseline = plan.acceptedTasks[id] ?? plan.baselines[id];
    const current = tasks[id];
    const target = planInstant(plan.date, choice.time, plan.timezone);
    const uncertain = plan.operations.find((receipt) => receipt.taskId === id && receipt.uncertain);
    if (uncertain) invalid[id] = uncertain.kind === 'reminder' ? 'reminder-unknown' : 'session';
    else if (!current) invalid[id] = plan.limited ? 'source-unavailable' : 'deleted';
    else if (current.done) invalid[id] = 'done';
    else if (baseline && !samePlanTask(baseline, current)) invalid[id] = 'changed';
    else if (target === null) invalid[id] = 'time';
    else if (target <= now) invalid[id] = 'past';
  }
  return invalid;
}

export function buildPlanReceipts(plan: PlanTomorrow): PlanReceipt[] {
  const previous = new Map(plan.operations.map((receipt) => [receipt.id, receipt]));
  const receipts: PlanReceipt[] = [];
  for (const [id, choice] of Object.entries(plan.choices)) {
    const task = plan.acceptedTasks[id] ?? plan.baselines[id];
    const after = planInstant(plan.date, choice.time, plan.timezone);
    if (!choice.include || !task || after === null) continue;
    const dueId = `due:${id}:${after}`;
    const previousDue = previous.get(dueId);
    if (previousDue && (previousDue.status === 'saved' || previousDue.uncertain)) receipts.push(previousDue);
    else if (task.dueAt !== after) receipts.push({ id: dueId, taskId: id, title: task.title, kind: 'due', before: task.dueAt, after, status: 'pending' });
    if (choice.addReminder) {
      const reminderId = `reminder:${id}:${after}`;
      const previousReminder = previous.get(reminderId);
      const title = task.title.slice(0, 500);
      receipts.push(previousReminder && (previousReminder.status === 'saved' || previousReminder.uncertain) ? previousReminder : {
        id: reminderId, taskId: id, title, kind: 'reminder', before: null, after, status: 'pending',
        creationKey: previousReminder?.title === title && previousReminder.creationKey ? previousReminder.creationKey : planCreationKey(),
      });
    }
  }
  for (const receipt of plan.operations) {
    if (receipt.uncertain && !receipts.some((candidate) => candidate.id === receipt.id)) receipts.push(receipt);
  }
  return receipts;
}

/** One reviewed create operation keeps its UUID through retries; a fresh plan gets a new key. */
export function planCreationKey(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function matchingPlanReminder(reminders: Reminder[], receipt: PlanReceipt, timezone: string): Reminder | undefined {
  if (!receipt.creationKey) return undefined;
  return reminders.find((reminder) => reminder.creationKey === receipt.creationKey && reminder.title === receipt.title && reminder.dueAt === receipt.after && reminder.timezone === timezone);
}
