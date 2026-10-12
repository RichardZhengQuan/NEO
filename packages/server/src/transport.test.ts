import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSContext } from 'hono/ws';
import { NeoConfigSchema, newId, silentLogger } from '@neo/protocol';
import type { AgentEvent, AgentRuntimeApi, Message, TurnHandle, WsServerMessage } from '@neo/protocol';
import type { NeoServer } from './index.js';
import { startServer } from './server.js';
import { createWsHandler } from './ws.js';

const TOKEN = 'transport-owner-token';
const config = NeoConfigSchema.parse({
  server: { host: '127.0.0.1', port: 0, authToken: TOKEN },
  settings: { memory: { consolidation: { enabled: false } } },
});

class Inbox {
  readonly messages: WsServerMessage[] = [];
  private queued: WsServerMessage[] = [];
  private pending: ((message: WsServerMessage) => void)[] = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as WsServerMessage;
      this.messages.push(message);
      const receive = this.pending.shift();
      if (receive) receive(message);
      else this.queued.push(message);
    });
  }

  async next(): Promise<WsServerMessage> {
    const queued = this.queued.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const receive = (message: WsServerMessage) => { clearTimeout(timeout); resolve(message); };
      const timeout = setTimeout(() => {
        this.pending = this.pending.filter((listener) => listener !== receive);
        reject(new Error('WebSocket message timed out'));
      }, 3000);
      this.pending.push(receive);
    });
  }
}

