import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import type { TunnelHandler } from '@neo/tunnel';
import { createServices } from '../services.js';
import type { NeoServices } from '../index.js';
import { createPhoneAccess } from './manager.js';
import * as lan from './lan.js';
import * as relay from './relay.js';
import type { PhoneAccessManager } from './manager.js';

let services: NeoServices | null = null;
let manager: PhoneAccessManager | null = null;
afterEach(async () => { await manager?.stop(); await services?.close(); manager = null; services = null; vi.restoreAllMocks(); });
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

  it('keeps the effective relay route during reconnects and applies relay choices', async () => {
    const connections: { options: Parameters<typeof relay.startRelayConnector>[0]; close: ReturnType<typeof vi.fn> }[] = [];
    const connect = vi.spyOn(relay, 'startRelayConnector').mockImplementation(options => {
      const close = vi.fn(async () => {});
      connections.push({ options, close });
      return { close };
    });
    const defaultUrl = 'ws://127.0.0.1:8787';
    const customUrl = 'ws://127.0.0.1:8788';
    const access = await fixture({ tunnel: { lan: false, relayUrl: defaultUrl }, settings: { phoneAccess: { enabled: true } } });
    await access.start();
    expect(access.status()).toMatchObject({ relay: { url: defaultUrl, status: 'connecting', error: null }, defaultRelayUrl: defaultUrl, lan: { listening: false } });
    expect(access.route()).toMatchObject({ lan: [], relay: defaultUrl });
    connections[0]!.options.onStatus('connected');
    expect(access.status().relay.status).toBe('connected');
    connections[0]!.options.onStatus('error', 'Relay unavailable');
    expect(access.status().relay).toEqual({ url: defaultUrl, status: 'error', error: 'Relay unavailable' });
    expect(access.route()?.relay).toBe(defaultUrl);
    connections[0]!.options.onStatus('connecting');
    expect(access.status().relay.error).toBeNull();
    services!.settings.update({ phoneAccess: { relayUrl: '' } });
    await access.ready();
    expect(connections[0]!.close).toHaveBeenCalledOnce();
    expect(access.status().relay).toEqual({ url: null, status: 'off', error: null });
    expect(access.route()).toBeNull();
    services!.settings.update({ phoneAccess: { relayUrl: customUrl } });
    await access.ready();
    expect(access.status().relay.url).toBe(customUrl);
    connections[0]!.options.onStatus('error', 'Stale connector');
    expect(access.status().relay.error).toBeNull();
    services!.settings.update({ phoneAccess: { relayUrl: null } });
    await access.ready();
    expect(connections[1]!.close).toHaveBeenCalledOnce();
    expect(access.status().relay.url).toBe(defaultUrl);
    expect(connect).toHaveBeenCalledTimes(3);
    await access.start();
    expect(connect).toHaveBeenCalledTimes(3);
    services!.settings.update({ phoneAccess: { enabled: false } });
    await access.ready();
    expect(connections[2]!.close).toHaveBeenCalledOnce();
    expect(access.status().relay).toEqual({ url: defaultUrl, status: 'off', error: null });
    expect(access.route()).toBeNull();
  });

  it('keeps LAN and relay routes available together and closes both on stop', async () => {
    const close = vi.fn(async () => {});
    vi.spyOn(relay, 'startRelayConnector').mockReturnValue({ close });
    const access = await fixture({
      tunnel: { host: '127.0.0.1', port: 0, advertise: ['127.0.0.1:7778'], relayUrl: 'ws://127.0.0.1:8787' },
      settings: { phoneAccess: { enabled: true } },
    });
    await access.start();
    expect(access.route()).toMatchObject({ lan: ['127.0.0.1:7778'], relay: 'ws://127.0.0.1:8787' });
    await access.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(access.status()).toMatchObject({ lan: { listening: false }, relay: { status: 'off' } });
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
