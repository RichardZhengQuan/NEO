import { once } from 'node:events';
import { createConnection } from 'node:net';
import WebSocket from 'ws';
import type { ClientOptions, RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOISE_MAX_MESSAGE, RELAY_HEADER, RelayControlMessageSchema, RelayOp, silentLogger, TunnelCloseCode } from '@neo/protocol';
import { decodeRelayFrame, encodeRelayFrame, fromBase64Url, generateServerIdentity, signRelayChallenge, toBase64Url } from '@neo/tunnel';
import type { RelayFrame, ServerIdentity } from '@neo/tunnel';
import { startRelay } from './relay.js';
import type { Relay, RelayOptions } from './relay.js';

interface Message { data: Uint8Array; binary: boolean }
class Inbox {
  private queue: Message[] = [];
  private waiting: ((message: Message) => void)[] = [];
  constructor(socket: WebSocket) {
    socket.on('message', (data: RawData, binary: boolean) => {
      const message = { data: new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data), binary };
      const receive = this.waiting.shift();
      if (receive) receive(message);
      else this.queue.push(message);
    });
  }
  next(): Promise<Message> {
    const existing = this.queue.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const receive = (message: Message) => { clearTimeout(timeout); resolve(message); };
      const timeout = setTimeout(() => {
        this.waiting = this.waiting.filter(item => item !== receive);
        reject(new Error('Timed out waiting for a relay message'));
      }, 2000);
      this.waiting.push(receive);
    });
  }
  async control() {
    const message = await this.next();
    expect(message.binary).toBe(false);
    return RelayControlMessageSchema.parse(JSON.parse(Buffer.from(message.data).toString('utf8')));
  }
  async frame(): Promise<RelayFrame> {
    const message = await this.next();
    expect(message.binary).toBe(true);
    return decodeRelayFrame(message.data);
  }
}

interface Peer { socket: WebSocket; inbox: Inbox; closed: Promise<number> }
const relays: Relay[] = [];
const peers: Peer[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map(relay => relay.close()));
  for (const peer of peers.splice(0)) peer.socket.terminate();
  vi.restoreAllMocks();
});
async function start(options: RelayOptions = {}): Promise<Relay> {
  const relay = await startRelay({ host: '127.0.0.1', port: 0, ...options });
  relays.push(relay);
  return relay;
}
async function connect(relay: Relay, path: string, options?: ClientOptions): Promise<Peer> {
  const socket = new WebSocket(relay.url + path, options);
  socket.on('error', () => {});
  const peer = { socket, inbox: new Inbox(socket), closed: new Promise<number>(resolve => socket.once('close', code => resolve(code))) };
  peers.push(peer);
  await once(socket, 'open');
  return peer;
}
function registration(identity: ServerIdentity, nonce: string) {
  return { type: 'register', serverId: identity.serverId, key: toBase64Url(identity.signing.publicKey), signature: toBase64Url(signRelayChallenge(identity, fromBase64Url(nonce))) };
}
async function register(relay: Relay, identity = generateServerIdentity(), options?: ClientOptions): Promise<Peer & { identity: ServerIdentity }> {
  const peer = await connect(relay, '/v1/server', options);
  const challenge = await peer.inbox.control();
  expect(challenge.type).toBe('challenge');
  if (challenge.type !== 'challenge') throw new Error('No registration challenge');
  peer.socket.send(JSON.stringify(registration(identity, challenge.nonce)));
  expect(await peer.inbox.control()).toEqual({ type: 'registered', serverId: identity.serverId });
  return { ...peer, identity };
}
async function phone(relay: Relay, server: Peer & { identity: ServerIdentity }, options?: ClientOptions) {
  const peer = await connect(relay, `/v1/connect/${server.identity.serverId}`, options);
  const frame = await server.inbox.frame();
  expect(frame.op).toBe(RelayOp.Open);
  expect(frame.connection).not.toBe(0);
  return { ...peer, connection: frame.connection, ip: Buffer.from(frame.payload).toString('utf8') };
}

