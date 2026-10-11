import type { Hono } from 'hono';
import { z } from 'zod';
import {
  CreateMemoryRequestSchema,
  ForgetMatchingRequestSchema,
  IdsRequestSchema,
  ImportMemoryRequestSchema,
  LinkMemoryRequestSchema,
  EdgeTypeSchema,
  GraphQuerySchema,
  MemoryKindSchema,
  MemorySearchQuerySchema,
  MemoryStatusSchema,
  NeoError,
  UpdateMemoryRequestSchema,
} from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { queryBoolean, queryList, queryLimit, queryNumber, validateBody, validateQuery } from './helpers.js';

export function registerMemory(app: Hono, services: NeoServices): void {
  const { memory } = services;

  // GET /api/memory
  app.get('/api/memory', async (c) => {
    const q = validateQuery(c, MemorySearchQuerySchema.extend({
      kinds: queryList(MemoryKindSchema).optional(),
      status: queryList(MemoryStatusSchema).optional(),
      tags: queryList(z.string()).optional(),
      pinned: queryBoolean.optional(),
      limit: queryLimit.optional(),
      offset: queryNumber.pipe(z.number().int().nonnegative()).optional(),
    }));
    const result = await memory.search(q);
    return c.json(result);
  });

  // POST /api/memory
  app.post('/api/memory', async (c) => {
    const body = await validateBody(c, CreateMemoryRequestSchema);
    const node = await memory.remember({ ...body, source: { by: 'user' } });
    return c.json(node, 201);
  });

  // GET /api/memory/stats
  app.get('/api/memory/stats', async (c) => {
    const stats = await memory.stats();
    return c.json(stats);
  });

  // GET /api/memory/graph
  app.get('/api/memory/graph', async (c) => {
    const q = validateQuery(c, GraphQuerySchema.extend({
      depth: queryNumber.pipe(z.number().int().min(1).max(4)).optional(),
      limit: queryNumber.pipe(z.number().int().min(1).max(1000)).optional(),
      kinds: queryList(MemoryKindSchema).optional(),
      includeArchived: queryBoolean.optional(),
    }));
    const graph = await memory.graph(q);
    return c.json(graph);
  });

  // GET /api/memory/journal
  app.get('/api/memory/journal', async (c) => {
    const q = validateQuery(c, z.object({ limit: queryLimit.optional() }));
    const items = await memory.journal(q.limit);
    return c.json({ items });
  });

  // POST /api/memory/consolidate
  app.post('/api/memory/consolidate', async (c) => {
    const report = await memory.consolidate({ force: true });
    return c.json(report);
  });

  // GET /api/memory/export
  app.get('/api/memory/export', async (c) => {
    const q = validateQuery(c, z.object({ embeddings: queryBoolean.optional() }));
    const data = await memory.export({ includeEmbeddings: q.embeddings ?? false });
    const date = new Date(services.clock()).toISOString().slice(0, 10);
    c.header('Content-Disposition', `attachment; filename=neo-memory-${date}.json`);
    c.header('Content-Type', 'application/json');
    return c.body(JSON.stringify(data));
  });

  // POST /api/memory/import
  app.post('/api/memory/import', async (c) => {
    const body = await validateBody(c, ImportMemoryRequestSchema);
    const report = await memory.import(body.data, { mode: body.mode });
    return c.json(report);
  });

  // POST /api/memory/approve
  app.post('/api/memory/approve', async (c) => {
    const body = await validateBody(c, IdsRequestSchema);
    const count = await memory.approve(body.ids);
    return c.json({ count });
  });

  // POST /api/memory/reject
  app.post('/api/memory/reject', async (c) => {
    const body = await validateBody(c, IdsRequestSchema);
    const count = await memory.reject(body.ids);
    return c.json({ count });
  });

  // POST /api/memory/forget
  app.post('/api/memory/forget', async (c) => {
    const body = await validateBody(c, IdsRequestSchema);
    const deleted = await memory.forget(body.ids);
    return c.json({ deleted });
  });

  // POST /api/memory/find-for-forget
  app.post('/api/memory/find-for-forget', async (c) => {
    const body = await validateBody(c, ForgetMatchingRequestSchema);
    const result = await memory.findForForget(body.query, body.limit);
    return c.json({ items: result });
  });

  // POST /api/memory/links
  app.post('/api/memory/links', async (c) => {
    const body = await validateBody(c, LinkMemoryRequestSchema.extend({ type: EdgeTypeSchema }));
    const edge = await memory.link(body.from, body.to, body.type, body.weight);
    return c.json(edge);
  });

  // DELETE /api/memory/links/:edgeId
  app.delete('/api/memory/links/:edgeId', async (c) => {
    const edgeId = c.req.param('edgeId');
    const ok = await memory.unlink(edgeId);
    return c.json({ ok });
  });

  // GET /api/memory/:id
  app.get('/api/memory/:id', async (c) => {
    const id = c.req.param('id');
    const node = await memory.get(id);
    if (!node) throw new NeoError('not_found', 'Memory node not found');
    return c.json(node);
  });

  // PATCH /api/memory/:id
  app.patch('/api/memory/:id', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, UpdateMemoryRequestSchema);
    const node = await memory.update(id, body);
    return c.json(node);
  });

  // DELETE /api/memory/:id
  app.delete('/api/memory/:id', async (c) => {
    const id = c.req.param('id');
    const deleted = await memory.forget([id]);
    return c.json({ deleted });
  });
}
