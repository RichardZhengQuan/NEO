import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, parsePairingLink, silentLogger } from '@neo/protocol';
import type { AgentEvent, EventEnvelope, PairingSession, TunnelRoute } from '@neo/protocol';
import { createTunnelTransport, generateServerIdentity, toBase64Url } from '@neo/tunnel';
import type { TunnelTransport } from '@neo/tunnel';
// The relay is a test dependency, never part of the server's runtime.
import { startRelay } from '@neo/relay';
import { WebSocket as RelayWebSocket } from 'ws';
// Exercise the real client without adding a server runtime dependency on it.
import { NeoClient } from '../../client/src/index.js';
import type { EventConnection } from '../../client/src/index.js';
import { startServer } from './server.js';
import type { NeoServer } from './index.js';
import * as lan from './tunnel/lan.js';

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    test: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '127.0.0.1/8' }],
  }),
  hostname: () => 'localhost',
}));

const TOKEN = 'tunnel-e2e-owner-token';
let server: NeoServer;
const transports: TunnelTransport[] = [];
const connections: EventConnection[] = [];
const relays: Awaited<ReturnType<typeof startRelay>>[] = [];

async function until(read: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = performance.now() + 4000;
  while (!await read() && performance.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  expect(await read(), description).toBe(true);
}

function transportFor(route: TunnelRoute): TunnelTransport {
  const transport = createTunnelTransport({ route, WebSocket: globalThis.WebSocket, connectTimeoutMs: 1500 });
  transports.push(transport);
  return transport;
}

async function pair() {
  const owner = new NeoClient({ baseUrl: server.url, token: TOKEN });
  expect((await owner.phoneAccess.status()).enabled).toBe(false);
  const session: PairingSession = await owner.pairing.create();
  const link = parsePairingLink(session.pairingUrl);
  if (!link || link.version !== 2 || !link.tunnel) throw new Error('Pairing did not advertise a tunnel');
  expect(link.serverUrl).toBeNull();
  expect((await owner.phoneAccess.status()).lan.listening).toBe(true);
  expect(link.tunnel.lan).toEqual([`127.0.0.1:${(await owner.phoneAccess.status()).lan.port}`]);
  const transport = transportFor(link.tunnel);
  const anonymous = new NeoClient({ baseUrl: transport.baseUrl, fetch: transport.fetch, WebSocket: transport.WebSocket });
  const claimed = await anonymous.pairing.claim({ code: link.code, deviceName: 'LAN phone', platform: 'ios' });
  const phone = new NeoClient({ baseUrl: transport.baseUrl, fetch: transport.fetch, WebSocket: transport.WebSocket, token: claimed.token });
  return { owner, phone, transport, route: link.tunnel, device: claimed.device };
}

function events(phone: NeoClient) {
  const envelopes: EventEnvelope[] = [];
  let status = '';
  const connection = phone.connect({
    reconnect: false, onEvent: envelope => envelopes.push(envelope), onStatus: value => { status = value; },
  });
  connections.push(connection);
  return { connection, envelopes, status: () => status };
}

async function startTestServer(lanEnabled = true): Promise<NeoServer> {
  return startServer(NeoConfigSchema.parse({
    dataDir: '/unwritten-tunnel-e2e',
    server: { host: '127.0.0.1', port: 0, authToken: TOKEN, trustProxy: true },
    tunnel: { host: '127.0.0.1', port: 0, lan: lanEnabled },
    settings: { agent: { autoTitle: false }, memory: { consolidation: { enabled: false } } },
  }), {
    inMemory: true, logger: silentLogger,
    mockScript: request => request.metadata?.['purpose'] === 'memory-extract'
      ? { text: JSON.stringify({ episode: null, memories: [], links: [] }) }
      : { text: 'Reply through the encrypted tunnel.', chunkSize: 5 },
  });
}

beforeEach(async () => { server = await startTestServer(); });

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  for (const transport of transports.splice(0)) transport.close();
  await server?.stop();
  for (const relay of relays.splice(0)) await relay.close();
  vi.restoreAllMocks();
});