async function connect(server: NeoServer): Promise<Inbox> {
  const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/api/ws`);
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  return inbox;
}

function scriptedRuntime(server: NeoServer, release: Promise<void> = Promise.resolve()) {
  let handle: TurnHandle | null = null;
  const cancel = vi.fn(() => false);
  const runtime: AgentRuntimeApi = {
    async send(input) {
      const turnId = newId('turn', server.services.clock());
      const userMessage: Message = { id: newId('msg'), conversationId: input.conversationId, episodeId: input.conversationId, role: 'user', parts: input.parts, createdAt: server.services.clock(), status: 'complete', turnId };
      const assistant: Message = { id: newId('msg'), conversationId: input.conversationId, episodeId: input.conversationId, role: 'assistant', parts: [], createdAt: server.services.clock(), status: 'streaming', turnId };
      server.services.conversations.appendMessage(userMessage);
      server.services.conversations.appendMessage(assistant);
      const scope = { conversationId: input.conversationId, episodeId: input.conversationId, turnId };
      // Completion is owned by the runtime, independently of its SSE consumer.
      const done = release.then(() => server.services.conversations.updateMessage(assistant.id, { parts: [{ type: 'text', text: 'A scripted reply' }], status: 'complete' }));
      async function* events(): AsyncIterable<AgentEvent> {
        yield { type: 'turn.started', ...scope, userMessage, assistantMessageId: assistant.id, model: { provider: 'test', model: 'neo-test' } };
        yield { type: 'text.delta', ...scope, messageId: assistant.id, text: 'A scripted reply' };
        yield { type: 'message.completed', ...scope, message: await done };
        yield { type: 'turn.finished', ...scope, usage: null, stopReason: 'end' };
      }
      handle = { ...scope, userMessage, assistantMessageId: assistant.id, done, events: events() };
      return handle;
    },
    async sendTimeline(input) {
      const episode = server.services.conversations.currentEpisode() ?? server.services.conversations.createEpisode({ offRecord: input.offRecord });
      return runtime.send({ conversationId: episode.id, parts: input.parts });
    },
    cancelTimeline: cancel,
    startOffRecord: async () => ({ active: true, episodeId: null, startedAt: server.services.clock() }),
    offRecordState: () => server.services.conversations.offRecordState(),
    endOffRecord: async () => ({ deleted: 0 }),
    purgeOffRecord: async () => 0,
    waitForIdle: async () => {},
    async mutateTimeline<T>(mutation: () => Promise<T>): Promise<T> { return mutation(); },
    handleTimelineUiAction: async () => ({ kind: 'noop' }),
    cancel,
    cancelConversation: cancel,
    confirm: () => false,
    pendingConfirmations: () => [],
    handleUiAction: async () => ({ kind: 'noop' }),
    subscribe: () => () => {},
    activeTurns: () => [],
  };
  Object.assign(server.services.runtime, runtime);
  return { runtime, cancel, get handle() { return handle; } };
}

let server: NeoServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  vi.useRealTimers();
});

describe('HTTP/WebSocket transport on port 0', () => {
  it('reports the actual listening port and stops all sockets idempotently', async () => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    const inbox = await connect(server);
    inbox.socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    expect((await inbox.next()).type).toBe('ready');
    const closed = new Promise<{ code: number }>((resolve) => inbox.socket.addEventListener('close', resolve, { once: true }));
    await Promise.all([server.stop(), server.stop()]);
    expect((await closed).code).toBe(1001);
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
  });

  it('authenticates owner/device sockets, sends current seq, filters conversations, and answers ping', async () => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    const eventHub = server.services.events;
    eventHub.publish({ type: 'task.deleted', taskId: 'before-connection' });
    const owner = await connect(server);
    const { token } = server.services.devices.create({ name: 'phone', platform: 'ios' });
    const device = await connect(server);
    owner.socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    device.socket.send(JSON.stringify({ type: 'auth', token }));
    expect(await owner.next()).toEqual({ type: 'ready', serverVersion: '0.1.0', seq: eventHub.seq });
    expect((await device.next()).type).toBe('ready');
    owner.socket.send(JSON.stringify({ type: 'subscribe', conversations: ['conv-visible'] }));
    owner.socket.send(JSON.stringify({ type: 'ping', id: 'subscription-applied' }));
    expect(await owner.next()).toEqual({ type: 'pong', id: 'subscription-applied' });

    eventHub.publish({ type: 'conversation.deleted', conversationId: 'conv-hidden', episodeId: 'conv-hidden' });
    const visible = eventHub.publish({ type: 'text.delta', conversationId: 'conv-visible', episodeId: 'conv-visible', turnId: 'turn-test', messageId: 'msg-test', text: 'hello' });
    const global = eventHub.publish({ type: 'task.deleted', taskId: 'global-task' });
    expect(await owner.next()).toEqual({ type: 'event', envelope: visible });
    expect(await owner.next()).toEqual({ type: 'event', envelope: global });
    expect((await device.next()).type).toBe('event');
    expect((await device.next()).type).toBe('event');
    expect((await device.next()).type).toBe('event');
    expect(owner.messages.filter((message) => message.type === 'event')).toHaveLength(2);
  });

  it('broadcasts private mode changes to a second device regardless of episode subscription', async () => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    const { token } = server.services.devices.create({ name: 'second phone', platform: 'ios' });
    const device = await connect(server);
    device.socket.send(JSON.stringify({ type: 'auth', token }));
    expect((await device.next()).type).toBe('ready');
    device.socket.send(JSON.stringify({ type: 'subscribe', conversations: [] }));
    device.socket.send(JSON.stringify({ type: 'ping', id: 'privacy-subscription' }));
    expect((await device.next()).type).toBe('pong');
    const change = async (action: string) => {
      const response = await fetch(`${server!.url}/api/timeline/off-record/${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await change('start')).toMatchObject({ active: true, episodeId: expect.any(String) });
    expect(await device.next()).toMatchObject({ type: 'event', envelope: { event: { type: 'timeline.off_record', active: true } } });
    await change('end');
    expect(await device.next()).toMatchObject({ type: 'event', envelope: { event: { type: 'timeline.off_record', active: false } } });
  });

  it.each([
    { type: 'auth', token: 'bad-token' },
    { type: 'subscribe', conversations: 'all' },
    { type: 'auth', token: 12 },
  ])('rejects invalid first-message authentication with 4401 (%j)', async (firstMessage) => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    const inbox = await connect(server);
    const closed = new Promise<{ code: number }>((resolve) => inbox.socket.addEventListener('close', resolve, { once: true }));
    inbox.socket.send(JSON.stringify(firstMessage));
    expect(await inbox.next()).toMatchObject({ type: 'error', error: { code: 'unauthorized' } });
    expect((await closed).code).toBe(4401);
  });

  it('validates subsequent messages without losing a valid subscription', async () => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    const inbox = await connect(server);
    inbox.socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await inbox.next();
    inbox.socket.send(JSON.stringify({ type: 'subscribe', conversations: 12 }));
    expect(await inbox.next()).toMatchObject({ type: 'error', error: { code: 'bad_request', details: { errors: [] } } });
    const envelope = server.services.events.publish({ type: 'conversation.deleted', conversationId: 'still-all', episodeId: 'still-all' });
    expect(await inbox.next()).toEqual({ type: 'event', envelope });
  });

  it('streams scripted turn events with SSE event names and JSON data', async () => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    const conversation = server.services.conversations.create();
    scriptedRuntime(server);
    const response = await fetch(`${server.url}/api/timeline/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test SSE' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await response.text()).trim().split('\n\n');
    const events = frames.map((frame) => {
      const [name, data] = frame.split('\n');
      const event = JSON.parse(data!.slice('data: '.length)) as AgentEvent;
      expect(name).toBe(`event: ${event.type}`);
      return event;
    });
    expect(events.map((event) => event.type)).toEqual(['turn.started', 'text.delta', 'message.completed', 'turn.finished']);
    expect(events[1]).toMatchObject({ text: 'A scripted reply' });
  });

  it('keeps the runtime turn running after an SSE client disconnect', async () => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    const conversation = server.services.conversations.create();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const script = scriptedRuntime(server, pending);
    const response = await fetch(`${server.url}/api/timeline/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test disconnect' }),
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    release();
    const final = await script.handle!.done;
    expect(final.status).toBe('complete');
    expect(server.services.conversations.getMessage(final.id)?.status).toBe('complete');
    expect(script.cancel).not.toHaveBeenCalled();
  });
});

describe('WebSocket timers', () => {
  it('requires auth within 10 seconds and sends native ping frames every 30 seconds', async () => {
    server = await startServer(config, { inMemory: true, logger: silentLogger });
    vi.useFakeTimers();
    const send = vi.fn();
    const close = vi.fn();
    const ping = vi.fn();
    const raw = { ping, terminate: vi.fn() };
    const unauthenticated = new WSContext({ send, close, readyState: 1, raw });
    const handler = createWsHandler(server.services.devices, server.services.events);
    handler.onOpen?.(new Event('open'), unauthenticated);
    await vi.advanceTimersByTimeAsync(9999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledWith(4401, 'Authentication timed out');
    type ClosedEvent = Parameters<NonNullable<typeof handler.onClose>>[0];
    handler.onClose?.(new Event('close') as ClosedEvent, unauthenticated);

    const authenticated = new WSContext({ send, close, readyState: 1, raw });
    handler.onOpen?.(new Event('open'), authenticated);
    handler.onMessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'auth', token: TOKEN }) }), authenticated);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
    handler.onError?.(new Event('error'), authenticated);
    handler.onClose?.(new Event('close') as ClosedEvent, authenticated);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ping).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
