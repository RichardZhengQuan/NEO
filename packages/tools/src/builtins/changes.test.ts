import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@neo/storage';
import { silentLogger, validateUIBlocks, type ChangeItem, type ToolContext, type ToolResult } from '@neo/protocol';
import { createProductivityStores, toolsMigrations } from '../stores/index.js';
import { createToolRegistry } from '../registry.js';
import { createChangeTools } from './changes.js';

const NOW = Date.UTC(2026, 9, 12, 8);
const TZ = 'Asia/Singapore';
const TOMORROW = Date.UTC(2026, 9, 13, 1);
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(timezone = TZ) {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db, 'tools', toolsMigrations);
  const stores = createProductivityStores(db, { clock: () => NOW, defaultTimezone: TZ });
  const registry = createToolRegistry();
  for (const tool of createChangeTools(stores)) registry.register(tool);
  const context: ToolContext = {
    toolCallId: 'tc_proposal', messageId: 'msg_proposal', conversationId: 'conv_proposal',
    signal: new AbortController().signal, now: () => NOW, timezone, locale: 'en-US',
    origin: 'model', allowSensitive: false, logger: silentLogger,
  };
  const run = (name: string, input: unknown, overrides: Partial<ToolContext> = {}) =>
    registry.execute({ id: 'tc_change', name, input }, { ...context, ...overrides });
  const propose = (changes: unknown[], extra: Record<string, unknown> = {}) => run('propose_changes', { changes, ...extra });
  const apply = (item: ChangeItem, overrides: Partial<ToolContext> = {}) => run('apply_change', { item }, { origin: 'ui', ...overrides });
  return { stores, registry, run, propose, apply };
}

function items(result: ToolResult): ChangeItem[] {
  expect(result.isError).not.toBe(true);
  const block = result.ui?.[0];
  if (block?.type !== 'changes') throw new Error('Expected a changes block.');
  return block.items;
}

describe('propose_changes', () => {
  it('snapshots exactly the changed fields and parses local times without changing stores', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Dentist', dueAt: NOW, priority: 1 });
    const reminder = h.stores.reminders.create({ title: 'Call mom', dueAt: NOW + 3_600_000 });
    const before = { task: h.stores.tasks.get(task.id), reminder: h.stores.reminders.get(reminder.id) };

    const result = await h.propose([
      { kind: 'task.update', taskId: task.id, due: 'tomorrow 9am', priority: 3, done: true, title: 'Dentist appointment' },
      { kind: 'reminder.update', reminderId: reminder.id, when: 'tomorrow 9am', title: 'Call parents' },
      { kind: 'reminder.create', title: 'Take documents', when: 'tomorrow 9am', notes: 'Passport' },
    ], { title: 'Tomorrow', note: 'Three concrete edits.' });

    const proposed = items(result);
    expect(proposed[0]).toMatchObject({
      kind: 'task.update', title: 'Dentist', taskId: task.id, status: 'pending',
      before: { dueAt: NOW, priority: 1, done: false, title: 'Dentist' },
      after: { dueAt: TOMORROW, priority: 3, done: true, title: 'Dentist appointment' },
    });
    expect(proposed[1]).toMatchObject({
      kind: 'reminder.update', title: 'Call mom', reminderId: reminder.id,
      before: { dueAt: reminder.dueAt, title: 'Call mom' }, after: { dueAt: TOMORROW, title: 'Call parents' },
    });
    expect(proposed[1]).not.toHaveProperty('before.timezone');
    expect(proposed[1]).not.toHaveProperty('after.timezone');
    expect(proposed[2]).toMatchObject({ kind: 'reminder.create', dueAt: TOMORROW, timezone: TZ, notes: 'Passport' });
    expect(result.ui?.[0]).toMatchObject({ type: 'changes', timezone: TZ, title: 'Tomorrow', note: 'Three concrete edits.' });
    expect(result.output).toMatchObject({ proposed: 3, changes: expect.any(Array) });
    expect(result.summary).toBe('Proposed 3 changes');
    expect({ task: h.stores.tasks.get(task.id), reminder: h.stores.reminders.get(reminder.id) }).toEqual(before);
    expect(h.stores.reminders.list()).toHaveLength(1);
    expect(validateUIBlocks(result.ui).ok).toBe(true);
  });

  it('produces UUID creation keys, unique item ids and valid long-title widgets', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'x'.repeat(1000) });
    const proposed = items(await h.propose([
      { kind: 'task.update', taskId: task.id, done: true },
      ...Array.from({ length: 19 }, (_, i) => ({ kind: 'reminder.create', title: `Reminder ${i}`, when: TOMORROW })),
    ]));
    expect(new Set(proposed.map((item) => item.id)).size).toBe(20);
    expect(proposed.every((item) => item.id.startsWith('chg_'))).toBe(true);
    expect(proposed[0]?.title).toHaveLength(500);
    const creates = proposed.filter((item) => item.kind === 'reminder.create');
    expect(new Set(creates.map((item) => item.creationKey)).size).toBe(19);
    for (const item of creates) expect(item.creationKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(validateUIBlocks([{ type: 'changes', items: proposed }]).ok).toBe(true);
  });

  it('drops no-op items and snapshots only requested fields, including clearing a due date', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Task', dueAt: NOW });
    const reminder = h.stores.reminders.create({ title: 'Reminder', dueAt: TOMORROW });
    const proposed = items(await h.propose([
      { kind: 'task.update', taskId: task.id, done: false },
      { kind: 'reminder.update', reminderId: reminder.id, when: TOMORROW, title: reminder.title },
      { kind: 'task.update', taskId: task.id, due: null },
    ]));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ before: { dueAt: NOW }, after: { dueAt: null } });
    const allNoOp = await h.propose([{ kind: 'task.update', taskId: task.id, title: ' Task ' }]);
    expect(allNoOp).toMatchObject({ isError: true, output: { code: 'bad_request', error: expect.stringContaining('Nothing would change') } });
  });

  it.each([
    { kind: 'task.update', taskId: 'task_missing', done: true },
    { kind: 'reminder.update', reminderId: 'rem_missing', title: 'Changed' },
  ])('explains how to find unknown ids for $kind', async (change) => {
    const result = await setup().propose([change]);
    expect(result).toMatchObject({ isError: true, output: { code: 'not_found', error: expect.stringMatching(/Use list_(tasks|reminders)/) } });
    expect(result.ui).toBeUndefined();
  });

  it('requires update fields, refuses unscheduled reminders and rejects past reminder times', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Task' });
    const reminder = h.stores.reminders.create({ title: 'Reminder', dueAt: TOMORROW });
    for (const change of [{ kind: 'task.update', taskId: task.id }, { kind: 'reminder.update', reminderId: reminder.id }]) {
      expect((await h.propose([change])).isError).toBe(true);
    }
    for (const change of [
      { kind: 'reminder.create', title: 'Past reminder', when: NOW - 60_001 },
      { kind: 'reminder.update', reminderId: reminder.id, when: NOW - 60_001 },
    ]) {
      expect(await h.propose([change])).toMatchObject({ isError: true, output: { code: 'bad_request', error: expect.stringMatching(/past/) } });
    }
    h.stores.reminders.complete(reminder.id);
    expect(await h.propose([{ kind: 'reminder.update', reminderId: reminder.id, title: 'New title' }])).toMatchObject({ isError: true, output: { code: 'conflict' } });
    expect(h.stores.reminders.list()).toHaveLength(1);
  });
});