describe('LAN encrypted tunnel end to end', () => {
  it('claims a one-time code, sends chat events over tunneled /api/ws and streams SSE', async () => {
    const { phone, transport } = await pair();
    expect(transport.via).toBe('lan');
    const inbox = events(phone);
    await until(() => inbox.status() === 'open', 'Phone event socket authenticates');
    const conversation = await phone.conversations.create();
    const sent = await phone.conversations.send(conversation.id, { text: 'Hello over LAN' });
    await until(() => inbox.envelopes.some(({ event }) => event.type === 'turn.finished' && event.turnId === sent.turnId), 'Chat completes over tunneled events');
    expect(inbox.envelopes.some(({ event }) => event.type === 'text.delta' && event.turnId === sent.turnId)).toBe(true);
    const streamed: AgentEvent[] = [];
    for await (const event of phone.conversations.stream(conversation.id, { text: 'Stream over LAN' }, AbortSignal.timeout(4000))) streamed.push(event);
    expect(streamed.at(-1)?.type).toBe('turn.finished');
    expect(streamed.filter(event => event.type === 'text.delta').map(event => event.text).join('')).toBe('Reply through the encrypted tunnel.');
  });

  it('serves no plaintext API on the LAN port and rejects a wrong pinned key', async () => {
    const { route } = await pair();
    for (const path of ['/', '/api/health', '/api/settings', '/v1/tunnel']) {
      const response = await fetch(`http://${route.lan[0]}${path}`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(404);
    }
    const wrong = transportFor({ ...route, publicKey: toBase64Url(generateServerIdentity().dh.publicKey) });
    await expect(wrong.fetch(`${wrong.baseUrl}/api/health`, { signal: AbortSignal.timeout(2500) })).rejects.toThrow();
    expect(wrong.via).toBeNull();
  });

  it('shares HTTP and WebSocket failure counters and ignores forwarded IPs with proxy trust enabled', async () => {
    const { transport } = await pair();
    for (let index = 0; index < 10; index++) {
      const response = await transport.fetch(`${transport.baseUrl}/api/settings`, {
        headers: { Authorization: 'Bearer invalid-token', 'X-Forwarded-For': `198.51.100.${index + 1}` },
      });
      expect(response.status).toBe(401);
    }
    const limited = await transport.fetch(`${transport.baseUrl}/api/settings`, {
      headers: { Authorization: 'Bearer still-invalid', 'X-Forwarded-For': '203.0.113.20' },
    });
    expect(limited.status).toBe(429);
    const socket = new transport.WebSocket(`${transport.baseUrl.replace('https:', 'wss:')}/api/ws`);
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
    const messages: unknown[] = [];
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token: 'bad-token' })), { once: true });
    expect(await closed).toBe(4401);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'rate_limited' }) }));
  });

  it('revocation closes the device event socket and rejects subsequent tunnel requests', async () => {
    const { owner, phone, device } = await pair();
    const inbox = events(phone);
    await until(() => inbox.status() === 'open', 'Phone event socket opens');
    await owner.devices.revoke(device.id);
    await until(() => inbox.status() === 'closed', 'Revocation closes tunneled socket');
    await expect(phone.devices.list()).rejects.toMatchObject({ status: 401 });
  });

  it('restricts phone access changes to the owner and disabling closes listener and sessions', async () => {
    const { owner, phone, transport, route } = await pair();
    await expect(phone.phoneAccess.update({ enabled: false })).rejects.toMatchObject({ status: 403 });
    await expect(phone.settings.update({ phoneAccess: { enabled: false } })).rejects.toMatchObject({ status: 400 });
    const socket = new transport.WebSocket(`${transport.baseUrl.replace('https:', 'wss:')}/api/ws`);
    let ready = false;
    socket.addEventListener('message', event => { ready = JSON.parse(String(event.data)).type === 'ready'; });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token: phone.options.token })), { once: true });
    await until(() => ready, 'Phone event socket authenticates');
    const status = await owner.phoneAccess.update({ enabled: false });
    expect(status).toMatchObject({ enabled: false, lan: { listening: false, port: null, addresses: [] } });
    await until(() => socket.readyState === WebSocket.CLOSED && transport.via === null, 'Disabling closes live tunnel sessions');
    await expect(fetch(`http://${route.lan[0]}/api/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    await expect(phone.health()).rejects.toThrow();
  });
});

describe('relay encrypted tunnel end to end', () => {
  async function configureRelay(owner: NeoClient) {
    const relay = await startRelay({ host: '127.0.0.1', port: 0, logger: silentLogger });
    relays.push(relay);
    const status = await owner.phoneAccess.update({ enabled: true, relayUrl: relay.url });
    expect(status.relay.url).toBe(relay.url);
    await until(async () => (await owner.phoneAccess.status()).relay.status === 'connected', 'Server registers with the relay');
    return relay;
  }

  it('pairs with a relay-only link and exchanges authenticated chat events without exposing plaintext', async () => {
    await server.stop();
    server = await startTestServer(false);
    const owner = new NeoClient({ baseUrl: server.url, token: TOKEN });
    // Observe binary writes on real ws sockets in both directions. Nothing is
    // added to relay logging or its public API to inspect tunnel contents.
    const writes = vi.spyOn(RelayWebSocket.prototype, 'send');
    const relay = await configureRelay(owner);
    const session = await owner.pairing.create();
    const link = parsePairingLink(session.pairingUrl);
    if (!link || link.version !== 2 || !link.tunnel) throw new Error('Missing relay pairing route');
    expect(link.serverUrl).toBeNull();
    expect(link.tunnel).toMatchObject({ lan: [], relay: relay.url });
    expect((await owner.phoneAccess.status()).lan.listening).toBe(false);
    const transport = transportFor(link.tunnel);
    const anonymous = new NeoClient({ baseUrl: transport.baseUrl, fetch: transport.fetch, WebSocket: transport.WebSocket });
    const claimed = await anonymous.pairing.claim({ code: link.code, deviceName: 'Away phone', platform: 'ios' });
    expect(transport.via).toBe('relay');
    await expect(anonymous.pairing.claim({ code: link.code, deviceName: 'Second phone', platform: 'ios' })).rejects.toMatchObject({ status: 401 });
    const phone = new NeoClient({ baseUrl: transport.baseUrl, fetch: transport.fetch, WebSocket: transport.WebSocket, token: claimed.token });
    const inbox = events(phone);
    await until(() => inbox.status() === 'open', 'Relay phone event socket authenticates');
    const conversation = await phone.conversations.create();
    const marker = 'private-relay-chat-marker-7f2924d2';
    const sent = await phone.conversations.send(conversation.id, { text: marker });
    await until(() => inbox.envelopes.some(({ event }) => event.type === 'turn.finished' && event.turnId === sent.turnId), 'Relay chat completes over tunneled events');
    expect(inbox.envelopes.filter(({ event }) => event.type === 'text.delta' && event.turnId === sent.turnId)
      .map(({ event }) => event.type === 'text.delta' ? event.text : '').join('')).toBe('Reply through the encrypted tunnel.');
    const bytes = writes.mock.calls.flatMap(([data]) => {
      if (data instanceof ArrayBuffer) return [Buffer.from(data)];
      if (ArrayBuffer.isView(data)) return [Buffer.from(data.buffer, data.byteOffset, data.byteLength)];
      return [];
    });
    expect(bytes.length).toBeGreaterThan(10);
    expect(relay.stats().messages).toBeGreaterThan(0);
    for (const payload of bytes) {
      expect(payload.includes(Buffer.from(marker))).toBe(false);
      expect(payload.includes(Buffer.from(claimed.token))).toBe(false);
    }
  });

  it('prefers LAN when both routes work and a new transport falls back after the LAN listener closes', async () => {
    const listenerStarted = vi.spyOn(lan, 'startLanListener');
    const owner = new NeoClient({ baseUrl: server.url, token: TOKEN });
    const relay = await configureRelay(owner);
    const session = await owner.pairing.create();
    const link = parsePairingLink(session.pairingUrl);
    if (!link || link.version !== 2 || !link.tunnel) throw new Error('Missing combined pairing route');
    expect(link.tunnel.lan).toHaveLength(1);
    expect(link.tunnel.relay).toBe(relay.url);
    const local = transportFor(link.tunnel);
    const anonymous = new NeoClient({ baseUrl: local.baseUrl, fetch: local.fetch, WebSocket: local.WebSocket });
    const claimed = await anonymous.pairing.claim({ code: link.code, deviceName: 'Travelling phone', platform: 'android' });
    expect(local.via).toBe('lan');
    expect(listenerStarted).toHaveBeenCalledTimes(1);
    const listener = await listenerStarted.mock.results[0]!.value as Awaited<ReturnType<typeof lan.startLanListener>>;
    await listener.close();
    const away = transportFor(link.tunnel);
    const phone = new NeoClient({ baseUrl: away.baseUrl, fetch: away.fetch, WebSocket: away.WebSocket, token: claimed.token });
    expect((await phone.devices.list()).items).toContainEqual(expect.objectContaining({ id: claimed.device.id }));
    expect(away.via).toBe('relay');
    expect((await owner.phoneAccess.status()).relay).toMatchObject({ url: relay.url, status: 'connected' });
  });
});
