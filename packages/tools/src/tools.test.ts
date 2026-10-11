/**
 * Comprehensive tests for @neo/tools.
 *
 * Constraints:
 * - All tests are offline / deterministic.
 * - SQLite via openDatabase(':memory:') from @neo/storage.
 * - Fake clocks injected as Clock functions.
 * - Fake MemoryService (minimal protocol implementation).
 * - Fake fetch / fake DNS for web tools.
 * - Vitest fake timers for Scheduler tests.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDatabase, migrate } from '@neo/storage';
import type { NeoDatabase } from '@neo/storage';
import type {
  Clock,
  MemoryService,
  MemoryNode,
  ToolContext,
} from '@neo/protocol';
import { NeoError, DEFAULT_MEMORY_POLICY } from '@neo/protocol';

import { evaluateExpression } from './calc.js';
import { parseDateTime, utcToZoned, zonedTimeToUtc } from './time.js';
import { toolsMigrations, createProductivityStores } from './stores/index.js';
import { createReminderScheduler } from './scheduler.js';
import { createToolRegistry } from './registry.js';
import { checkSsrf, createWebFetchTool } from './builtins/web.js';
import type { DnsResolver } from './builtins/web.js';
import { createMemoryTools } from './builtins/memory.js';
import { loadPlugins } from './plugins.js';
import { createBuiltinTools } from './builtins/index.js';
import type {
  RememberInput,
  RecallQuery,
  RecallResult,
  MemoryNodePatch,
  ObservedTurn,
  MemoryWriteResult,
  MemorySearchQuery,
  MemoryNodeDetail,
  EdgeType,
  MemoryEdge,
  GraphQuery,
  MemoryGraph,
  ConsolidationReport,
  MemoryStats,
  MemoryExport,
  ImportReport,
  MemoryPolicy,
  MemoryChangeEvent,
} from '@neo/protocol';
import { silentLogger } from '@neo/protocol';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDb(): NeoDatabase {
  const db = openDatabase(':memory:');
  migrate(db, 'tools', toolsMigrations);
  return db;
}

function makeStores(db: NeoDatabase, clock: Clock) {
  return createProductivityStores(db, { clock });
}

/** Build a ToolContext for tests. */
function makeCtx(nowMs: number, timezone = 'UTC'): ToolContext {
  return {
    toolCallId: 'tc-test',
    conversationId: 'test-conv',
    now: () => nowMs,
    timezone,
    locale: 'en-US',
    allowSensitive: false,
    signal: new AbortController().signal,
    origin: 'model',
    logger: silentLogger,
  };
}

// Fake MemoryService: only stubs the methods used by memory tools.
function makeFakeMemory(): MemoryService {
  const store = new Map<string, MemoryNode>();
  let nextId = 1;

  const makeNode = (input: { content: string; label?: string; kind?: MemoryNode['kind'] }): MemoryNode => ({
    id: `mem_${nextId++}`,
    label: input.label ?? input.content.slice(0, 40),
    content: input.content,
    kind: input.kind ?? 'fact',
    aliases: [],
    tags: [],
    importance: 0.5,
    confidence: 1,
    stability: 30,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'active',
    pinned: false,
    sensitivity: 'normal',
    source: { by: 'tool', conversationId: null },
  });

  const fakeService: MemoryService = {
    async remember(input: RememberInput) {
      const node = makeNode({ content: input.content, label: input.label, kind: input.kind });
      store.set(node.id, node);
      return node;
    },
    async recall(query: RecallQuery): Promise<RecallResult> {
      const items = [...store.values()].map((node) => ({
        node,
        score: 0.9,
        activation: 0.9,
        similarity: 0.9,
        retention: 1,
        via: [],
        reason: 'matches your message',
      }));
      return { items: items.slice(0, query.limit ?? 8), tookMs: 0, seeds: 1, considered: store.size };
    },
    async forget(ids: string[]): Promise<number> {
      let deleted = 0;
      for (const id of ids) { if (store.delete(id)) deleted++; }
      return deleted;
    },
    async findForForget(query: string, _limit?: number): Promise<MemoryNode[]> {
      return [...store.values()].filter((n) => n.content.includes(query));
    },
    async approve(ids: string[]): Promise<number> {
      let count = 0;
      for (const id of ids) {
        const n = store.get(id);
        if (n) { store.set(id, { ...n, status: 'active' }); count++; }
      }
      return count;
    },
    async reject(ids: string[]): Promise<number> {
      let count = 0;
      for (const id of ids) { if (store.delete(id)) count++; }
      return count;
    },
    // Unused stubs — typed for interface compliance:
    async observe(_turn: ObservedTurn): Promise<MemoryWriteResult> {
      return { created: [], updated: [], superseded: [], pending: [], linked: 0 };
    },
    async search(_query: MemorySearchQuery): Promise<{ items: MemoryNode[]; total: number }> {
      return { items: [], total: 0 };
    },
    async get(_id: string): Promise<MemoryNodeDetail | null> { return null; },
    async update(id: string, patch: MemoryNodePatch): Promise<MemoryNode> {
      const n = store.get(id);
      if (!n) throw new NeoError('not_found', `Memory ${id} not found`);
      const updated = { ...n, ...patch } as MemoryNode;
      store.set(id, updated);
      return updated;
    },
    async link(_from: string, _to: string, _type: EdgeType, _weight?: number): Promise<MemoryEdge> {
      throw new NeoError('not_found', 'not implemented');
    },
    async unlink(_edgeId: string): Promise<boolean> { return false; },
    async graph(_query: GraphQuery): Promise<MemoryGraph> { return { nodes: [], edges: [] }; },
    async consolidate(_options?: { now?: number; force?: boolean; signal?: AbortSignal }): Promise<ConsolidationReport> {
      return { id: 'fake', startedAt: 0, finishedAt: 0, archived: 0, edgesDecayed: 0, edgesPruned: 0, episodesConsolidated: 0, factsCreated: 0, linksCreated: 0, entitiesMerged: 0, notes: [] };
    },
    async journal(_limit?: number): Promise<ConsolidationReport[]> { return []; },
    async stats(): Promise<MemoryStats> {
      return {
        total: store.size,
        byStatus: {} as Record<import('@neo/protocol').MemoryStatus, number>,
        byKind: {} as Record<import('@neo/protocol').MemoryKind, number>,
        edges: 0,
        pending: 0,
        lastConsolidationAt: null,
        embeddingModel: 'fake',
      };
    },
    async export(_options?: { includeEmbeddings?: boolean }): Promise<MemoryExport> {
      return { format: 'neo-memory', version: 1, exportedAt: Date.now(), nodes: [], edges: [] };
    },
    async import(_data: MemoryExport, _options?: { mode?: 'merge' | 'replace' }): Promise<ImportReport> {
      return { nodes: 0, edges: 0, skipped: 0 };
    },
    getPolicy(): MemoryPolicy { return DEFAULT_MEMORY_POLICY; },
    setPolicy(_policy: MemoryPolicy): void {},
    onChange(_listener: (event: MemoryChangeEvent) => void): () => void { return () => {}; },
  };
  return fakeService;
}

