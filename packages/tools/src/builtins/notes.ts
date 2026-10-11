/**
 * Note tools: create_note, search_notes, get_note, update_note, replace_note, delete_note.
 */
import { z } from 'zod';
import { NeoError, defineTool, type Note, type NotePatch, type ProductivityStores, type UIBlock } from '@neo/protocol';
import { clip } from './format.js';

const EXCERPT_CHARS = 200;

/** A title from the first meaningful line of Markdown ("# Trip to Lisbon" → "Trip to Lisbon"). */
function deriveTitle(content: string): string {
  const line = content.split('\n').map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*)/, '').trim()).find(Boolean) ?? '';
  return clip(line.replace(/[*_`]/g, ''), 80);
}

function excerpt(content: string): string {
  return clip(content.replace(/\s+/g, ' ').trim(), EXCERPT_CHARS);
}

export function createNoteTools(stores: ProductivityStores) {
  const { notes } = stores;
  const mustGet = (id: string): Note => {
    const n = notes.get(id);
    if (!n) throw new NeoError('not_found', `No note with id "${id}". Use search_notes to find it.`);
    return n;
  };
  const brief = (n: Note) => ({ id: n.id, title: n.title, tags: n.tags, pinned: n.pinned, updatedAt: n.updatedAt });
  const name = (n: Note) => (n.title ? `“${clip(n.title, 60)}”` : 'untitled note');

  const createNote = defineTool({
    name: 'create_note',
    title: 'Create note',
    description:
      'Save a Markdown note for the user (ideas, plans, lists, meeting notes, anything to keep). Without a title, the first ' +
      'line becomes the title. For things the user wants NEO itself to remember about them, use remember instead.',
    inputSchema: z.object({
      title: z.string().max(300).optional(),
      content: z.string().max(200_000).describe('Markdown content.'),
      tags: z.array(z.string().min(1).max(60)).max(30).optional(),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input) {
      const title = input.title?.trim() || deriveTitle(input.content);
      const note = notes.create({ title, content: input.content, tags: input.tags ?? [] });
      return { output: { note: brief(note) }, summary: `Saved note ${name(note)}` };
    },
  });

  const searchNotes = defineTool({
    name: 'search_notes',
    title: 'Search notes',
    description:
      'Find the user\'s notes by words in the title, text or tags (`query`) and/or by `tag`; without either it lists the most ' +
      'recent notes. Returns titles with a 200-character excerpt; use get_note to read one in full.',
    inputSchema: z.object({
      query: z.string().max(500).optional(),
      tag: z.string().max(60).optional(),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20.'),
    }),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(input) {
      const found = notes.list({ query: input.query, tag: input.tag, limit: input.limit ?? 20 });
      const items = found.map((n) => ({ ...brief(n), excerpt: excerpt(n.content) }));
      const ui: UIBlock[] = [
        {
          type: 'list',
          title: input.query ? clip(`Notes matching “${input.query}”`, 200) : input.tag ? clip(`Notes tagged “${input.tag}”`, 200) : 'Notes',
          items: items.map((n) => ({
            id: n.id,
            title: clip(n.title || '(untitled)', 300),
            ...(n.excerpt ? { subtitle: n.excerpt } : {}),
            icon: 'file-text',
            ...(n.tags.length ? { meta: clip(n.tags.join(', '), 100) } : {}),
          })),
        },
      ];
      return { output: { notes: items, total: items.length }, ui, summary: `${items.length} note${items.length === 1 ? '' : 's'} found` };
    },
  });

  const getNote = defineTool({
    name: 'get_note',
    title: 'Read note',
    description: 'Read a note in full by id (ids come from search_notes or create_note).',
    inputSchema: z.object({ id: z.string().min(1).max(64) }),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(input) {
      const note = mustGet(input.id);
      return { output: { note }, summary: `Read ${name(note)}` };
    },
  });

  const updateNote = defineTool({
    name: 'update_note',
    title: 'Update note',
    description:
      'Edit a note title or tags, or set `append: true` to add `content` at the end on a new line. Existing text is ' +
      'preserved. To rewrite, remove or replace any existing content, use replace_note, which asks for confirmation.',
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      title: z.string().max(300).optional(),
      content: z.string().max(200_000).optional(),
      append: z.boolean().optional().describe('Must be true when supplying `content`; replacements require replace_note.'),
      tags: z.array(z.string().min(1).max(60)).max(30).optional(),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input) {
      const existing = mustGet(input.id);
      if (input.append && input.content === undefined) throw new NeoError('bad_request', '`append` needs `content` to append.');
      if (input.content !== undefined && !input.append) {
        throw new NeoError('bad_request', 'Replacing note content requires replace_note and user confirmation. Use append: true to add content.');
      }
      const patch: NotePatch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.tags !== undefined) patch.tags = input.tags;
      if (input.content !== undefined) {
        patch.content = existing.content ? `${existing.content}\n${input.content}` : input.content;
      }
      const note = notes.update(existing.id, patch);
      return { output: { note: { ...brief(note), length: note.content.length } }, summary: `Updated ${name(note)}` };
    },
  });

  const replaceNote = defineTool({
    name: 'replace_note',
    title: 'Replace note content',
    description:
      'Replace the full Markdown content of a note by id, including edits that remove text or clear the note. ' +
      'The user is asked to confirm first. Use update_note for adding text or changing title and tags without replacing content.',
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      content: z.string().max(200_000).describe('Complete replacement Markdown content. Empty content clears the note.'),
    }),
    risk: 'dangerous',
    defaultPermission: 'confirm',
    describeCall: (input) => {
      const n = notes.get(input.id);
      return n ? `Replace all content of the note ${name(n)}` : `Replace all content of note ${input.id}`;
    },
    async execute(input) {
      const existing = mustGet(input.id);
      const note = notes.update(existing.id, { content: input.content });
      return { output: { note: { ...brief(note), length: note.content.length } }, summary: `Replaced content of ${name(note)}` };
    },
  });

  const deleteNote = defineTool({
    name: 'delete_note',
    title: 'Delete note',
    description: 'Permanently delete a note by id. The user is asked to confirm first, and it cannot be undone.',
    inputSchema: z.object({ id: z.string().min(1).max(64) }),
    risk: 'dangerous',
    defaultPermission: 'confirm',
    describeCall: (input) => {
      const n = notes.get(input.id);
      return n ? `Delete the note ${name(n)}` : `Delete note ${input.id}`;
    },
    async execute(input) {
      const note = mustGet(input.id);
      notes.delete(note.id);
      return { output: { deleted: true, id: note.id, title: note.title }, summary: `Deleted ${name(note)}` };
    },
  });

  return [createNote, searchNotes, getNote, updateNote, replaceNote, deleteNote];
}
