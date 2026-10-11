import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConsoleLogger } from '@neo/protocol';
import type { Logger } from '@neo/protocol';
import { generateServerIdentity, parseServerIdentity, serializeServerIdentity } from '@neo/tunnel';
import type { ServerIdentity } from '@neo/tunnel';

/** Keep the pinned server key stable for the lifetime of the data directory. */
export function loadOrCreateTunnelIdentity(dataDir: string, options: { inMemory?: boolean; logger?: Logger } = {}): ServerIdentity {
  if (options.inMemory) return generateServerIdentity();
  const path = join(dataDir, 'tunnel-identity.json');
  let stored: string | null = null;
  try {
    stored = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stored !== null) {
    try {
      const identity = parseServerIdentity(JSON.parse(stored));
      return identity;
    } catch (error) {
      const backup = `${path}.corrupt-${Date.now()}`;
      renameSync(path, backup);
      (options.logger ?? createConsoleLogger('warn')).warn('Corrupt tunnel identity was replaced. Paired phones will need to pair again.', { path: backup, error: String(error) });
    }
  }
  const identity = generateServerIdentity();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(serializeServerIdentity(identity)), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return identity;
}