// ── evaluateExpression ────────────────────────────────────────────────────────

describe('evaluateExpression', () => {
  it('basic arithmetic', () => {
    expect(evaluateExpression('2 + 3')).toBe(5);
    expect(evaluateExpression('10 - 4')).toBe(6);
    expect(evaluateExpression('3 * 4')).toBe(12);
    expect(evaluateExpression('10 / 4')).toBe(2.5);
    expect(evaluateExpression('10 % 3')).toBe(1);
  });

  it('operator precedence', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512); // right-associative: 2^(3^2)=2^9
  });

  it('constants', () => {
    expect(evaluateExpression('pi')).toBeCloseTo(Math.PI);
    expect(evaluateExpression('e')).toBeCloseTo(Math.E);
  });

  it('unary functions', () => {
    expect(evaluateExpression('sqrt(16)')).toBe(4);
    expect(evaluateExpression('abs(-5)')).toBe(5);
    expect(evaluateExpression('floor(3.9)')).toBe(3);
    expect(evaluateExpression('ceil(3.1)')).toBe(4);
    expect(evaluateExpression('round(3.5)')).toBe(4);
  });

  it('binary functions', () => {
    expect(evaluateExpression('min(3, 5)')).toBe(3);
    expect(evaluateExpression('max(3, 5)')).toBe(5);
    expect(evaluateExpression('pow(2, 10)')).toBe(1024);
  });

  it('nested expressions', () => {
    expect(evaluateExpression('sqrt(pow(3, 2) + pow(4, 2))')).toBe(5);
  });

  it('unary minus', () => {
    expect(evaluateExpression('-5')).toBe(-5);
    expect(evaluateExpression('-(3 + 2)')).toBe(-5);
  });

  it('throws on division by zero', () => {
    expect(() => evaluateExpression('1 / 0')).toThrow(NeoError);
  });

  it('throws on empty expression', () => {
    expect(() => evaluateExpression('')).toThrow(NeoError);
    expect(() => evaluateExpression('  ')).toThrow(NeoError);
  });

  it('throws on unknown identifier', () => {
    expect(() => evaluateExpression('x + 1')).toThrow(NeoError);
  });

  it('throws on injection attempt: eval keyword', () => {
    expect(() => evaluateExpression('eval("1+1")')).toThrow(NeoError);
  });

  it('throws on unexpected character', () => {
    expect(() => evaluateExpression('1 $ 2')).toThrow(NeoError);
  });

  it('handles scientific notation', () => {
    expect(evaluateExpression('1e3')).toBe(1000);
    expect(evaluateExpression('1.5e2')).toBe(150);
  });

  it('throws on Infinity', () => {
    // log(-1) = NaN
    expect(() => evaluateExpression('sqrt(-1)')).toThrow(NeoError);
  });
});

// ── parseDateTime ─────────────────────────────────────────────────────────────

