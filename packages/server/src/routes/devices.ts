import type { Hono } from 'hono';
import { CreateDeviceRequestSchema, NeoError, buildPairingUrl } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { validateBody } from './helpers.js';

export function registerDevices(app: Hono, services: NeoServices): void {
  const { devices } = services;

  // GET /api/devices
  app.get('/api/devices', (c) => {
    return c.json({ items: devices.list() });
  });

  // POST /api/devices (owner only — enforced in app.ts)
  app.post('/api/devices', async (c) => {
    const body = await validateBody(c, CreateDeviceRequestSchema);
    const { device, token } = devices.create({
      name: body.name,
      platform: body.platform,
      owner: false,
    });

    const origin = new URL(c.req.url).origin;
    const publicUrl = services.config.server.publicUrl ?? origin;
    const pairingUrl = buildPairingUrl(publicUrl, token);

    return c.json({ device, token, pairingUrl }, 201);
  });

  // DELETE /api/devices/:id
  app.delete('/api/devices/:id', (c) => {
    const id = c.req.param('id');
    const all = devices.list();
    const target = all.find((d) => d.id === id);
    if (!target) throw new NeoError('not_found', 'Device not found');
    if (target.owner) throw new NeoError('bad_request', 'Cannot revoke the owner device');
    const ok = devices.revoke(id);
    if (!ok) throw new NeoError('not_found', 'Device not found');
    return new Response(null, { status: 204 });
  });
}
