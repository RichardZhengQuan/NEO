import { fromJson, type Migration } from './db.js';

/** Tables owned by @neo/storage (namespace 'storage'). */
export const storageMigrations: Migration[] = [
  {
    version: 1,
    name: 'core tables',
    up: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT,
        incognito INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        system_prompt TEXT,
        toolset TEXT,
        last_message_at INTEGER,
        preview TEXT
      );
      CREATE INDEX conversations_by_update ON conversations (archived, pinned, updated_at DESC);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        turn_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        error TEXT,
        usage TEXT
      );
      CREATE INDEX messages_by_conversation ON messages (conversation_id, created_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        owner INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );

      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        device_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE provider_configs (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'message sensitivity',
    up: `ALTER TABLE messages ADD COLUMN sensitive INTEGER;`,
  },
  {
    // Separate from v2 so databases that already added the column still get the backfill.
    version: 3,
    name: 'message sensitivity backfill',
    up(db) {
      const memoryTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_nodes'").get();
      const normalIds = new Set(memoryTable
        ? (db.prepare("SELECT id FROM memory_nodes WHERE sensitivity = 'normal'").all() as { id: string }[]).map((row) => row.id)
        : []);
      const messages = db.prepare('SELECT id, conversation_id, role, parts FROM messages ORDER BY conversation_id, created_at, rowid').all() as {
        id: string; conversation_id: string; role: string; parts: string;
      }[];
      const markSensitive = db.prepare('UPDATE messages SET sensitive = 1 WHERE id = ?');
      const privateConversations = new Set<string>();
      for (const message of messages) {
        const parsed = fromJson<unknown>(message.parts, []);
        const parts = Array.isArray(parsed) ? parsed : [];
        const privateContent = parts.some((part: unknown) => {
          if (!part || typeof part !== 'object') return false;
          const p = part as Record<string, unknown>;
          if ((p.type === 'context' || p.type === 'tool_result') && p.sensitive === true) return true;
          if (p.type !== 'tool_result' || !p.output || typeof p.output !== 'object') return false;
          const output = p.output as Record<string, unknown>;
          if (p.name === 'remember') {
            if (typeof output.id === 'string') return !normalIds.has(output.id);
            return typeof output.label === 'string' && output.label.trim().length > 0;
          }
          // Deleted memories no longer carry a privacy classification; protect their old labels too.
          if (p.name === 'forget' && Array.isArray(output.forgotten)) {
            return output.forgotten.some((label: unknown) => typeof label === 'string' && label.trim().length > 0);
          }
          return p.name === 'recall' && Array.isArray(output.memories) && output.memories.some((memory: unknown) => {
            if (typeof memory === 'string') return memory.trim().length > 0;
            if (!memory || typeof memory !== 'object') return false;
            const item = memory as Record<string, unknown>;
            if (typeof item.id === 'string') return !normalIds.has(item.id);
            return [item.label, item.content].some((text) => typeof text === 'string' && text.trim().length > 0);
          });
        });
        // Later answers saw this history too. Keep the transcript bytes intact and backfill only its privacy flag.
        if (privateContent) privateConversations.add(message.conversation_id);
        if (message.role === 'assistant' && privateConversations.has(message.conversation_id)) {
          markSensitive.run(message.id);
        }
      }
    },
  },
];
