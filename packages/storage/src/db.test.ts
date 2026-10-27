import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase } from './db.js';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'neo-db-start-')); directories.push(dir); return join(dir, 'neo.db'); };
const release = (signal: Int32Array) => { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); };

it('retries an observed native WAL SQLITE_BUSY and restores normal connection policy', async () => {
  const path = file();
  const seed = new sqlite.DatabaseSync(path);
  seed.exec('CREATE TABLE lock_seed (value INTEGER); INSERT INTO lock_seed VALUES (1)');
  seed.close();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const holder = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.path);
    db.exec('BEGIN; SELECT * FROM lock_seed');
    parentPort.postMessage('read-lock-held');
    Atomics.wait(new Int32Array(workerData.signal), 0, 0, 10000);
    db.exec('ROLLBACK'); db.close();
  `, { eval: true, workerData: { path, signal: signal.buffer } });
  const exited = once(holder, 'exit');
  const nativeBusy: unknown[] = [];
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    expect((await once(holder, 'message'))[0]).toBe('read-lock-held');
    const original = sqlite.DatabaseSync.prototype.exec;
    vi.spyOn(sqlite.DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      try { return original.call(this, sql); }
      catch (error) {
        if (sql === 'PRAGMA journal_mode = WAL;' && (error as { errcode?: number }).errcode === 5) {
          nativeBusy.push(error);
          release(signal);
        }
        throw error;
      }
    });
    expect(() => { db = openDatabase(path); }).not.toThrow();
    expect(nativeBusy.length).toBeGreaterThan(0);
    expect(db!.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db!.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(db!.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 1 });
    expect(db!.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    db!.exec('INSERT INTO lock_seed VALUES (2)');
    expect(db!.prepare('SELECT value FROM lock_seed ORDER BY value').all()).toEqual([{ value: 1 }, { value: 2 }]);
  } finally {
    release(signal);
    db?.close();
    vi.restoreAllMocks();
    expect((await exited)[0]).toBe(0);
  }
}, 15000);

it('does not replay a migration callback from a stale pre-lock version snapshot', async () => {
  const path = file();
  const db = openDatabase(path);
  const first = { version: 1, name: 'seed', up: 'CREATE TABLE effects (value TEXT); INSERT INTO effects VALUES (\'history\')' };
  migrate(db, 'race', [first]);
  const originalReceipt = db.prepare('SELECT * FROM _migrations').all();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openDatabase, migrate } = await import(workerData.module);
      const db = openDatabase(workerData.path);
      const transaction = db.transaction.bind(db);
      let calls = 0;
      db.transaction = callback => {
        parentPort.postMessage({ type: 'before-begin' });
        Atomics.wait(new Int32Array(workerData.signal), 0, 0, 5000);
        return transaction(callback);
      };
      try {
        const result = migrate(db, 'race', [{ version: 2, name: 'once', up: () => { calls++; db.exec("INSERT INTO effects VALUES ('once')"); } }]);
        parentPort.postMessage({ type: 'result', applied: result.applied, calls });
      } catch (error) { parentPort.postMessage({ type: 'result', error: error.message, calls }); }
      finally { db.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, execArgv: ['--experimental-strip-types'], workerData: { path, signal: signal.buffer, module: new URL('./db.ts', import.meta.url).href } });
  const exited = once(worker, 'exit');
  try {
    expect((await once(worker, 'message'))[0]).toEqual({ type: 'before-begin' });
    const resultMessage = once(worker, 'message');
    expect(migrate(db, 'race', [{ version: 2, name: 'once', up: "INSERT INTO effects VALUES ('once')" }]).applied).toEqual([2]);
    release(signal);
    expect((await resultMessage)[0]).toEqual({ type: 'result', applied: [], calls: 0 });
    expect(db.prepare('SELECT value FROM effects ORDER BY rowid').all()).toEqual([{ value: 'history' }, { value: 'once' }]);
    expect(db.prepare('SELECT * FROM _migrations WHERE version = 1').all()).toEqual(originalReceipt);
    expect(db.prepare('SELECT version FROM _migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
  } finally { release(signal); db.close(); expect((await exited)[0]).toBe(0); }
}, 10000);

it('does not retry arbitrary migration failures and preserves earlier committed history', () => {
  const db = openDatabase(':memory:');
  let calls = 0;
  try {
    expect(() => migrate(db, 'atomic', [
      { version: 1, name: 'history', up: 'CREATE TABLE history (value TEXT); INSERT INTO history VALUES (\'retained\')' },
      { version: 2, name: 'fails', up: () => { calls++; db.exec('CREATE TABLE rolled_back (value TEXT); INSERT INTO missing_table VALUES (1)'); } },
    ])).toThrow('missing_table');
    expect(calls).toBe(1);
    expect(db.prepare('SELECT * FROM history').all()).toEqual([{ value: 'retained' }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'rolled_back'").all()).toEqual([]);
    expect(db.prepare('SELECT version FROM _migrations').all()).toEqual([{ version: 1 }]);
    expect(migrate(db, 'atomic', [{ version: 2, name: 'valid', up: 'CREATE TABLE valid (id INTEGER)' }]).applied).toEqual([2]);
  } finally { db.close(); }
});

it('closes the raw connection when initialization fails with a non-busy native error', () => {
  const path = file();
  writeFileSync(path, 'not a SQLite database');
  const close = vi.spyOn(sqlite.DatabaseSync.prototype, 'close');
  expect(() => openDatabase(path)).toThrow('not a database');
  expect(close).toHaveBeenCalledTimes(1);
});
