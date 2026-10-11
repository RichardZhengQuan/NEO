/** Review tests for the built-in tools (catalogue, outputs, ui blocks, memory wiring, render_ui). */
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@neo/storage';
import {
  DEFAULT_MEMORY_POLICY,
  INBOX_LIST_ID,
  UI_BLOCK_TYPES,
  silentLogger,
  validateUIBlocks,
  type MemoryNode,
  type MemoryService,
  type ProductivityStores,
  type RecallQuery,
  type RememberInput,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
} from '@neo/protocol';
import { createBuiltinTools } from './builtins/index.js';
import { createToolRegistry } from './registry.js';
import { createProductivityStores, toolsMigrations } from './stores/index.js';

// Saturday 2026-10-10 12:15Z = 20:15 in Shanghai.
const NOW = Date.UTC(2026, 9, 10, 12, 15);
const TZ = 'Asia/Shanghai';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolCallId: 'tc_1',
    conversationId: 'conv_42',
    signal: new AbortController().signal,
    now: () => NOW,
    timezone: TZ,
    locale: 'en-US',
    allowSensitive: false,
    origin: 'model',
    logger: silentLogger,
    ...overrides,
  };
}

function node(id: string, label: string, extra: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id, label, content: `${label} (content)`, kind: 'fact', aliases: [], tags: [], importance: 0.5, confidence: 1, stability: 30,
    accessCount: 0, lastAccessedAt: null, createdAt: 0, updatedAt: 0, status: 'active', pinned: false, sensitivity: 'normal',
    source: { by: 'tool', conversationId: null }, ...extra,
  } as MemoryNode;
}

/** A recording fake MemoryService (only the methods the tools use do anything). */
function fakeMemory(opts: { pending?: boolean; recall?: boolean } = {}) {
  const nodes = new Map<string, MemoryNode>();
  const calls: { method: string; args: unknown }[] = [];
  let n = 0;
  const memory = {
    getPolicy() {
      return { ...DEFAULT_MEMORY_POLICY, recall: opts.recall ?? true };
    },
    async remember(input: RememberInput) {
      calls.push({ method: 'remember', args: input });
      const m = node(`mem_${++n}`, input.label ?? input.content.slice(0, 40), { content: input.content, status: opts.pending ? 'pending' : 'active', sensitivity: input.sensitivity ?? 'normal' });
      nodes.set(m.id, m);
      return m;
    },
    async recall(query: RecallQuery) {
      calls.push({ method: 'recall', args: query });
      return { items: [...nodes.values()].map((m) => ({ node: m, score: 0.9, activation: 1, similarity: 0.9, retention: 1, via: [], reason: 'matches your message' })), tookMs: 1, seeds: 1, considered: nodes.size };
    },
    async findForForget(query: string, limit?: number) {
      calls.push({ method: 'findForForget', args: { query, limit } });
      return [...nodes.values()].filter((m) => m.content.toLowerCase().includes(query.toLowerCase()));
    },
    async get(id: string) {
      const m = nodes.get(id);
      return m ? { node: m, edges: [], neighbors: [], retention: 1 } : null;
    },
    async forget(ids: string[]) {
      calls.push({ method: 'forget', args: ids });
      let k = 0;
      for (const id of ids) if (nodes.delete(id)) k++;
      return k;
    },
    async approve(ids: string[]) {
      calls.push({ method: 'approve', args: ids });
      return ids.length;
    },
    async reject(ids: string[]) {
      calls.push({ method: 'reject', args: ids });
      return ids.length;
    },
  };
  return { memory: memory as unknown as MemoryService, nodes, calls };
}

function setup(memoryOpts: { pending?: boolean; recall?: boolean } = {}, webSearch?: { provider: 'searxng'; baseUrl: string }) {
  const db = openDatabase(':memory:');
  migrate(db, 'tools', toolsMigrations);
  const stores = createProductivityStores(db, { clock: () => NOW, defaultTimezone: TZ });
  const mem = fakeMemory(memoryOpts);
  const tools = createBuiltinTools({ stores, memory: mem.memory, clock: () => NOW, ...(webSearch ? { webSearch } : {}) });
  const registry = createToolRegistry();
  for (const t of tools) registry.register(t, 'builtin');
  const run = (name: string, input: unknown, c: Partial<ToolContext> = {}) => registry.execute({ id: 'tc_1', name, input }, ctx(c));
  return { stores, registry, run, tools, mem };
}

