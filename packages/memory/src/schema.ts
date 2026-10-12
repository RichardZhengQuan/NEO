/**
 * Database schema (migrations) for the memory net.
 * Namespace: 'memory'.
 */
import type { Migration } from '@neo/storage';
import { deleteNodes } from './db-helpers.js';
import { redactJournal } from './journal.js';

export const memoryMigrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        norm_label TEXT NOT NULL,
        content TEXT NOT NULL,
        entity_type TEXT,
        aliases TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        stability REAL NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        source TEXT NOT NULL,
        embedding_model TEXT,
        valid_until INTEGER,
        consolidated_at INTEGER,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_nodes_by_status ON memory_nodes (status, kind);
      CREATE INDEX IF NOT EXISTS memory_nodes_by_label ON memory_nodes (kind, norm_label);

      CREATE TABLE IF NOT EXISTS memory_vectors (
        node_id TEXT PRIMARY KEY REFERENCES memory_nodes (id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        src TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,
        dst TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        weight REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_reinforced_at INTEGER NOT NULL,
        coactivations INTEGER NOT NULL DEFAULT 0,
        UNIQUE (src, dst, type)
      );
      CREATE INDEX IF NOT EXISTS memory_edges_by_src ON memory_edges (src);
      CREATE INDEX IF NOT EXISTS memory_edges_by_dst ON memory_edges (dst);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (node_id UNINDEXED, label, content, aliases, tags);

      CREATE TABLE IF NOT EXISTS memory_journal (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        report TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'remove unapproved memories',
    up(db) {
      const nodes = db.prepare("SELECT id, label FROM memory_nodes WHERE status = 'pending'").all() as { id: string; label: string }[];
      deleteNodes(db, nodes.map((node) => node.id));
      redactJournal(db, nodes);
    },
  },
];
