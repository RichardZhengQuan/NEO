import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayOp, silentLogger, TunnelFrameType } from '@neo/protocol';
import {
  decodeRelayFrame, encodeJson, encodeRelayFrame, generateServerIdentity,
  linkPair, openChannel, toBase64Url, utf8, verifyRelayRegistration,
} from '@neo/tunnel';
import type { RelayFrame, ServerIdentity, TunnelHandler } from '@neo/tunnel';
import { startRelayConnector } from './relay.js';
import type { RelayConnector } from './relay.js';

const connectors: RelayConnector[] = [];
const relays: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(connectors.splice(0).map(connector => connector.close()));
  await Promise.all(relays.splice(0).map(relay => new Promise<void>(resolve => {
    for (const ws of relay.clients) ws.terminate();
    relay.close(() => resolve());
  })));
  vi.restoreAllMocks();
});

const handler: TunnelHandler = { fetch: async () => new Response('OK'), openWebSocket: () => null };

async function fixture(options: { challenge?: boolean } = {}) {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  relays.push(relay);
  const peers: WebSocket[] = [];
  const registrations: { serverId: string; key: string; signature: string; nonce: Uint8Array }[] = [];
  const frames: RelayFrame[] = [];
  let onFrame: ((frame: RelayFrame) => void) | undefined;
  relay.on('connection', (ws, request) => {
    expect(request.url).toBe('/v1/server');
    peers.push(ws);
    const nonce = randomBytes(32);
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      if (binary) {
        const frame = decodeRelayFrame(new Uint8Array(data as Buffer));
        frames.push(frame);
        onFrame?.(frame);
      } else {
        const registration = { ...JSON.parse(data.toString()), nonce };
        registrations.push(registration);
        ws.send(JSON.stringify({ type: 'registered', serverId: registration.serverId }));
      }
    });
    if (options.challenge !== false) ws.send(JSON.stringify({ type: 'challenge', version: 1, nonce: toBase64Url(nonce) }));
  });
  await once(relay, 'listening');
  const port = (relay.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`, peers, registrations, frames,
    receive(callback: (frame: RelayFrame) => void) { onFrame = callback; },
  };
}

function connect(url: string, identity: ServerIdentity = generateServerIdentity(), tunnelHandler: TunnelHandler = handler) {
  const status = vi.fn();
  const connector = startRelayConnector({ url, identity, handler: tunnelHandler, logger: silentLogger, onStatus: status });
  connectors.push(connector);
  return { connector, status, identity };
}

describe('server relay connector', () => {
  it('proves its identity and serves independent encrypted sessions with the relay peer', async () => {
    const relay = await fixture();
    const fetch = vi.fn(async () => new Response('relay response'));
    const { identity, status } = connect(relay.url + '/', undefined, { ...handler, fetch });
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('connected', undefined));
    expect(relay.registrations).toHaveLength(1);
    expect(verifyRelayRegistration(relay.registrations[0]!)).toBe(true);
    expect(relay.registrations[0]!.serverId).toBe(identity.serverId);

    const [phone, forwarded] = linkPair();
    const ws = relay.peers[0]!;
    forwarded.onMessage = bytes => ws.send(encodeRelayFrame({ op: RelayOp.Data, connection: 7, payload: bytes }));
    relay.receive(frame => {
      if (frame.connection !== 7) return;
      if (frame.op === RelayOp.Data) forwarded.send(frame.payload);
      else if (frame.op === RelayOp.Close) forwarded.close();
    });
    ws.send(encodeRelayFrame({ op: RelayOp.Open, connection: 7, payload: utf8('127.0.0.7') }));
    const channel = await openChannel(phone, { serverId: identity.serverId, serverPublicKey: identity.dh.publicKey });
    const received: { type: number; payload: Uint8Array }[] = [];
    channel.onFrame = frame => received.push(frame);
    channel.send({ type: TunnelFrameType.Request, stream: 1, payload: encodeJson({ method: 'GET', path: '/api/health', headers: [] }) });
    channel.send({ type: TunnelFrameType.RequestEnd, stream: 1, payload: new Uint8Array() });
    await vi.waitFor(() => expect(received.some(frame => frame.type === TunnelFrameType.ResponseEnd)).toBe(true));
    expect(fetch).toHaveBeenCalledWith(expect.any(Request), { ip: '127.0.0.7', via: 'relay' });
    expect(new TextDecoder().decode(received.find(frame => frame.type === TunnelFrameType.ResponseBody)!.payload)).toBe('relay response');
    channel.send({ type: TunnelFrameType.Request, stream: 0, payload: new Uint8Array() });
    await vi.waitFor(() => expect(relay.frames.some(frame => frame.op === RelayOp.Close && frame.connection === 7)).toBe(true));
  });

  it('ends active tunneled WebSockets on relay loss, reconnects, and stops for good', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const relay = await fixture();
    const closed = vi.fn();
    const { connector, identity, status } = connect(relay.url, undefined, {
      ...handler, openWebSocket: () => ({ message() {}, close: closed }),
    });
    await vi.waitFor(() => expect(relay.registrations).toHaveLength(1));
    const [phone, forwarded] = linkPair();
    const ws = relay.peers[0]!;
    forwarded.onMessage = bytes => ws.send(encodeRelayFrame({ op: RelayOp.Data, connection: 1, payload: bytes }));
    relay.receive(frame => { if (frame.op === RelayOp.Data) forwarded.send(frame.payload); });
    ws.send(encodeRelayFrame({ op: RelayOp.Open, connection: 1, payload: utf8('127.0.0.1') }));
    const channel = await openChannel(phone, { serverId: identity.serverId, serverPublicKey: identity.dh.publicKey });
    const frames: number[] = [];
    channel.onFrame = frame => frames.push(frame.type);
    channel.send({ type: TunnelFrameType.WsOpen, stream: 1, payload: encodeJson({ path: '/api/ws' }) });
    await vi.waitFor(() => expect(frames).toContain(TunnelFrameType.WsOpened));
    ws.terminate();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(1006, 'Tunnel session closed'));
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('error', 'The relay connection closed.'));
    await vi.waitFor(() => expect(relay.registrations).toHaveLength(2), { timeout: 2500 });
    expect(status.mock.calls.filter(call => call[0] === 'connecting')).toHaveLength(2);
    await connector.close();
    await connector.close();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(relay.registrations).toHaveLength(2);
    forwarded.close();
  });

  it('caps live relay sessions at 256 and releases closed sessions', async () => {
    const relay = await fixture();
    connect(relay.url);
    await vi.waitFor(() => expect(relay.registrations).toHaveLength(1));
    const ws = relay.peers[0]!;
    for (let connection = 1; connection <= 257; connection++) {
      ws.send(encodeRelayFrame({ op: RelayOp.Open, connection, payload: utf8('127.0.0.1') }));
    }
    await vi.waitFor(() => expect(relay.frames).toContainEqual({ op: RelayOp.Close, connection: 257, payload: new Uint8Array() }));
    ws.send(encodeRelayFrame({ op: RelayOp.Close, connection: 1, payload: new Uint8Array() }));
    ws.send(encodeRelayFrame({ op: RelayOp.Open, connection: 258, payload: utf8('127.0.0.1') }));
    // A duplicate open closes the whole relay rather than replacing a live link.
    ws.send(encodeRelayFrame({ op: RelayOp.Open, connection: 258, payload: utf8('127.0.0.1') }));
    await once(ws, 'close');
    expect(relay.frames.filter(frame => frame.connection === 258)).toEqual([]);
  });

  it('ends an overflowing relay before buffering session-limit Close responses', async () => {
    const relay = await fixture();
    const { status } = connect(relay.url);
    await vi.waitFor(() => expect(relay.registrations).toHaveLength(1));
    const original = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!;
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
      return relay.peers.includes(this) ? original.get!.call(this) : 8 * 1024 * 1024 + 1;
    });
    const ws = relay.peers[0]!;
    const ended = once(ws, 'close');
    for (let connection = 1; connection <= 257; connection++) {
      ws.send(encodeRelayFrame({ op: RelayOp.Open, connection, payload: utf8('127.0.0.1') }));
    }
    await ended;
    expect(status).toHaveBeenCalledWith('error', 'The relay connection is too busy.');
    expect(relay.frames).toEqual([]);
  });

  it.each([
    ['text after registration', (ws: WebSocket) => ws.send('unexpected')],
    ['zero connection id', (ws: WebSocket) => ws.send(encodeRelayFrame({ op: RelayOp.Open, connection: 0, payload: utf8('127.0.0.1') }))],
    ['malformed frame', (ws: WebSocket) => ws.send(new Uint8Array([99]))],
    ['invalid IP bytes', (ws: WebSocket) => ws.send(encodeRelayFrame({ op: RelayOp.Open, connection: 1, payload: new Uint8Array([255]) }))],
  ])('rejects %s', async (_name, send) => {
    const relay = await fixture();
    const { status } = connect(relay.url);
    await vi.waitFor(() => expect(relay.registrations).toHaveLength(1));
    const ws = relay.peers[0]!;
    const ended = once(ws, 'close');
    send(ws);
    await ended;
    expect(status).toHaveBeenCalledWith('error', 'The relay sent an invalid message.');
  });

  it('rejects registration acknowledgements before a signed challenge', async () => {
    const relay = await fixture({ challenge: false });
    const { identity, status } = connect(relay.url);
    await vi.waitFor(() => expect(relay.peers).toHaveLength(1));
    const ws = relay.peers[0]!;
    const ended = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'registered', serverId: identity.serverId }));
    await ended;
    expect(relay.registrations).toHaveLength(0);
    expect(status).toHaveBeenCalledWith('error', 'The relay sent an invalid message.');
  });
});
