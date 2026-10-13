import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NeoDatabase } from '@neo/storage';
import { silentLogger, validateUIBlocks, type ToolContext } from '@neo/protocol';
import { createToolRegistry } from '../registry.js';
import { createProductivityStores, toolsMigrations } from '../stores/index.js';
import { createReminderTools } from './reminders.js';

const NOW = Date.UTC(2026, 9, 13, 0);
const context: ToolContext = {
  toolCallId: 'tc_reminders', signal: new AbortController().signal, now: () => NOW,
  timezone: 'UTC', locale: 'en-US', origin: 'model', allowSensitive: false, logger: silentLogger,
};

describe('reminder tool widgets', () => {
  let db: NeoDatabase;
  let stores: ReturnType<typeof createProductivityStores>;
  let registry: ReturnType<typeof createToolRegistry>;
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db, 'tools', toolsMigrations);
    stores = createProductivityStores(db, { clock: () => NOW, defaultTimezone: 'UTC' });
    registry = createToolRegistry();
    for (const tool of createReminderTools(stores)) registry.register(tool, 'builtin');
  });
  afterEach(() => db.close());
  const run = (name: string, input: unknown) => registry.execute({ id: context.toolCallId, name, input }, context);

  it('returns separate top-level reminder widgets in due order with unchanged output', async () => {
    const later = stores.reminders.create({ title: 'Later', dueAt: NOW + 120_000, timezone: 'UTC', notes: 'Bring the receipt' });
    const sooner = stores.reminders.create({ title: 'Sooner', dueAt: NOW + 60_000, timezone: 'UTC' });
    const result = await run('list_reminders', {});
    expect(result.output).toMatchObject({ total: 2, reminders: [{ id: sooner.id, notes: null }, { id: later.id, notes: 'Bring the receipt' }] });
    expect(result.ui).toEqual([
      { type: 'reminder', reminderId: sooner.id, title: 'Sooner', dueAt: sooner.dueAt, timezone: 'UTC', status: 'scheduled' },
      { type: 'reminder', reminderId: later.id, title: 'Later', notes: 'Bring the receipt', dueAt: later.dueAt, timezone: 'UTC', status: 'scheduled' },
    ]);
    expect(validateUIBlocks(result.ui).ok).toBe(true);
  });

  it('caps widgets at ten and links to all returned reminders without capping model output', async () => {
    for (let i = 0; i < 12; i++) stores.reminders.create({ title: `Reminder ${i}`, dueAt: NOW + (i + 1) * 60_000, timezone: 'UTC' });
    const result = await run('list_reminders', {});
    expect(result.output).toMatchObject({ total: 12 });
    expect((result.output as { reminders: unknown[] }).reminders).toHaveLength(12);
    expect(result.ui?.slice(0, 10).every(block => block.type === 'reminder')).toBe(true);
    expect(result.ui).toHaveLength(11);
    expect(result.ui?.[10]).toEqual({ type: 'link', title: 'Show all 12 reminders', url: 'neo://reminders' });
    expect(validateUIBlocks(result.ui).ok).toBe(true);
    const limited = await run('list_reminders', { limit: 10 });
    expect(limited.ui).toHaveLength(10);
    expect(limited.ui?.every(block => block.type === 'reminder')).toBe(true);
  });

  it('returns no widgets for an empty list', async () => {
    const result = await run('list_reminders', {});
    expect(result.output).toEqual({ reminders: [], total: 0 });
    expect(result.ui ?? []).toEqual([]);
    expect(result.summary).toBe('No upcoming reminders');
  });

  it('includes non-null reminder notes, including empty strings and the store limit', async () => {
    const created = await run('create_reminder', { title: 'Call', when: NOW + 60_000, notes: 'x'.repeat(5000) });
    expect(created.ui?.[0]).toMatchObject({ type: 'reminder', notes: 'x'.repeat(5000) });
    expect(validateUIBlocks(created.ui).ok).toBe(true);
    const id = (created.output as { reminder: { id: string } }).reminder.id;
    expect((await run('update_reminder', { id, notes: '' })).ui?.[0]).toMatchObject({ notes: '' });
    expect((await run('update_reminder', { id, notes: null })).ui?.[0]).not.toHaveProperty('notes');
  });
});