const expectValidUi = (res: ToolResult) => {
  expect(res.ui?.length).toBeGreaterThan(0);
  const v = validateUIBlocks(res.ui);
  expect(v.ok ? 'ok' : v.error).toBe('ok');
};
const errorOf = (res: ToolResult) => String((res.output as { error?: string }).error);

describe('catalogue', () => {
  it('has every documented tool with the documented risk, permission and flags', () => {
    const { registry } = setup({}, { provider: 'searxng', baseUrl: 'http://127.0.0.1:8888' });
    const expected: Record<string, [string, string]> = {
      get_datetime: ['read', 'auto'], calculate: ['read', 'auto'],
      create_reminder: ['write', 'auto'], list_reminders: ['read', 'auto'], update_reminder: ['write', 'auto'],
      snooze_reminder: ['write', 'auto'], complete_reminder: ['write', 'auto'], cancel_reminder: ['write', 'auto'],
      create_task: ['write', 'auto'], list_tasks: ['read', 'auto'], update_task: ['write', 'auto'], delete_task: ['dangerous', 'confirm'],
      create_note: ['write', 'auto'], search_notes: ['read', 'auto'], get_note: ['read', 'auto'], update_note: ['write', 'auto'],
      replace_note: ['dangerous', 'confirm'], delete_note: ['dangerous', 'confirm'], remember: ['write', 'auto'], recall: ['read', 'auto'], forget: ['dangerous', 'confirm'],
      approve_memory: ['write', 'auto'], reject_memory: ['write', 'auto'], web_fetch: ['external', 'auto'],
      web_search: ['external', 'auto'], render_ui: ['read', 'auto'],
    };
    const tools = registry.list();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(expected).sort());
    for (const t of tools) {
      expect([t.risk, t.defaultPermission], t.name).toEqual(expected[t.name]);
      expect(t.description.length, t.name).toBeGreaterThan(60);
      if (t.risk === 'dangerous') expect(typeof t.describeCall, t.name).toBe('function');
      expect(Boolean(t.uiOnly), t.name).toBe(t.name === 'approve_memory' || t.name === 'reject_memory');
      expect(Boolean(t.untrustedOutput), t.name).toBe(t.name === 'web_fetch' || t.name === 'web_search');
    }
    expect(registry.specs().map((s) => s.name)).not.toContain('approve_memory');
  });

  it('web_search is only offered when a provider is configured', () => {
    expect(setup().registry.get('web_search')).toBeUndefined();
  });
});

describe('time tools', () => {
  it('get_datetime reports epoch, local ISO and weekday; rejects unknown zones', async () => {
    const { run } = setup();
    const res = await run('get_datetime', {});
    expect(res.output).toMatchObject({ epochMs: NOW, iso: '2026-10-10T12:15:00.000Z', local: '2026-10-10T20:15:00', timezone: TZ, weekday: 'Saturday' });
    expect((await run('get_datetime', { timezone: 'Europe/Berlin' })).output).toMatchObject({ local: '2026-10-10T14:15:00' });
    expect((await run('get_datetime', { timezone: 'Mars/Base' })).isError).toBe(true);
  });

  it('calculate returns a result or a readable error', async () => {
    const { run } = setup();
    expect((await run('calculate', { expression: '2^3^2' })).output).toMatchObject({ result: 512 });
    const bad = await run('calculate', { expression: 'process.exit()' });
    expect(bad.isError).toBe(true);
    expect(errorOf(bad)).toMatch(/process/);
  });
});

