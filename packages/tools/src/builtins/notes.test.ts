import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NeoDatabase } from '@neo/storage';
import { silentLogger, validateUIBlocks, type ToolContext, type ToolResult } from '@neo/protocol';
import { createToolRegistry } from '../registry.js';
import { createProductivityStores, toolsMigrations } from '../stores/index.js';
import { createNoteTools } from './notes.js';

const context: ToolContext = {
  toolCallId: 'tc_notes', signal: new AbortController().signal, now: () => 0,
  timezone: 'UTC', locale: 'en-US', origin: 'model', allowSensitive: false, logger: silentLogger,
};

describe('note tool previews', () => {
  let db: NeoDatabase;
  let stores: ReturnType<typeof createProductivityStores>;
  let registry: ReturnType<typeof createToolRegistry>;
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db, 'tools', toolsMigrations);
    stores = createProductivityStores(db, { clock: () => 0, defaultTimezone: 'UTC' });
    registry = createToolRegistry();
    for (const tool of createNoteTools(stores)) registry.register(tool, 'builtin');
  });
  afterEach(() => db.close());
  const run = (name: string, input: unknown) => registry.execute({ id: context.toolCallId, name, input }, context);
  const expectPreview = (result: ToolResult, id: string, title: string, text: string) => {
    expect(result.isError).toBeFalsy();
    expect(result.ui).toEqual([{ type: 'card', title, children: [
      { type: 'text', text }, { type: 'link', title: 'Open note', url: `neo://notes/${id}` },
    ] }]);
    expect(validateUIBlocks(result.ui).ok).toBe(true);
  };

  it('creates a Markdown preview and keeps its brief model output', async () => {
    const result = await run('create_note', { content: '# Trip\n\nBring **passport**.' });
    const note = (result.output as { note: { id: string } }).note;
    expectPreview(result, note.id, 'Trip', '# Trip\n\nBring **passport**.');
    expect(note).not.toHaveProperty('content');
  });

  it.each(['create_note', 'get_note', 'update_note', 'replace_note'])('%s bounds long titles and content without truncating the stored note', async tool => {
    const title = 't'.repeat(300);
    const content = '# **Long note**\n\n' + 'word '.repeat(39990);
    const existing = tool === 'create_note' ? undefined : stores.notes.create({ title, content });
    const input = tool === 'create_note' ? { title, content } : tool === 'replace_note' ? { id: existing!.id, content } : { id: existing!.id };
    const result = await run(tool, input);
    const id = (result.output as { note: { id: string } }).note.id;
    const card = result.ui?.[0];
    expect(card?.type).toBe('card');
    if (card?.type !== 'card') throw new Error('Expected note card');
    expect(card.title).toBe('t'.repeat(199) + '…');
    const text = card.children?.[0];
    expect(text?.type).toBe('text');
    if (text?.type !== 'text') throw new Error('Expected Markdown excerpt');
    expect(text.text).toMatch(/^# \*\*Long note\*\*\n\n/);
    expect(text.text.length).toBeLessThanOrEqual(1000);
    expect(text.text).toMatch(/word…$/);
    expect(card.children?.[1]).toEqual({ type: 'link', title: 'Open note', url: `neo://notes/${id}` });
    expect(stores.notes.get(id)?.content).toBe(content);
    if (tool === 'get_note') expect(result.output).toMatchObject({ note: { title, content } });
    expect(validateUIBlocks(result.ui).ok).toBe(true);
  });

  it('uses the resulting content in update and replacement receipts, including empty notes', async () => {
    const note = stores.notes.create({ title: '', content: '- milk' });
    expectPreview(await run('update_note', { id: note.id, content: '- eggs', append: true, title: 'Shopping' }), note.id, 'Shopping', '- milk\n- eggs');
    expectPreview(await run('replace_note', { id: note.id, content: '**New list**' }), note.id, 'Shopping', '**New list**');
    expectPreview(await run('replace_note', { id: note.id, content: '' }), note.id, 'Shopping', '');
    const untitled = stores.notes.create({ title: '', content: '' });
    expectPreview(await run('get_note', { id: untitled.id }), untitled.id, '(untitled)', '');
  });

  it('gives each search result an Open action without changing model excerpts', async () => {
    const note = stores.notes.create({ title: 'Packing', content: 'Bring passport', tags: ['trip'] });
    const result = await run('search_notes', { query: 'passport' });
    expect(result.output).toMatchObject({ total: 1, notes: [{ id: note.id, excerpt: 'Bring passport' }] });
    expect(result.ui?.[0]).toMatchObject({ type: 'list', items: [{ id: note.id, action: { id: note.id, kind: 'link', label: 'Open', url: `neo://notes/${note.id}` } }] });
    expect(validateUIBlocks(result.ui).ok).toBe(true);
  });
});
