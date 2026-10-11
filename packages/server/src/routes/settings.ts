import type { Hono } from 'hono';
import { NeoError, UpdateSettingsRequestSchema } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { validateBody } from './helpers.js';

export function registerSettings(app: Hono, services: NeoServices): void {
  const { settings } = services;

  // GET /api/settings
  app.get('/api/settings', (c) => {
    return c.json(settings.get());
  });

  // PATCH /api/settings
  app.patch('/api/settings', async (c) => {
    const raw: unknown = await c.req.json().catch(() => { throw new NeoError('bad_request', 'Invalid JSON body'); });
    if (raw && typeof raw === 'object' && 'phoneAccess' in raw) {
      throw new NeoError('bad_request', 'Use PATCH /api/phone-access');
    }
    const body = await validateBody(c, UpdateSettingsRequestSchema);

    // Deep partial patch: update settings (validate + merge done inside)
    let updated;
    try {
      updated = settings.update(body);
    } catch (err) {
      throw NeoError.from(err, 'bad_request');
    }

    // Composition subscribes once, so API and tool-driven updates behave alike.
    return c.json(updated);
  });
}
