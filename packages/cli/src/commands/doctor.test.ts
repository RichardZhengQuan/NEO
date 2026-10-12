import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './doctor.js';

const client = vi.hoisted(() => ({
  health: vi.fn(),
  providers: { list: vi.fn(), test: vi.fn() },
}));
vi.mock('@neo/client', () => ({ NeoClient: vi.fn(function () { return client; }) }));

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

  it('checks enabled supported providers normally', async () => {
    client.providers.list.mockResolvedValue({ items: [{ id: 'local', kind: 'ollama', enabled: true }] });
    client.providers.test.mockResolvedValue({ ok: true });
    await runDoctor({ dataDir, server: 'http://fixture.test', token: 'fixture-token' });
    expect(client.providers.test).toHaveBeenCalledWith('local');
    expect(process.exit).not.toHaveBeenCalled();
  });
});
