import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStore } from '@neo/protocol';
import type { NeoDatabase } from './db.js';

/**
 * Load the 32-byte master key from `path`, creating it (mode 0600) on first use.
 * The key file lives next to the database in the data directory; back them up together.
 */
export function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Invalid key file at ${path} (expected 32 bytes base64).`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  try {
    writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort on platforms without POSIX modes
    }
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // writeFileSync 'wx' makes the file visible at open() before write() completes;
    // a concurrent loser receiving EEXIST may read an empty or partial file.
    // Retry for up to 50 × 1 ms (50 ms total) to cover the open→write window.
    for (let attempt = 0; attempt < 50; attempt++) {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw.length > 0) {
        const existing = Buffer.from(raw, 'base64');
        if (existing.length !== 32) throw new Error(`Invalid key file at ${path} (expected 32 bytes base64).`);
        return existing;
      }
      // 1 ms pause. In worker threads Atomics.wait provides a true sleep;
      // on the main thread it throws, so fall back to a busy-spin.
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      } catch {
        const end = Date.now() + 1;
        while (Date.now() < end) { /* spin */ }
      }
    }
    throw new Error(`Invalid key file at ${path} (expected 32 bytes base64).`);
  }
}

/** Secrets (API keys entered in the app) encrypted at rest with AES-256-GCM. */
export function createSecretStore(db: NeoDatabase, key: Uint8Array): SecretStore {
  if (key.length !== 32) throw new Error('Secret store key must be 32 bytes.');
  return {
    get(name) {
      const row = db.prepare('SELECT iv, tag, data FROM secrets WHERE name = ?').get(name) as
        | { iv: Uint8Array; tag: Uint8Array; data: Uint8Array }
        | undefined;
      if (!row) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.data), decipher.final()]).toString('utf8');
    },
    set(name, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(name));
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      db.prepare(
        `INSERT INTO secrets (name, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = excluded.updated_at`,
      ).run(name, iv, cipher.getAuthTag(), data, Date.now());
    },
    delete(name) {
      return Number(db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes) > 0;
    },
    list() {
      return (db.prepare('SELECT name FROM secrets ORDER BY name').all() as { name: string }[]).map((r) => r.name);
    },
  };
}
