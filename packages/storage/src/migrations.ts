import type { Migration } from './db.js';

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
];
