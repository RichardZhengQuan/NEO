import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  CancelTurnRequestSchema,
  ConfirmToolRequestSchema,
  NeoError,
  SendMessageRequestSchema,
  StartOffRecordRequestSchema,
  UiActionRequestSchema,
  type TimelineDeleteResult,
} from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { queryLimit, validateBody, validateQuery } from './helpers.js';

const isoDate = z.string().datetime({ offset: true }).transform(value => Date.parse(value));

export function registerTimeline(app: Hono, services: NeoServices): void {
  const { conversations, runtime, memory } = services;

  app.get('/api/timeline', c => {
    const query = validateQuery(c, z.object({
      before: z.string().min(1).optional(),
      limit: queryLimit.optional(),
      around: z.string().min(1).optional(),
    }).refine(query => !(query.before && query.around), 'Use before or around, not both'));
    return c.json(conversations.timeline(query));
  });

  app.get('/api/timeline/search', c => {
    const query = validateQuery(c, z.object({ q: z.string().trim().min(1).max(1000), limit: queryLimit.optional() }));
    return c.json({ items: conversations.searchMessages(query.q, query.limit) });
  });

  app.post('/api/timeline/messages', async c => {
    const body = await validateBody(c, SendMessageRequestSchema);
    const rawParts = body.parts ?? [];
    const hasTextPart = rawParts.some(part => part.type === 'text');
    const text = body.text?.trim();
    const parts = rawParts.length
      ? (text && !hasTextPart ? [{ type: 'text' as const, text }, ...rawParts] : rawParts)
      : [{ type: 'text' as const, text: text! }];
    const turn = await runtime.sendTimeline({ parts, offRecord: body.offRecord });
    if ((c.req.header('accept') ?? '').includes('text/event-stream')) {
      return streamSSE(c, async stream => {
        for await (const event of turn.events) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === 'turn.finished' || event.type === 'turn.failed') break;
        }
      });
    }
    return c.json({
      turnId: turn.turnId,
      episodeId: turn.conversationId,
      userMessage: { ...turn.userMessage, episodeId: turn.conversationId },
      assistantMessageId: turn.assistantMessageId,
    } satisfies import('@neo/protocol').SendMessageResponse, 202);
  });

  app.post('/api/timeline/cancel', async c => {
    const body = await validateBody(c, CancelTurnRequestSchema);
    return c.json({ cancelled: runtime.cancelTimeline(body.turnId) });
  });

  app.get('/api/timeline/off-record', c => c.json(runtime.offRecordState()));
  app.post('/api/timeline/off-record/start', async c => {
    if ((await c.req.text()).length) await validateBody(c, StartOffRecordRequestSchema);
    return c.json(await runtime.startOffRecord());
  });
  app.post('/api/timeline/off-record/end', async c => c.json(await runtime.endOffRecord()));

  app.post('/api/timeline/ui-action', async c => {
    const body = await validateBody(c, UiActionRequestSchema);
    const result = await runtime.handleTimelineUiAction(body);
    if (result.kind === 'turn') {
      return c.json({
        kind: 'turn',
        turnId: result.turn.turnId,
        episodeId: result.turn.conversationId,
        assistantMessageId: result.turn.assistantMessageId,
        userMessage: { ...result.turn.userMessage, episodeId: result.turn.conversationId },
      });
    }
    if (result.kind === 'tool') {
      return c.json({ kind: 'tool', output: result.result.output, isError: result.result.isError ?? false, summary: result.result.summary });
    }
    if (result.kind === 'client') return c.json({ kind: 'client', action: result.action });
    if (result.kind === 'confirm') return c.json({ kind: 'confirm', confirmation: result.confirmation });
    return c.json({ kind: 'noop' });
  });

  async function deleteMessages(ids: string[], remove: () => string[]): Promise<TimelineDeleteResult> {
    const episodeIds = new Set(ids.map(id => conversations.getMessage(id)?.conversationId).filter((id): id is string => !!id));
    // Close before removing anything: cached prefixes must never be reused after a user deletion.
    for (const id of episodeIds) conversations.closeEpisode(id);
    for (const turn of runtime.activeTurns()) {
      if (episodeIds.has(turn.conversationId)) runtime.cancel(turn.turnId);
    }
    await runtime.waitForIdle([...episodeIds]);
    const messageIds = remove();
    const derivedMemories = (await memory.findBySource(messageIds)).length;
    return { deleted: messageIds.length, messageIds, derivedMemories };
  }

  app.delete('/api/timeline/messages/:id', async c => {
    const id = c.req.param('id');
    return c.json(await runtime.mutateTimeline(async () => {
      if (!conversations.getMessage(id)) throw new NeoError('not_found', 'Message not found');
      return deleteMessages([id], () => conversations.deleteMessage(id) ? [id] : []);
    }));
  });

  app.delete('/api/timeline', async c => {
    const query = validateQuery(c, z.object({ from: isoDate.optional(), to: isoDate.optional() })
      .refine(query => query.from !== undefined || query.to !== undefined, 'Provide from or to')
      .refine(query => query.from === undefined || query.to === undefined || query.from <= query.to, 'from must not be after to'));
    return c.json(await runtime.mutateTimeline(async () => {
      // Select while sends are excluded, then settle affected turns before rows disappear.
      const ids = conversations.messagesInRange(query).map(message => message.id);
      return deleteMessages(ids, () => conversations.deleteRange(query).map(message => message.id));
    }));
  });

  app.get('/api/confirmations', c => c.json({ items: runtime.pendingConfirmations() }));
  app.post('/api/confirmations/:id', async c => {
    const body = await validateBody(c, ConfirmToolRequestSchema);
    const ok = runtime.confirm(c.req.param('id'), body);
    if (!ok) throw new NeoError('not_found', 'Confirmation not found or expired');
    return c.json({ ok });
  });
}
