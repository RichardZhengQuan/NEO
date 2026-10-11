/**
 * NoteStore: Markdown notes with full-text search.
 *
 * Search uses the FTS5 index `notes_fts (note_id, title, content, tags)`, kept in
 * sync by triggers (migration 5) and ranked by bm25. FTS5's unicode61 tokenizer
 * does not segment CJK text (a whole Chinese sentence is one token), so queries
 * containing CJK characters, or with only one-letter terms, use substring
 * matching instead.
 */
import { NeoError, NoteInputSchema, NotePatchSchema, newId, type Clock, type Note, type NoteInput, type NotePatch, type NoteStore } from '@neo/protocol';
import { fromJson, ftsQuery, toBool, toJson, toNum, type NeoDatabase } from '@neo/storage';
import { changes, clampLimit, likePattern, parseInput } from './validate.js';

type Row = Record<string, unknown>;
type ChangeEvent = { type: 'upsert'; note: Note } | { type: 'delete'; id: string };

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

function toNote(r: Row): Note {
  return {
    id: r.id as string,
    title: (r.title as string) ?? '',
    content: (r.content as string) ?? '',
    tags: fromJson(r.tags, []),
    pinned: toBool(r.pinned),
    createdAt: toNum(r.created_at),
    updatedAt: toNum(r.updated_at),
  };
}

export function createNoteStore(db: NeoDatabase, options: { clock?: Clock } = {}): NoteStore {
  const clock = options.clock ?? (() => Date.now());
  const listeners = new Set<(event: ChangeEvent) => void>();

  const emit = (event: ChangeEvent) => {
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the mutation that already happened.
      }
    }
  };

  const get = (id: string): Note | null => {
    const r = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined;
    return r ? toNote(r) : null;
  };
  const mustGet = (id: string): Note => {
    const n = get(id);
    if (!n) throw new NeoError('not_found', `Note ${id} not found.`);
    return n;
  };

  return {
    list(query: { query?: string; tag?: string; limit?: number } = {}): Note[] {
      const limit = clampLimit(query.limit, 100, 500);
      const where: string[] = [];
      const args: (string | number)[] = [];
      const tag = query.tag?.trim();
      if (tag) {
        where.push('EXISTS (SELECT 1 FROM json_each(n.tags) t WHERE lower(t.value) = lower(?))');
        args.push(tag);
      }
      const text = query.query?.trim();
      if (text) {
        const fts = CJK.test(text) ? null : ftsQuery(text);
        if (fts) {
          const sql = `SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.note_id
            WHERE notes_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
            ORDER BY bm25(notes_fts, 0.0, 10.0, 1.0, 5.0) ASC, n.updated_at DESC LIMIT ?`;
          return (db.prepare(sql).all(fts, ...args, limit) as Row[]).map(toNote);
        }
        const terms = text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
        if (!terms.length) return [];
        for (const term of terms) {
          where.push("(n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\' OR n.tags LIKE ? ESCAPE '\\')");
          const p = likePattern(term);
          args.push(p, p, p);
        }
      }
      const sql = `SELECT n.* FROM notes n${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
        ORDER BY n.pinned DESC, n.updated_at DESC LIMIT ?`;
      return (db.prepare(sql).all(...args, limit) as Row[]).map(toNote);
    },

    get,

    create(input: NoteInput): Note {
      const data = parseInput(NoteInputSchema, input, 'note');
      const now = clock();
      const note: Note = {
        id: newId('note', now),
        title: (data.title ?? '').trim(),
        content: data.content,
        tags: data.tags ?? [],
        pinned: data.pinned ?? false,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare('INSERT INTO notes (id, title, content, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        note.id, note.title, note.content, toJson(note.tags), note.pinned ? 1 : 0, now, now,
      );
      emit({ type: 'upsert', note });
      return note;
    },

    update(id: string, patch: NotePatch): Note {
      const data = parseInput(NotePatchSchema, patch, 'note update');
      const existing = mustGet(id);
      const now = clock();
      const updated: Note = {
        ...existing,
        title: data.title !== undefined ? data.title.trim() : existing.title,
        content: data.content ?? existing.content,
        tags: data.tags ?? existing.tags,
        pinned: data.pinned ?? existing.pinned,
        updatedAt: now,
      };
      db.prepare('UPDATE notes SET title = ?, content = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?').run(
        updated.title, updated.content, toJson(updated.tags), updated.pinned ? 1 : 0, now, id,
      );
      emit({ type: 'upsert', note: updated });
      return updated;
    },

    delete(id: string): boolean {
      if (changes(db.prepare('DELETE FROM notes WHERE id = ?').run(id)) === 0) return false;
      emit({ type: 'delete', id });
      return true;
    },

    onChange(listener: (event: ChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
