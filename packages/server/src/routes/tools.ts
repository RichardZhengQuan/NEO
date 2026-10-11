import type { Hono } from 'hono';
import { NeoError, SetToolPermissionRequestSchema } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { validateBody } from './helpers.js';

export function registerTools(app: Hono, services: NeoServices): void {
  const { tools, settings } = services;

  // GET /api/tools
  app.get('/api/tools', (c) => {
    const items = tools.info();
    return c.json({ items });
  });

  // PUT /api/tools/:name/permission
  app.put('/api/tools/:name/permission', async (c) => {
    const name = c.req.param('name');
    const body = await validateBody(c, SetToolPermissionRequestSchema);

    // Check tool exists
    const tool = tools.get(name);
    if (!tool) throw new NeoError('not_found', `Tool '${name}' not found`);

    // Persist into settings
    const currentSettings = settings.get();
    settings.update({
      tools: {
        permissions: {
          ...currentSettings.tools.permissions,
          [name]: body.permission,
        },
      },
    });

    // Return updated tool info
    const updatedTool = tools.info().find((info) => info.name === name);
    if (!updatedTool) throw new NeoError('not_found', `Tool '${name}' not found`);
    return c.json(updatedTool);
  });
}
