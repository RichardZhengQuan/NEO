import { fromJson, type Migration, type NeoDatabase } from './db.js';

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
  {
    version: 4,
    name: 'retire legacy default demo provider',
    up: retireLegacyDemoProvider,
  },
  {
    version: 5,
    name: 'continuous timeline episodes and message search',
    up: `
      ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'episode';
      ALTER TABLE conversations ADD COLUMN off_record INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN started_at INTEGER;
      ALTER TABLE conversations ADD COLUMN closed_at INTEGER;
      UPDATE conversations SET
        off_record = incognito,
        started_at = COALESCE((SELECT MIN(created_at) FROM messages WHERE conversation_id = conversations.id), created_at),
        last_message_at = (SELECT MAX(created_at) FROM messages WHERE conversation_id = conversations.id),
        closed_at = COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = conversations.id), updated_at);
      CREATE INDEX episodes_by_start ON conversations (started_at, id);
      CREATE INDEX ephemeral_episodes_by_start ON conversations (ephemeral, off_record, started_at);
      CREATE INDEX messages_by_time ON messages (created_at, id);

      CREATE VIRTUAL TABLE message_fts USING fts5(message_id UNINDEXED, text, tokenize = 'unicode61');
      INSERT INTO message_fts (rowid, message_id, text)
        SELECT messages.rowid, messages.id,
          COALESCE((SELECT group_concat(json_extract(value, '$.text'), '')
                    FROM json_each(messages.parts) WHERE json_extract(value, '$.type') = 'text'), '')
        FROM messages;
      CREATE TRIGGER message_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_fts (rowid, message_id, text) VALUES (new.rowid, new.id,
          COALESCE((SELECT group_concat(json_extract(value, '$.text'), '')
                    FROM json_each(new.parts) WHERE json_extract(value, '$.type') = 'text'), ''));
      END;
      CREATE TRIGGER message_fts_update AFTER UPDATE OF parts ON messages BEGIN
        DELETE FROM message_fts WHERE rowid = old.rowid;
        INSERT INTO message_fts (rowid, message_id, text) VALUES (new.rowid, new.id,
          COALESCE((SELECT group_concat(json_extract(value, '$.text'), '')
                    FROM json_each(new.parts) WHERE json_extract(value, '$.type') = 'text'), ''));
      END;
      CREATE TRIGGER message_fts_delete AFTER DELETE ON messages BEGIN
        DELETE FROM message_fts WHERE rowid = old.rowid;
      END;
    `,
  },
  {
    version: 6,
    name: 'persist timeline off-record state',
    up: `
      CREATE TABLE timeline_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        off_record_started_at INTEGER,
        private_episode_id TEXT REFERENCES conversations (id) ON DELETE SET NULL
      );
      INSERT INTO timeline_state (id, off_record_started_at, private_episode_id)
        VALUES (1, NULL, NULL);
      UPDATE timeline_state SET
        private_episode_id = (SELECT id FROM conversations
          WHERE off_record = 1 AND ephemeral = 1 AND closed_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1),
        off_record_started_at = (SELECT started_at FROM conversations
          WHERE off_record = 1 AND ephemeral = 1 AND closed_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1);
    `,
  },
  {
    version: 7,
    name: 'persist episode search mode',
    up: `ALTER TABLE conversations ADD COLUMN search_mode TEXT;`,
  },
];

/** Startup can retire orphan references after checking config-file providers as well. */
export function retireLegacyDemoProvider(db: NeoDatabase, retireOrphanReferences = false): void {
  const row = db.prepare('SELECT config FROM provider_configs WHERE id = ?').get('demo') as { config: string } | undefined;
  const parsedProvider = fromJson<unknown>(row?.config, null);
  const provider = parsedProvider && typeof parsedProvider === 'object' ? parsedProvider as Record<string, unknown> : {};
  const legacy = provider.id === 'demo' && provider.kind === 'mock';
  const preserveReferences = provider.id === 'demo' && provider.kind !== 'mock';
  if (legacy) db.prepare('DELETE FROM provider_configs WHERE id = ?').run('demo');
  const pointsAtDemo = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const ref = value as Record<string, unknown>;
    return !preserveReferences && ref.provider === 'demo' && (legacy || retireOrphanReferences);
  };
  const settings = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string } | undefined;
  const parsedSettings = fromJson<unknown>(settings?.value, null);
  const value = parsedSettings && typeof parsedSettings === 'object' ? parsedSettings as Record<string, unknown> : {};
  let changed = false;
  for (const key of ['defaultModel', 'memoryModel', 'titleModel', 'embedding']) {
    if (!pointsAtDemo(value[key])) continue;
    value[key] = null;
    changed = true;
  }
  if (changed) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(value), 'settings');
  const conversations = db.prepare('SELECT id, model FROM conversations WHERE model IS NOT NULL').all() as { id: string; model: string }[];
  for (const conversation of conversations) {
    if (pointsAtDemo(fromJson(conversation.model, null))) db.prepare('UPDATE conversations SET model = NULL WHERE id = ?').run(conversation.id);
  }
  // Historical message models and parts remain byte-identical for replay.
}
