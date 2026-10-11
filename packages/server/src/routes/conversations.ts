import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  CancelTurnRequestSchema,
  ConfirmToolRequestSchema,
  CreateConversationRequestSchema,
  NeoError,
  SendMessageRequestSchema,
  UiActionRequestSchema,
  UpdateConversationRequestSchema,
} from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { queryBoolean, queryLimit, queryNumber, validateBody, validateQuery } from './helpers.js';

export function registerConversations(app: Hono, services: NeoServices): void {
  const { conversations, runtime } = services;

  // GET /api/conversations
  app.get('/api/conversations', async (c) => {
    const q = validateQuery(c, z.object({
      limit: queryLimit.optional(),
      before: queryNumber.optional(),
      archived: queryBoolean.optional(),
      query: z.string().optional(),
    }));
    const items = conversations.list(q);
    return c.json({ items });
  });

  // POST /api/conversations
  app.post('/api/conversations', async (c) => {
    const body = await validateBody(c, CreateConversationRequestSchema);
    const conv = conversations.create(body);
    services.events.publish({ type: 'conversation.updated', conversation: conv });
    return c.json(conv, 201);
  });

  // GET /api/conversations/:id
  app.get('/api/conversations/:id', async (c) => {
    const id = c.req.param('id');
    const q = validateQuery(c, z.object({
      limit: queryLimit.optional(),
      before: queryNumber.optional(),
    }));
    const conv = conversations.get(id);
    if (!conv) throw new NeoError('not_found', 'Conversation not found');
    const limit = q.limit ?? 100;
    const msgs = conversations.messages(id, { limit: limit + 1, before: q.before });
    const hasMore = msgs.length > limit;
    const messages = hasMore ? msgs.slice(-limit) : msgs;
    return c.json({ conversation: conv, messages, hasMore });
  });

  // PATCH /api/conversations/:id
  app.patch('/api/conversations/:id', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, UpdateConversationRequestSchema);
    const conv = conversations.get(id);
    if (!conv) throw new NeoError('not_found', 'Conversation not found');
    const updated = conversations.update(id, body);
    services.events.publish({ type: 'conversation.updated', conversation: updated });
    return c.json(updated);
  });

  // DELETE /api/conversations/:id
  app.delete('/api/conversations/:id', async (c) => {
    const id = c.req.param('id');
    const conv = conversations.get(id);
    if (!conv) throw new NeoError('not_found', 'Conversation not found');
    runtime.cancelConversation(id);
    conversations.delete(id);
    services.events.publish({ type: 'conversation.deleted', conversationId: id });
    return new Response(null, { status: 204 });
  });

  // POST /api/conversations/:id/messages
  app.post('/api/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    const conv = conversations.get(id);
    if (!conv) throw new NeoError('not_found', 'Conversation not found');
    const body = await validateBody(c, SendMessageRequestSchema);

    const parts = body.parts?.length ? body.parts : [{ type: 'text' as const, text: body.text! }];
    // Let the runtime apply conversation/default-model precedence.
    const model = body.model;

    // Check if client wants SSE streaming
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/event-stream')) {
      // Start turn but do NOT pass abort signal (client disconnect must not cancel)
      const turn = await runtime.send({ conversationId: id, parts, model });
      return streamSSE(c, async (stream) => {
        for await (const event of turn.events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
          if (event.type === 'turn.finished' || event.type === 'turn.failed') break;
        }
      });
    }

    // Non-streaming: kick off the turn and return 202
    const turn = await runtime.send({ conversationId: id, parts, model });
    return c.json(
      {
        turnId: turn.turnId,
        userMessage: turn.userMessage,
        assistantMessageId: turn.assistantMessageId,
      } satisfies import('@neo/protocol').SendMessageResponse,
      202,
    );
  });

  // POST /api/conversations/:id/cancel
  app.post('/api/conversations/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, CancelTurnRequestSchema);
    if (!conversations.get(id)) throw new NeoError('not_found', 'Conversation not found');
    let cancelled: boolean;
    if (body.turnId) {
      cancelled = runtime.activeTurns().some((turn) => turn.turnId === body.turnId && turn.conversationId === id)
        ? runtime.cancel(body.turnId) : false;
    } else {
      cancelled = runtime.cancelConversation(id);
    }
    return c.json({ cancelled });
  });

  // POST /api/conversations/:id/ui-action
  app.post('/api/conversations/:id/ui-action', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, UiActionRequestSchema);
    const result = await runtime.handleUiAction({
      conversationId: id,
      messageId: body.messageId,
      uiId: body.uiId,
      actionId: body.actionId,
      values: body.values,
      ...(body.confirmationToken !== undefined ? { confirmationToken: body.confirmationToken } : {}),
    });
    if (result.kind === 'turn') {
      return c.json({
        kind: 'turn',
        turnId: result.turn.turnId,
        assistantMessageId: result.turn.assistantMessageId,
        userMessage: result.turn.userMessage,
      });
    } else if (result.kind === 'tool') {
      return c.json({
        kind: 'tool',
        output: result.result.output,
        isError: result.result.isError ?? false,
        summary: result.result.summary,
      });
    } else if (result.kind === 'client') {
      return c.json({ kind: 'client', action: result.action });
    } else if (result.kind === 'confirm') {
      return c.json({ kind: 'confirm', confirmation: result.confirmation });
    } else {
      return c.json({ kind: 'noop' });
    }
  });

  // GET /api/confirmations
  app.get('/api/confirmations', (c) => {
    const items = runtime.pendingConfirmations();
    return c.json({ items });
  });

  // POST /api/confirmations/:id (server-generated confirmation nonce)
  app.post('/api/confirmations/:id', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, ConfirmToolRequestSchema);
    const ok = runtime.confirm(id, body);
    if (!ok) throw new NeoError('not_found', 'Confirmation not found or expired');
    return c.json({ ok });
  });
}