describe('reminder tools', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('create_reminder: local time output, live widget, friendly summary', async () => {
    const res = await t.run('create_reminder', { title: '  Call mom  ', when: 'tomorrow 9am', recurrence: { freq: 'weekly', byWeekday: [0] } });
    expect(res.isError).toBeFalsy();
    const r = (res.output as { reminder: Record<string, unknown> }).reminder;
    expect(r).toMatchObject({ title: 'Call mom', dueAt: Date.UTC(2026, 9, 11, 1), dueLocal: '2026-10-11T09:00:00', timezone: TZ, status: 'scheduled' });
    expect(String(r.repeats)).toMatch(/every week/);
    expectValidUi(res);
    expect(res.ui![0]).toMatchObject({ type: 'reminder', reminderId: r.id, dueAt: Date.UTC(2026, 9, 11, 1), timezone: TZ, status: 'scheduled' });
    expect(res.summary).toMatch(/Call mom/);
    expect(res.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(t.stores.reminders.get(String(r.id))?.conversationId).toBe('conv_42');
  });

  it('create_reminder refuses times in the past and unparseable times', async () => {
    const past = await t.run('create_reminder', { title: 'x', when: '2026-10-10T08:00' });
    expect(past.isError).toBe(true);
    expect(errorOf(past)).toMatch(/past/i);
    expect((await t.run('create_reminder', { title: 'x', when: 'someday' })).isError).toBe(true);
    expect(t.stores.reminders.list()).toEqual([]);
  });

  it('long titles still produce valid widgets', async () => {
    const res = await t.run('create_reminder', { title: 'x'.repeat(500), when: 'in 1 hour' });
    expectValidUi(res);
    const list = await t.run('list_reminders', {});
    expectValidUi(list);
  });

  it('list_reminders filters by status and shows local times', async () => {
    await t.run('create_reminder', { title: 'a', when: 'in 1 hour' });
    const b = await t.run('create_reminder', { title: 'b', when: 'in 2 hours' });
    await t.run('complete_reminder', { id: (b.output as { reminder: { id: string } }).reminder.id });
    const upcoming = await t.run('list_reminders', {});
    expect((upcoming.output as { reminders: { title: string; dueLocal: string }[] }).reminders.map((r) => r.title)).toEqual(['a']);
    expect((upcoming.output as { reminders: { dueLocal: string }[] }).reminders[0]!.dueLocal).toBe('2026-10-10T21:15:00');
    const all = await t.run('list_reminders', { status: 'all' });
    expect((all.output as { reminders: unknown[] }).reminders).toHaveLength(2);
  });

  it('update_reminder with a new time reschedules a reminder that already fired', async () => {
    const created = await t.run('create_reminder', { title: 'x', when: 'in 5 minutes' });
    const id = (created.output as { reminder: { id: string } }).reminder.id;
    t.stores.reminders.markFired(id, NOW + 300_000);
    const res = await t.run('update_reminder', { id, when: 'tomorrow 8:00', recurrence: null });
    expect(res.output).toMatchObject({ reminder: { status: 'scheduled', dueLocal: '2026-10-11T08:00:00' } });
    expectValidUi(res);
    expect((await t.run('update_reminder', { id: 'rem_missing', title: 'y' })).isError).toBe(true);
  });

  it('snooze, complete and cancel', async () => {
    const created = await t.run('create_reminder', { title: 'x', when: 'in 5 minutes' });
    const id = (created.output as { reminder: { id: string } }).reminder.id;
    expect((await t.run('snooze_reminder', { id, minutes: 10 })).output).toMatchObject({ reminder: { dueAt: NOW + 600_000 } });
    expect((await t.run('snooze_reminder', { id, minutes: 0 })).isError).toBe(true);
    expect((await t.run('complete_reminder', { id })).output).toMatchObject({ reminder: { status: 'completed' } });
    expect((await t.run('cancel_reminder', { id })).output).toMatchObject({ status: 'cancelled' });
  });
});

