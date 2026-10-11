import type { Hono } from 'hono';
import { z } from 'zod';
import {
  CreateReminderRequestSchema,
  NeoError,
  ReminderStatusSchema,
  SnoozeRequestSchema,
  UpdateReminderRequestSchema,
} from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { queryList, queryLimit, queryNumber, validateBody, validateQuery } from './helpers.js';

export function registerReminders(app: Hono, services: NeoServices): void {
  const { stores: { reminders } } = services;

  // GET /api/reminders
  app.get('/api/reminders', (c) => {
    const q = validateQuery(c, z.object({
      status: queryList(ReminderStatusSchema).optional(),
      from: queryNumber.optional(), to: queryNumber.optional(), limit: queryLimit.optional(),
    }));
    const items = reminders.list(q);
    return c.json({ items });
  });

  // POST /api/reminders
  app.post('/api/reminders', async (c) => {
    const body = await validateBody(c, CreateReminderRequestSchema);
    const reminder = reminders.create({ ...body, timezone: body.timezone ?? services.settings.get().timezone });
    return c.json(reminder, 201);
  });

  // GET /api/reminders/:id
  app.get('/api/reminders/:id', (c) => {
    const id = c.req.param('id');
    const reminder = reminders.get(id);
    if (!reminder) throw new NeoError('not_found', 'Reminder not found');
    return c.json(reminder);
  });

  // PATCH /api/reminders/:id
  app.patch('/api/reminders/:id', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, UpdateReminderRequestSchema);
    if (!reminders.get(id)) throw new NeoError('not_found', 'Reminder not found');
    const reminder = reminders.update(id, body);
    return c.json(reminder);
  });

  // DELETE /api/reminders/:id
  app.delete('/api/reminders/:id', (c) => {
    const id = c.req.param('id');
    if (!reminders.get(id)) throw new NeoError('not_found', 'Reminder not found');
    reminders.delete(id);
    return new Response(null, { status: 204 });
  });

  // POST /api/reminders/:id/snooze
  app.post('/api/reminders/:id/snooze', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, SnoozeRequestSchema);
    if (!reminders.get(id)) throw new NeoError('not_found', 'Reminder not found');
    const reminder = reminders.snooze(id, body.minutes);
    return c.json(reminder);
  });

  // POST /api/reminders/:id/complete
  app.post('/api/reminders/:id/complete', (c) => {
    const id = c.req.param('id');
    if (!reminders.get(id)) throw new NeoError('not_found', 'Reminder not found');
    const reminder = reminders.complete(id);
    return c.json(reminder);
  });
}