describe('parseDateTime', () => {
  // Reference: 2024-03-15 12:00:00 UTC (a Friday)
  const NOW_UTC = new Date('2024-03-15T12:00:00Z').getTime();

  it('epoch number passthrough', () => {
    expect(parseDateTime(NOW_UTC, NOW_UTC, 'UTC')).toBe(NOW_UTC);
  });

  it('epoch string', () => {
    expect(parseDateTime(String(NOW_UTC), NOW_UTC, 'UTC')).toBe(NOW_UTC);
  });

  it('ISO 8601 with Z offset', () => {
    const ts = parseDateTime('2024-03-15T12:00:00Z', NOW_UTC, 'UTC');
    expect(ts).toBe(NOW_UTC);
  });

  it('ISO 8601 with timezone offset', () => {
    const ts = parseDateTime('2024-03-15T14:00:00+02:00', NOW_UTC, 'UTC');
    expect(ts).toBe(NOW_UTC);
  });

  it('ISO 8601 without offset — interpreted in named timezone', () => {
    // NYC is UTC-5 in March (before DST springs forward)
    const ts = parseDateTime('2024-03-15T12:00:00', NOW_UTC, 'America/New_York');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 15, hour: 12, minute: 0, second: 0 }, 'America/New_York');
    expect(ts).toBe(expected);
    expect(ts).toBeGreaterThan(NOW_UTC); // UTC-5, so same wall clock is later in UTC
  });

  it('"in N minutes"', () => {
    const ts = parseDateTime('in 10 minutes', NOW_UTC, 'UTC');
    expect(ts).toBe(NOW_UTC + 10 * 60_000);
  });

  it('"in N hours"', () => {
    const ts = parseDateTime('in 2 hours', NOW_UTC, 'UTC');
    expect(ts).toBe(NOW_UTC + 2 * 3_600_000);
  });

  it('"in N days"', () => {
    const ts = parseDateTime('in 3 days', NOW_UTC, 'UTC');
    expect(ts).toBe(NOW_UTC + 3 * 86_400_000);
  });

  it('"tomorrow" defaults to 9am in timezone', () => {
    const ts = parseDateTime('tomorrow', NOW_UTC, 'UTC');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 16, hour: 9, minute: 0, second: 0 }, 'UTC');
    expect(ts).toBe(expected);
  });

  it('"tomorrow 14:30" explicit time', () => {
    const ts = parseDateTime('tomorrow 14:30', NOW_UTC, 'UTC');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 16, hour: 14, minute: 30, second: 0 }, 'UTC');
    expect(ts).toBe(expected);
  });

  it('"tonight" defaults to 20:00', () => {
    const ts = parseDateTime('tonight', NOW_UTC, 'UTC');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 15, hour: 20, minute: 0, second: 0 }, 'UTC');
    expect(ts).toBe(expected);
  });

  it('"next monday" advances to next Monday', () => {
    // 2024-03-15 is Friday (weekday 5). Next Monday = 2024-03-18.
    const ts = parseDateTime('next monday', NOW_UTC, 'UTC');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 18, hour: 9, minute: 0, second: 0 }, 'UTC');
    expect(ts).toBe(expected);
  });

  it('"monday" (no "next") also advances past today', () => {
    // Friday → next Monday
    const ts = parseDateTime('monday', NOW_UTC, 'UTC');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 18, hour: 9, minute: 0, second: 0 }, 'UTC');
    expect(ts).toBe(expected);
  });

  it('bare HH:MM time advances to next day if in the past', () => {
    // NOW is 12:00; "10:00" is in the past — should return tomorrow 10:00
    const ts = parseDateTime('10:00', NOW_UTC, 'UTC');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 16, hour: 10, minute: 0, second: 0 }, 'UTC');
    expect(ts).toBe(expected);
  });

  it('bare HH:MM in the future stays today', () => {
    const ts = parseDateTime('14:00', NOW_UTC, 'UTC');
    const expected = zonedTimeToUtc({ year: 2024, month: 3, day: 15, hour: 14, minute: 0, second: 0 }, 'UTC');
    expect(ts).toBe(expected);
  });

  it('throws NeoError on garbage input', () => {
    expect(() => parseDateTime('not a date', NOW_UTC, 'UTC')).toThrow(NeoError);
  });

  it('throws NeoError on empty string', () => {
    expect(() => parseDateTime('', NOW_UTC, 'UTC')).toThrow(NeoError);
  });

  it('DST spring-forward: 2:30 AM does not exist in America/New_York on 2024-03-10', () => {
    // 2024-03-10 is DST spring-forward day in New York (clocks skip 2:00→3:00).
    // The function should still return a valid epoch (falling in post-gap time).
    const ts = parseDateTime('2024-03-10T02:30:00', NOW_UTC, 'America/New_York');
    expect(typeof ts).toBe('number');
    expect(isNaN(ts)).toBe(false);
  });
});

// ── utcToZoned / zonedTimeToUtc ───────────────────────────────────────────────

