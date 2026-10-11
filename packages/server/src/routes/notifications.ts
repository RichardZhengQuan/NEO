import type { Hono } from 'hono';
import { z } from 'zod';
import { MarkReadRequestSchema } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { queryBoolean, queryLimit, validateBody, validateQuery } from './helpers.js';

export function registerNotifications(app: Hono, services: NeoServices): void {
  const { stores: { notifications } } = services;

  // GET /api/notifications
  app.get('/api/notifications', (c) => {
    const q = validateQuery(c, z.object({ unread: queryBoolean.optional(), limit: queryLimit.optional() }));
    const items = notifications.list(q);
    return c.json({ items });
  });

  // POST /api/notifications/read
  app.post('/api/notifications/read', async (c) => {
    const body = await validateBody(c, MarkReadRequestSchema);
    const count = notifications.markRead(body.ids);
    return c.json({ count });
  });
}
