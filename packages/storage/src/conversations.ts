import {
  NeoError,
  newId,
  previewOf,
  systemClock,
  type Clock,
  type Conversation,
  type ConversationListQuery,
  type ConversationPatch,
  type ConversationStore,
  type Message,
  type MessagePatch,
  type NewConversation,
} from '@neo/protocol';
import { fromBool, fromJson, toBool, toJson, toNum, toNumOrNull, type NeoDatabase } from './db.js';

type Row = Record<string, unknown>;

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
  };
}

function toMessage(r: Row): Message {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    role: r.role as Message['role'],
    parts: fromJson(r.parts, []),
    createdAt: toNum(r.created_at),
    turnId: (r.turn_id as string | null) ?? null,
    model: fromJson(r.model, null),
    status: r.status as Message['status'],
    error: fromJson(r.error, null),
    usage: fromJson(r.usage, null),
  };
}

export function createConversationStore(db: NeoDatabase, options: { clock?: Clock } = {}): ConversationStore {
  const clock = options.clock ?? systemClock;

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

  return {
    list(query: ConversationListQuery = {}) {
      const where: string[] = ['archived = ?'];
      const args: (string | number)[] = [fromBool(query.archived ?? false)];
      if (query.before !== undefined) {
        where.push('updated_at < ?');
        args.push(query.before);
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

    create(input: NewConversation = {}) {
      const now = clock();
      const conv: Conversation = {
        id: newId('conv', now),
        title: input.title?.trim() || 'New conversation',
        createdAt: now,
        updatedAt: now,
        model: input.model ?? null,
        incognito: input.incognito ?? false,
        pinned: false,
        archived: false,
        systemPrompt: null,
        toolset: null,
        lastMessageAt: null,
        preview: null,
      };
      db.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, model, incognito, pinned, archived, system_prompt, toolset, last_message_at, preview)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, NULL)`,
      ).run(conv.id, conv.title, now, now, toJson(conv.model), fromBool(conv.incognito));
      return conv;
    },

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
      return next;
    },

    delete(id: string) {
      return db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
        return toNum(db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes) > 0;
      });
    },

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
          `INSERT INTO messages (id, conversation_id, role, parts, created_at, turn_id, model, status, error, usage)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
        const preview = previewOf(message.parts) || conv.preview;
        db.prepare('UPDATE conversations SET updated_at = ?, last_message_at = ?, preview = ? WHERE id = ?').run(
          Math.max(clock(), message.createdAt),
          message.createdAt,
          preview,
          conv.id,
        );
        return message;
      });
    },

    updateMessage(id: string, patch: MessagePatch) {
      const current = getMessage(id);
      if (!current) throw new NeoError('not_found', `Message ${id} not found.`);
      const next: Message = { ...current, ...patch };
      db.transaction(() => {
        db.prepare('UPDATE messages SET parts = ?, status = ?, error = ?, usage = ?, model = ? WHERE id = ?').run(
          JSON.stringify(next.parts),
          next.status,
          toJson(next.error),
          toJson(next.usage),
          toJson(next.model),
          id,
        );
        if (patch.parts) {
          const preview = previewOf(next.parts);
          if (preview) db.prepare('UPDATE conversations SET preview = ?, updated_at = ? WHERE id = ?').run(preview, clock(), next.conversationId);
        }
      });
      return next;
    },

    deleteMessage(id: string) {
      return toNum(db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes) > 0;
    },
  };
}