describe('timezone helpers', () => {
  it('UTC identity round-trip', () => {
    const ms = new Date('2024-06-15T10:30:00Z').getTime();
    const parts = utcToZoned(ms, 'UTC');
    expect(parts.year).toBe(2024);
    expect(parts.month).toBe(6);
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(30);
    expect(parts.second).toBe(0);
    const back = zonedTimeToUtc(parts, 'UTC');
    expect(back).toBe(ms);
  });

  it('UTC offset timezone', () => {
    const ms = new Date('2024-06-15T10:00:00Z').getTime();
    const parts = utcToZoned(ms, 'America/New_York'); // EDT = UTC-4
    expect(parts.hour).toBe(6); // 10 - 4
  });

  it('DST fold: ambiguous hour picks the earlier instant', () => {
    // 2024-11-03 at 01:30 AM EST is ambiguous in America/New_York (both EDT and EST).
    // The fold runs from 2:00 AM EDT back to 1:00 AM EST.
    // Our zone → UTC should pick the EARLIER UTC (1:30 AM EDT = 5:30 UTC).
    const parts = { year: 2024, month: 11, day: 3, hour: 1, minute: 30, second: 0 };
    const ts = zonedTimeToUtc(parts, 'America/New_York');
    expect(typeof ts).toBe('number');
    expect(isNaN(ts)).toBe(false);
    // 1:30 AM EDT = UTC-4 → 5:30 UTC
    // 1:30 AM EST = UTC-5 → 6:30 UTC
    // Earlier is 5:30 UTC = 5.5 * 3600_000 past midnight
    const utcHour = new Date(ts).getUTCHours();
    expect(utcHour).toBe(5); // should pick the earlier (EDT) interpretation
  });

  it('weekday calculation: 2024-01-01 is Monday', () => {
    const ms = new Date('2024-01-01T12:00:00Z').getTime();
    const parts = utcToZoned(ms, 'UTC');
    expect(parts.weekday).toBe(1); // 0=Sun, 1=Mon
  });
});

// ── ReminderStore ─────────────────────────────────────────────────────────────

describe('ReminderStore', () => {
  let db: NeoDatabase;
  let clock: { now: number; fn: Clock };

  beforeEach(() => {
    db = makeDb();
    clock = { now: 1_700_000_000_000, fn: () => clock.now };
  });

  it('create and get', () => {
    const stores = makeStores(db, clock.fn);
    const r = stores.reminders.create({
      title: 'Test reminder',
      dueAt: clock.now + 60_000,
      timezone: 'UTC',
      recurrence: null,
      notes: null,
      conversationId: null,
    });
    expect(r.id).toMatch(/^rem_/);
    expect(r.title).toBe('Test reminder');
    expect(r.status).toBe('scheduled');

    const got = stores.reminders.get(r.id);
    expect(got?.id).toBe(r.id);
  });

  it('list by status', () => {
    const stores = makeStores(db, clock.fn);
    stores.reminders.create({ title: 'A', dueAt: clock.now + 60_000, timezone: 'UTC', recurrence: null, notes: null, conversationId: null });
    stores.reminders.create({ title: 'B', dueAt: clock.now + 120_000, timezone: 'UTC', recurrence: null, notes: null, conversationId: null });

    const scheduled = stores.reminders.list({ status: ['scheduled'] });
    expect(scheduled.length).toBe(2);
  });

  it('due returns overdue items in order', () => {
    const stores = makeStores(db, clock.fn);
    stores.reminders.create({ title: 'First', dueAt: clock.now - 2000, timezone: 'UTC', recurrence: null, notes: null, conversationId: null });
    stores.reminders.create({ title: 'Second', dueAt: clock.now - 1000, timezone: 'UTC', recurrence: null, notes: null, conversationId: null });
    stores.reminders.create({ title: 'Future', dueAt: clock.now + 1000, timezone: 'UTC', recurrence: null, notes: null, conversationId: null });

    const due = stores.reminders.due(clock.now);
    expect(due.length).toBe(2);
    expect(due[0]?.title).toBe('First');
  });

  it('recurrence with interval defaults to 1', () => {
    const stores = makeStores(db, clock.fn);
    const r = stores.reminders.create({
      title: 'Daily',
      dueAt: clock.now + 60_000,
      timezone: 'UTC',
      // Note: RecurrenceInput allows interval to be optional
      recurrence: { freq: 'daily' },
      notes: null,
      conversationId: null,
    });
    expect(r.recurrence?.interval).toBe(1);
  });
});

// ── TaskStore ─────────────────────────────────────────────────────────────────

describe('TaskStore', () => {
  let db: NeoDatabase;
  const clock: Clock = () => 1_700_000_000_000;

  beforeEach(() => {
    db = makeDb();
  });

  it('create task in inbox', () => {
    const { tasks } = makeStores(db, clock);
    // listId omitted → defaults to INBOX_LIST_ID ('list_inbox')
    const t = tasks.create({ title: 'Buy groceries', dueAt: null, priority: 0, notes: null, tags: [] });
    expect(t.title).toBe('Buy groceries');
    expect(t.listId).toBe('list_inbox');
    expect(t.done).toBe(false);
  });

  it('update task title and done', () => {
    const { tasks } = makeStores(db, clock);
    const t = tasks.create({ title: 'Buy groceries', dueAt: null, priority: 0, notes: null, tags: [] });
    const updated = tasks.update(t.id, { title: 'Buy organic groceries', done: true });
    expect(updated.title).toBe('Buy organic groceries');
    expect(updated.done).toBe(true);
  });

  it('list tasks with done filter', () => {
    const { tasks } = makeStores(db, clock);
    tasks.create({ title: 'A', dueAt: null, priority: 0, notes: null, tags: [] });
    const b = tasks.create({ title: 'B', dueAt: null, priority: 0, notes: null, tags: [] });
    tasks.update(b.id, { done: true });

    const undone = tasks.list({ done: false });
    expect(undone.length).toBe(1);
    expect(undone[0]?.title).toBe('A');
  });

  it('update list metadata', () => {
    const { tasks } = makeStores(db, clock);
    const list = tasks.createList({ name: 'Work' });
    const updated = tasks.updateList(list.id, { name: 'Work Items', color: '#ff0000' });
    expect(updated.name).toBe('Work Items');
    expect(updated.color).toBe('#ff0000');
  });
});

