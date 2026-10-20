import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadOrCreateKey } from './index.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

it('returns the persisted key to both concurrent creators and decrypts secrets encrypted by either', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-secrets-'));
  const p = join(dir, 'key');
  try {
    expect(existsSync(p)).toBe(false);
    const absent = vi.mocked(existsSync);
    absent.mockClear();
    // Synchronous calls cannot interleave in microtasks. Model both processes
    // observing absence before either writes, while keeping all I/O real.
    absent.mockReturnValueOnce(false).mockReturnValueOnce(false);
    const keys = await Promise.all([
      Promise.resolve().then(() => loadOrCreateKey(p)),
      Promise.resolve().then(() => loadOrCreateKey(p)),
    ]);
    expect(absent).toHaveBeenNthCalledWith(1, p);
    expect(absent).toHaveBeenNthCalledWith(2, p);

    const persisted = Buffer.from(readFileSync(p, 'utf8').trim(), 'base64');
    expect(persisted).toHaveLength(32);
    for (const key of keys) {
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key).toHaveLength(32);
      expect(key).toEqual(persisted);

      const value = 'a secret encrypted during startup';
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const decipher = createDecipheriv('aes-256-gcm', persisted, iv);
      decipher.setAuthTag(cipher.getAuthTag());
      expect(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')).toBe(value);
    }
  } finally {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('retries readFileSync when existsSync=true but file is initially empty (open→write race window)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-secrets-exist-race-'));
  const p = join(dir, 'key');
  try {
    // The winning process has already called open() so the file is visible, but
    // write() hasn't completed yet — the file is empty.
    writeFileSync(p, '', { mode: 0o600 });

    // Caller observes existsSync=true and takes the existsSync branch.
    vi.mocked(existsSync).mockReturnValueOnce(true);

    // Key that the winner will have written once write() completes.
    const winnerKey = randomBytes(32);
    const winnerContent = `${winnerKey.toString('base64')}\n`;

    // First readFileSync returns '' (race window); second returns the winner's key.
    vi.mocked(readFileSync).mockReturnValueOnce('').mockReturnValueOnce(winnerContent);

    const result = loadOrCreateKey(p);

    expect(result).toEqual(winnerKey);
    // The retry loop must have called readFileSync at least twice.
    expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('retries readFileSync after EEXIST when the file is initially empty (open→write race window)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-secrets-race-'));
  const p = join(dir, 'key');
  try {
    // Simulate the winning process: it has called open() (file exists) but has not
    // finished write() yet, so the file is empty.
    writeFileSync(p, '', { mode: 0o600 });

    // Loser sees the file absent (its existsSync ran before the winner opened it).
    vi.mocked(existsSync).mockReturnValueOnce(false);

    // Key that the winner will have written by the time the loser retries.
    const winnerKey = randomBytes(32);
    const winnerContent = `${winnerKey.toString('base64')}\n`;

    // First readFileSync in the retry loop returns '' (race window); second returns the winner's key.
    vi.mocked(readFileSync).mockReturnValueOnce('').mockReturnValueOnce(winnerContent);

    const result = loadOrCreateKey(p);

    expect(result).toEqual(winnerKey);
    // The retry loop must have called readFileSync at least twice.
    expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    rmSync(dir, { recursive: true, force: true });
  }
});