describe('apply_change', () => {
  it('keeps the stored timezone for title-only edits proposed in a different timezone', async () => {
    const h = setup('America/New_York');
    const reminder = h.stores.reminders.create({ title: 'Call mom', dueAt: TOMORROW, timezone: 'America/Los_Angeles' });
    const item = items(await h.propose([{ kind: 'reminder.update', reminderId: reminder.id, title: 'Call parents' }]))[0]!;

    expect(item).not.toHaveProperty('before.timezone');
    expect(item).not.toHaveProperty('after.timezone');
    expect((await h.apply(item)).isError).not.toBe(true);
    expect(h.stores.reminders.get(reminder.id)).toMatchObject({ title: 'Call parents', timezone: 'America/Los_Angeles' });
  });

  it('records the proposing timezone and applies it to the stored reminder', async () => {
    const h = setup('America/New_York');
    const reminder = h.stores.reminders.create({ title: 'Call mom', dueAt: TOMORROW, timezone: 'America/Los_Angeles' });
    const dueAt = Date.UTC(2026, 9, 13, 13);
    const item = items(await h.propose([{ kind: 'reminder.update', reminderId: reminder.id, when: 'tomorrow 9am' }]))[0]!;

    expect.soft(item).toMatchObject({
      kind: 'reminder.update',
      before: { dueAt: reminder.dueAt, timezone: 'America/Los_Angeles' },
      after: { dueAt, timezone: 'America/New_York' },
    });
    expect(validateUIBlocks([{ type: 'changes', items: [item] }]).ok).toBe(true);
    expect(h.stores.reminders.get(reminder.id)?.timezone).toBe('America/Los_Angeles');
    expect((await h.apply(item)).isError).not.toBe(true);
    expect(h.stores.reminders.get(reminder.id)?.dueAt).toBe(dueAt);
    expect(h.stores.reminders.get(reminder.id)?.timezone).toBe('America/New_York');
  });

  it('applies every stored task field and returns a receipt plus the normal task output', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Task', dueAt: NOW, priority: 1 });
    const item = items(await h.propose([{ kind: 'task.update', taskId: task.id, title: 'Updated', due: null, priority: 3, done: true }]))[0]!;
    const result = await h.apply(item);
    expect(result.isError).not.toBe(true);
    expect(result.output).toMatchObject({ change: { id: item.id, status: 'applied' }, task: { id: task.id, title: 'Updated', dueAt: null, priority: 3, done: true, list: 'Inbox' } });
    expect(h.stores.tasks.get(task.id)).toMatchObject({ title: 'Updated', dueAt: null, priority: 3, done: true });
  });

  it('refuses changed and deleted tasks without applying the proposal', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Task', dueAt: NOW });
    const item = items(await h.propose([{ kind: 'task.update', taskId: task.id, due: TOMORROW }]))[0]!;
    h.stores.tasks.update(task.id, { dueAt: NOW + 1 });
    expect(await h.apply(item)).toMatchObject({ isError: true, output: { code: 'conflict', error: expect.stringMatching(/fresh plan/) } });
    expect(h.stores.tasks.get(task.id)?.dueAt).toBe(NOW + 1);
    h.stores.tasks.delete(task.id);
    expect(await h.apply(item)).toMatchObject({ isError: true, output: { code: 'not_found', error: expect.stringMatching(/deleted/) } });
  });

  it('checks only snapshotted fields, so unrelated task edits stay intact', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Task' });
    const item = items(await h.propose([{ kind: 'task.update', taskId: task.id, done: true }]))[0]!;
    h.stores.tasks.update(task.id, { notes: 'Keep these notes' });
    expect((await h.apply(item)).isError).not.toBe(true);
    expect(h.stores.tasks.get(task.id)).toMatchObject({ done: true, notes: 'Keep these notes' });
  });

  it('creates the same keyed reminder once across repeat attempts', async () => {
    const h = setup();
    const item = items(await h.propose([{ kind: 'reminder.create', title: 'Call mom', when: TOMORROW, notes: 'Say hello' }]))[0]!;
    const first = await h.apply(item);
    const second = await h.apply(item, { timezone: 'America/New_York' });
    expect(second.output).toEqual(first.output);
    expect(h.stores.reminders.list()).toHaveLength(1);
    const reminder = h.stores.reminders.list()[0]!;
    expect(first.output).toMatchObject({ change: { id: item.id, status: 'applied', reminderId: reminder.id }, reminder: { timezone: TZ, recurrence: null, notes: 'Say hello' } });
    expect(reminder.messageId).toBe('msg_proposal');
  });

  it('never recreates a deleted keyed reminder or reuses a key for changed values', async () => {
    const h = setup();
    const item = items(await h.propose([{ kind: 'reminder.create', title: 'Call mom', when: TOMORROW }]))[0]!;
    await h.apply(item);
    expect(await h.apply({ ...item, title: 'Changed payload' })).toMatchObject({ isError: true, output: { code: 'conflict', error: expect.stringMatching(/different values/) } });
    h.stores.reminders.delete(h.stores.reminders.list()[0]!.id);
    expect(await h.apply(item)).toMatchObject({ isError: true, output: { code: 'conflict', error: expect.stringMatching(/deleted reminder/) } });
    expect(h.stores.reminders.list()).toEqual([]);
  });

  it('rechecks reminder creation time at application using the shared tolerance', async () => {
    const h = setup();
    const item = items(await h.propose([{ kind: 'reminder.create', title: 'Call mom', when: TOMORROW }]))[0]!;
    expect(await h.apply(item, { now: () => TOMORROW + 60_001 })).toMatchObject({ isError: true, output: { code: 'bad_request', error: expect.stringMatching(/past/) } });
    expect(h.stores.reminders.list()).toEqual([]);
    expect((await h.apply(item, { now: () => TOMORROW + 60_000 })).isError).not.toBe(true);
  });

  it('applies reminder snapshots and rejects changed, unscheduled or deleted reminders', async () => {
    const h = setup();
    const reminder = h.stores.reminders.create({ title: 'Reminder', dueAt: TOMORROW });
    const item = items(await h.propose([{ kind: 'reminder.update', reminderId: reminder.id, title: 'Changed', when: TOMORROW + 3_600_000 }]))[0]!;
    expect(await h.apply(item)).toMatchObject({ output: { change: { id: item.id, status: 'applied' }, reminder: { id: reminder.id, title: 'Changed', dueAt: TOMORROW + 3_600_000 } } });
    expect(await h.apply(item)).toMatchObject({ isError: true, output: { code: 'conflict' } });
    const titleOnly = items(await h.propose([{ kind: 'reminder.update', reminderId: reminder.id, title: 'Again' }]))[0]!;
    h.stores.reminders.complete(reminder.id);
    expect(await h.apply(titleOnly)).toMatchObject({ isError: true, output: { code: 'conflict', error: expect.stringMatching(/fresh plan/) } });
    h.stores.reminders.delete(reminder.id);
    expect(await h.apply(titleOnly)).toMatchObject({ isError: true, output: { code: 'not_found' } });
  });

  it('cannot run from a model call and is absent from model tool specs', async () => {
    const h = setup();
    const task = h.stores.tasks.create({ title: 'Task' });
    const item = items(await h.propose([{ kind: 'task.update', taskId: task.id, done: true }]))[0]!;
    expect(await h.run('apply_change', { item })).toMatchObject({ isError: true, output: { error: expect.stringMatching(/app's controls/) } });
    expect(h.stores.tasks.get(task.id)?.done).toBe(false);
    expect(h.registry.specs().map((tool) => tool.name)).toEqual(['propose_changes']);
  });
});