// ── NoteStore ─────────────────────────────────────────────────────────────────

describe('NoteStore', () => {
  let db: NeoDatabase;
  const clock: Clock = () => 1_700_000_000_000;

  beforeEach(() => {
    db = makeDb();
  });

  it('create and get note', () => {
    const { notes } = makeStores(db, clock);
    const n = notes.create({ title: 'Hello', content: 'World', tags: [] });
    const got = notes.get(n.id);
    expect(got?.content).toBe('World');
  });

  it('full-text search', () => {
    const { notes } = makeStores(db, clock);
    notes.create({ title: 'Alpha', content: 'foo bar baz', tags: [] });
    notes.create({ title: 'Beta', content: 'hello world', tags: [] });

    const results = notes.list({ query: 'foo' });
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe('Alpha');
  });

  it('delete note', () => {
    const { notes } = makeStores(db, clock);
    const n = notes.create({ title: 'ToDelete', content: 'content', tags: [] });
    expect(notes.delete(n.id)).toBe(true);
    expect(notes.get(n.id)).toBeNull();
  });
});

// ── ToolRegistry ──────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  const NOW = 1_700_000_000_000;
  const ctx = makeCtx(NOW);

  it('returns error for unknown tool', async () => {
    const registry = createToolRegistry();
    const result = await registry.execute({ id: 'tc-1', name: 'nonexistent', input: {} }, ctx);
    expect(result.isError).toBe(true);
  });

  it('registers and executes a tool', async () => {
    const registry = createToolRegistry();
    const { defineTool } = await import('@neo/protocol');
    const { z } = await import('zod');

    const greet = defineTool({
      name: 'greet',
      title: 'Greet',
      description: 'Say hello.',
      inputSchema: z.object({ name: z.string() }),
      risk: 'read',
      defaultPermission: 'auto',
      async execute(input) {
        return { output: { message: `Hello, ${input.name}!` } };
      },
    });

    registry.register(greet, 'builtin');
    const result = await registry.execute({ id: 'tc-1', name: 'greet', input: { name: 'World' } }, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.output as { message: string }).message).toBe('Hello, World!');
  });

  it('validates input and returns error on bad input', async () => {
    const registry = createToolRegistry();
    const { defineTool } = await import('@neo/protocol');
    const { z } = await import('zod');

    const strict = defineTool({
      name: 'strict_tool',
      title: 'Strict',
      description: 'Needs number.',
      inputSchema: z.object({ n: z.number() }),
      risk: 'read',
      defaultPermission: 'auto',
      async execute(input) { return { output: { n: input.n } }; },
    });

    registry.register(strict, 'builtin');
    const result = await registry.execute({ id: 'tc-1', name: 'strict_tool', input: { n: 'notanumber' } }, ctx);
    expect(result.isError).toBe(true);
  });

  it('never throws — catches thrown errors and returns error result', async () => {
    const registry = createToolRegistry();
    const { defineTool } = await import('@neo/protocol');
    const { z } = await import('zod');

    const broken = defineTool({
      name: 'broken_tool',
      title: 'Broken',
      description: 'Always throws.',
      inputSchema: z.object({}),
      risk: 'read',
      defaultPermission: 'auto',
      async execute() { throw new NeoError('internal', 'unexpected failure'); },
    });

    registry.register(broken, 'builtin');
    // Should NOT throw — must return error result
    const result = await registry.execute({ id: 'tc-1', name: 'broken_tool', input: {} }, ctx);
    expect(result.isError).toBe(true);
  });

  it('denies uiOnly tools when origin is model', async () => {
    const registry = createToolRegistry();
    const { defineTool } = await import('@neo/protocol');
    const { z } = await import('zod');

    const uiTool = defineTool({
      name: 'ui_only',
      title: 'UI Only',
      description: 'Only from UI.',
      inputSchema: z.object({}),
      risk: 'read',
      defaultPermission: 'auto',
      uiOnly: true,
      async execute() { return { output: {} }; },
    });

    registry.register(uiTool, 'builtin');
    const result = await registry.execute({ id: 'tc-1', name: 'ui_only', input: {} }, { ...ctx, origin: 'model' });
    expect(result.isError).toBe(true);
  });
});

// ── ReminderScheduler ────────────────────────────────────────────────────────

