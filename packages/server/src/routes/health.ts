import type { Hono } from 'hono';
import { API_VERSION } from '@neo/protocol';
import type { NeoServices } from '../index.js';

const VERSION = '0.1.0';

export function registerHealth(app: Hono, services: NeoServices): void {
  app.get('/api/health', (c) => {
    const settings = services.settings.get();
    return c.json({
      ok: true as const,
      name: 'neo' as const,
      version: VERSION,
      apiVersion: API_VERSION,
      mode: services.config.mode,
      onboarded: settings.onboarded,
      time: services.clock(),
    });
  });
}
