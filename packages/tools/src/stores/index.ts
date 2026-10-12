/**
 * Productivity stores + migrations.
 * Namespace: 'tools'
 */
import type { Clock, ProductivityStores } from '@neo/protocol';
import { fromJson, type Migration, type NeoDatabase } from '@neo/storage';
import { createReminderStore } from './reminders.js';
import { createTaskStore } from './tasks.js';
import { createNoteStore } from './notes.js';
import { createNotificationStore } from './notifications.js';

export const toolsMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_reminders',
    up: `
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT,
        due_at INTEGER NOT NULL,
        anchor_at INTEGER NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        recurrence TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled',
        fired_count INTEGER NOT NULL DEFAULT 0,
        last_fired_at INTEGER,
        conversation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders(status, due_at);
    `,
  },
  {
    version: 2,
    name: 'create_task_lists_and_tasks',
    up: `
      CREATE TABLE IF NOT EXISTS task_lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        icon TEXT,
        "order" REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        notes TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        done_at INTEGER,
        due_at INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        "order" REAL NOT NULL DEFAULT 0,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done);
    `,
  },
  {
    version: 3,
    name: 'create_notes_fts',
    up: `
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title,
        content,
        content='notes',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
    `,
  },
  {
    version: 4,
    name: 'create_notifications',
    up: `
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read_at);
    `,
  },
  {
    // The spec'd schema (docs/TOOLS.md): the inbox comes from the migration, and
    // the notes index is keyed by note id (not the implicit rowid, which VACUUM
    // may renumber) and also indexes tags.
    version: 5,
    name: 'inbox_and_notes_fts_by_id',
    up: `
      INSERT OR IGNORE INTO task_lists (id, name, color, icon, "order", created_at)
        VALUES ('list_inbox', 'Inbox', NULL, 'inbox', 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

      DROP TRIGGER IF EXISTS notes_fts_insert;
      DROP TRIGGER IF EXISTS notes_fts_update;
      DROP TRIGGER IF EXISTS notes_fts_delete;
      DROP TABLE IF EXISTS notes_fts;

      CREATE VIRTUAL TABLE notes_fts USING fts5 (note_id UNINDEXED, title, content, tags);
      INSERT INTO notes_fts (note_id, title, content, tags)
        SELECT id, title, content, (SELECT group_concat(value, ' ') FROM json_each(notes.tags)) FROM notes;

      CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts (note_id, title, content, tags)
          VALUES (new.id, new.title, new.content, (SELECT group_concat(value, ' ') FROM json_each(new.tags)));
      END;
      CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
        DELETE FROM notes_fts WHERE note_id = old.id;
      END;
      CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, content, tags ON notes BEGIN
        DELETE FROM notes_fts WHERE note_id = old.id;
        INSERT INTO notes_fts (note_id, title, content, tags)
          VALUES (new.id, new.title, new.content, (SELECT group_concat(value, ' ') FROM json_each(new.tags)));
      END;
    `,
  },
  {
    version: 6,
    name: 'timeline_reminder_links',
    up(db) {
      db.exec('ALTER TABLE reminders ADD COLUMN message_id TEXT');
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()) db.exec(`
        UPDATE reminders SET message_id = COALESCE(
          (SELECT id FROM messages WHERE conversation_id = reminders.conversation_id AND created_at <= reminders.created_at
            ORDER BY created_at DESC, id DESC LIMIT 1),
          (SELECT id FROM messages WHERE conversation_id = reminders.conversation_id ORDER BY created_at, id LIMIT 1)
        ) WHERE conversation_id IS NOT NULL;
        UPDATE notifications SET data = json_set(json_remove(data, '$.conversationId'), '$.messageId', (
          SELECT id FROM messages WHERE conversation_id = json_extract(notifications.data, '$.conversationId')
          ORDER BY created_at DESC, id DESC LIMIT 1
        )) WHERE json_valid(data) AND json_extract(data, '$.conversationId') IS NOT NULL;
      `);
      const notifications = db.prepare(`
        SELECT id, data FROM notifications WHERE json_valid(data) AND (
          json_type(data, '$.messageId') = 'text' OR
          json_extract(data, '$.url') LIKE 'neo://chat/%' OR
          json_extract(data, '$.url') LIKE 'neo://conversations/%'
        )
      `).all() as { id: string; data: string }[];
      const updateNotification = db.prepare('UPDATE notifications SET data = ? WHERE id = ?');
      for (const notification of notifications) {
        const data = fromJson<Record<string, unknown>>(notification.data, {});
        if (typeof data.messageId === 'string' && data.messageId) data.url = `neo://timeline/${encodeURIComponent(data.messageId)}`;
        else delete data.url;
        updateNotification.run(JSON.stringify(data), notification.id);
      }
    },
  },
  {
    version: 7,
    name: 'reminder_creation_keys',
    up: `
      ALTER TABLE reminders ADD COLUMN creation_key TEXT;
      ALTER TABLE reminders ADD COLUMN creation_fingerprint TEXT;
      CREATE UNIQUE INDEX idx_reminders_creation_key ON reminders(creation_key) WHERE creation_key IS NOT NULL;
    `,
  },
];

export function createProductivityStores(
  db: NeoDatabase,
  options: { clock?: Clock; defaultTimezone?: string } = {},
): ProductivityStores {
  // Migrations are applied by the caller (migrate(db, 'tools', toolsMigrations)).
  return {
    reminders: createReminderStore(db, options),
    tasks: createTaskStore(db, { clock: options.clock }),
    notes: createNoteStore(db, { clock: options.clock }),
    notifications: createNotificationStore(db, { clock: options.clock }),
  };
}