describe('relay registration and routing', () => {
  it('serves health only, registers with a fresh challenge, and reports aggregate counts', async () => {
    const relay = await start();
    const health = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect((await fetch(`http://127.0.0.1:${relay.port}/api/health`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${relay.port}/healthz`, { method: 'POST' })).status).toBe(404);
    await register(relay);
    expect(relay.stats()).toMatchObject({ servers: 1, phones: 0, pendingRegistrations: 0, registrations: 1, bytes: 0, messages: 0 });
    await relay.close();
    await relay.close();
    expect(relay.stats().servers).toBe(0);
  });

  it.each(['/api/ws', '/v1/connect/bad-id', '/v1/server?query=1', '/v1/connect/00000000000000000000000000000000/extra'])('refuses upgrades outside the contract: %s', async path => {
    const relay = await start();
    await expect(connect(relay, path)).rejects.toThrow('404');
  });

  it('finishes shutdown after refusing an upgrade from a half-open raw peer', async () => {
    const relay = await start();
    const raw = createConnection({ host: '127.0.0.1', port: relay.port, allowHalfOpen: true });
    raw.on('error', () => {});
    try {
      await once(raw, 'connect');
      const response = once(raw, 'data');
      raw.write(`GET /refused-path HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16).toString('base64')}\r\n\r\n`);
      expect((await response)[0].toString()).toContain('404 Not Found');
      // The peer deliberately leaves its write side open after the refusal.
      expect(raw.writableEnded).toBe(false);
      await relay.close();
      expect(relay.stats()).toMatchObject({ servers: 0, phones: 0 });
    } finally { raw.destroy(); }
  });

  it('refuses a stolen server id even with a valid signature from the thief', async () => {
    const relay = await start();
    const victim = await register(relay);
    const thief = generateServerIdentity();
    const peer = await connect(relay, '/v1/server');
    const challenge = await peer.inbox.control();
    if (challenge.type !== 'challenge') throw new Error('No challenge');
    peer.socket.send(JSON.stringify({ ...registration(thief, challenge.nonce), serverId: victim.identity.serverId }));
    expect((await peer.inbox.control()).type).toBe('error');
    expect(await peer.closed).toBe(TunnelCloseCode.ProtocolError);
    expect(relay.stats().servers).toBe(1);
    const mobile = await phone(relay, victim);
    expect(mobile.connection).toBeGreaterThan(0);
  });

  it('refuses a replayed signature from an earlier challenge', async () => {
    const relay = await start();
    const identity = generateServerIdentity();
    const first = await connect(relay, '/v1/server');
    const challenge = await first.inbox.control();
    if (challenge.type !== 'challenge') throw new Error('No challenge');
    const proof = registration(identity, challenge.nonce);
    first.socket.send(JSON.stringify(proof));
    expect((await first.inbox.control()).type).toBe('registered');
    const replay = await connect(relay, '/v1/server');
    const fresh = await replay.inbox.control();
    expect(fresh).not.toEqual(challenge);
    replay.socket.send(JSON.stringify(proof));
    expect((await replay.inbox.control()).type).toBe('error');
    expect(await replay.closed).toBe(TunnelCloseCode.ProtocolError);
    expect(relay.stats().registrations).toBe(1);
  });

  it('replaces a proven registration, closes its phones, and preserves the replacement', async () => {
    const relay = await start();
    const first = await register(relay);
    const mobile = await phone(relay, first);
    const replacement = await register(relay, first.identity);
    expect(await first.closed).toBe(4409);
    expect(await mobile.closed).toBe(TunnelCloseCode.UnknownServer);
    expect(relay.stats()).toMatchObject({ servers: 1, phones: 0, registrations: 2 });
    const fresh = await phone(relay, replacement);
    expect(fresh.connection).not.toBe(mobile.connection);
  });

  it('closes a phone for an unknown server with 4404', async () => {
    const relay = await start();
    const mobile = await connect(relay, `/v1/connect/${generateServerIdentity().serverId}`);
    expect(await mobile.closed).toBe(4404);
    expect(relay.stats().phones).toBe(0);
  });

  it('pipes opaque bytes unchanged in both directions and ignores other servers connections', async () => {
    const relay = await start();
    const first = await register(relay);
    const second = await register(relay);
    const firstPhone = await phone(relay, first);
    const secondPhone = await phone(relay, second);
    expect(secondPhone.connection).not.toBe(firstPhone.connection);
    const outbound = Uint8Array.from([0, 255, 3, 8, 0, 61, 128]);
    firstPhone.socket.send(outbound);
    const forwarded = await first.inbox.frame();
    expect(forwarded).toEqual({ op: RelayOp.Data, connection: firstPhone.connection, payload: outbound });
    first.socket.send(encodeRelayFrame({ op: RelayOp.Data, connection: secondPhone.connection, payload: Uint8Array.of(66) }));
    first.socket.send(encodeRelayFrame({ op: RelayOp.Close, connection: secondPhone.connection, payload: new Uint8Array() }));
    const response = Uint8Array.of(255, 0, 99, 7);
    second.socket.send(encodeRelayFrame({ op: RelayOp.Data, connection: secondPhone.connection, payload: response }));
    expect((await secondPhone.inbox.next()).data).toEqual(response);
    first.socket.send(encodeRelayFrame({ op: RelayOp.Data, connection: firstPhone.connection, payload: response }));
    expect((await firstPhone.inbox.next()).data).toEqual(response);
    expect(relay.stats()).toMatchObject({ phones: 2, messages: 3, bytes: outbound.length + 2 * response.length });
    firstPhone.socket.close();
    expect(await first.inbox.frame()).toEqual({ op: RelayOp.Close, connection: firstPhone.connection, payload: new Uint8Array() });
    second.socket.send(encodeRelayFrame({ op: RelayOp.Close, connection: secondPhone.connection, payload: new Uint8Array() }));
    expect(await secondPhone.closed).toBe(1000);
  });

  it('rejects text from phones and from registered servers', async () => {
    const relay = await start();
    const server = await register(relay);
    const mobile = await phone(relay, server);
    mobile.socket.send('plaintext is forbidden');
    expect(await mobile.closed).toBe(TunnelCloseCode.ProtocolError);
    expect((await server.inbox.frame()).op).toBe(RelayOp.Close);
    server.socket.send(JSON.stringify({ type: 'register' }));
    expect((await server.inbox.control()).type).toBe('error');
    expect(await server.closed).toBe(TunnelCloseCode.ProtocolError);
  });

  it('rejects binary registration and malformed server frames', async () => {
    const relay = await start();
    const unregistered = await connect(relay, '/v1/server');
    await unregistered.inbox.control();
    unregistered.socket.send(Uint8Array.of(1));
    expect((await unregistered.inbox.control()).type).toBe('error');
    expect(await unregistered.closed).toBe(TunnelCloseCode.ProtocolError);
    const server = await register(relay);
    server.socket.send(Uint8Array.of(255, 0, 0, 0, 1));
    expect((await server.inbox.control()).type).toBe('error');
    expect(await server.closed).toBe(TunnelCloseCode.ProtocolError);
  });

  it('rejects oversized phone messages and enforces the WebSocket payload cap', async () => {
    const relay = await start();
    const server = await register(relay);
    const mobile = await phone(relay, server);
    mobile.socket.send(new Uint8Array(NOISE_MAX_MESSAGE + 1));
    expect(await mobile.closed).toBe(TunnelCloseCode.ProtocolError);
    expect((await server.inbox.frame()).op).toBe(RelayOp.Close);
    const oversized = await phone(relay, server);
    oversized.socket.send(new Uint8Array(NOISE_MAX_MESSAGE + RELAY_HEADER + 1));
    expect(await oversized.closed).toBe(1009);
    expect((await server.inbox.frame()).op).toBe(RelayOp.Close);
    server.socket.send(new Uint8Array(NOISE_MAX_MESSAGE + RELAY_HEADER + 1));
    expect(await server.closed).toBe(1009);
  });

  it('closes all phones when their server disconnects', async () => {
    const relay = await start();
    const server = await register(relay);
    const first = await phone(relay, server);
    const second = await phone(relay, server);
    server.socket.close();
    expect(await first.closed).toBe(TunnelCloseCode.UnknownServer);
    expect(await second.closed).toBe(TunnelCloseCode.UnknownServer);
    expect(relay.stats()).toMatchObject({ servers: 0, phones: 0 });
  });

  it('logs only events and counts with server ids truncated to eight characters', async () => {
    const info = vi.fn();
    const debug = vi.fn();
    const relay = await start({ logger: { ...silentLogger, info, debug } });
    const server = await register(relay);
    const mobile = await phone(relay, server);
    const marker = 'known-private-payload';
    mobile.socket.send(Buffer.from(marker));
    await server.inbox.frame();
    const logged = JSON.stringify([...info.mock.calls, ...debug.mock.calls]);
    expect(logged).toContain(server.identity.serverId.slice(0, 8));
    expect(logged).not.toContain(server.identity.serverId);
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain(toBase64Url(server.identity.signing.publicKey));
  });
});

describe('relay limits and lifecycle', () => {
  it('rejects millisecond limits that exceed Node\'s setTimeout range', async () => {
    await expect(start({ limits: { registrationTimeoutMs: 2_147_483_648 } })).rejects.toThrow(/Invalid relay limit: registrationTimeoutMs/);
    await expect(start({ limits: { heartbeatIntervalMs: 2_147_483_648 } })).rejects.toThrow(/Invalid relay limit: heartbeatIntervalMs/);
    await expect(start({ limits: { phoneIdleTimeoutMs: 2_147_483_648 } })).rejects.toThrow(/Invalid relay limit: phoneIdleTimeoutMs/);
    const relay = await start({ limits: { registrationTimeoutMs: 2_147_483_647 } });
    expect(relay.port).toBeGreaterThan(0);
  });

  it('caps concurrent phone connections per IP across servers and releases slots', async () => {
    const relay = await start({ limits: { perIpPhoneConnections: 1 } });
    const first = await register(relay);
    const second = await register(relay);
    const mobile = await phone(relay, first);
    const refused = await connect(relay, `/v1/connect/${second.identity.serverId}`);
    expect(await refused.closed).toBe(TunnelCloseCode.RateLimited);
    expect(relay.stats().phones).toBe(1);
    mobile.socket.close();
    await first.inbox.frame();
    await phone(relay, second);
    expect(relay.stats().phones).toBe(1);
  });

  it('uses forwarded IPs only when trustProxy is enabled and selects the first entry', async () => {
    const trusted = await start({ trustProxy: true, limits: { perIpPhoneConnections: 1 } });
    const trustedServer = await register(trusted);
    const first = await phone(trusted, trustedServer, { headers: { 'x-forwarded-for': '192.0.2.1, 192.0.2.99' } });
    const second = await phone(trusted, trustedServer, { headers: { 'x-forwarded-for': '192.0.2.2' } });
    expect(first.ip).toBe('192.0.2.1');
    expect(second.ip).toBe('192.0.2.2');
    const untrusted = await start({ limits: { perIpPhoneConnections: 1 } });
    const untrustedServer = await register(untrusted);
    const local = await phone(untrusted, untrustedServer, { headers: { 'x-forwarded-for': '192.0.2.1' } });
    expect(local.ip).toBe('127.0.0.1');
    const refused = await connect(untrusted, `/v1/connect/${untrustedServer.identity.serverId}`, { headers: { 'x-forwarded-for': '192.0.2.2' } });
    expect(await refused.closed).toBe(TunnelCloseCode.RateLimited);
  });

  it('caps phones per server and globally', async () => {
    const relay = await start({ trustProxy: true, limits: { perServerPhoneConnections: 1, maxPhones: 2 } });
    const first = await register(relay);
    const second = await register(relay);
    const third = await register(relay);
    await phone(relay, first);
    const serverLimited = await connect(relay, `/v1/connect/${first.identity.serverId}`, { headers: { 'x-forwarded-for': '192.0.2.3' } });
    expect(await serverLimited.closed).toBe(TunnelCloseCode.RateLimited);
    await phone(relay, second);
    const globalLimited = await connect(relay, `/v1/connect/${third.identity.serverId}`);
    expect(await globalLimited.closed).toBe(TunnelCloseCode.RateLimited);
  });

  it('ignores malformed forwarded addresses and never emits an oversized IP payload', async () => {
    const relay = await start({ trustProxy: true });
    const server = await register(relay);
    const malformed = await phone(relay, server, { headers: { 'x-forwarded-for': 'not-an-ip, 192.0.2.1' } });
    expect(malformed.ip).toBe('127.0.0.1');
    const oversized = await phone(relay, server, { headers: { 'x-forwarded-for': 'x'.repeat(1024) } });
    expect(oversized.ip).toBe('127.0.0.1');
    expect(relay.stats()).toMatchObject({ servers: 1, phones: 2 });
  });

  it('caps registered servers but permits a proven replacement at capacity', async () => {
    const relay = await start({ limits: { maxServers: 1 } });
    const first = await register(relay);
    const extra = await connect(relay, '/v1/server');
    const challenge = await extra.inbox.control();
    if (challenge.type !== 'challenge') throw new Error('No challenge');
    extra.socket.send(JSON.stringify(registration(generateServerIdentity(), challenge.nonce)));
    expect(await extra.closed).toBe(TunnelCloseCode.RateLimited);
    await register(relay, first.identity);
    expect(await first.closed).toBe(TunnelCloseCode.Replaced);
    expect(relay.stats().servers).toBe(1);
  });

  it('expires sliding phone and registration windows using the supplied clock', async () => {
    let now = 1000;
    const relay = await start({ clock: () => now, limits: { perIpPhoneConnectionsPerMinute: 1, perIpServerRegistrationsPerMinute: 1 } });
    const server = await register(relay);
    const mobile = await phone(relay, server);
    mobile.socket.close();
    await server.inbox.frame();
    const phoneLimited = await connect(relay, `/v1/connect/${server.identity.serverId}`);
    expect(await phoneLimited.closed).toBe(TunnelCloseCode.RateLimited);
    const serverLimited = await connect(relay, '/v1/server');
    expect(await serverLimited.closed).toBe(TunnelCloseCode.RateLimited);
    now += 60_000;
    await phone(relay, server);
    await register(relay);
  });

  it('counts a shared byte bucket in both directions and sends Close on exhaustion', async () => {
    const relay = await start({ clock: () => 1000, limits: { burstBytes: 6, bytesPerSecond: 2 } });
    const server = await register(relay);
    const mobile = await phone(relay, server);
    mobile.socket.send(Uint8Array.of(1, 2, 3, 4));
    expect((await server.inbox.frame()).payload).toHaveLength(4);
    server.socket.send(encodeRelayFrame({ op: RelayOp.Data, connection: mobile.connection, payload: Uint8Array.of(5, 6, 7) }));
    expect(await mobile.closed).toBe(TunnelCloseCode.RateLimited);
    expect((await server.inbox.frame()).op).toBe(RelayOp.Close);
    expect(relay.stats()).toMatchObject({ phones: 0, messages: 1, bytes: 4 });
  });

  it('refills byte tokens at the configured sustained rate', async () => {
    let now = 1000;
    const relay = await start({ clock: () => now, limits: { burstBytes: 4, bytesPerSecond: 2 } });
    const server = await register(relay);
    const mobile = await phone(relay, server);
    mobile.socket.send(new Uint8Array(4));
    await server.inbox.frame();
    now += 1000;
    server.socket.send(encodeRelayFrame({ op: RelayOp.Data, connection: mobile.connection, payload: Uint8Array.of(1, 2) }));
    expect((await mobile.inbox.next()).data).toEqual(Uint8Array.of(1, 2));
    expect(relay.stats().phones).toBe(1);
  });

  it('rejects a slow destination instead of queuing additional phone data', async () => {
    const relay = await start({ limits: { maxBufferedBytes: 8 } });
    const server = await register(relay);
    const mobile = await phone(relay, server);
    // Simulate a congested relay-side destination without filling kernel buffers.
    const original = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!;
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
      return peers.some(peer => peer.socket === this) ? original.get!.call(this) : 9;
    });
    mobile.socket.send(Uint8Array.of(1));
    expect(await mobile.closed).toBe(TunnelCloseCode.RateLimited);
    expect((await server.inbox.frame()).op).toBe(RelayOp.Close);
    expect(relay.stats().messages).toBe(0);
  });

  it('expires idle phones using the clock, but traffic in either direction keeps them active', async () => {
    let now = 1000;
    const relay = await start({ clock: () => now, limits: { phoneIdleTimeoutMs: 20 } });
    const server = await register(relay);
    const mobile = await phone(relay, server);
    now += 19;
    server.socket.send(encodeRelayFrame({ op: RelayOp.Data, connection: mobile.connection, payload: Uint8Array.of(1) }));
    await mobile.inbox.next();
    now += 19;
    mobile.socket.send(Uint8Array.of(2));
    await server.inbox.frame();
    now += 20;
    expect(await mobile.closed).toBe(1000);
    expect((await server.inbox.frame()).op).toBe(RelayOp.Close);
  });

  it('times out a server that never registers', async () => {
    const relay = await start({ limits: { registrationTimeoutMs: 20 } });
    const peer = await connect(relay, '/v1/server');
    expect((await peer.inbox.control()).type).toBe('challenge');
    expect(await peer.inbox.control()).toMatchObject({ type: 'error', code: 'registration_timeout' });
    expect(await peer.closed).toBe(TunnelCloseCode.ProtocolError);
    expect(relay.stats().pendingRegistrations).toBe(0);
  });

  it('terminates a registered server after a missed pong and closes its phones', async () => {
    const relay = await start({ limits: { heartbeatIntervalMs: 20 } });
    const server = await register(relay, generateServerIdentity(), { autoPong: false });
    const mobile = await phone(relay, server);
    expect(await server.closed).toBe(1006);
    expect(await mobile.closed).toBe(TunnelCloseCode.UnknownServer);
    expect(relay.stats().servers).toBe(0);
  });
});
