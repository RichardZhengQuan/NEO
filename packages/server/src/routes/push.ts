import type { Hono } from 'hono';
import { z } from 'zod';
import { NeoError, PushSubscribeRequestSchema } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import '../types.js';
import { validateBody } from './helpers.js';
import { isAllowedPushEndpoint, pushAllowedHosts } from '../push-policy.js';

export function registerPush(app: Hono, services: NeoServices, vapidPublicKey: string | null): void {
  const { push } = services;

  // GET /api/push/vapid-public-key
  app.get('/api/push/vapid-public-key', (c) => {
    return c.json({ publicKey: vapidPublicKey });
  });

  // POST /api/push/subscribe
  app.post('/api/push/subscribe', async (c) => {
    const body = await validateBody(c, PushSubscribeRequestSchema);
    if (!isAllowedPushEndpoint(body.subscription.endpoint, pushAllowedHosts(services.config))) {
      throw new NeoError('bad_request', 'Push endpoint must use HTTPS on an allowed Web Push service host');
    }
    const device = c.get('device');
    push.add(body.subscription, device.id);
    return c.json({ ok: true });
  });

  // POST /api/push/unsubscribe
  app.post('/api/push/unsubscribe', async (c) => {
    const body = await validateBody(c, z.object({ endpoint: z.string().url() }));
    push.remove(body.endpoint);
    return c.json({ ok: true });
  });
}
