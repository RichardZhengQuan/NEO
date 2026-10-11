import type { Hono } from 'hono';
import { z } from 'zod';
import { CreateNoteRequestSchema, NeoError, UpdateNoteRequestSchema } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { queryLimit, validateBody, validateQuery } from './helpers.js';

export function registerNotes(app: Hono, services: NeoServices): void {
  const { stores: { notes } } = services;

  // GET /api/notes
  app.get('/api/notes', (c) => {
    const q = validateQuery(c, z.object({
      query: z.string().optional(), tag: z.string().optional(), limit: queryLimit.optional(),
    }));
    const items = notes.list(q);
    return c.json({ items });
  });

  // POST /api/notes
  app.post('/api/notes', async (c) => {
    const body = await validateBody(c, CreateNoteRequestSchema);
    const note = notes.create(body);
    return c.json(note, 201);
  });

  // GET /api/notes/:id
  app.get('/api/notes/:id', (c) => {
    const id = c.req.param('id');
    const note = notes.get(id);
    if (!note) throw new NeoError('not_found', 'Note not found');
    return c.json(note);
  });

  // PATCH /api/notes/:id
  app.patch('/api/notes/:id', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, UpdateNoteRequestSchema);
    if (!notes.get(id)) throw new NeoError('not_found', 'Note not found');
    const note = notes.update(id, body);
    return c.json(note);
  });

  // DELETE /api/notes/:id
  app.delete('/api/notes/:id', (c) => {
    const id = c.req.param('id');
    if (!notes.get(id)) throw new NeoError('not_found', 'Note not found');
    notes.delete(id);
    return new Response(null, { status: 204 });
  });
}