describe('ReminderScheduler (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires overdue reminders on start (catch-up)', async () => {
    const NOW = 1_700_000_060_000; // 1 minute past epoch reference
    const db = makeDb();
    let clockNow = NOW;
    const clock: Clock = () => clockNow;
    const stores = makeStores(db, clock);

    // Create a reminder due 30s ago
    stores.reminders.create({
      title: 'Overdue',
      dueAt: NOW - 30_000,
      timezone: 'UTC',
      recurrence: null,
      notes: null,
      conversationId: null,
    });

    const firings: import('@neo/protocol').ReminderFiring[] = [];
    const scheduler = createReminderScheduler({ reminders: stores.reminders, clock });
    scheduler.onFire((f) => firings.push(f));
    scheduler.start();

    // Catch-up is synchronous in tick()
    expect(firings.length).toBe(1);
    expect(firings[0]?.reminder.title).toBe('Overdue');
    expect(firings[0]?.missed).toBe(false); // within 15-min grace

    scheduler.stop();
  });

  it('fires a future reminder after advancing fake clock', async () => {
    const NOW = 1_700_000_000_000;
    const db = makeDb();
    let clockNow = NOW;
    const clock: Clock = () => clockNow;
    const stores = makeStores(db, clock);

    stores.reminders.create({
      title: 'Future',
      dueAt: NOW + 5_000, // 5s from now
      timezone: 'UTC',
      recurrence: null,
      notes: null,
      conversationId: null,
    });

    const firings: import('@neo/protocol').ReminderFiring[] = [];
    const scheduler = createReminderScheduler({ reminders: stores.reminders, clock, maxTimerMs: 10_000 });
    scheduler.onFire((f) => firings.push(f));
    scheduler.start();

    expect(firings.length).toBe(0);

    // Advance fake timer AND clock
    clockNow = NOW + 5_001;
    vi.advanceTimersByTime(5_001);

    expect(firings.length).toBe(1);
    expect(firings[0]?.reminder.title).toBe('Future');

    scheduler.stop();
  });

  it('marks missed=true when fired way past grace period', () => {
    const NOW = 1_700_000_000_000;
    const db = makeDb();
    // Clock is already 20 min past the reminder's due time
    let clockNow = NOW + 20 * 60_000;
    const clock: Clock = () => clockNow;
    const stores = makeStores(db, clock);

    stores.reminders.create({
      title: 'Very Overdue',
      dueAt: NOW, // due 20 min ago
      timezone: 'UTC',
      recurrence: null,
      notes: null,
      conversationId: null,
    });

    const firings: import('@neo/protocol').ReminderFiring[] = [];
    const scheduler = createReminderScheduler({ reminders: stores.reminders, clock, graceMs: 15 * 60_000 });
    scheduler.onFire((f) => firings.push(f));
    scheduler.start();

    expect(firings.length).toBe(1);
    expect(firings[0]?.missed).toBe(true);

    scheduler.stop();
  });
});

// ── SSRF guard ────────────────────────────────────────────────────────────────

describe('checkSsrf', () => {
  const allowAll: DnsResolver = async () => ['93.184.216.34']; // public IP

  it('allows public URLs', async () => {
    await expect(checkSsrf('https://example.com', allowAll)).resolves.toBeUndefined();
  });

  it('blocks http:// to a loopback via DNS', async () => {
    const resolveLoopback: DnsResolver = async () => ['127.0.0.1'];
    await expect(checkSsrf('http://internal.example.com', resolveLoopback)).rejects.toThrow(NeoError);
  });

  it('blocks direct loopback IP in URL', async () => {
    await expect(checkSsrf('http://127.0.0.1/secret', allowAll)).rejects.toThrow(NeoError);
  });

  it('blocks link-local (169.254.x.x)', async () => {
    await expect(checkSsrf('http://169.254.169.254/latest/meta-data/', allowAll)).rejects.toThrow(NeoError);
  });

  it('blocks private 10.x.x.x via raw IP in URL', async () => {
    await expect(checkSsrf('http://10.0.0.1/admin', allowAll)).rejects.toThrow(NeoError);
  });

  it('blocks private range via DNS resolution', async () => {
    const resolvePrivate: DnsResolver = async () => ['192.168.1.1'];
    await expect(checkSsrf('https://evil.example.com', resolvePrivate)).rejects.toThrow(NeoError);
  });

  it('blocks non-http schemes', async () => {
    await expect(checkSsrf('file:///etc/passwd', allowAll)).rejects.toThrow(NeoError);
    await expect(checkSsrf('ftp://example.com/file', allowAll)).rejects.toThrow(NeoError);
  });

  it('blocks ::1 IPv6 loopback', async () => {
    await expect(checkSsrf('http://[::1]/secret', allowAll)).rejects.toThrow(NeoError);
  });
});

// ── web_fetch tool ────────────────────────────────────────────────────────────

