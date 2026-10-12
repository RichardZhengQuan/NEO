import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectChat, parseConfig, silentLogger } from '@neo/protocol';
import type {
  AgentEvent,
  ChatRequest,
  Conversation,
  TimelinePage,
  EventEnvelope,
  ImportReport,
  ListResponse,
  MemoryExport,
  MemoryGraph,
  MemoryNode,
  MemoryStats,
  Message,
  NeoSettings,
  Notification,
  OffRecordState,
  Reminder,
  Task,
  ToolInfo,
  UIPart,
  UiActionResponse,
  WsServerMessage,
} from '@neo/protocol';
import { scriptedMockScript } from '../../providers/src/testing/scripted-brain.js';
import { scriptedProviderOptions } from './testing/mock-options.js';
import type { MockScript } from '@neo/providers';
import { startServer } from './server.js';
import { createServices } from './services.js';
import type { NeoServer } from './index.js';

// @neo/client is intentionally not a server dependency and is not resolvable
// from this package. Exercise the documented HTTP, SSE and WebSocket contracts
// directly, without adding a dependency or using any fake server services.
const epoch = Date.UTC(2026, 9, 10, 12);

function latestUserText(request: ChatRequest): string {
  const user = request.messages.findLast((message) => message.role === 'user');
  return user?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n').replace(/<neo_context>[\s\S]*?<\/neo_context>/g, '') ?? '';
}

function makeScript(): MockScript {
  return (request, callIndex) => {
    const text = latestUserText(request);
    if (request.metadata?.['purpose'] === 'memory-extract') {
      // The stock mock's extraction JSON is tracked in the expected-failure
      // regression below. This fixture uses the documented extraction contract
      // so the remaining integration journey can test real memory write/recall.
      const learnsHiking = text.includes('User: My name is Richard and I love hiking');
      return {
        text: JSON.stringify({
          episode: learnsHiking
            ? { label: 'Richard introduces himself', summary: 'Richard introduced himself and said he loves hiking.', importance: 0.5 }
            : null,
          memories: learnsHiking
            ? [{ op: 'create', kind: 'preference', label: 'Hiking', content: 'Richard loves hiking.', importance: 0.8, entities: ['Richard'] }]
            : [],
          links: [],
        }),
      };
    }
    if (request.metadata?.['purpose']) return scriptedMockScript(request, callIndex);
    if (request.messages.at(-1)?.role === 'tool') return { text: 'Done.' };
    if (text.includes('Remind me to drink water in 2 minutes')) {
      return scriptedMockScript(request, callIndex);
    }
    const deleteId = /Delete task (task_[A-Za-z0-9_-]+)/.exec(text)?.[1];
    if (deleteId) return { toolCalls: [{ id: `delete-call-${callIndex}`, name: 'delete_task', input: { id: deleteId } }] };
    return { text: 'I hear you.', chunkSize: 4 };
  };
}

async function until<T>(read: () => Promise<T> | T, matches: (value: T) => boolean, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let value = await read();
  while (!matches(value) && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  expect(matches(value), description).toBe(true);
  return value;
}

async function json<T>(server: NeoServer, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.ownerToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  expect(response.ok, `${method} ${path}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : undefined) as T;
}

function newEpisode(server: NeoServer, offRecord = false): Conversation {
  const current = server.services.conversations.currentEpisode();
  if (current) server.services.conversations.closeEpisode(current.id);
  return server.services.conversations.createEpisode({ offRecord });
}

async function episodeTranscript(server: NeoServer, episodeId: string): Promise<{ messages: Message[] }> {
  const page = await json<TimelinePage>(server, 'GET', '/timeline?limit=500');
  return { messages: page.items.filter(message => message.episodeId === episodeId) };
}

async function streamTurn(server: NeoServer, conversationId: string, text: string): Promise<AgentEvent[]> {
  const response = await fetch(`${server.url}/api/timeline/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.ownerToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text, offRecord: server.services.conversations.get(conversationId)?.offRecord ?? false }),
    signal: AbortSignal.timeout(8_000),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: AgentEvent[] = [];
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const lines = frame.split('\n');
        const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as AgentEvent;
        expect(name).toBe(event.type);
        events.push(event);
      }
      if (chunk.done) break;
    }
  } finally {
    reader.releaseLock();
  }
  expect(events.at(-1)?.type).toBe('turn.finished');
  expect(events.some((event) => event.type === 'turn.failed')).toBe(false);
  return events;
}

