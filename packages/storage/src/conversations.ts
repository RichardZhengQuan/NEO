import {
  NeoError,
  newId,
  previewOf,
  systemClock,
  ToolUseQuerySchema,
  type Clock,
  type Conversation,
  type ConversationListQuery,
  type ConversationPatch,
  type ConversationStore,
  type Message,
  type MessagePatch,
  type NewConversation,
  type OffRecordState,
  type TimelineMessage,
  type TimelinePage,
  type TimelineQuery,
  type TimelineSearchSnippet,
  type ToolCallPart,
  type ToolResultPart,
  type ToolUseQuery,
} from '@neo/protocol';
import { fromBool, fromJson, toBool, toJson, toNum, toNumOrNull, type NeoDatabase } from './db.js';
import { describeToolUse } from './tool-uses.js';

type Row = Record<string, unknown>;

const snippetStart = '\uE000';
const snippetEnd = '\uE001';

function toSearchSnippet(marked: string, start: string, end: string): TimelineSearchSnippet {
  const snippet: TimelineSearchSnippet = { text: '', highlights: [] };
  let cursor = 0;
  for (;;) {
    const from = marked.indexOf(start, cursor);
    if (from === -1) {
      snippet.text += marked.slice(cursor);
      return snippet;
    }
    snippet.text += marked.slice(cursor, from);
    const to = marked.indexOf(end, from + start.length);
    if (to === -1) throw new Error('Unbalanced FTS snippet markers.');
    const highlightStart = snippet.text.length;
    snippet.text += marked.slice(from + start.length, to);
    snippet.highlights.push([highlightStart, snippet.text.length]);
    cursor = to + end.length;
  }
}

function toConversation(r: Row): Conversation {
  return {
    id: r.id as string,
    title: r.title as string,
    createdAt: toNum(r.created_at),
    updatedAt: toNum(r.updated_at),
    model: fromJson(r.model, null),
    incognito: toBool(r.incognito),
    pinned: toBool(r.pinned),
    archived: toBool(r.archived),
    systemPrompt: (r.system_prompt as string | null) ?? null,
    toolset: fromJson(r.toolset, null),
    lastMessageAt: toNumOrNull(r.last_message_at),
    preview: (r.preview as string | null) ?? null,
    kind: 'episode',
    offRecord: toBool(r.off_record ?? r.incognito),
    ephemeral: toBool(r.ephemeral),
    startedAt: toNum(r.started_at ?? r.created_at),
    closedAt: toNumOrNull(r.closed_at),
    searchMode: (r.search_mode as 'native' | 'engine' | 'off') || undefined,
  };
}

function toMessage(r: Row): Message {
  const msg: Message = {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    episodeId: r.conversation_id as string,
    role: r.role as Message['role'],
    parts: fromJson(r.parts, []),
    createdAt: toNum(r.created_at),
    turnId: (r.turn_id as string | null) ?? null,
    model: fromJson(r.model, null),
    status: r.status as Message['status'],
    error: fromJson(r.error, null),
    usage: fromJson(r.usage, null),
  };
  if (r.sensitive) msg.sensitive = true;
  return msg;
}

