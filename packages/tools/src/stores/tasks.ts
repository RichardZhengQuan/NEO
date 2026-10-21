/**
 * TaskStore: task lists and tasks on node:sqlite.
 * The inbox list (INBOX_LIST_ID) always exists and cannot be deleted; deleting
 * another list moves its tasks to the inbox.
 */
import {
  INBOX_LIST_ID,
  NeoError,
  TaskInputSchema,
  TaskListInputSchema,
  TaskPatchSchema,
  newId,
  type Clock,
  type Task,
  type TaskInput,
  type TaskList,
  type TaskListInput,
  type TaskListQuery,
  type TaskPatch,
  type TaskStore,
} from '@neo/protocol';
import { fromJson, toBool, toJson, toNum, toNumOrNull, type NeoDatabase } from '@neo/storage';
import { clampLimit, likePattern, parseInput, requireText } from './validate.js';

type Row = Record<string, unknown>;
type ChangeEvent = { type: 'upsert'; task: Task } | { type: 'delete'; id: string };

function toTaskList(r: Row): TaskList {
  return {
    id: r.id as string,
    name: r.name as string,
    color: (r.color as string | null) ?? null,
    icon: (r.icon as string | null) ?? null,
    order: toNum(r.order),
    createdAt: toNum(r.created_at),
  };
}

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    listId: r.list_id as string,
    title: r.title as string,
    notes: (r.notes as string | null) ?? null,
    done: toBool(r.done),
    doneAt: toNumOrNull(r.done_at),
    dueAt: toNumOrNull(r.due_at),
    priority: toNum(r.priority),
    tags: fromJson(r.tags, []),
    order: toNum(r.order),
    parentId: (r.parent_id as string | null) ?? null,
    createdAt: toNum(r.created_at),
    updatedAt: toNum(r.updated_at),
  };
}

const TaskListPatchSchema = TaskListInputSchema.partial();

