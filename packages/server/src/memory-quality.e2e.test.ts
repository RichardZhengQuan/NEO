/**
 * Memory quality, end to end: a replay of a real scripted test session against the
 * real server, storage, memory net, tools, runtime and the scripted test fixture
 * (explicitly injected test model). It guards what a user actually notices: NEO learns only
 * from what the user said, writes clean memories once, recalls the right ones
 * across conversations, leaves the current conversation's own episodes out,
 * and does not flood the context for short or non-English messages.
 */
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig, silentLogger } from '@neo/protocol';
import type { AgentEvent, Conversation, MemoryNode, MemoryService, Message } from '@neo/protocol';
import { startServer } from './server.js';
import { scriptedProviderOptions } from './testing/mock-options.js';
import type { NeoServer } from './index.js';

const epoch = Date.UTC(2026, 9, 10, 12);

type Recalled = Extract<AgentEvent, { type: 'memory.recalled' }>['items'];

interface TurnOutcome {
  events: AgentEvent[];
  recalled: Recalled;
  reply: string;
}

async function until<T>(read: () => Promise<T> | T, matches: (value: T) => boolean, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let value = await read();
  while (!matches(value) && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
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

/** POST a message and read the SSE stream to the end. */
function newEpisode(server: NeoServer, offRecord = false): Conversation {
  const current = server.services.conversations.currentEpisode();
  if (current) server.services.conversations.closeEpisode(current.id);
  return server.services.conversations.createEpisode({ offRecord });
}

async function streamTurn(server: NeoServer, conversationId: string, text: string): Promise<AgentEvent[]> {
  const response = await fetch(`${server.url}/api/timeline/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.ownerToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text, offRecord: server.services.conversations.get(conversationId)?.offRecord ?? false }),
    signal: AbortSignal.timeout(8_000),
  });
  expect(response.status).toBe(200);
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
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) events.push(JSON.parse(data) as AgentEvent);
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

function replyText(events: AgentEvent[]): string {
  const completed = events.find((event): event is Extract<AgentEvent, { type: 'message.completed' }> => event.type === 'message.completed');
  const message: Message | undefined = completed?.message;
  return (message?.parts ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

const text = (n: MemoryNode) => `${n.label}\n${n.content}`;

describe.sequential('memory quality: replaying a scripted test session with the scripted test fixture', () => {
  let server: NeoServer;
  let memory: MemoryService;
  let observed = 0;
  const inFlight = new Set<Promise<unknown>>();
  let first: Conversation;
  let second: Conversation;
  const turns: Record<string, TurnOutcome> = {};

  /** One user turn; resolves once the turn finished AND memory write-back for it has settled. */
  async function turn(conversation: Conversation, message: string): Promise<TurnOutcome> {
    const before = observed;
    const events = await streamTurn(server, conversation.id, message);
    await until(() => server.services.runtime.activeTurns().length, (n) => n === 0, 'turn completes');
    await until(() => observed, (n) => n > before, `memory observes "${message}"`);
    await Promise.all([...inFlight]);
    const recalled = events.find((e): e is Extract<AgentEvent, { type: 'memory.recalled' }> => e.type === 'memory.recalled')?.items ?? [];
    const outcome = { events, recalled, reply: replyText(events) };
    turns[message] = outcome;
    return outcome;
  }

  async function allMemories(): Promise<MemoryNode[]> {
    return (await memory.export()).nodes.filter((n) => n.status === 'active');
  }

  async function nodesOf(items: Recalled): Promise<MemoryNode[]> {
    const nodes = await Promise.all(items.map(async (item) => (await memory.get(item.id))?.node));
    return nodes.filter((n): n is MemoryNode => Boolean(n));
  }

  beforeAll(async () => {
    const started = performance.now();
    const clock = () => epoch + Math.floor(performance.now() - started);
    server = await startServer(
      parseConfig({
        dataDir: '/unwritten-neo-memory-quality',
        server: { host: '127.0.0.1', port: 0, authToken: 'memory-quality-token-0123456789' },
        settings: { timezone: 'UTC', locale: 'en', memory: { consolidation: { enabled: false } } },
        log: { level: 'silent' },
      }),
      { ...scriptedProviderOptions(), inMemory: true, logger: silentLogger, clock },
    );
    memory = server.services.memory;
    // Count and await the post-turn write-back (core starts it after the reply, off the critical path).
    const observe = memory.observe.bind(memory);
    memory.observe = (t) => {
      observed++;
      const p = observe(t);
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
      return p;
    };
    await json(server, 'PATCH', '/settings', { onboarded: true });
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('1. learns the name and the hobby from an introduction, not from NEO’s reply', async () => {
    first = newEpisode(server);
    await turn(first, 'Hi! My name is Richard and I love hiking in the mountains.');
    const nodes = await allMemories();
    const labels = nodes.filter((n) => n.kind !== 'episode').map((n) => n.label);
    expect(labels).toContain('Name: Richard');
    expect(labels).toContain('Loves hiking in the mountains');
    // The test reply suggests “Remember that I prefer window seats”; the user never said it.
    expect(nodes.filter((n) => /window seat|靠窗/i.test(text(n)))).toEqual([]);
    expect(nodes.filter((n) => /\bNEO\b/.test(text(n)))).toEqual([]);
    const episode = nodes.find((n) => n.kind === 'episode');
    expect(episode?.label).toBe('Introduced themselves');
  });

  it('2. a reminder request recalls nothing from the same conversation and nothing unrelated', async () => {
    const { recalled, events } = await turn(first, 'Remind me to drink water in 2 minutes');
    expect(events.some((e) => e.type === 'tool.finished' && e.name === 'create_reminder' && !e.isError)).toBe(true);
    const nodes = await nodesOf(recalled);
    expect(nodes.filter((n) => n.kind === 'episode' && n.source.conversationId === first.id)).toEqual([]);
    expect(recalled.filter((r) => r.reason === 'shares keywords')).toEqual([]);
    expect(recalled.length).toBeLessThanOrEqual(1);
    const episodes = (await allMemories()).filter((n) => n.kind === 'episode');
    expect(episodes.map((n) => n.label)).toContain('Asked for a reminder to drink water');
  });

  it('3. “Remember that I am vegetarian” writes exactly one clean vegetarian fact (tool + extraction)', async () => {
    const { recalled, events } = await turn(first, 'Remember that I am vegetarian');
    expect(events.some((e) => e.type === 'tool.finished' && e.name === 'remember' && !e.isError)).toBe(true);
    const nodes = await nodesOf(recalled);
    expect(nodes.filter((n) => n.kind === 'episode' && n.source.conversationId === first.id)).toEqual([]);
    const vegetarian = (await allMemories()).filter((n) => n.kind !== 'episode' && /vegetarian/i.test(text(n)));
    expect(vegetarian).toHaveLength(1);
    expect(vegetarian[0]).toMatchObject({ kind: 'fact', label: 'Vegetarian', content: 'The user is vegetarian.' });
  });

  it('4. “What do you remember about me?” in a new conversation recalls name, hiking and vegetarian', async () => {
    second = newEpisode(server);
    const { recalled, reply } = await turn(second, 'What do you remember about me?');
    const nodes = await nodesOf(recalled);
    const all = nodes.map(text).join('\n');
    expect(all).toMatch(/Richard/);
    expect(all).toMatch(/hiking/i);
    expect(all).toMatch(/vegetarian/i);
    expect(nodes.filter((n) => n.kind === 'episode' && n.source.conversationId === second.id)).toEqual([]);
    // The test provider answers with the recall tool; the answer names the same three things.
    expect(reply).toMatch(/Richard/);
    expect(reply).toMatch(/hiking/i);
    expect(reply).toMatch(/vegetarian/i);
    expect(reply).not.toMatch(/window seat|\bname is NEO\b|The user said/i);
    // A question about memory is not an event worth remembering.
    expect((await allMemories()).filter((n) => n.source.conversationId === second.id)).toEqual([]);
  });

  it('5. “你好，我喜欢喝茶” recalls only relevant memories, not the whole net', async () => {
    const { recalled } = await turn(second, '你好，我喜欢喝茶');
    expect(recalled.length).toBeLessThanOrEqual(3);
    const nodes = await nodesOf(recalled);
    for (const n of nodes) expect(text(n)).toMatch(/茶|tea/i);
    const tea = (await allMemories()).filter((n) => n.kind !== 'episode' && /茶/.test(text(n)));
    expect(tea.map((n) => n.label)).toEqual(['喜欢喝茶']);
  });

  it('6. a later Chinese message about tea recalls the tea preference (CJK keywords work)', async () => {
    const third = newEpisode(server);
    const { recalled } = await turn(third, '我今天想喝茶');
    const nodes = await nodesOf(recalled);
    expect(nodes.map((n) => n.label)).toContain('喜欢喝茶');
    expect(recalled.length).toBeLessThanOrEqual(3);
    for (const n of nodes) expect(text(n)).toMatch(/茶|tea/i);
  });

  it('7. every stored memory is clean: no quotes, no NEO lines, no raw truncations', async () => {
    const nodes = await allMemories();
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(text(n), n.label).not.toMatch(/["“”「」]/);
      expect(text(n), n.label).not.toMatch(/NEO:/);
      expect(text(n), n.label).not.toMatch(/name is NEO|Name: NEO/i);
      expect(n.label, n.content).not.toMatch(/[\s.,;:!?。，、！？…]$/);
      expect(n.label, n.content).not.toMatch(/^(?:hi|hello|hey)\b/i);
    }
    expect(nodes.filter((n) => /window seat|靠窗|演示/i.test(text(n)))).toEqual([]);
    expect(nodes.filter((n) => n.kind === 'fact' && /vegetarian/i.test(text(n)))).toHaveLength(1);
  });
});