function completedMessage(events: AgentEvent[]): Message {
  const completed = events.find((event) => event.type === 'message.completed');
  if (!completed || completed.type !== 'message.completed') throw new Error('Turn did not emit message.completed');
  expect(completed.message.status).toBe('complete');
  return completed.message;
}

async function openEvents(server: NeoServer): Promise<{ socket: WebSocket; envelopes: EventEnvelope[]; messages: WsServerMessage[] }> {
  const socket = new WebSocket(`${server.url.replace(/^http/, 'ws')}/api/ws`);
  const envelopes: EventEnvelope[] = [];
  const messages: WsServerMessage[] = [];
  socket.addEventListener('message', (message) => {
    const parsed = JSON.parse(String(message.data)) as WsServerMessage;
    messages.push(parsed);
    if (parsed.type === 'event') envelopes.push(parsed.envelope);
  });
  await until(() => socket.readyState, (state) => state === WebSocket.OPEN, 'WebSocket opens');
  socket.send(JSON.stringify({ type: 'auth', token: server.ownerToken }));
  await until(() => messages, (items) => items.some((message) => message.type === 'ready'), 'WebSocket owner auth receives ready');
  const ready = messages.find((message) => message.type === 'ready');
  expect(ready).toMatchObject({ type: 'ready', serverVersion: '0.1.0' });
  return { socket, envelopes, messages };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await until(() => socket.readyState, (state) => state === WebSocket.CLOSED, 'WebSocket closes');
}

