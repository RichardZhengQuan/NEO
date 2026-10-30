import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fixtureDir: string;
let previousArgv: string[];
let exited: Promise<string | number | null | undefined>;

beforeEach(() => {
  vi.doUnmock('@neo/server');
  vi.resetModules();
  // Reload the real loader with each CLI entry, so their NeoError identity is
  // shared. Only startup is mocked; inherited configuration is excluded.
  vi.doMock('@neo/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@neo/server')>();
    return {
      ...actual,
      loadConfig: (options: Parameters<typeof actual.loadConfig>[0]) => actual.loadConfig({ ...options, env: {} }),
      startServer: vi.fn(),
    };
  });
  fixtureDir = mkdtempSync(join(tmpdir(), 'neo-serve-invalid-config-'));
  previousArgv = process.argv;
  vi.stubEnv('NO_COLOR', '1');
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  exited = new Promise((resolve) => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      resolve(code);
      return undefined as never;
    });
  });
  vi.spyOn(process, 'on').mockReturnValue(process);
});

afterEach(() => {
  process.argv = previousArgv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('serve config-file diagnostics at the CLI entry', () => {
  it.each([
    ['bare address', '192.0.2.10'],
    ['URL form', 'https://user:URL_SECRET@example.test:7778/path?token=QUERY_SECRET'],
  ])('rejects %s before startup/data creation and prints only a safe host:port reason', async (_kind, address) => {
    const dataDir = join(fixtureDir, 'not-created');
    const configPath = join(fixtureDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      dataDir,
      tunnel: { advertise: [address] },
      server: { authToken: 'OWNER_TOKEN_SECRET_DO_NOT_PRINT' },
      webSearch: { apiKey: 'SEARCH_KEY_SECRET_DO_NOT_PRINT' },
      providers: [],
    }), { mode: 0o600 });
    process.argv = ['node', 'neo', 'serve', '--config', configPath];

    await import('../index.js');
    expect(await exited).toBe(1);

    const { startServer } = await import('@neo/server');
    const stderr = vi.mocked(process.stderr.write).mock.calls.map(([text]) => String(text)).join('');
    expect(stderr).toBe('  Error: Invalid configuration: tunnel.advertise: Each tunnel.advertise entry must be a host:port address\n');
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(existsSync(dataDir)).toBe(false);
    for (const secret of [address, configPath, dataDir, 'URL_SECRET', 'QUERY_SECRET', 'OWNER_TOKEN_SECRET_DO_NOT_PRINT', 'SEARCH_KEY_SECRET_DO_NOT_PRINT']) {
      expect(stderr).not.toContain(secret);
    }
    expect(stderr).not.toContain(' at ');
  });
});