export function createTaskStore(db: NeoDatabase, options: { clock?: Clock } = {}): TaskStore {
  const clock = options.clock ?? (() => Date.now());
  const listeners = new Set<(event: ChangeEvent) => void>();

  const emit = (event: ChangeEvent) => {
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the mutation that already happened.
      }
    }
  };

  const getList = (id: string): TaskList | null => {
    const r = db.prepare('SELECT * FROM task_lists WHERE id = ?').get(id) as Row | undefined;
    return r ? toTaskList(r) : null;
  };
  const mustGetList = (id: string): TaskList => {
    const l = getList(id);
    if (!l) throw new NeoError('not_found', `Unknown task list "${id}".`);
    return l;
  };
  const get = (id: string): Task | null => {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : null;
  };
  const mustGetTask = (id: string): Task => {
    const t = get(id);
    if (!t) throw new NeoError('not_found', `Task ${id} not found.`);
    return t;
  };
  const requireParent = (parentId: string | null | undefined, self?: string) => {
    if (parentId == null) return;
    if (parentId === self) throw new NeoError('bad_request', 'A task cannot be its own parent.');
    if (!get(parentId)) throw new NeoError('not_found', `Unknown parent task "${parentId}".`);
    if (self !== undefined) {
      // Walk the ancestor chain to reject N-level cycles.  The walk runs
      // inside the caller's db.transaction so a concurrent reparent cannot
      // sneak a cycle past this check.
      let cur: string | null = parentId;
      const visited = new Set<string>();
      while (cur !== null) {
        if (cur === self) throw new NeoError('bad_request', 'A task cannot be an ancestor of itself.');
        if (visited.has(cur)) break; // pre-existing corrupt cycle in storage — stop to avoid looping forever
        visited.add(cur);
        cur = get(cur)?.parentId ?? null;
      }
    }
  };
  const nextOrder = (table: 'tasks' | 'task_lists', listId?: string): number => {
    const r = (listId === undefined
      ? db.prepare(`SELECT MAX("order") AS m FROM ${table}`).get()
      : db.prepare(`SELECT MAX("order") AS m FROM ${table} WHERE list_id = ?`).get(listId)) as { m: number | null } | undefined;
    return (r?.m ?? 0) + 1;
  };

  // Older databases (before migration 5) may lack the inbox.
  db.prepare('INSERT OR IGNORE INTO task_lists (id, name, color, icon, "order", created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    INBOX_LIST_ID, 'Inbox', null, 'inbox', 0, clock(),
  );

  return {
    lists(): TaskList[] {
      return (db.prepare('SELECT * FROM task_lists ORDER BY "order" ASC, created_at ASC').all() as Row[]).map(toTaskList);
    },

    createList(input: TaskListInput): TaskList {
      const data = parseInput(TaskListInputSchema, input, 'task list');
      const now = clock();
      const list: TaskList = {
        id: newId('list', now),
        name: requireText(data.name, 'name'),
        color: data.color ?? null,
        icon: data.icon ?? null,
        order: nextOrder('task_lists'),
        createdAt: now,
      };
      db.prepare('INSERT INTO task_lists (id, name, color, icon, "order", created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        list.id, list.name, list.color, list.icon, list.order, list.createdAt,
      );
      return list;
    },

    updateList(id: string, patch: Partial<TaskListInput>): TaskList {
      const data = parseInput(TaskListPatchSchema, patch, 'task list update');
      const existing = mustGetList(id);
      const next: TaskList = {
        ...existing,
        name: data.name !== undefined ? requireText(data.name, 'name') : existing.name,
        color: data.color !== undefined ? data.color : existing.color,
        icon: data.icon !== undefined ? data.icon : existing.icon,
      };
      db.prepare('UPDATE task_lists SET name = ?, color = ?, icon = ? WHERE id = ?').run(next.name, next.color, next.icon, id);
      return next;
    },

    deleteList(id: string): boolean {
      if (id === INBOX_LIST_ID) throw new NeoError('forbidden', 'The inbox list cannot be deleted.');
      const moved = db.transaction((): Task[] | null => {
        if (!getList(id)) return null;
        // One statement moves every task (appended after the inbox's own tasks, keeping their order).
        const offset = nextOrder('tasks', INBOX_LIST_ID);
        const rows = db
          .prepare('UPDATE tasks SET list_id = ?, updated_at = ?, "order" = "order" + ? WHERE list_id = ? RETURNING *')
          .all(INBOX_LIST_ID, clock(), offset, id) as Row[];
        db.prepare('DELETE FROM task_lists WHERE id = ?').run(id);
        return rows.map(toTask).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
      });
      if (moved === null) return false;
      for (const task of moved) emit({ type: 'upsert', task });
      return true;
    },

    list(query: TaskListQuery = {}): Task[] {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (query.listId) {
        where.push('list_id = ?');
        args.push(query.listId);
      }
      if (query.done !== undefined) {
        where.push('done = ?');
        args.push(query.done ? 1 : 0);
      }
      if (typeof query.dueBefore === 'number' && Number.isFinite(query.dueBefore)) {
        where.push('due_at IS NOT NULL AND due_at <= ?');
        args.push(query.dueBefore);
      }
      const q = query.query?.trim();
      if (q) {
        where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
        args.push(likePattern(q), likePattern(q));
      }
      args.push(clampLimit(query.limit, 200, 1000));
      const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY "order" ASC, created_at ASC LIMIT ?`;
      return (db.prepare(sql).all(...args) as Row[]).map(toTask);
    },

    get,

    create(input: TaskInput): Task {
      const data = parseInput(TaskInputSchema, input, 'task');
      const title = requireText(data.title, 'title');
      const listId = data.listId ?? INBOX_LIST_ID;
      mustGetList(listId);
      requireParent(data.parentId);
      let parentId = data.parentId ?? null;
      if (parentId !== null && get(parentId)?.listId !== listId) parentId = null;
      const now = clock();
      const task: Task = {
        id: newId('task', now),
        listId,
        title,
        notes: data.notes ?? null,
        done: false,
        doneAt: null,
        dueAt: data.dueAt ?? null,
        priority: data.priority ?? 0,
        tags: data.tags ?? [],
        order: nextOrder('tasks', listId),
        parentId,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO tasks (id, list_id, title, notes, done, done_at, due_at, priority, tags, "order", parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(task.id, task.listId, task.title, task.notes, task.dueAt, task.priority, toJson(task.tags), task.order, task.parentId, now, now);
      emit({ type: 'upsert', task });
      return task;
    },

    update(id: string, patch: TaskPatch): Task {
      const { updated, subtasks } = db.transaction(() => {
        const data = parseInput(TaskPatchSchema, patch, 'task update');
        const existing = mustGetTask(id);
        if (data.listId !== undefined) mustGetList(data.listId);
        if (data.parentId !== undefined) requireParent(data.parentId, id);
        const now = clock();
        const done = data.done ?? existing.done;
        const movedList = data.listId !== undefined && data.listId !== existing.listId;
        const movedAwayFromParent = movedList && existing.parentId !== null;
        const updated: Task = {
          ...existing,
          title: data.title !== undefined ? requireText(data.title, 'title') : existing.title,
          notes: data.notes !== undefined ? data.notes : existing.notes,
          done,
          doneAt: done ? (existing.done ? existing.doneAt : now) : null,
          dueAt: data.dueAt !== undefined ? data.dueAt : existing.dueAt,
          priority: data.priority ?? existing.priority,
          tags: data.tags ?? existing.tags,
          listId: data.listId ?? existing.listId,
          order: data.order ?? (movedList ? nextOrder('tasks', data.listId) : existing.order),
          parentId: (() => {
            let pid = data.parentId !== undefined ? data.parentId : (movedAwayFromParent ? null : existing.parentId);
            const effectiveListId = data.listId ?? existing.listId;
            if (pid !== null && pid !== undefined && get(pid)?.listId !== effectiveListId) pid = null;
            return pid;
          })(),
          updatedAt: now,
        };
        db.prepare(
          `UPDATE tasks SET list_id = ?, title = ?, notes = ?, done = ?, done_at = ?, due_at = ?, priority = ?, tags = ?, "order" = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
        ).run(
          updated.listId, updated.title, updated.notes, updated.done ? 1 : 0, updated.doneAt, updated.dueAt, updated.priority,
          toJson(updated.tags), updated.order, updated.parentId, now, id,
        );
        const subtasks: Task[] = [];
        if (movedList) {
          const rows = db
            .prepare(
              `WITH RECURSIVE descendants(id) AS (
                 SELECT id FROM tasks WHERE id = ?
                 UNION
                 SELECT t.id FROM tasks t JOIN descendants d ON t.parent_id = d.id
               )
               SELECT * FROM tasks WHERE id IN (SELECT id FROM descendants) AND id != ?`,
            )
            .all(id, id) as Row[];
          if (rows.length > 0) {
            const ids = rows.map((r) => r.id as string);
            db.prepare(
              `UPDATE tasks SET list_id = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
            ).run(updated.listId, now, ...ids);
          }
          for (const row of rows) {
            subtasks.push({ ...toTask(row), listId: updated.listId, updatedAt: now });
          }
        }
        return { updated, subtasks };
      });
      for (const task of subtasks) emit({ type: 'upsert', task });
      emit({ type: 'upsert', task: updated });
      return updated;
    },

    delete(id: string): boolean {
      const deletedIds = db.transaction(() => {
        if (!get(id)) return [];
        const rows = db
          .prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM tasks WHERE id = ?
               UNION
               SELECT t.id FROM tasks t JOIN descendants d ON t.parent_id = d.id
             )
             SELECT id FROM descendants`,
          )
          .all(id) as { id: string }[];
        const ids = rows.map((r) => r.id);
        const CHUNK = 999;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          db.prepare(`DELETE FROM tasks WHERE id IN (${chunk.map(() => '?').join(', ')})`).run(...chunk);
        }
        return ids;
      });
      for (const deletedId of deletedIds) emit({ type: 'delete', id: deletedId });
      return deletedIds.length > 0;
    },

    onChange(listener: (event: ChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
