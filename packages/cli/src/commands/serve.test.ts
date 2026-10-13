import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, startServer } from '@neo/server';
import QRCode from 'qrcode';
import { runServe } from './serve.js';

vi.mock('@neo/server', () => ({ loadConfig: vi.fn(), startServer: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toString: vi.fn() } }));

const ownerToken = 'PERMANENT_OWNER_SECRET';
const stdoutTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '1');
  vi.mocked(QRCode.toString).mockImplementation(() => Promise.resolve('OWNER_TOKEN_QR'));
  vi.mocked(startServer).mockResolvedValue({
    url: 'http://127.0.0.1:7777',
    ownerToken,
    stop: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof startServer>>);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  // The server is mocked and the unresolved keep-alive promise owns no resources.
  vi.spyOn(process, 'on').mockReturnValue(process);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  if (stdoutTTYDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutTTYDescriptor);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
});

async function startup(mode: 'local' | 'server', isTTY: boolean, showToken = false): Promise<string> {
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTTY });
  vi.mocked(loadConfig).mockReturnValue({
    mode,
    dataDir: '/test/neo',
    server: { publicUrl: 'https://neo.example.com' },
  } as ReturnType<typeof loadConfig>);
  let startupError: unknown;
  void runServe({ mode, showToken, dataDir: '/test/neo' }).catch((error: unknown) => {
    startupError = error;
  });
  await vi.waitFor(() => {
    expect(startupError).toBeUndefined();
    expect(process.stdout.write).toHaveBeenCalled();
  });
  return vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join('');
}

describe('serve startup owner-token disclosure', () => {
  it.each([false, true])('server startup suppresses owner token and QR without --show-token (TTY=%s)', async (isTTY) => {
    const banner = await startup('server', isTTY);
    expect(banner).toContain('✦ NEO');
    expect(banner).toContain('run `neo pair` to add a device');
    expect(banner).not.toContain(ownerToken);
    expect(banner).not.toContain('OWNER_TOKEN_QR');
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('server startup shows owner token and pairing QR with --show-token', async () => {
    const banner = await startup('server', false, true);
    expect(banner).toContain(ownerToken);
    expect(banner).toContain('OWNER_TOKEN_QR');
    expect(QRCode.toString).toHaveBeenCalledWith(expect.stringContaining(ownerToken), expect.any(Object));
  });

  it('local startup suppresses the owner token when stdout is captured', async () => {
    const banner = await startup('local', false);
    expect(banner).not.toContain(ownerToken);
  });

  it('local startup shows the owner token on an interactive TTY', async () => {
    const banner = await startup('local', true);
    expect(banner).toContain(ownerToken);
  });

  it('local startup shows the owner token with --show-token when stdout is captured', async () => {
    const banner = await startup('local', false, true);
    expect(banner).toContain(ownerToken);
  });
});

describe('serve data directory configuration', () => {
  it('config-file dataDir: loadConfig is called without a dataDir override when only --config is given', async () => {
    vi.stubEnv('NEO_DATA_DIR', '');
    vi.mocked(loadConfig).mockReturnValue({
      mode: 'local',
      dataDir: '/from/config/file',
      server: {},
    } as ReturnType<typeof loadConfig>);
    void runServe({ config: '/some/config.json' }).catch(() => {/* ignore keep-alive */});
    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalled());
    const callArgs = vi.mocked(loadConfig).mock.calls[0]![0]!;
    expect(callArgs.overrides?.dataDir).toBeUndefined();
    expect(callArgs.path).toBe('/some/config.json');
  });

  it('leaves NEO_DATA_DIR to loadConfig when no --data-dir flag is given', async () => {
    vi.stubEnv('NEO_DATA_DIR', '/from/env');
    vi.mocked(loadConfig).mockReturnValue({
      mode: 'local',
      dataDir: '/from/env',
      server: {},
    } as ReturnType<typeof loadConfig>);
    void runServe({ config: '/some/config.json' }).catch(() => {/* ignore keep-alive */});
    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalled());
    const callArgs = vi.mocked(loadConfig).mock.calls[0]![0]!;
    expect(callArgs.overrides?.dataDir).toBeUndefined();
  });

  it('expands an explicit --data-dir flag into an override ahead of NEO_DATA_DIR', async () => {
    vi.stubEnv('NEO_DATA_DIR', '/from/env');
    vi.mocked(loadConfig).mockReturnValue({
      mode: 'local',
      dataDir: homedir(),
      server: {},
    } as ReturnType<typeof loadConfig>);
    void runServe({ config: '/some/config.json', dataDir: '~' }).catch(() => {/* ignore keep-alive */});
    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalled());
    const callArgs = vi.mocked(loadConfig).mock.calls[0]![0]!;
    expect(callArgs.overrides?.dataDir).toBe(homedir());
  });
});
