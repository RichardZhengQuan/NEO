import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoApiError } from '@neo/client';
import { runDoctor } from './doctor.js';

const client = vi.hoisted(() => ({
  health: vi.fn(),
  providers: { list: vi.fn(), test: vi.fn() },
}));
vi.mock('@neo/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@neo/client')>(),
  NeoClient: vi.fn(function () { return client; }),
}));

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'neo-doctor-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ providers: [] }));
  client.health.mockReset().mockResolvedValue({ name: 'NEO', version: 'test', mode: 'local' });
  client.providers.list.mockReset().mockResolvedValue({ items: [] });
  client.providers.test.mockReset();
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Unexpected failure exit'); });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('doctor without an AI provider', () => {
  it('runDoctor does not follow a symlink at the old predictable test-file path', async () => {
    if (process.platform === 'win32') return;
    const sentinelPath = join(dataDir, 'sentinel.txt');
    const sentinelContent = 'sentinel-content';
    writeFileSync(sentinelPath, sentinelContent);
    symlinkSync(sentinelPath, join(dataDir, '.neo-doctor-test'));

    await runDoctor({ dataDir });

    expect(readFileSync(sentinelPath, 'utf8')).toBe(sentinelContent);
  });

  it.each([{ items: [] }, { items: [
    { id: 'test', kind: 'mock', enabled: true },
    { id: 'off', kind: 'ollama', enabled: false },
  ] }])('reports a warning without failing for unusable providers: %j', async ({ items }) => {
    client.providers.list.mockResolvedValue({ items });
    await runDoctor({ dataDir, server: 'http://fixture.test', token: 'fixture-token' });
    const output = vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain('! Providers');
    expect(output).toContain('no AI provider configured');
    expect(output).toContain('All checks passed.');
    expect(process.exit).not.toHaveBeenCalled();
    expect(client.providers.test).not.toHaveBeenCalled();
  });

  it('reports a provider-list failure as a failed check', async () => {
    client.providers.list.mockRejectedValue(new Error('401 Unauthorized'));
    vi.mocked(process.exit).mockImplementation(() => { throw new Error('exit(1) called'); });
    await expect(runDoctor({ dataDir, server: 'http://fixture.test', token: 'bad-token' }))
      .rejects.toThrow('exit(1) called');
    const output = vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join('');
    expect(client.providers.list).toHaveBeenCalledOnce();
    expect(output).toContain('✗ Providers');
    expect(output).toContain('provider list failed — 401 Unauthorized');
    expect(output).toContain('Some checks failed.');
    expect(output).not.toContain('All checks passed.');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    new Error('403 Forbidden'),
    new Error('500 Internal Server Error'),
    new TypeError('fetch failed'),
    'connection reset',
  ])('reports other provider-list errors as failed checks: %s', async (error) => {
    client.providers.list.mockRejectedValue(error);
    vi.mocked(process.exit).mockImplementation(() => { throw new Error('exit(1) called'); });
    await expect(runDoctor({ dataDir, server: 'http://fixture.test', token: 'fixture-token' }))
      .rejects.toThrow('exit(1) called');
    const output = vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join('');
    const message = error instanceof Error ? error.message : error;
    expect(client.providers.list).toHaveBeenCalledOnce();
    expect(output).toContain('✗ Providers');
    expect(output).toContain(`provider list failed — ${message}`);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('treats a 404 from the provider list as a warning, not a failure', async () => {
    client.providers.list.mockRejectedValue(new Error('404 Not Found'));
    await runDoctor({ dataDir, server: 'http://fixture.test', token: 'fixture-token' });
    const output = vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join('');
    expect(client.providers.list).toHaveBeenCalledOnce();
    expect(output).toContain('! Providers');
    expect(output).toContain('provider list unavailable (older server?)');
    expect(output).toContain('All checks passed.');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('treats a server-shape NeoApiError 404 as an older-server warning', async () => {
    client.providers.list.mockRejectedValue(
      new NeoApiError(404, { code: 'not_found', message: 'Route not found' }),
    );
    await runDoctor({ dataDir, server: 'http://fixture.test', token: 'fixture-token' });
    const output = vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join('');
    expect(client.providers.list).toHaveBeenCalledOnce();
    expect(output).toContain('! Providers');
    expect(output).toContain('provider list unavailable (older server?)');
    expect(output).toContain('All checks passed.');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('checks enabled supported providers normally', async () => {
    client.providers.list.mockResolvedValue({ items: [{ id: 'local', kind: 'ollama', enabled: true }] });
    client.providers.test.mockResolvedValue({ ok: true });
    await runDoctor({ dataDir, server: 'http://fixture.test', token: 'fixture-token' });
    expect(client.providers.test).toHaveBeenCalledWith('local');
    expect(process.exit).not.toHaveBeenCalled();
  });
});
