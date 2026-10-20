/**
 * Task tools: create_task, list_tasks, update_task, delete_task.
 * Lists are addressed by name (case-insensitive) or id; the Inbox is the default.
 */
import { z } from 'zod';
import { INBOX_LIST_ID, NeoError, defineTool, type ProductivityStores, type Task, type TaskList, type TaskPatch, type UIBlock } from '@neo/protocol';
import type { Clock } from '@neo/protocol';
import { parseDateTime } from '../time.js';
import { clip, friendlyTime, localIso } from './format.js';

/** Most tasks a tasks widget can hold (TasksBlockSchema). */
const WIDGET_MAX = 100;

export const DUE_HELP = 'Due date/time: "tomorrow", "friday 17:00", "in 3 days", an ISO date ("2026-10-12") or epoch ms.';

export function taskOutput(t: Task, timezone: string, stores: ProductivityStores) {
  return {
    id: t.id,
    listId: t.listId,
    list: stores.tasks.lists().find((l) => l.id === t.listId)?.name ?? 'Tasks',
    title: t.title,
    done: t.done,
    dueAt: t.dueAt,
    dueLocal: t.dueAt === null ? null : localIso(t.dueAt, timezone),
    priority: t.priority,
    tags: t.tags,
    notes: t.notes,
  };
}

