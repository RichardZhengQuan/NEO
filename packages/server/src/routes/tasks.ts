import type { Hono } from 'hono';
import { z } from 'zod';
import {
  CreateTaskListRequestSchema,
  CreateTaskRequestSchema,
  NeoError,
  UpdateTaskListRequestSchema,
  UpdateTaskRequestSchema,
} from '@neo/protocol';
import { INBOX_LIST_ID } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { queryBoolean, queryLimit, validateBody, validateQuery } from './helpers.js';

export function registerTasks(app: Hono, services: NeoServices): void {
  const { stores: { tasks } } = services;

  // GET /api/task-lists
  app.get('/api/task-lists', (c) => {
    const items = tasks.lists();
    return c.json({ items });
  });

  // POST /api/task-lists
  app.post('/api/task-lists', async (c) => {
    const body = await validateBody(c, CreateTaskListRequestSchema);
    const list = tasks.createList(body);
    return c.json(list, 201);
  });

  // PATCH /api/task-lists/:id
  app.patch('/api/task-lists/:id', async (c) => {
    const id = c.req.param('id');
    if (id === INBOX_LIST_ID) throw new NeoError('bad_request', 'Cannot modify the inbox list');
    const body = await validateBody(c, UpdateTaskListRequestSchema);
    const list = tasks.updateList(id, body);
    return c.json(list);
  });

  // DELETE /api/task-lists/:id
  app.delete('/api/task-lists/:id', (c) => {
    const id = c.req.param('id');
    if (id === INBOX_LIST_ID) throw new NeoError('bad_request', 'Cannot delete the inbox list');
    // TaskStore.list caps results at 1000 and has no pagination. Snapshot IDs
    // directly when SQLite is available so large lists also deliver every move.
    const movedIds = services.db
      ? (services.db.prepare('SELECT id FROM tasks WHERE list_id = ?').all(id) as { id: string }[]).map((row) => row.id)
      : tasks.list({ listId: id, limit: 1000 }).map((task) => task.id);
    // Current TaskStore moves these rows silently. Publish their new state;
    // suppress duplicates if the store starts emitting those upserts itself.
    const emitted = new Set<string>();
    const unsubscribe = tasks.onChange((event) => {
      if (event.type === 'upsert') emitted.add(event.task.id);
    });
    try {
      const ok = tasks.deleteList(id);
      if (!ok) throw new NeoError('not_found', 'Task list not found');
      for (const taskId of movedIds) {
        const current = tasks.get(taskId);
        if (current && !emitted.has(current.id)) services.events.publish({ type: 'task.updated', task: current });
      }
    } finally {
      unsubscribe();
    }
    return new Response(null, { status: 204 });
  });

  // GET /api/tasks
  app.get('/api/tasks', (c) => {
    const q = validateQuery(c, z.object({
      listId: z.string().optional(), done: queryBoolean.optional(),
      query: z.string().optional(), limit: queryLimit.optional(),
    }));
    const items = tasks.list(q);
    return c.json({ items });
  });

  // GET /api/tasks/:id
  app.get('/api/tasks/:id', (c) => {
    const task = tasks.get(c.req.param('id'));
    if (!task) throw new NeoError('not_found', 'Task not found');
    return c.json(task);
  });

  // POST /api/tasks
  app.post('/api/tasks', async (c) => {
    const body = await validateBody(c, CreateTaskRequestSchema);
    const task = tasks.create(body);
    return c.json(task, 201);
  });

  // PATCH /api/tasks/:id
  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, UpdateTaskRequestSchema);
    if (!tasks.get(id)) throw new NeoError('not_found', 'Task not found');
    // The store currently lets SQLite reject unknown destinations as raw errors.
    if (body.listId !== undefined && !tasks.lists().some((list) => list.id === body.listId)) {
      throw new NeoError('not_found', 'Task list not found');
    }
    const task = tasks.update(id, body);
    return c.json(task);
  });

  // DELETE /api/tasks/:id
  app.delete('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    if (!tasks.get(id)) throw new NeoError('not_found', 'Task not found');
    tasks.delete(id);
    return new Response(null, { status: 204 });
  });
}
