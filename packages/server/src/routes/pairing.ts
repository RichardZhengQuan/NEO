import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ClaimPairingRequestSchema, NeoError, buildPairingLink } from '@neo/protocol';
import type { ClaimPairingResponse, PairingSession } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { getClientIp, IpFailureLimiter } from '../auth.js';
import type { PairingService } from '../pairing.js';
import { validateBody } from './helpers.js';

/** Register before authentication: a phone has no device token until it claims a code. */
export function registerPairingClaim(app: Hono, services: NeoServices, pairing: PairingService): void {
  const limiter = new IpFailureLimiter(services.clock);
  app.post('/api/pairing/claim', bodyLimit({
    maxSize: 4 * 1024,
    onError: () => { throw new NeoError('bad_request', 'Request body is too large'); },
  }), async (c) => {
    const ip = getClientIp(c, services.config.server.trustProxy);
    if (limiter.isRateLimited(ip)) {
      c.header('Retry-After', '60');
      return c.json({ code: 'rate_limited', message: 'Too many failed pairing attempts', retryable: true }, 429);
    }
    const body = await validateBody(c, ClaimPairingRequestSchema);
    const claimed = pairing.claim(body.code);
    if (!claimed) {
      limiter.recordFailure(ip);
      throw new NeoError('unauthorized', 'This pairing code is invalid or has expired.');
    }
    const result: ClaimPairingResponse = services.devices.create({
      name: body.deviceName,
      platform: body.platform,
      owner: false,
    });
    services.events.publish({ type: 'device.paired', device: result.device, pairingId: claimed.id });
    return c.json(result, 201);
  });
}

export function registerPairing(app: Hono, services: NeoServices, pairing: PairingService): void {
  // POST /api/pairing (owner only — enforced in app.ts)
  app.post('/api/pairing', (c) => {
    const session = pairing.create();
    const serverUrl = services.config.server.publicUrl ?? new URL(c.req.url).origin;
    const result: PairingSession = { ...session, pairingUrl: buildPairingLink({ code: session.code, serverUrl }) };
    return c.json(result, 201);
  });

  // DELETE /api/pairing/:id (owner only — enforced in app.ts)
  app.delete('/api/pairing/:id', (c) => {
    if (!pairing.cancel(c.req.param('id'))) throw new NeoError('not_found', 'Pairing code not found');
    return new Response(null, { status: 204 });
  });
}
