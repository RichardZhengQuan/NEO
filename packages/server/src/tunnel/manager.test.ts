import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import type { TunnelHandler } from '@neo/tunnel';
import { createServices } from '../services.js';
import type { NeoServices } from '../index.js';
import { createPhoneAccess } from './manager.js';
import * as lan from './lan.js';
import type { PhoneAccessManager } from './manager.js';

let services: NeoServices | null = null;
let manager: PhoneAccessManager | null = null;
afterEach(async () => { await manager?.stop(); await services?.close(); manager = null; services = null; });
const handler: TunnelHandler = { fetch: async () => new Response('OK'), openWebSocket: () => null };
async function fixture(input: unknown = {}): Promise<PhoneAccessManager> {
  services = await createServices(NeoConfigSchema.parse({ tunnel: { host: '127.0.0.1', port: 0, advertise: ['computer.local:7778'] }, ...input as object }), { inMemory: true, logger: { ...silentLogger } });
  manager = createPhoneAccess({ services, handler });
  return manager;
}

describe('phone access manager', () => {
  it('stays unbound before start, follows settings and stops idempotently', async () => {
    const access = await fixture();
    services!.settings.update({ phoneAccess: { enabled: true } });
    await access.ready();
    expect(access.status()).toMatchObject({ enabled: true, lan: { listening: false, port: null, addresses: [] } });
    expect(access.route()).toBeNull();
    await access.start();
    const port = access.status().lan.port;
    expect(port).toBeGreaterThan(0);
    expect(access.route()).toMatchObject({ lan: ['computer.local:7778'], relay: null });
    await access.start();
    expect(access.status().lan.port).toBe(port);
    services!.settings.update({ phoneAccess: { enabled: false } });
    await access.ready();
    expect(access.status().lan.listening).toBe(false);
    expect(access.route()).toBeNull();
    await access.stop();
    await access.stop();
  });

  it('applies the latest settings while a listener is binding', async () => {
    const access = await fixture();
    await access.start();
    services!.settings.update({ phoneAccess: { enabled: true } });
    services!.settings.update({ phoneAccess: { enabled: false } });
    await access.ready();
    expect(access.status().lan.listening).toBe(false);
    services!.settings.update({ phoneAccess: { enabled: true } });
    await access.ready();
    expect(access.status().lan.listening).toBe(true);
    const stop = access.stop();
    services!.settings.update({ phoneAccess: { enabled: true } });
    await stop;
    expect(access.status().lan.listening).toBe(false);
  });

  it('keeps relay status off while reflecting defaults and per-user overrides', async () => {
    const access = await fixture({ tunnel: { lan: false, relayUrl: 'wss://relay.example' }, settings: { phoneAccess: { enabled: true } } });
    await access.start();
    expect(access.status()).toMatchObject({ relay: { url: 'wss://relay.example', status: 'off', error: null }, defaultRelayUrl: 'wss://relay.example', lan: { listening: false } });
    expect(access.route()).toBeNull();
    services!.settings.update({ phoneAccess: { relayUrl: '' } });
    await access.ready();
    expect(access.status().relay.url).toBeNull();
    services!.settings.update({ phoneAccess: { relayUrl: 'ws://custom.example' } });
    await access.ready();
    expect(access.status().relay.url).toBe('ws://custom.example');
    services!.settings.update({ phoneAccess: { relayUrl: null } });
    expect(access.status().relay.url).toBe('wss://relay.example');
  });

  it('reports listener failure without failing server startup', async () => {
    const bind = vi.spyOn(lan, 'startLanListener').mockRejectedValueOnce(new Error('Listen failed'));
    const access = await fixture({ settings: { phoneAccess: { enabled: true } } });
    const warn = vi.fn();
    services!.logger.warn = warn;
    await access.start();
    expect(access.status()).toMatchObject({ enabled: true, lan: { listening: false, error: expect.any(String), addresses: [] } });
    expect(warn).toHaveBeenCalled();
    expect(access.route()).toBeNull();
    bind.mockRestore();
  });
});
