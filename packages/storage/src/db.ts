/**
 * Database access on Node's built-in `node:sqlite` (no native modules).
 * One file per NEO installation; WAL mode; foreign keys on.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
let sqlite: typeof import('node:sqlite') | undefined;

/** Load node:sqlite once, muting its one-time ExperimentalWarning. */
function loadSqlite(): typeof import('node:sqlite') {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqlite = require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface NeoDatabase {
  readonly raw: DatabaseSync;
  /** File path, or ':memory:'. */
  readonly path: string;
  exec(sql: string): void;
  /** Prepared statements are cached per SQL string. */
  prepare(sql: string): StatementSync;
  /** Run `fn` atomically. Nested calls use savepoints. Re-throws after rolling back. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(path: string): NeoDatabase {
  const { DatabaseSync } = loadSqlite();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') {
    raw.exec('PRAGMA journal_mode = WAL;');
    raw.exec('PRAGMA synchronous = NORMAL;');
  }
  const cache = new Map<string, StatementSync>();
  let depth = 0;

  const db: NeoDatabase = {
    raw,
    path,
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      let stmt = cache.get(sql);
      if (!stmt) {
        stmt = raw.prepare(sql);
        cache.set(sql, stmt);
      }
      return stmt;
    },
    transaction<T>(fn: () => T): T {
      const entryDepth = depth;
      const outer = entryDepth === 0;
      const savepoint = `sp_${entryDepth}`;
      raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      depth++;
      try {
        const result = fn();
        raw.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        try {
          raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        } catch (cleanupErr) {
          throw new AggregateError([err, cleanupErr], 'transaction cleanup failed', { cause: err });
        }
        throw err;
      } finally {
        depth = entryDepth;
      }
    },
    close() {
      cache.clear();
      if (raw.isOpen) raw.close();
    },
  };
  return db;
}

export interface Migration {
  version: number;
  name: string;
  up: string | ((db: NeoDatabase) => void);
}

/**
 * Apply pending migrations for one namespace (each package owns its own:
 * 'storage', 'memory', 'tools', …). Idempotent; each migration runs in a transaction.
 */
export function migrate(db: NeoDatabase, namespace: string, migrations: readonly Migration[]): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    namespace TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, version)
  )`);
  const done = new Set(
    (db.prepare('SELECT version FROM _migrations WHERE namespace = ?').all(namespace) as { version: number }[]).map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      if (typeof m.up === 'string') db.exec(m.up);
      else m.up(db);
      db.prepare('INSERT INTO _migrations (namespace, version, name, applied_at) VALUES (?, ?, ?, ?)').run(
        namespace,
        m.version,
        m.name,
        Date.now(),
      );
    });
    applied.push(m.version);
  }
  return { applied };
}

// ───────────────────────────── row helpers ─────────────────────────────

export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function fromJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const toBool = (v: unknown): boolean => v === 1 || v === 1n || v === true;
export const fromBool = (b: boolean | undefined | null): number => (b ? 1 : 0);
export const toNum = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
export const toNumOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : toNum(v));

/** Float32Array ⇄ BLOB. */
export function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function blobToVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Escape user text for an FTS5 MATCH: every token quoted, OR-ed. Returns null for empty input. */
export function ftsQuery(text: string): string | null {
  const tokens = text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 32);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
