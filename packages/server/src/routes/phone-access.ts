import type { Hono } from 'hono';
import { NeoError, UpdatePhoneAccessRequestSchema } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import type { PhoneAccessManager } from '../tunnel/manager.js';
import { validateBody } from './helpers.js';

export function registerPhoneAccess(app: Hono, services: NeoServices, phoneAccess: PhoneAccessManager): void {
  app.get('/api/phone-access', (c) => c.json(phoneAccess.status()));

  // Owner only — enforced in app.ts.
  app.patch('/api/phone-access', async (c) => {
    const body = await validateBody(c, UpdatePhoneAccessRequestSchema);
    if (body.relayUrl) {
      let url: URL;
      try { url = new URL(body.relayUrl); }
      catch { throw new NeoError('bad_request', 'Invalid relay URL'); }
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || body.relayUrl.includes('?') || body.relayUrl.includes('#')) {
        throw new NeoError('bad_request', 'Invalid relay URL');
      }
    }
    try { services.settings.update({ phoneAccess: body }); }
    catch (error) { throw NeoError.from(error, 'bad_request'); }
    await phoneAccess.ready();
    return c.json(phoneAccess.status());
  });
}