export function createTaskTools(stores: ProductivityStores, _clock?: Clock) {
  const { tasks } = stores;

  const findList = (nameOrId: string): TaskList | undefined => {
    const key = nameOrId.trim().toLowerCase();
    const lists = tasks.lists();
    return lists.find((l) => l.id === nameOrId) ?? lists.find((l) => l.name.toLowerCase() === key);
  };
  /** Resolve a list by id or name; an unknown name creates the list. */
  const resolveOrCreateList = (nameOrId: string): TaskList => findList(nameOrId) ?? tasks.createList({ name: nameOrId.trim() });
  const listName = (id: string) => tasks.lists().find((l) => l.id === id)?.name ?? 'Tasks';
  const mustGet = (id: string): Task => {
    const t = tasks.get(id);
    if (!t) throw new NeoError('not_found', `No task with id "${id}". Use list_tasks to find it.`);
    return t;
  };

  const widget = (title: string, items: Task[], listId?: string): UIBlock => ({
    type: 'tasks',
    title: clip(title, 200),
    ...(listId ? { listId } : {}),
    tasks: items.slice(0, WIDGET_MAX).map((t) => ({
      id: t.id,
      title: clip(t.title, 500),
      done: t.done,
      dueAt: t.dueAt,
      priority: t.priority,
    })),
  });

  /** The open tasks of a list, always including `focus` (the task just created). */
  const listWidget = (list: TaskList, focus: Task): UIBlock => {
    const open = tasks.list({ listId: list.id, done: false, limit: WIDGET_MAX });
    const items = open.some((t) => t.id === focus.id) ? open : [...open.slice(0, WIDGET_MAX - 1), focus];
    return widget(list.name, items, list.id);
  };

  const createTask = defineTool({
    name: 'create_task',
    title: 'Add task',
    description:
      'Add a to-do item. `list` is a list name or id ("Groceries", "Work"); an unknown name creates that list, and the Inbox ' +
      'is the default. The user sees the list as a live checklist, so keep your reply short. Use create_reminder instead ' +
      'when the user wants to be notified at a specific time.',
    inputSchema: z.object({
      title: z.string().min(1).max(1000).describe('The task, e.g. "Buy milk".'),
      list: z.string().min(1).max(100).optional().describe('List name or id. Default: Inbox.'),
      due: z.union([z.string().min(1).max(100), z.number()]).optional().describe(DUE_HELP),
      priority: z.number().int().min(0).max(3).optional().describe('0 none, 1 low, 2 medium, 3 high.'),
      notes: z.string().max(10_000).nullable().optional(),
      tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      const dueAt = input.due !== undefined ? parseDateTime(input.due, ctx.now(), ctx.timezone) : null;
      const list = input.list ? resolveOrCreateList(input.list) : (findList(INBOX_LIST_ID) as TaskList);
      const task = tasks.create({
        title: input.title,
        listId: list.id,
        dueAt,
        priority: input.priority ?? 0,
        notes: input.notes ?? null,
        tags: input.tags ?? [],
      });
      return {
        output: { task: taskOutput(task, ctx.timezone, stores) },
        ui: [listWidget(list, task)],
        summary: `Added “${clip(task.title, 60)}” to ${list.name}${dueAt !== null ? ` (due ${friendlyTime(dueAt, ctx.timezone, ctx.locale)})` : ''}`,
      };
    },
  });

  const listTasks = defineTool({
    name: 'list_tasks',
    title: 'List tasks',
    description:
      'Show tasks as a live checklist. Filter by `list` (name or id), `done` (false = open tasks only) and `query` ' +
      '(text in the title or notes). Without `list` it searches every list. Also use it to find a task id before ' +
      'update_task or delete_task.',
    inputSchema: z.object({
      list: z.string().min(1).max(100).optional().describe('List name or id.'),
      done: z.boolean().optional().describe('true = completed only, false = open only. Default: both.'),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
    }),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      let list: TaskList | undefined;
      if (input.list) {
        list = findList(input.list);
        if (!list) {
          const names = tasks.lists().map((l) => `"${l.name}"`).join(', ');
          return { isError: true, output: { error: `There is no task list called "${input.list}". Existing lists: ${names}.` }, summary: 'Unknown list' };
        }
      }
      const items = tasks.list({ listId: list?.id, done: input.done, query: input.query, limit: input.limit ?? 50 });
      const title = list ? list.name : input.query ? `Tasks matching “${input.query}”` : input.done === true ? 'Completed tasks' : 'Tasks';
      return {
        output: { tasks: items.map((t) => taskOutput(t, ctx.timezone, stores)), total: items.length, ...(list ? { list: { id: list.id, name: list.name } } : {}) },
        ui: [widget(title, items, list?.id)],
        summary: `${items.length} task${items.length === 1 ? '' : 's'}${list ? ` in ${list.name}` : ''}`,
      };
    },
  });

  const updateTask = defineTool({
    name: 'update_task',
    title: 'Update task',
    description:
      'Change a task by id: mark it done or not done, rename it, set or clear (`due: null`) the due date, change priority ' +
      'or notes, or move it to another list (by name or id; an unknown name creates the list). Moving a subtask to a different list automatically detaches it from its parent task (parentId is cleared). Used by the checklist checkboxes.',
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      title: z.string().min(1).max(1000).optional(),
      done: z.boolean().optional(),
      due: z.union([z.string().min(1).max(100), z.number()]).nullable().optional().describe(`${DUE_HELP} null clears it.`),
      priority: z.number().int().min(0).max(3).optional(),
      notes: z.string().max(10_000).nullable().optional(),
      list: z.string().min(1).max(100).optional().describe('Move to this list (name or id).'),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      const existing = mustGet(input.id);
      const patch: TaskPatch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.done !== undefined) patch.done = input.done;
      if (input.due !== undefined) patch.dueAt = input.due === null ? null : parseDateTime(input.due, ctx.now(), ctx.timezone);
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.list !== undefined) patch.listId = resolveOrCreateList(input.list).id;
      const task = tasks.update(existing.id, patch);
      const what = input.done === true ? 'Completed' : input.done === false ? 'Reopened' : 'Updated';
      return { output: { task: taskOutput(task, ctx.timezone, stores) }, summary: `${what} “${clip(task.title, 60)}”` };
    },
  });

  const deleteTask = defineTool({
    name: 'delete_task',
    title: 'Delete task',
    description: 'Permanently delete a task by id (asks the user first). To tick a task off, use update_task with done: true instead.',
    inputSchema: z.object({ id: z.string().min(1).max(64) }),
    risk: 'dangerous',
    defaultPermission: 'confirm',
    describeCall: (input) => {
      const t = tasks.get(input.id);
      return t ? `Delete the task “${clip(t.title, 80)}” from ${listName(t.listId)}` : `Delete task ${input.id}`;
    },
    async execute(input) {
      const task = mustGet(input.id);
      tasks.delete(task.id);
      return { output: { deleted: true, id: task.id, title: task.title }, summary: `Deleted “${clip(task.title, 60)}”` };
    },
  });

  return [createTask, listTasks, updateTask, deleteTask];
}