describe.sequential('end-to-end: real storage, provider, memory, tools, runtime and server', () => {
  let server: NeoServer;
  let connection: Awaited<ReturnType<typeof openEvents>>;
  let clock: () => number;
  let conversation: Conversation;
  let hiking: MemoryNode;
  let reminder: Reminder;
  let reminderMessage: Message;
  let widget: UIPart;

  beforeAll(async () => {
    const started = performance.now();
    clock = () => epoch + Math.floor(performance.now() - started);
    // The stock mock parses relative reminder times with Date.now rather than
    // an injected clock. Keep it on the same deterministic epoch as services.
    vi.spyOn(Date, 'now').mockImplementation(clock);
    server = await startServer(parseConfig({
      dataDir: '/unwritten-neo-e2e',
      server: { host: '127.0.0.1', port: 0, authToken: 'e2e-owner-token-0123456789' },
      settings: { timezone: 'UTC', locale: 'en', memory: { consolidation: { enabled: false } } },
      log: { level: 'silent' },
    }), { ...scriptedProviderOptions(), inMemory: true, logger: silentLogger, clock, mockScript: makeScript() });
    expect(server.port).toBeGreaterThan(0);
    connection = await openEvents(server);
  });

  afterAll(async () => {
    try {
      if (connection) await closeSocket(connection.socket);
      if (server) await server.stop();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('1. reports health and completes onboarding through a deep settings patch', async () => {
    const health = await json<{ ok: boolean; onboarded: boolean }>(server, 'GET', '/health');
    expect(health).toMatchObject({ ok: true, onboarded: false });
    const settings = await json<NeoSettings>(server, 'PATCH', '/settings', { onboarded: true });
    expect(settings.onboarded).toBe(true);
    expect(settings.agent).not.toHaveProperty('autoTitle');
    await until(() => connection.envelopes, (events) => events.some(({ event }) => event.type === 'settings.updated' && event.settings.onboarded), 'settings update reaches WebSocket');
  });

  it('2. streams an introduction and observes a hiking memory asynchronously', async () => {
    conversation = newEpisode(server);
    const events = await streamTurn(server, conversation.id, 'My name is Richard and I love hiking');
    completedMessage(events);
    const memories = await until(
      () => json<ListResponse<MemoryNode>>(server, 'GET', '/memory?query=hiking'),
      (result) => result.items.some((node) => node.kind === 'preference' && /hiking/i.test(node.content)),
      'post-turn write-back stores hiking',
    );
    hiking = memories.items.find((node) => node.kind === 'preference' && /hiking/i.test(node.content))!;
    expect(hiking.source).toMatchObject({ by: 'extraction', conversationId: conversation.id });
    await until(() => connection.envelopes, (events) => events.some(({ event }) => event.type === 'memory.changed'), 'memory store changes reach WebSocket');
  });

  it('3. creates a reminder through a model tool call and persists its live widget', async () => {
    const events = await streamTurn(server, conversation.id, 'Remind me to drink water in 2 minutes');
    expect(events.some((event) => event.type === 'tool.started' && event.name === 'create_reminder')).toBe(true);
    expect(events.some((event) => event.type === 'tool.finished' && event.name === 'create_reminder' && !event.isError)).toBe(true);
    reminderMessage = completedMessage(events);
    const part = reminderMessage.parts.find((part): part is UIPart => part.type === 'ui' && part.block.type === 'reminder');
    expect(part).toBeDefined();
    widget = part!;
    const reminders = await json<ListResponse<Reminder>>(server, 'GET', '/reminders');
    expect(reminders.items).toHaveLength(1);
    reminder = reminders.items[0]!;
    expect(reminder.title).toBe('drink water');
    expect(widget.block).toMatchObject({ type: 'reminder', reminderId: reminder.id, dueAt: reminder.dueAt });
    expect(reminder.dueAt - clock()).toBeGreaterThan(119_000);
    expect(reminder.dueAt - clock()).toBeLessThanOrEqual(120_000);
    const stored = await episodeTranscript(server, conversation.id);
    expect(stored.messages.find((message) => message.id === reminderMessage.id)?.parts).toContainEqual(widget);
  });

  it('4. resolves reminder.snooze:10 against the stored widget and moves dueAt', async () => {
    const action = await json<UiActionResponse>(server, 'POST', '/timeline/ui-action', {
      messageId: reminderMessage.id, uiId: widget.id, actionId: 'reminder.snooze:10',
    });
    expect(action).toMatchObject({ kind: 'tool', isError: false });
    const snoozed = await json<Reminder>(server, 'GET', `/reminders/${reminder.id}`);
    expect(snoozed.dueAt).toBeGreaterThan(reminder.dueAt);
    expect(snoozed.dueAt - clock()).toBeGreaterThan(599_000);
  });

  it('5. fires an API reminder, delivers WebSocket events and stores a notification within five seconds', async () => {
    const created = await json<Reminder>(server, 'POST', '/reminders', { title: 'Stand up', notes: 'Stretch your legs', dueAt: clock() + 1_500 });
    await until(
      () => connection.envelopes,
      (events) => events.some(({ event }) => event.type === 'reminder.fired' && event.firing.reminder.id === created.id),
      'scheduler emits reminder.fired',
    );
    const notifications = await until(
      () => json<ListResponse<Notification>>(server, 'GET', '/notifications'),
      (result) => result.items.some((item) => item.data?.['reminderId'] === created.id),
      'reminder firing creates notification',
    );
    expect(notifications.items.find((item) => item.data?.['reminderId'] === created.id)).toMatchObject({
      kind: 'reminder', title: 'Stand up', body: 'Stretch your legs', data: { reminderId: created.id, url: `neo://reminders/${created.id}` },
    });
    expect((await json<Reminder>(server, 'GET', `/reminders/${created.id}`)).status).toBe('fired');
  });

  // Foreign-package limitation: the hashing recall seed path has no intent for
  // a broad personal-memory question. Ordinary hiking/name facts share no
  // keywords with "What do you remember about me?", so no context is injected.
  // Keep the exact requested journey step as an expected failure; the next
  // case proves ordinary keyword recall still works across conversations.
  it('6. recalls hiking for the broad personal-memory question in a new conversation', async () => {
    const other = newEpisode(server);
    const events = await streamTurn(server, other.id, 'What do you remember about me?');
    completedMessage(events);
    expect(events.some((event) => event.type === 'memory.recalled' && event.items.some((item) => item.id === hiking.id))).toBe(true);
    const stored = await episodeTranscript(server, other.id);
    const context = stored.messages.find((message) => message.role === 'user')?.parts.find((part) => part.type === 'context');
    expect(context?.type).toBe('context');
    expect(context && context.type === 'context' ? context.text : '').toContain('hiking');
  });

  it('6a. recalls hiking across conversations when the question names hiking', async () => {
    const other = newEpisode(server);
    const events = await streamTurn(server, other.id, 'What do you remember about Richard and hiking?');
    completedMessage(events);
    expect(events.some((event) => event.type === 'memory.recalled' && event.items.some((item) => item.id === hiking.id))).toBe(true);
    const stored = await episodeTranscript(server, other.id);
    const context = stored.messages.find((message) => message.role === 'user')?.parts.find((part) => part.type === 'context');
    expect(context && context.type === 'context' ? context.text : '').toContain('hiking');
  });

  it('7. allows recall off the record without writing new memories', async () => {
    const before = await json<MemoryStats>(server, 'GET', '/memory/stats');
    const incognito = await json<OffRecordState>(server, 'POST', '/timeline/off-record/start', {});
    const events = await streamTurn(server, incognito.episodeId!, 'My name is Richard and I love hiking');
    completedMessage(events);
    expect(events.some((event) => event.type === 'memory.recalled')).toBe(true);
    const stored = await episodeTranscript(server, incognito.episodeId!);
    const context = stored.messages.find((message) => message.role === 'user')?.parts.find((part) => part.type === 'context');
    const contextText = context && context.type === 'context' ? context.text : '';
    expect(contextText).toContain('Off the record');
    expect(events.some(event => event.type === 'memory.written')).toBe(false);
    // A subsequent completed turn lets pending microtasks/write-back settle;
    // the count assertion is about actual stored memory, not just absent events.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect((await json<MemoryStats>(server, 'GET', '/memory/stats')).total).toBe(before.total);
    await json(server, 'POST', '/timeline/off-record/end', {});
  });

  it('8. pauses for a dangerous tool confirmation, approves through HTTP and deletes the task', async () => {
    const permission = await json<ToolInfo>(server, 'PUT', '/tools/delete_task/permission', { permission: 'confirm' });
    expect(permission.permission).toBe('confirm');
    const task = await json<Task>(server, 'POST', '/tasks', { title: 'Disposable integration task' });
    const deleting = newEpisode(server);
    const afterSeq = connection.envelopes.at(-1)?.seq ?? 0;
    const stream = streamTurn(server, deleting.id, `Delete task ${task.id}`);
    const observed = await until(
      () => connection.envelopes,
      (events) => events.some(({ seq, event }) => seq > afterSeq && event.type === 'tool.confirmation' && event.confirmation.input && JSON.stringify(event.confirmation.input).includes(task.id)),
      'delete_task confirmation reaches WebSocket',
    );
    const event = observed.find(({ seq, event }) => seq > afterSeq && event.type === 'tool.confirmation')?.event;
    if (!event || event.type !== 'tool.confirmation') throw new Error('Expected tool.confirmation');
    expect((await json<ListResponse<Task>>(server, 'GET', '/tasks')).items.some((item) => item.id === task.id)).toBe(true);
    expect(event.confirmation.id).toMatch(/^cnf_/);
    expect(await json<{ ok: boolean }>(server, 'POST', `/confirmations/${event.confirmation.id}`, { approve: true })).toEqual({ ok: true });
    const events = await stream;
    completedMessage(events);
    expect(events.some((item) => item.type === 'tool.finished' && item.name === 'delete_task' && !item.isError)).toBe(true);
    expect((await json<ListResponse<Task>>(server, 'GET', '/tasks')).items.some((item) => item.id === task.id)).toBe(false);
  });

  it('9. returns a linked memory graph and preserves nodes and edges across export/import', async () => {
    const graph = await json<MemoryGraph>(server, 'GET', '/memory/graph');
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.some((node) => node.id === hiking.id)).toBe(true);
    const exported = await json<MemoryExport>(server, 'GET', '/memory/export?embeddings=1');
    expect(exported).toMatchObject({ format: 'neo-memory', version: 1 });
    const report = await json<ImportReport>(server, 'POST', '/memory/import', { data: exported, mode: 'replace' });
    expect(report.nodes).toBe(exported.nodes.length);
    expect(report.edges).toBe(exported.edges.length);
    const roundTrip = await json<MemoryExport>(server, 'GET', '/memory/export?embeddings=1');
    expect(roundTrip.nodes.map((node) => node.id).sort()).toEqual(exported.nodes.map((node) => node.id).sort());
    expect(roundTrip.edges).toEqual(exported.edges);
    expect(roundTrip.nodes.find((node) => node.id === hiking.id)?.content).toBe(hiking.content);
  });

  it('10. stops cleanly with an open event socket and tolerates repeated shutdown', async () => {
    await server.stop();
    await until(() => connection.socket.readyState, (state) => state === WebSocket.CLOSED, 'stop closes event sockets');
    await server.stop();
    expect(server.services.db?.raw.isOpen).toBe(false);
  });
});

// Foreign-package regression: providers/src/mock.ts emits { facts, episodes }
// for purpose=memory-extract, but memory/extract.ts expects { episode, memories,
// links } and treats the wrong shape as a valid empty extraction. Keep this
// single expected failure visible until WP-providers corrects its mock script.
it('stock mock: introduction should create a hiking memory after a real turn', async () => {
  const server = await startServer(parseConfig({
    dataDir: '/unwritten-neo-e2e-default',
    server: { host: '127.0.0.1', port: 0, authToken: 'e2e-default-token-0123456789' },
    log: { level: 'silent' },
  }), { ...scriptedProviderOptions(), inMemory: true, logger: silentLogger });
  try {
    const conversation = newEpisode(server);
    await streamTurn(server, conversation.id, 'My name is Richard and I love hiking');
    await until(() => server.services.runtime.activeTurns(), (turns) => turns.length === 0, 'turn completes');
    // Poll through the public API for asynchronous write-back, as a real client
    // would, rather than substituting explicit API-created memory.
    await until(
      () => json<ListResponse<MemoryNode>>(server, 'GET', '/memory?query=hiking'),
      (memories) => memories.items.some((node) => /hiking/i.test(node.content)),
      'stock mock stores hiking',
      500,
    );
  } finally {
    await server.stop();
  }
});

// Foreign-package regression: core renders the persisted context part to a
// leading text part, but providers/src/mock.ts anchors its remember recognizer
// to the start of the joined text, so the stock mock never calls remember.
// Its bare-request branch also sends { text } instead of the tool's { content }.
it('stock mock: explicit Remember should call remember and store the requested fact', async () => {
  const server = await startServer(parseConfig({
    dataDir: '/unwritten-neo-e2e-remember',
    server: { host: '127.0.0.1', port: 0, authToken: 'e2e-remember-token-0123456789' },
    log: { level: 'silent' },
  }), { ...scriptedProviderOptions(), inMemory: true, logger: silentLogger });
  try {
    const conversation = newEpisode(server);
    const events = await streamTurn(server, conversation.id, 'Remember that I prefer window seats');
    expect(events.some((event) => event.type === 'tool.started' && event.name === 'remember')).toBe(true);
    await until(
      () => json<ListResponse<MemoryNode>>(server, 'GET', '/memory?query=window%20seats'),
      (memories) => memories.items.some((node) => /window seats/i.test(node.content)),
      'stock mock stores explicitly remembered fact',
      500,
    );
  } finally {
    await server.stop();
  }
});

it('stock mock: bare remember intent should send input accepted by the real remember tool', async () => {
  const services = await createServices(parseConfig({
    dataDir: '/unwritten-neo-e2e-remember-schema',
    server: { authToken: 'e2e-remember-schema-0123456789' }, log: { level: 'silent' },
  }), { ...scriptedProviderOptions(), inMemory: true, logger: silentLogger, clock: () => epoch });
  try {
    const adapter = services.providers.get('test');
    if (!adapter) throw new Error('Missing test adapter');
    const reply = await collectChat(adapter.chat({
      model: 'neo-test', tools: services.tools.specs(),
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Remember that I prefer window seats' }] }],
    }));
    expect(reply.toolCalls[0]?.name).toBe('remember');
    const call = reply.toolCalls[0]!;
    const result = await services.tools.execute(call, {
      toolCallId: call.id, signal: new AbortController().signal, now: () => epoch,
      timezone: 'UTC', locale: 'en', allowSensitive: true, origin: 'model', logger: silentLogger,
    });
    expect(result.isError, JSON.stringify(result.output)).not.toBe(true);
    expect((await services.memory.search({ query: 'window seats' })).items.length).toBeGreaterThan(0);
  } finally {
    await services.close();
  }
});

it('stock mock: relative reminders should use the injected service clock', async () => {
  const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(epoch + 3_600_000);
  const services = await createServices(parseConfig({
    dataDir: '/unwritten-neo-e2e-reminder-clock',
    server: { authToken: 'e2e-reminder-clock-0123456789' },
    settings: { timezone: 'UTC', agent: { autoTitle: false } }, log: { level: 'silent' },
  }), { ...scriptedProviderOptions(), inMemory: true, logger: silentLogger, clock: () => epoch });
  try {
    const conversation = services.conversations.create();
    const turn = await services.runtime.send({ conversationId: conversation.id, parts: [{ type: 'text', text: 'Remind me to drink water in 2 minutes' }] });
    expect((await turn.done).status).toBe('complete');
    expect(services.stores.reminders.list()[0]?.dueAt).toBe(epoch + 120_000);
  } finally {
    await services.close();
    dateSpy.mockRestore();
  }
});