describe('task tools', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('create_task: unknown list names create the list; the widget shows that list', async () => {
    const res = await t.run('create_task', { title: 'Milk', list: 'Groceries', due: 'tomorrow', priority: 2 });
    expect(res.isError).toBeFalsy();
    const task = (res.output as { task: { id: string; listId: string; dueLocal: string } }).task;
    const list = t.stores.tasks.lists().find((l) => l.name === 'Groceries');
    expect(task.listId).toBe(list?.id);
    expect(task.dueLocal).toBe('2026-10-11T09:00:00');
    expectValidUi(res);
    expect(res.ui![0]).toMatchObject({ type: 'tasks', title: 'Groceries', listId: list?.id });
    // Case-insensitive reuse, no duplicate list
    await t.run('create_task', { title: 'Eggs', list: 'groceries' });
    expect(t.stores.tasks.lists().filter((l) => l.name.toLowerCase() === 'groceries')).toHaveLength(1);
  });

  it('the widget always contains the task just created, even in a long list', async () => {
    for (let i = 0; i < 120; i++) t.stores.tasks.create({ title: `old ${i}` });
    const res = await t.run('create_task', { title: 'x'.repeat(1000) });
    expectValidUi(res);
    const id = (res.output as { task: { id: string } }).task.id;
    const block = res.ui![0] as { tasks: { id: string }[] };
    expect(block.tasks.some((x) => x.id === id)).toBe(true);
  });

  it('list_tasks: an unknown list is an error, not "all tasks labelled as the inbox"', async () => {
    t.stores.tasks.create({ title: 'inbox task' });
    const res = await t.run('list_tasks', { list: 'Nope' });
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toMatch(/Inbox/);
    const all = await t.run('list_tasks', {});
    expectValidUi(all);
    expect(all.ui![0]).not.toHaveProperty('listId');
    const inbox = await t.run('list_tasks', { list: 'inbox' });
    expect(inbox.ui![0]).toMatchObject({ listId: INBOX_LIST_ID });
  });

  it('update_task toggles done (as the checkbox does) and moves lists', async () => {
    const created = await t.run('create_task', { title: 'x' });
    const id = (created.output as { task: { id: string } }).task.id;
    expect((await t.run('update_task', { id, done: true }, { origin: 'ui' })).output).toMatchObject({ task: { done: true } });
    expect((await t.run('update_task', { id, due: null, list: 'Work' })).output).toMatchObject({ task: { dueAt: null } });
  });

  it('delete_task names the task when asking and errors on unknown ids', async () => {
    const created = await t.run('create_task', { title: 'Book flights' });
    const id = (created.output as { task: { id: string } }).task.id;
    expect(t.registry.get('delete_task')!.describeCall!({ id })).toMatch(/Book flights/);
    expect((await t.run('delete_task', { id })).output).toMatchObject({ deleted: true });
    expect((await t.run('delete_task', { id })).isError).toBe(true);
  });
});

describe('note tools', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('create_note derives a title; search_notes returns excerpts and a valid list', async () => {
    const res = await t.run('create_note', { content: '# Trip to Lisbon\n\nPack the passport and sunscreen.' });
    expect(res.output).toMatchObject({ note: { title: 'Trip to Lisbon' } });
    await t.run('create_note', { title: 'x'.repeat(300), content: 'y'.repeat(5000) + ' passport' });
    const found = await t.run('search_notes', { query: 'passport' });
    const notes = (found.output as { notes: { excerpt: string }[] }).notes;
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.excerpt.length <= 201)).toBe(true);
    expectValidUi(found);
  });

  it('update_note append, delete_note naming and not-found errors', async () => {
    const res = await t.run('create_note', { title: 'Shopping', content: '- milk' });
    const id = (res.output as { note: { id: string } }).note.id;
    await t.run('update_note', { id, content: '- eggs', append: true });
    expect((await t.run('get_note', { id })).output).toMatchObject({ note: { content: '- milk\n- eggs' } });
    expect(t.registry.get('delete_note')!.describeCall!({ id })).toMatch(/Shopping/);
    expect((await t.run('delete_note', { id })).output).toMatchObject({ deleted: true });
    expect((await t.run('delete_note', { id })).isError).toBe(true);
    expect((await t.run('get_note', { id })).isError).toBe(true);
    expect((await t.run('update_note', { id, title: 'x' })).isError).toBe(true);
  });

  it.each(['', 'short', 'a'.repeat(50), 'a'.repeat(200)])('update_note refuses full-content replacement (%s)', async (content) => {
    const existing = t.stores.notes.create({ title: 'Keep me', content: 'a'.repeat(200), tags: ['original'] });
    const result = await t.run('update_note', { id: existing.id, content, title: 'Changed', tags: [] });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatch(/replace_note/);
    expect(t.stores.notes.get(existing.id)).toEqual(existing);
  });

  it('update_note preserves all existing content when appending or changing metadata', async () => {
    const existing = t.stores.notes.create({ title: 'Keep me', content: 'Important text\n\n  ', tags: [] });
    await t.run('update_note', { id: existing.id, title: 'New title', tags: ['saved'] });
    expect(t.stores.notes.get(existing.id)?.content).toBe(existing.content);
    await t.run('update_note', { id: existing.id, append: true, content: 'Addition' });
    expect(t.stores.notes.get(existing.id)).toMatchObject({ title: 'New title', tags: ['saved'], content: `${existing.content}\nAddition` });
  });

  it('replace_note requires confirmation and names the note before replacing all content', async () => {
    const existing = t.stores.notes.create({ title: 'Keep me', content: 'Important text', tags: ['saved'] });
    const tool = t.registry.get('replace_note');
    expect(tool).toMatchObject({ risk: 'dangerous', defaultPermission: 'confirm' });
    expect(t.registry.permissionFor('replace_note')).toBe('confirm');
    expect(tool?.describeCall?.({ id: existing.id, content: '' })).toMatch(/Keep me/);
    // The runtime obtains confirmation before it invokes registry.execute.
    const result = await t.run('replace_note', { id: existing.id, content: '' });
    expect(result.isError).toBeFalsy();
    expect(t.stores.notes.get(existing.id)).toMatchObject({ content: '', title: existing.title, tags: existing.tags });
  });
});

