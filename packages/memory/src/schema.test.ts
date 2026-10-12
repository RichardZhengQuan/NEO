import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryNode } from '@neo/protocol';
import { migrate, openNeoDatabase, vectorToBlob, type NeoDatabase } from '@neo/storage';
import { addEdge, insertNode } from './db-helpers.js';
import { memoryMigrations } from './schema.js';

const T0 = 1_700_000_000_000;

function seed(db: NeoDatabase): void {
  migrate(db, 'memory', memoryMigrations.slice(0, 1));
  for (const id of ['mem_active', 'mem_other', 'mem_pending', 'mem_pending_entity']) {
    const node: MemoryNode = {
      id, kind: id.endsWith('entity') ? 'entity' : 'fact', label: id, content: `Content of ${id}`,
      aliases: [], tags: [], importance: 0.7, confidence: 0.9, stability: 30,
      accessCount: 0, lastAccessedAt: null, createdAt: T0, updatedAt: T0,
      status: 'active', pinned: false, sensitivity: 'normal', source: { by: 'extraction' },
      embeddingModel: 'hash2-2',
    };
    insertNode(db, node);
    db.prepare('INSERT INTO memory_vectors (node_id, model, dims, vector) VALUES (?, ?, ?, ?)')
      .run(id, 'hash2-2', 2, vectorToBlob(new Float32Array([1, 0])));
  }
  db.prepare("UPDATE memory_nodes SET status = 'pending' WHERE id IN (?, ?)").run('mem_pending', 'mem_pending_entity');
  addEdge(db, 'mem_active', 'mem_other', 'related', 0.7, T0);
  addEdge(db, 'mem_active', 'mem_pending', 'related', 0.5, T0);
  addEdge(db, 'mem_pending', 'mem_other', 'supersedes', 1, T0);
  addEdge(db, 'mem_pending', 'mem_pending_entity', 'about', 0.8, T0);
  db.prepare('INSERT INTO memory_journal (id, started_at, finished_at, report) VALUES (?, ?, ?, ?)').run('cons_old', T0, T0, JSON.stringify({
    id: 'cons_old', startedAt: T0, finishedAt: T0, factsCreated: 2,
    notes: ['Learned: mem_pending (from 2 conversations)', 'Learned: mem_active (from 2 conversations)'],
    noteRefs: { 0: ['mem_pending'], 1: ['mem_active'] },
  }));
}

describe('memory migration v2', () => {
  it.each([true, false])('hard-deletes unapproved rows and their indexes with foreign_keys=%s', (foreignKeys) => {
    const db = openNeoDatabase(':memory:');
    try {
      db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
      seed(db);
      const activeRows = db.prepare("SELECT * FROM memory_nodes WHERE status = 'active' ORDER BY id").all();
      const activeVectors = db.prepare("SELECT * FROM memory_vectors WHERE node_id IN ('mem_active', 'mem_other') ORDER BY node_id").all();
      const activeFts = db.prepare("SELECT * FROM memory_fts WHERE node_id IN ('mem_active', 'mem_other') ORDER BY node_id").all();
      const activeEdges = db.prepare("SELECT * FROM memory_edges WHERE src = 'mem_active' AND dst = 'mem_other'").all();

      expect(migrate(db, 'memory', memoryMigrations).applied).toEqual([2]);
      expect(db.prepare('SELECT * FROM memory_nodes ORDER BY id').all()).toEqual(activeRows);
      expect(db.prepare('SELECT * FROM memory_vectors ORDER BY node_id').all()).toEqual(activeVectors);
      expect(db.prepare('SELECT * FROM memory_fts ORDER BY node_id').all()).toEqual(activeFts);
      expect(db.prepare('SELECT * FROM memory_edges').all()).toEqual(activeEdges);
      const journal = JSON.parse((db.prepare('SELECT report FROM memory_journal').get() as { report: string }).report) as {
        factsCreated: number; notes: string[]; noteRefs: Record<string, string[]>;
      };
      expect(journal.factsCreated).toBe(2);
      expect(journal.notes).toEqual(['Learned something you later asked me to forget (from 2 conversations)', 'Learned: mem_active (from 2 conversations)']);
      expect(journal.noteRefs).toEqual({ 1: ['mem_active'] });
      expect(migrate(db, 'memory', memoryMigrations).applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps the completed migration and surviving memories intact after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-memory-migration-'));
    const path = join(dir, 'neo.db');
    let db = openNeoDatabase(path);
    try {
      seed(db);
      migrate(db, 'memory', memoryMigrations);
      const surviving = db.prepare('SELECT * FROM memory_nodes ORDER BY id').all();
      db.close();
      db = openNeoDatabase(path);
      expect(migrate(db, 'memory', memoryMigrations).applied).toEqual([]);
      expect(db.prepare('SELECT * FROM memory_nodes ORDER BY id').all()).toEqual(surviving);
      expect(db.prepare("SELECT id FROM memory_nodes WHERE status = 'pending'").all()).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