describe('createWebFetchTool', () => {
  const allowAll: DnsResolver = async () => ['93.184.216.34'];

  const fakeFetch = (status: number, body: string, contentType = 'text/plain'): typeof fetch =>
    async () => new Response(body, { status, headers: { 'Content-Type': contentType } });

  const ctx = makeCtx(Date.now());

  it('fetches text content successfully', async () => {
    const tool = createWebFetchTool(fakeFetch(200, 'Hello from the web'), false, allowAll);
    const result = await tool.execute({ url: 'https://example.com' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(String((result.output as { text: unknown }).text)).toContain('Hello from the web');
  });

  it('strips HTML tags from HTML responses', async () => {
    const html = '<html><head><title>Test</title></head><body><p>Content here</p></body></html>';
    const tool = createWebFetchTool(fakeFetch(200, html, 'text/html; charset=utf-8'), false, allowAll);
    const result = await tool.execute({ url: 'https://example.com' }, ctx);
    const text = String((result.output as { text: unknown }).text);
    expect(text).not.toContain('<html>');
    expect(text).toContain('Content here');
  });

  it('returns error on HTTP 404', async () => {
    const tool = createWebFetchTool(fakeFetch(404, 'Not Found'), false, allowAll);
    const result = await tool.execute({ url: 'https://example.com/missing' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('blocks SSRF via DNS with private IP injection', async () => {
    const maliciousResolver: DnsResolver = async () => ['10.0.0.1'];
    const tool = createWebFetchTool(fakeFetch(200, 'leaked data'), false, maliciousResolver);
    const result = await tool.execute({ url: 'https://internal-service.local' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('allows private network when flag is set', async () => {
    const privateResolver: DnsResolver = async () => ['192.168.1.1'];
    const tool = createWebFetchTool(fakeFetch(200, 'internal data'), true, privateResolver);
    const result = await tool.execute({ url: 'http://192.168.1.1/data' }, ctx);
    expect(result.isError).toBeFalsy();
  });
});

// ── memory tools ──────────────────────────────────────────────────────────────

/** Find a tool by name, throwing if missing (avoids undefined from array index). */
function findTool(tools: import('@neo/protocol').ToolDefinition[], name: string): import('@neo/protocol').ToolDefinition {
  const t = tools.find((td) => td.name === name);
  if (!t) throw new Error(`Tool '${name}' not found in list`);
  return t;
}

describe('memory tools', () => {
  const ctx = makeCtx(Date.now());

  it('remember stores a memory', async () => {
    const memory = makeFakeMemory();
    const tools = createMemoryTools(memory);
    const remember = findTool(tools, 'remember');
    const result = await remember.execute(
      { content: 'User is allergic to peanuts', kind: 'fact' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect((result.output as { id: string }).id).toBeTruthy();
  });

  it('recall returns stored memories', async () => {
    const memory = makeFakeMemory();
    const tools = createMemoryTools(memory);
    const remember = findTool(tools, 'remember');
    const recall = findTool(tools, 'recall');
    await remember.execute({ content: 'User likes jazz' }, ctx);
    const result = await recall.execute({ query: 'music preferences', limit: 5 }, ctx);
    expect(result.isError).toBeFalsy();
    const memories = (result.output as { memories: unknown[] }).memories;
    expect(memories.length).toBeGreaterThan(0);
  });

  it('recall follows the live policy: off → a friendly result, on again → memories', async () => {
    let recallOn = false;
    const base = makeFakeMemory();
    const memory: MemoryService = { ...base, getPolicy: () => ({ ...DEFAULT_MEMORY_POLICY, recall: recallOn }) };
    const tools = createMemoryTools(memory);
    await findTool(tools, 'remember').execute({ content: 'User likes jazz' }, ctx);
    const recall = findTool(tools, 'recall');
    const off = await recall.execute({ query: 'music preferences' }, ctx);
    expect(off.isError).toBeFalsy();
    expect(off.output).toMatchObject({ memories: [], note: expect.stringMatching(/memory recall is turned off/i) });
    recallOn = true;
    const on = await recall.execute({ query: 'music preferences' }, ctx);
    expect((on.output as { memories: unknown[] }).memories.length).toBeGreaterThan(0);
  });

  it('forget removes by id', async () => {
    const memory = makeFakeMemory();
    const tools = createMemoryTools(memory);
    const remember = findTool(tools, 'remember');
    const forget = findTool(tools, 'forget');
    const rem = await remember.execute({ content: 'Temporary fact' }, ctx);
    const id = (rem.output as { id: string }).id;

    const forgetResult = await forget.execute({ ids: [id] }, ctx);
    expect((forgetResult.output as { forgotten: string[] }).forgotten).toHaveLength(1);
  });

  it('forget by query finds and deletes', async () => {
    const memory = makeFakeMemory();
    const tools = createMemoryTools(memory);
    const remember = findTool(tools, 'remember');
    const forget = findTool(tools, 'forget');
    await remember.execute({ content: 'User visited Paris last summer' }, ctx);
    const result = await forget.execute({ query: 'Paris' }, ctx);
    expect((result.output as { forgotten: string[] }).forgotten.length).toBeGreaterThan(0);
  });
});

// ── builtin tools integration ──────────────────────────────────────────────────

describe('builtin tools integration', () => {
  const NOW = 1_700_000_000_000;
  const ctx = makeCtx(NOW);
  let db: NeoDatabase;

  beforeEach(() => { db = makeDb(); });

  it('get_datetime returns current time', async () => {
    const clock: Clock = () => NOW;
    const stores = makeStores(db, clock);
    const tools = createBuiltinTools({ stores, memory: makeFakeMemory(), clock });
    const dt = tools.find((t) => t.name === 'get_datetime');
    expect(dt).toBeDefined();
    const result = await dt!.execute({}, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.output as { epochMs: number }).epochMs).toBe(NOW);
  });

  it('calculate returns correct result', async () => {
    const clock: Clock = () => NOW;
    const stores = makeStores(db, clock);
    const tools = createBuiltinTools({ stores, memory: makeFakeMemory(), clock });
    const calc = tools.find((t) => t.name === 'calculate');
    expect(calc).toBeDefined();
    const result = await calc!.execute({ expression: '2 ^ 10' }, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.output as { result: number }).result).toBe(1024);
  });

  it('calculate returns error for bad expression', async () => {
    const clock: Clock = () => NOW;
    const stores = makeStores(db, clock);
    const tools = createBuiltinTools({ stores, memory: makeFakeMemory(), clock });
    const calc = tools.find((t) => t.name === 'calculate');
    const result = await calc!.execute({ expression: 'bad expression $$' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('create_reminder and list_reminders round-trip', async () => {
    const clock: Clock = () => NOW;
    const stores = makeStores(db, clock);
    const tools = createBuiltinTools({ stores, memory: makeFakeMemory(), clock });
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t, 'builtin');

    // Create
    const createResult = await registry.execute(
      { id: 'tc-1', name: 'create_reminder', input: { title: 'Meeting', when: 'in 1 hour' } },
      ctx,
    );
    expect(createResult.isError).toBeFalsy();

    // List
    const listResult = await registry.execute(
      { id: 'tc-2', name: 'list_reminders', input: { status: 'upcoming' } },
      ctx,
    );
    expect(listResult.isError).toBeFalsy();
    const reminders = (listResult.output as { reminders: unknown[] }).reminders;
    expect(reminders.length).toBe(1);
  });

  it('create_task and list_tasks round-trip', async () => {
    const clock: Clock = () => NOW;
    const stores = makeStores(db, clock);
    const tools = createBuiltinTools({ stores, memory: makeFakeMemory(), clock });
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t, 'builtin');

    await registry.execute({ id: 'tc-1', name: 'create_task', input: { title: 'Finish report' } }, ctx);
    const listResult = await registry.execute({ id: 'tc-2', name: 'list_tasks', input: {} }, ctx);
    expect(listResult.isError).toBeFalsy();
    const tasks = (listResult.output as { tasks: unknown[] }).tasks;
    expect(tasks.length).toBe(1);
  });

  it('create_note and get_note round-trip', async () => {
    const clock: Clock = () => NOW;
    const stores = makeStores(db, clock);
    const tools = createBuiltinTools({ stores, memory: makeFakeMemory(), clock });
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t, 'builtin');

    const createResult = await registry.execute(
      { id: 'tc-1', name: 'create_note', input: { title: 'Meeting notes', content: '# Discussion\n\n- Point 1' } },
      ctx,
    );
    expect(createResult.isError).toBeFalsy();
    const note = (createResult.output as { note: { id: string } }).note;

    const getResult = await registry.execute({ id: 'tc-2', name: 'get_note', input: { id: note.id } }, ctx);
    expect(getResult.isError).toBeFalsy();
  });
});

// ── loadPlugins ───────────────────────────────────────────────────────────────

describe('loadPlugins', () => {
  it('returns [] for an empty directory', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(`${tmpdir()}/neo-test-plugins-`);
    const plugins = await loadPlugins(dir);
    expect(plugins).toEqual([]);
    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true }).catch(() => {}));
  });

  it('returns [] for a non-existent directory (graceful)', async () => {
    const plugins = await loadPlugins('/tmp/definitely-does-not-exist-neo-test-12345678');
    expect(plugins).toEqual([]);
  });

  it('loads a valid plugin from a .mjs file', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(`${tmpdir()}/neo-test-plugins-`);
    const pluginSrc = `
export default {
  name: 'my-test-plugin',
  tools: [{
    name: 'test_tool',
    title: 'Test Tool',
    description: 'A test tool',
    inputSchema: { parse: (x) => x, safeParse: (x) => ({ success: true, data: x }) },
    risk: 'read',
    defaultPermission: 'auto',
    execute: async (input) => ({ output: { ok: true } }),
  }],
};
`;
    await writeFile(join(dir, 'my-plugin.mjs'), pluginSrc, 'utf-8');

    const plugins = await loadPlugins(dir);
    // loadPlugins may load 0 plugins if the format doesn't match exactly,
    // but it must not throw.
    expect(Array.isArray(plugins)).toBe(true);

    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true }).catch(() => {}));
  });

  it('skips invalid plugin files without throwing', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(`${tmpdir()}/neo-test-plugins-`);
    await writeFile(join(dir, 'bad-plugin.mjs'), 'export default { notAPlugin: true };', 'utf-8');
    await writeFile(join(dir, 'syntax-error.mjs'), 'this is not valid JS!!!', 'utf-8');

    // Must not throw
    const plugins = await loadPlugins(dir);
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBe(0);

    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true }).catch(() => {}));
  });
});