describe('memory tools', () => {
  it('flags outputs of remember, recall and forget when they carry sensitive memory text', async () => {
    const t = setup();
    const remembered = await t.run('remember', { content: 'Private atlas project', sensitivity: 'sensitive' }, { allowSensitive: true });
    expect(remembered.sensitive).toBe(true);
    const recalled = await t.run('recall', { query: 'atlas' }, { allowSensitive: true });
    expect(recalled.sensitive).toBe(true);
    const forgotten = await t.run('forget', { query: 'atlas' }, { allowSensitive: true });
    expect(forgotten.sensitive).toBe(true);
    expect(forgotten.output).toMatchObject({ forgotten: ['Private atlas project'] });
    const normal = await t.run('remember', { content: 'Likes tea' });
    expect(normal.sensitive).not.toBe(true);
    expect((await t.run('recall', { query: 'tea' })).sensitive).not.toBe(true);
  });

  it.each([false, true])('protects cached sensitive labels during forget when details are unavailable (allowed=%s)', async (allowSensitive) => {
    const t = setup();
    const remembered = await t.run('remember', { content: 'Private atlas project', sensitivity: 'sensitive' });
    const id = (remembered.output as { id: string }).id;
    t.mem.memory.get = async () => null;
    const forgotten = await t.run('forget', { ids: [id] }, { allowSensitive });
    expect(forgotten.output).toMatchObject({ forgotten: [allowSensitive ? 'Private atlas project' : '(a sensitive memory)'] });
    expect(forgotten.sensitive === true).toBe(allowSensitive);
  });

  it('remember: tool source with conversation id, memory card with pending status', async () => {
    const t = setup({ pending: true });
    const res = await t.run('remember', { content: 'The user is allergic to peanuts', label: 'Peanut allergy', kind: 'fact', importance: 0.9 });
    expect(t.mem.calls[0]).toMatchObject({ method: 'remember', args: { source: { by: 'tool', conversationId: 'conv_42' }, label: 'Peanut allergy' } });
    expectValidUi(res);
    expect(res.ui![0]).toMatchObject({ type: 'memory', nodes: [{ label: 'Peanut allergy', status: 'pending' }] });
    expect(res.output).toMatchObject({ status: 'pending' });
  });

  it('remember: long content still gives a valid card', async () => {
    const t = setup();
    expectValidUi(await t.run('remember', { content: 'z'.repeat(9000) }));
  });

  it('recall passes allowSensitive from the context', async () => {
    const t = setup();
    await t.run('remember', { content: 'Likes jazz' });
    const res = await t.run('recall', { query: 'music' }, { allowSensitive: true });
    expect(t.mem.calls.find((c) => c.method === 'recall')?.args).toMatchObject({ text: 'music', allowSensitive: true });
    expect((res.output as { memories: { reason: string }[] }).memories[0]).toMatchObject({ label: 'Likes jazz', reason: 'matches your message' });
    await t.run('recall', { query: 'music' });
    expect(t.mem.calls.filter((c) => c.method === 'recall')[1]?.args).toMatchObject({ allowSensitive: false });
  });

  it('recall answers that memory recall is turned off (a result, not an error) when policy.recall is false', async () => {
    const t = setup({ recall: false });
    await t.run('remember', { content: 'Likes jazz' });
    const res = await t.run('recall', { query: 'music' });
    expect(res.isError).toBeFalsy();
    expect(t.mem.calls.some((c) => c.method === 'recall')).toBe(false);
    expect(res.output).toMatchObject({ memories: [], note: expect.stringMatching(/memory recall is turned off/i) });
    expect(res.summary).toMatch(/turned off/i);
  });

  it('forget resolves a query through findForForget and returns the forgotten labels', async () => {
    const t = setup();
    await t.run('remember', { content: 'Lives in Berlin', label: 'Home city' });
    await t.run('remember', { content: 'Likes tea', label: 'Tea' });
    expect(t.registry.get('forget')!.describeCall!({ query: 'berlin' })).toMatch(/berlin/);
    const res = await t.run('forget', { query: 'berlin' });
    expect(t.mem.calls.find((c) => c.method === 'findForForget')).toBeTruthy();
    expect(res.output).toMatchObject({ forgotten: ['Home city'] });
    expect([...t.mem.nodes.values()].map((n) => n.label)).toEqual(['Tea']);
  });

  it('forget by ids names them in the confirmation and needs ids or a query', async () => {
    const t = setup();
    const r = await t.run('remember', { content: 'Likes tea', label: 'Tea' });
    const id = (r.output as { id: string }).id;
    expect(t.registry.get('forget')!.describeCall!({ ids: [id] })).toMatch(/Tea/);
    expect((await t.run('forget', {})).isError).toBe(true);
    expect((await t.run('forget', { ids: [id] }, { origin: 'ui' })).output).toMatchObject({ forgotten: ['Tea'] });
  });

  it('approve/reject are UI-only', async () => {
    const t = setup();
    expect((await t.run('approve_memory', { ids: ['mem_1'] })).isError).toBe(true);
    expect((await t.run('approve_memory', { ids: ['mem_1'] }, { origin: 'ui' })).isError).toBeFalsy();
    expect((await t.run('reject_memory', { ids: ['mem_1'] }, { origin: 'ui' })).isError).toBeFalsy();
  });
});