export function createConversationStore(db: NeoDatabase, options: { clock?: Clock } = {}): ConversationStore & Required<Pick<ConversationStore, 'toolUses'>> {
  const clock = options.clock ?? systemClock;
  const offRecordState = (): OffRecordState => {
    const row = db.prepare('SELECT off_record_started_at, private_episode_id FROM timeline_state WHERE id = 1').get() as Row;
    const startedAt = toNumOrNull(row.off_record_started_at);
    return { active: startedAt !== null, episodeId: (row.private_episode_id as string | null) ?? null, startedAt };
  };
  // Migration fixtures also use this store against older versions of its tables.
  const hasEpisodes = () => (db.prepare('PRAGMA table_info(conversations)').all() as Row[]).some((column) => column.name === 'started_at');

  const get = (id: string): Conversation | null => {
    const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    return r ? toConversation(r) : null;
  };
  const mustGet = (id: string): Conversation => {
    const c = get(id);
    if (!c) throw new NeoError('not_found', `Conversation ${id} not found.`);
    return c;
  };
  const getMessage = (id: string): Message | null => {
    const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  };
  const closeEpisode = (id: string): Conversation => {
    const current = mustGet(id);
    if (current.closedAt === null || current.closedAt === undefined) {
      db.prepare('UPDATE conversations SET closed_at = ?, updated_at = ? WHERE id = ?').run(clock(), clock(), id);
    }
    return mustGet(id);
  };
  const latestPreview = (episodeId: string): string | null => {
    const rows = db.prepare(
      'SELECT parts FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC',
    ).iterate(episodeId);
    for (const row of rows) {
      const preview = previewOf(fromJson(row.parts, [])) || null;
      if (preview) return preview;
    }
    return null;
  };
  const refreshEpisodePreview = (episodeId: string): void => {
    const row = db.prepare(
      'SELECT created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(episodeId) as Row | undefined;
    db.prepare('UPDATE conversations SET preview = ?, last_message_at = ?, updated_at = ? WHERE id = ?')
      .run(latestPreview(episodeId), row ? toNum(row.created_at) : null, clock(), episodeId);
  };
  const refreshEpisodePreviewOnly = (episodeId: string): void => {
    db.prepare('UPDATE conversations SET preview = ?, updated_at = ? WHERE id = ?')
      .run(latestPreview(episodeId), clock(), episodeId);
  };
  const create = (input: NewConversation = {}): Conversation => {
    const now = clock();
    const id = newId('conv', now);
    const title = input.title?.trim() || 'New conversation';
    const incognito = input.incognito ?? input.offRecord ?? false;
    if (hasEpisodes()) {
      db.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, model, incognito, off_record, ephemeral, started_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, title, now, now, toJson(input.model), fromBool(incognito), fromBool(input.offRecord ?? incognito), fromBool(input.ephemeral), now, input.closedAt ?? null);
    } else {
      db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, model, incognito) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, title, now, now, toJson(input.model), fromBool(incognito));
    }
    return mustGet(id);
  };
  const deleteEpisode = (id: string): boolean => db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    return toNum(db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes) > 0;
  });

  const order = '(c.started_at, c.rowid, m.created_at, m.rowid)';
  const ascending = 'c.started_at, c.rowid, m.created_at, m.rowid';
  const descending = 'c.started_at DESC, c.rowid DESC, m.created_at DESC, m.rowid DESC';
  const joined = 'FROM messages m JOIN conversations c ON c.id = m.conversation_id';
  const cursorOf = (row: Row): string => Buffer.from(JSON.stringify([
    toNum(row.episode_start), toNum(row.episode_row), toNum(row.created_at), toNum(row.message_row),
  ])).toString('base64url');
  const timeline = (query: TimelineQuery = {}): TimelinePage => {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), 500);
    const select = `SELECT m.*, c.started_at AS episode_start, c.rowid AS episode_row, m.rowid AS message_row, c.off_record ${joined}`;
    let rows: Row[];
    let hasOlder: boolean;
    if (query.around !== undefined) {
      if (query.before !== undefined) throw new NeoError('bad_request', 'Use either before or around.');
      let anchor = db.prepare(`${select} WHERE m.id = ?`).get(query.around) as Row | undefined;
      if (!anchor) {
        const instant = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(query.around) ? Date.parse(query.around) : NaN;
        if (!Number.isFinite(instant)) throw new NeoError('not_found', 'Timeline message not found.');
        anchor = db.prepare(`${select} ORDER BY ABS(m.created_at - ?), ${ascending} LIMIT 1`).get(instant) as Row | undefined;
      }
      if (!anchor) return { items: [], episodes: [], nextCursor: null };
      const position = toNum((db.prepare(`SELECT COUNT(*) AS n ${joined} WHERE ${order} < (?, ?, ?, ?)`)
        .get(toNum(anchor.episode_start), toNum(anchor.episode_row), toNum(anchor.created_at), toNum(anchor.message_row)) as Row).n);
      const total = toNum((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as Row).n);
      const offset = Math.max(0, Math.min(position - Math.floor(limit / 2), total - limit));
      rows = db.prepare(`${select} ORDER BY ${ascending} LIMIT ? OFFSET ?`).all(limit, offset) as Row[];
      hasOlder = offset > 0;
    } else {
      let where = '';
      let args: number[] = [];
      if (query.before !== undefined) {
        try {
          const parsed: unknown = JSON.parse(Buffer.from(query.before, 'base64url').toString());
          if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every((value) => typeof value === 'number' && Number.isFinite(value))) throw new Error();
          args = parsed as number[];
        } catch {
          throw new NeoError('bad_request', 'Invalid timeline cursor.');
        }
        where = ` WHERE ${order} < (?, ?, ?, ?)`;
      }
      rows = db.prepare(`${select}${where} ORDER BY ${descending} LIMIT ?`).all(...args, limit + 1) as Row[];
      hasOlder = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    }
    const episodes: TimelinePage['episodes'] = [];
    for (const row of rows) {
      const first = db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT 1').get(row.conversation_id as string) as Row;
      if (first.id === row.id) episodes.push({ episodeId: row.conversation_id as string, startedAt: toNum(row.episode_start), offRecord: toBool(row.off_record) });
    }
    return {
      items: rows.map((row) => toMessage(row) as TimelineMessage),
      episodes,
      nextCursor: hasOlder && rows.length ? cursorOf(rows[0]!) : null,
    };
  };

  const rangeQuery = (range: { from?: number; to?: number }): { clause: string; args: number[] } => {
    const where: string[] = [];
    const args: number[] = [];
    if (range.from !== undefined) { where.push('created_at >= ?'); args.push(range.from); }
    if (range.to !== undefined) { where.push('created_at <= ?'); args.push(range.to); }
    return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
  };

  const messagesInRange = (range: { from?: number; to?: number }): Message[] => {
    const { clause, args } = rangeQuery(range);
    return (db.prepare(`SELECT * FROM messages${clause} ORDER BY created_at, rowid`).all(...args) as Row[]).map(toMessage);
  };

  return {
    list(query: ConversationListQuery = {}) {
      const where: string[] = ['archived = ?'];
      const args: (string | number)[] = [fromBool(query.archived ?? false)];
      if (query.before !== undefined) {
        if (query.beforePinned !== undefined) {
          const cp = fromBool(query.beforePinned);
          where.push('(pinned < ? OR (pinned = ? AND updated_at < ?))');
          args.push(cp, cp, query.before);
        } else {
          where.push('updated_at < ?');
          args.push(query.before);
        }
      }
      if (query.query?.trim()) {
        where.push("(title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')");
        const like = `%${query.query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        args.push(like, like);
      }
      const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 500);
      const sql = `SELECT * FROM conversations WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ${limit}`;
      return (db.prepare(sql).all(...args) as Row[]).map(toConversation);
    },

    get,

    create,

    update(id: string, patch: ConversationPatch) {
      const current = mustGet(id);
      const next: Conversation = { ...current, ...patch, updatedAt: clock() };
      db.prepare(
        `UPDATE conversations SET title = ?, updated_at = ?, model = ?, pinned = ?, archived = ?, system_prompt = ?, toolset = ?,
           last_message_at = ?, preview = ? WHERE id = ?`,
      ).run(
        next.title,
        next.updatedAt,
        toJson(next.model),
        fromBool(next.pinned),
        fromBool(next.archived),
        next.systemPrompt,
        toJson(next.toolset),
        next.lastMessageAt,
        next.preview,
        id,
      );
      if (hasEpisodes() && patch.closedAt !== undefined) db.prepare('UPDATE conversations SET closed_at = ? WHERE id = ?').run(patch.closedAt, id);
      if (hasEpisodes() && patch.searchMode !== undefined) db.prepare('UPDATE conversations SET search_mode = ? WHERE id = ?').run(patch.searchMode, id);
      return next;
    },

    delete: deleteEpisode,

    messages(conversationId: string, options: { limit?: number; before?: number } = {}) {
      const args: (string | number)[] = [conversationId];
      let where = 'conversation_id = ?';
      if (options.before !== undefined) {
        where += ' AND created_at < ?';
        args.push(options.before);
      }
      if (options.limit !== undefined) {
        const rows = db
          .prepare(`SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ${Math.max(1, Math.floor(options.limit))}`)
          .all(...args) as Row[];
        return rows.reverse().map(toMessage);
      }
      return (db.prepare(`SELECT * FROM messages WHERE ${where} ORDER BY created_at ASC, rowid ASC`).all(...args) as Row[]).map(toMessage);
    },

    getMessage,

    appendMessage(message: Message) {
      return db.transaction(() => {
        const conv = mustGet(message.conversationId);
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, parts, created_at, turn_id, model, status, error, usage, sensitive)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          message.id,
          message.conversationId,
          message.role,
          JSON.stringify(message.parts),
          message.createdAt,
          message.turnId ?? null,
          toJson(message.model),
          message.status,
          toJson(message.error),
          toJson(message.usage),
          message.sensitive ? 1 : null,
        );
        const preview = previewOf(message.parts) || conv.preview;
        db.prepare('UPDATE conversations SET updated_at = ?, last_message_at = ?, preview = ? WHERE id = ?').run(
          Math.max(clock(), message.createdAt),
          message.createdAt,
          preview,
          conv.id,
        );
        return { ...message, episodeId: message.conversationId };
      });
    },

    updateMessage(id: string, patch: MessagePatch) {
      const current = getMessage(id);
      if (!current) throw new NeoError('not_found', `Message ${id} not found.`);
      const next: Message = { ...current, ...patch };
      db.transaction(() => {
        db.prepare('UPDATE messages SET parts = ?, status = ?, error = ?, usage = ?, model = ?, sensitive = ? WHERE id = ?').run(
          JSON.stringify(next.parts),
          next.status,
          toJson(next.error),
          toJson(next.usage),
          toJson(next.model),
          next.sensitive ? 1 : null,
          id,
        );
        if (patch.parts) refreshEpisodePreviewOnly(next.conversationId);
      });
      return next;
    },

    deleteMessage(id: string) {
      return db.transaction(() => {
        const message = getMessage(id);
        if (!message) return false;
        if (hasEpisodes()) closeEpisode(message.conversationId);
        const deleted = toNum(db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes) > 0;
        if (deleted) refreshEpisodePreview(message.conversationId);
        return deleted;
      });
    },

    currentEpisode() {
      const row = db.prepare('SELECT * FROM conversations WHERE closed_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as Row | undefined;
      return row ? toConversation(row) : null;
    },

    latestEpisode() {
      const row = db.prepare('SELECT * FROM conversations ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as Row | undefined;
      return row ? toConversation(row) : null;
    },

    createEpisode(input: { offRecord?: boolean } = {}) {
      return db.transaction(() => {
        const now = clock();
        db.prepare('UPDATE conversations SET closed_at = ? WHERE closed_at IS NULL').run(now);
        return create({ offRecord: input.offRecord ?? false, ephemeral: input.offRecord ?? false });
      });
    },

    closeEpisode,

    offRecordState,

    setOffRecordState(state: OffRecordState) {
      db.prepare('UPDATE timeline_state SET off_record_started_at = ?, private_episode_id = ? WHERE id = 1')
        .run(state.active ? state.startedAt : null, state.active ? state.episodeId : null);
    },

    purgeOffRecord(before: number) {
      return db.transaction(() => {
        const state = offRecordState();
        const expired = state.active && state.startedAt !== null && state.startedAt < before;
        const rows = db.prepare('SELECT id FROM conversations WHERE off_record = 1 AND ephemeral = 1 AND started_at < ?')
          .all(expired ? Number.MAX_SAFE_INTEGER : before) as Row[];
        for (const row of rows) deleteEpisode(row.id as string);
        if (expired) db.prepare('UPDATE timeline_state SET off_record_started_at = NULL, private_episode_id = NULL WHERE id = 1').run();
        return rows.length;
      });
    },

    offRecordEpisodes(before = Number.MAX_SAFE_INTEGER) {
      return (db.prepare('SELECT * FROM conversations WHERE off_record = 1 AND ephemeral = 1 AND started_at < ? ORDER BY started_at, rowid').all(before) as Row[]).map(toConversation);
    },

    timeline,

    searchMessages(query: string, limit = 50) {
      const tokens = query.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}_\p{M}]+/u).filter(Boolean).slice(0, 32);
      if (!tokens.length) return [];
      const match = tokens.map((token) => `"${token}"`).join(' OR ');
      return (db.prepare(
        `SELECT m.id, m.conversation_id, m.created_at, message_fts.rowid AS fts_rowid, message_fts.text AS source_text,
           snippet(message_fts, 1, ?, ?, '…', 24) AS snippet
         FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid
         WHERE message_fts MATCH ? ORDER BY bm25(message_fts), m.created_at DESC, m.rowid DESC LIMIT ?`,
      ).all(snippetStart, snippetEnd, match, Math.min(Math.max(Math.floor(limit), 1), 500)) as Row[]).map((row) => {
        let start = snippetStart;
        let end = snippetEnd;
        let marked = row.snippet as string;
        const source = row.source_text as string;
        if (source.includes(start) || source.includes(end)) {
          // Preserve literal private-use characters too. Different leading/trailing
          // characters prevent a delimiter from overlapping adjacent source text.
          let salt = 0;
          do {
            start = `${snippetStart}${salt}\uE002`;
            end = `${snippetEnd}${salt}\uE002`;
            salt++;
          } while (source.includes(start) || source.includes(end));
          marked = (db.prepare(
            `SELECT snippet(message_fts, 1, ?, ?, '…', 24) AS snippet
             FROM message_fts WHERE message_fts MATCH ? AND rowid = ?`,
          ).get(start, end, match, row.fts_rowid as number) as Row).snippet as string;
        }
        return {
          messageId: row.id as string,
          episodeId: row.conversation_id as string,
          createdAt: toNum(row.created_at),
          snippet: toSearchSnippet(marked, start, end),
        };
      });
    },

    messagesInRange,

    toolUses(query: ToolUseQuery = {}) {
      const parsed = ToolUseQuerySchema.safeParse(query);
      if (!parsed.success) throw new NeoError('bad_request', 'Invalid tool-use range or limit.');
      const { from, to, limit = 100 } = parsed.data;
      const where = ["m.role = 'assistant'", 'c.off_record = 0', 'c.incognito = 0'];
      const args: number[] = [];
      if (from !== undefined) { where.push('m.created_at >= ?'); args.push(from); }
      if (to !== undefined) { where.push('m.created_at <= ?'); args.push(to); }
      // The existing messages_by_time index bounds the messages before JSON expansion.
      // Results belong to this assistant message and must follow their matching call.
      // A reused call id cannot accidentally borrow a later call's result.
      const rows = db.prepare(`
        SELECT m.id, m.created_at, m.sensitive, call.key AS part_index, call.value AS tool_call, result.value AS tool_result
        FROM messages m INDEXED BY messages_by_time
        JOIN conversations c ON c.id = m.conversation_id
        JOIN json_each(m.parts) call ON json_extract(call.value, '$.type') = 'tool_call'
        JOIN json_each(m.parts) result ON result.key = (
          SELECT candidate.key FROM json_each(m.parts) candidate
          WHERE candidate.key > call.key
            AND json_extract(candidate.value, '$.type') = 'tool_result'
            AND json_extract(candidate.value, '$.toolCallId') = json_extract(call.value, '$.id')
            AND json_extract(candidate.value, '$.name') = json_extract(call.value, '$.name')
            AND NOT EXISTS (
              SELECT 1 FROM json_each(m.parts) next_call
              WHERE next_call.key > call.key AND next_call.key < candidate.key
                AND json_extract(next_call.value, '$.type') = 'tool_call'
                AND json_extract(next_call.value, '$.id') = json_extract(call.value, '$.id')
            )
          ORDER BY candidate.key LIMIT 1
        )
        WHERE ${where.join(' AND ')} AND COALESCE(json_extract(result.value, '$.isError'), 0) = 0
        ORDER BY m.created_at DESC, m.id DESC, call.key DESC LIMIT ?
      `).all(...args, limit) as Row[];
      return rows.reverse().map((row) => describeToolUse(
        row.id as string, toNum(row.created_at), toNum(row.part_index),
        fromJson<ToolCallPart>(row.tool_call, {} as ToolCallPart),
        fromJson<ToolResultPart>(row.tool_result, {} as ToolResultPart), toBool(row.sensitive),
      ));
    },

    deleteRange(range: { from?: number; to?: number }) {
      return db.transaction(() => {
        const { clause, args } = rangeQuery(range);
        const messages = messagesInRange(range);
        const episodeIds = new Set(messages.map((message) => message.conversationId));
        for (const id of episodeIds) closeEpisode(id);
        db.prepare(`DELETE FROM messages${clause}`).run(...args);
        for (const id of episodeIds) refreshEpisodePreview(id);
        return messages;
      });
    },
  };
}
