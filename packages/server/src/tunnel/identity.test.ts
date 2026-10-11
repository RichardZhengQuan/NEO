import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '@neo/protocol';
import { parseServerIdentity } from '@neo/tunnel';
import { loadOrCreateTunnelIdentity } from './identity.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'neo-tunnel-identity-'));
  directories.push(path);
  return path;
}

describe('tunnel identity', () => {
  it('persists one private identity atomically and reloads its keys', () => {
    const path = directory();
    const first = loadOrCreateTunnelIdentity(path);
    expect(loadOrCreateTunnelIdentity(path)).toEqual(first);
    expect(statSync(join(path, 'tunnel-identity.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(path)).toEqual(['tunnel-identity.json']);
    expect(parseServerIdentity(JSON.parse(readFileSync(join(path, 'tunnel-identity.json'), 'utf8')))).toEqual(first);
  });

  it('uses a fresh identity in memory without creating a directory', () => {
    const path = join(directory(), 'absent');
    const first = loadOrCreateTunnelIdentity(path, { inMemory: true });
    expect(loadOrCreateTunnelIdentity(path, { inMemory: true }).serverId).not.toBe(first.serverId);
    expect(existsSync(path)).toBe(false);
  });

  it.each(['{broken', '{"version":1,"dh":{},"signing":{}}'])('archives corrupt contents and warns about re-pairing', contents => {
    const path = directory();
    writeFileSync(join(path, 'tunnel-identity.json'), contents);
    const warn = vi.fn();
    const identity = loadOrCreateTunnelIdentity(path, { logger: { ...silentLogger, warn } });
    const backup = readdirSync(path).find(name => name.startsWith('tunnel-identity.json.corrupt-'));
    expect(backup).toBeDefined();
    expect(readFileSync(join(path, backup!), 'utf8')).toBe(contents);
    expect(loadOrCreateTunnelIdentity(path)).toEqual(identity);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Paired phones will need to pair again'), expect.any(Object));
  });
});