describe('render_ui', () => {
  const tool = (registry: ToolRegistry) => registry.get('render_ui')!;

  it('describes every block type compactly', () => {
    const { registry } = setup();
    const d = tool(registry).description;
    for (const type of UI_BLOCK_TYPES) expect(d, type).toContain(type);
    expect(d.length).toBeLessThan(4000);
  });

  it('has the loose spec schema (1-20 object blocks)', () => {
    const { registry } = setup();
    const schema = tool(registry).inputSchema;
    expect(schema.safeParse({ blocks: [] }).success).toBe(false);
    expect(schema.safeParse({ blocks: Array.from({ length: 21 }, () => ({ type: 'divider' })) }).success).toBe(false);
    expect(schema.safeParse({ blocks: ['text'] }).success).toBe(false);
  });

  it('valid blocks are shown and summarised as text; invalid ones are an error with the validation message', async () => {
    const { run } = setup();
    const ok = await run('render_ui', { blocks: [{ type: 'heading', text: 'Plan' }, { type: 'text', text: 'x'.repeat(3000) }] });
    expect(ok.isError).toBeFalsy();
    expect(ok.output).toMatchObject({ shown: true });
    expect((ok.output as { text: string }).text.length).toBeLessThanOrEqual(1000);
    expect(ok.ui).toHaveLength(2);
    const bad = await run('render_ui', { blocks: [{ type: 'chart', kind: 'bar' }] });
    expect(bad.isError).toBe(true);
    expect(errorOf(bad)).toMatch(/series/);
  });
});
