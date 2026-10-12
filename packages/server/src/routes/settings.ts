import type { Hono } from 'hono';
import { AI_CAPABILITIES, NeoError, UpdateSettingsRequestSchema, applySettingsPatch } from '@neo/protocol';
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
    const body = await validateBody(c, UpdateSettingsRequestSchema);

    // Deep partial patch: update settings (validate + merge done inside)
    let updated;
    try {
      const next = applySettingsPatch(settings.get(), body);
      for (const capability of AI_CAPABILITIES) {
        const legacyKey = capability === 'text' ? ('defaultModel' in body || 'memoryModel' in body) : capability === 'embedding' && 'embedding' in body;
        if (!body.ai && !legacyKey) continue;
        const ref = next.ai.capabilities[capability];
        if (!ref) continue;
        const configured = services.config.providers.find(provider => provider.id === ref.provider)
          ?? services.providerConfigs.get(ref.provider)
          ?? services.providers.get(ref.provider)?.config;
        if (configured?.kind === 'mock') throw new NeoError('bad_request', 'Mock providers are reserved for internal tests. Connect an AI provider instead.');
        if (configured?.kind === 'chatgpt' && capability !== 'text') throw new NeoError('bad_request', 'ChatGPT plan connections support text generation only.');
      }
      updated = settings.update(body);
    } catch (err) {
      throw NeoError.from(err, 'bad_request');
    }

    // Composition subscribes once, so API and tool-driven updates behave alike.
    return c.json(updated);
  });
}
