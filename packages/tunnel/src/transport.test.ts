import { afterEach, describe, expect, it, vi } from 'vitest';
import { TUNNEL_BODY_CHUNK, TunnelCloseCode, TunnelFrameType } from '@neo/protocol';
import { toBase64Url, utf8 } from './bytes.js';
import { acceptChannel } from './channel.js';
import { encodeJson } from './frames.js';
import { createTunnelTransport } from './client.js';
import type { TunnelTransport, TunnelTransportOptions } from './client.js';
import { generateServerIdentity } from './identity.js';
import type { ServerIdentity } from './identity.js';
import { linkPair } from './link.js';
import type { MessageLink, WebSocketLike } from './link.js';
import { serveTunnel } from './server.js';
import type { TunnelHandler, TunnelServerLimits, TunnelSocket } from './server.js';

type Reachability = 'open' | 'dead' | 'hang' | 'handshake-hang' | number;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });

function environment(input: {
  handler?: TunnelHandler;
  addresses?: Record<string, Reachability>;
  lan?: string[];
  relay?: string | null;
  limits?: Partial<TunnelServerLimits>;
  wrongPin?: boolean;
  lanTimeoutMs?: number;
  connectTimeoutMs?: number;
  onStatus?: TunnelTransportOptions['onStatus'];
  accept?: (link: MessageLink, identity: ServerIdentity) => { close(): void };
} = {}) {
  const identity = generateServerIdentity();
  const addresses = input.addresses ?? { 'ws://lan:7778/v1/tunnel': 'open' };
  const peers: { link: MessageLink; close(): void }[] = [];
  const attempted: string[] = [];
  const closeCodes: number[] = [];
  const received: Request[] = [];
  const handler = input.handler ?? {
    async fetch(request: Request) { received.push(request); return Response.json({ url: request.url, method: request.method }); },
    openWebSocket() { return null; },
  };
  class FakeSocket implements WebSocketLike {
    readyState = 0;
    binaryType = 'blob';
    bufferedAmount = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private link: MessageLink | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(url: string) {
      attempted.push(url);
      const reach = addresses[url] ?? 'dead';
      const open = () => {
        if (this.readyState !== 0) return;
        if (reach === 'dead') { this.onerror?.(new Event('error')); this.close(1006, 'Unreachable'); return; }
        if (reach === 'hang') return;
        const [phone, server] = linkPair();
        this.link = phone;
        phone.onMessage = bytes => this.onmessage?.({ data: bytes.slice().buffer });
        phone.onClose = (code, reason) => this.finished(code, reason);
        const service = reach === 'handshake-hang' ? { close() { server.close(); } } : input.accept?.(server, identity) ?? serveTunnel(server, {
          identity, handler, peer: { ip: '192.0.2.1', via: url.includes('/v1/connect/') ? 'relay' : 'lan' },
          limits: input.limits,
        });
        peers.push({ link: server, close: service.close });
        this.readyState = 1;
        this.onopen?.(new Event('open'));
      };
      if (typeof reach === 'number') this.timer = setTimeout(open, reach);
      else queueMicrotask(open);
      cleanup.push(() => this.close());
    }
    send(bytes: Uint8Array) {
      if (this.readyState !== 1) throw new Error('Not open');
      this.link!.send(bytes);
    }
    close(code = 1000, reason = '') {
      closeCodes.push(code);
      if (this.timer !== null) clearTimeout(this.timer);
      this.link?.close(code, reason);
      this.finished(code, reason);
    }
    private finished(code: number, reason: string) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }
  const transport = createTunnelTransport({
    route: {
      serverId: identity.serverId,
      publicKey: toBase64Url(input.wrongPin ? generateServerIdentity().dh.publicKey : identity.dh.publicKey),
      lan: input.lan ?? ['lan:7778'], relay: input.relay ?? null,
    },
    WebSocket: FakeSocket, lanTimeoutMs: input.lanTimeoutMs ?? 10, connectTimeoutMs: input.connectTimeoutMs ?? 300,
    onStatus: input.onStatus,
  });
  cleanup.push(() => { transport.close(); for (const peer of peers) peer.close(); });
  return { transport, peers, attempted, received, identity, closeCodes };
}

function event(socket: WebSocket, type: string): Promise<Event> {
  return new Promise(resolve => socket.addEventListener(type, resolve, { once: true }));
}

function socketUrl(transport: TunnelTransport) { return transport.baseUrl.replace('https:', 'wss:') + '/api/ws'; }

describe('phone transport over an in-memory outer WebSocket', () => {
  it('preserves GET queries and shares one connection for concurrent requests', async () => {
    const { transport, attempted } = environment();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => transport.fetch(`${transport.baseUrl}/api/query?n=${index}`)));
    for (const [index, response] of responses.entries()) {
      expect(await response.json()).toEqual({ url: `http://tunnel.invalid/api/query?n=${index}`, method: 'GET' });
    }
    expect(attempted).toHaveLength(1);
    expect(transport.via).toBe('lan');
  });

  it('chunks a large POST without changing bytes', async () => {
    const body = new Uint8Array(TUNNEL_BODY_CHUNK * 5 + 79);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const { transport } = environment({ handler: {
      async fetch(request) { return new Response(await request.arrayBuffer()); },
      openWebSocket() { return null; },
    } });
    const response = await transport.fetch(`${transport.baseUrl}/api/echo`, { method: 'POST', body });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it('delivers a response incrementally before its producer finishes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    const { transport } = environment({ handler: {
      async fetch() { return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(utf8('first\n')); } })); },
      openWebSocket() { return null; },
    } });
    const response = await transport.fetch(`${transport.baseUrl}/api/sse`);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(utf8('first\n'));
    expect(finished).toBe(false);
    controller.enqueue(utf8('second\n'));
    controller.close();
    finished = true;
    expect((await reader.read()).value).toEqual(utf8('second\n'));
    expect((await reader.read()).done).toBe(true);
  });

  it('uses a null body for 204 and HEAD', async () => {
    const { transport } = environment({ handler: {
      async fetch(request) { return new Response(null, { status: request.method === 'HEAD' ? 200 : 204 }); },
      openWebSocket() { return null; },
    } });
    expect((await transport.fetch(`${transport.baseUrl}/api/empty`)).body).toBeNull();
    expect((await transport.fetch(`${transport.baseUrl}/api/empty`, { method: 'HEAD' })).body).toBeNull();
  });

  it('aborts a streaming body and the handler signal', async () => {
    let requestSignal!: AbortSignal;
    let cancelled = false;
    const { transport } = environment({ handler: {
      async fetch(request) {
        requestSignal = request.signal;
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(utf8('started')); },
          cancel() { cancelled = true; },
        }));
      },
      openWebSocket() { return null; },
    } });
    const abort = new AbortController();
    const response = await transport.fetch(`${transport.baseUrl}/api/stream`, { signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => { expect(requestSignal.aborted).toBe(true); expect(cancelled).toBe(true); });
  });

  it('rejects invalid destinations before connecting and honors an already aborted signal', async () => {
    const { transport, attempted } = environment();
    for (const url of ['https://other.invalid/api/health', `${transport.baseUrl}/private`, `${transport.baseUrl}/api/../private`]) {
      await expect(transport.fetch(url)).rejects.toBeInstanceOf(TypeError);
    }
    const abort = new AbortController();
    abort.abort();
    await expect(transport.fetch(`${transport.baseUrl}/api/health`, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempted).toHaveLength(0);
  });

  it('strips hop-by-hop and untrusted forwarding headers', async () => {
    const { transport, received } = environment();
    await (await transport.fetch(`${transport.baseUrl}/api/headers`, {
      headers: { host: 'evil', connection: 'x-hop', 'x-hop': 'evil', forwarded: 'evil',
        'x-forwarded-for': 'evil', 'x-forwarded-host': 'evil', 'x-forwarded-proto': 'evil',
        'x-real-ip': 'evil', authorization: 'Bearer device' },
    })).text();
    for (const name of ['host', 'connection', 'x-hop', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
      expect(received[0]!.headers.has(name)).toBe(false);
    }
    expect(received[0]!.headers.get('authorization')).toBe('Bearer device');
  });

  it('rejects an oversized request with fetch network semantics', async () => {
    let called = false;
    const { transport } = environment({ limits: { maxRequestBodyBytes: 10 }, handler: {
      async fetch() { called = true; return new Response('unexpected'); }, openWebSocket() { return null; },
    } });
    await expect(transport.fetch(`${transport.baseUrl}/api/echo`, { method: 'POST', body: new Uint8Array(TUNNEL_BODY_CHUNK * 3) }))
      .rejects.toThrow('Failed to fetch');
    expect(called).toBe(false);
  });

  it('bridges WebSocket messages, property callbacks, listeners, and phone close', async () => {
    let serverSocket!: TunnelSocket;
    const closed = vi.fn();
    const { transport } = environment({ handler: {
      async fetch() { return new Response('ok'); },
      openWebSocket(_path, _peer, socket) {
        serverSocket = socket;
        return { message(text) { socket.send(`echo:${text}`); }, close: closed };
      },
    } });
    const socket = new transport.WebSocket(socketUrl(transport));
    expect(socket.readyState).toBe(socket.CONNECTING);
    expect(() => socket.send('too early')).toThrow(/connecting/);
    const propertyOpen = vi.fn();
    socket.onopen = propertyOpen;
    await event(socket, 'open');
    expect(propertyOpen).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(socket.OPEN);
    const echo = event(socket, 'message');
    socket.send('hello');
    expect((await echo as MessageEvent).data).toBe('echo:hello');
    const message = event(socket, 'message');
    serverSocket.send('from server');
    expect((await message as MessageEvent).data).toBe('from server');
    const close = event(socket, 'close');
    socket.close(3001, 'done');
    expect(await close).toMatchObject({ code: 3001, reason: 'done', wasClean: true });
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(3001, 'done'));
  });

  it('handles server WebSocket close and a refused path', async () => {
    let serverSocket!: TunnelSocket;
    const { transport } = environment({ handler: {
      async fetch() { return new Response('ok'); },
      openWebSocket(_path, _peer, socket) {
        serverSocket = socket;
        return { message() {}, close() {} };
      },
    } });
    const socket = new transport.WebSocket(socketUrl(transport));
    await event(socket, 'open');
    const close = event(socket, 'close');
    serverSocket.close(4401, 'revoked');
    expect(await close).toMatchObject({ code: 4401, reason: 'revoked', wasClean: true });
    const refused = environment();
    const missing = new refused.transport.WebSocket(socketUrl(refused.transport));
    const error = vi.fn();
    missing.onerror = error;
    expect(await event(missing, 'close')).toMatchObject({ code: 1006, wasClean: false });
    expect(error).toHaveBeenCalledOnce();
  });

  it('fails in-flight streams on channel loss and reconnects on the next fetch', async () => {
    let pendingSignal!: AbortSignal;
    const websocketClose = vi.fn();
    const { transport, peers, attempted } = environment({ handler: {
      async fetch(request) {
        if (new URL(request.url).pathname === '/api/pending') {
          pendingSignal = request.signal;
          await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        return new Response('ok');
      },
      openWebSocket() { return { message() {}, close: websocketClose }; },
    } });
    const socket = new transport.WebSocket(socketUrl(transport));
    await event(socket, 'open');
    const order: string[] = [];
    socket.onerror = () => order.push('error');
    socket.onclose = () => order.push('close');
    const closed = event(socket, 'close');
    const pending = transport.fetch(`${transport.baseUrl}/api/pending`);
    const failed = expect(pending).rejects.toEqual(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    peers[0]!.link.close(1006, 'lost');
    await failed;
    expect(await closed).toMatchObject({ code: 1006, wasClean: false });
    expect(order).toEqual(['error', 'close']);
    expect(pendingSignal.aborted).toBe(true);
    expect(websocketClose).toHaveBeenCalledWith(1006, expect.any(String));
    expect(await (await transport.fetch(`${transport.baseUrl}/api/reconnected`)).text()).toBe('ok');
    expect(attempted).toHaveLength(2);
  });

  it('prefers a LAN handshake and uses relay when all LAN candidates fail', async () => {
    const relay = 'wss://relay.invalid';
    const liveAddresses: Record<string, Reachability> = {
      'ws://lan:7778/v1/tunnel': 'open',
    };
    const live = environment({ relay, addresses: liveAddresses });
    liveAddresses[`${relay}/v1/connect/${live.identity.serverId}`] = 'open';
    expect(await live.transport.connect()).toBe('lan');
    expect(live.attempted).toEqual(['ws://lan:7778/v1/tunnel']);
    const addresses: Record<string, Reachability> = { 'ws://lan:7778/v1/tunnel': 'dead' };
    const fallback = environment({ relay, addresses });
    addresses[`${relay}/v1/connect/${fallback.identity.serverId}`] = 'open';
    expect(await fallback.transport.connect()).toBe('relay');
    expect(fallback.attempted).toHaveLength(2);
  });

  it('races handshake completion, allowing a late LAN success to beat relay', async () => {
    const relay = 'wss://relay.invalid';
    const addresses: Record<string, Reachability> = { 'ws://lan:7778/v1/tunnel': 20 };
    const { transport, identity, attempted } = environment({ relay, addresses, lanTimeoutMs: 1 });
    addresses[`${relay}/v1/connect/${identity.serverId}`] = 80;
    expect(await transport.connect()).toBe('lan');
    expect(attempted).toHaveLength(2);
    const stalled: Record<string, Reachability> = { 'ws://lan:7778/v1/tunnel': 'handshake-hang' };
    const fallback = environment({ relay, addresses: stalled, lanTimeoutMs: 1 });
    stalled[`${relay}/v1/connect/${fallback.identity.serverId}`] = 'open';
    expect(await fallback.transport.connect()).toBe('relay');
  });

  it('starts every LAN candidate, and never accepts a wrong pinned key', async () => {
    const fastest = environment({ lan: ['dead:7778', 'lan:7778', 'slow:7778'], addresses: {
      'ws://dead:7778/v1/tunnel': 'dead', 'ws://lan:7778/v1/tunnel': 'open', 'ws://slow:7778/v1/tunnel': 50,
    } });
    expect(await fastest.transport.connect()).toBe('lan');
    expect(fastest.attempted).toHaveLength(3);
    const wrong = environment({ wrongPin: true });
    await expect(wrong.transport.fetch(`${wrong.transport.baseUrl}/api/health`)).rejects.toThrow('Failed to fetch');
    expect(wrong.received).toHaveLength(0);
  });

  it('times out hanging candidates and cancels connection attempts on close', async () => {
    const hanging = environment({ addresses: { 'ws://lan:7778/v1/tunnel': 'hang' }, connectTimeoutMs: 20 });
    await expect(hanging.transport.connect()).rejects.toThrow('Failed to fetch');
    const closed = environment({ addresses: { 'ws://lan:7778/v1/tunnel': 'hang' } });
    const pending = closed.transport.connect();
    closed.transport.close();
    await expect(pending).rejects.toThrow('Failed to fetch');
    await expect(closed.transport.connect()).rejects.toThrow('Failed to fetch');
  });

  it('fails a request even when its upload is still being buffered', async () => {
    const { transport, peers } = environment();
    await transport.connect();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { pulled = true; } });
    const request = new Request(`${transport.baseUrl}/api/slow-upload`, {
      method: 'POST', body, duplex: 'half',
    } as RequestInit);
    const fetching = transport.fetch(request);
    const failed = expect(fetching).rejects.toThrow('Failed to fetch');
    await vi.waitFor(() => expect(pulled).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    peers[0]!.link.close(1006, 'lost');
    await failed;
  });

  it('keeps a responsive channel alive and closes after two unanswered pings', async () => {
    vi.useFakeTimers();
    const { transport, peers } = environment();
    await transport.connect();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(transport.via).toBe('lan');
    peers[0]!.link.onMessage = null;
    await vi.advanceTimersByTimeAsync(75_000);
    expect(transport.via).toBeNull();
  });

  it('aborts before a response head and cancels when a response reader is cancelled', async () => {
    const signals: AbortSignal[] = [];
    const { transport } = environment({ handler: {
      async fetch(request) {
        signals.push(request.signal);
        if (new URL(request.url).pathname === '/api/pending') {
          await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(utf8('chunk')); } }));
      },
      openWebSocket() { return null; },
    } });
    const abort = new AbortController();
    const fetching = transport.fetch(`${transport.baseUrl}/api/pending`, { signal: abort.signal });
    const failed = expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    abort.abort();
    await failed;
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    const response = await transport.fetch(`${transport.baseUrl}/api/cancel-reader`);
    await response.body!.cancel();
    await vi.waitFor(() => expect(signals[1]!.aborted).toBe(true));
  });

  it('waits for a WebSocket close acknowledgment and tolerates closing during open', async () => {
    const { transport, peers } = environment({ handler: {
      async fetch() { return new Response('ok'); },
      openWebSocket() { return { message() {}, close() {} }; },
    } });
    await transport.connect();
    const early = new transport.WebSocket(socketUrl(transport));
    const opened = vi.fn();
    const errored = vi.fn();
    early.onopen = opened;
    early.onerror = errored;
    const earlyClose = event(early, 'close');
    queueMicrotask(() => early.close(3002, 'closed while opening'));
    expect(await earlyClose).toMatchObject({ code: 3002, wasClean: true });
    expect(opened).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
    expect(transport.via).toBe('lan');
    const socket = new transport.WebSocket(socketUrl(transport));
    await event(socket, 'open');
    peers[0]!.link.onMessage = null;
    socket.close();
    await Promise.resolve();
    expect(socket.readyState).toBe(socket.CLOSING);
    const lost = event(socket, 'close');
    peers[0]!.link.close(1006, 'lost before acknowledgment');
    expect(await lost).toMatchObject({ code: 1006, wasClean: false });
  });

  it('allows reentrant status observers to connect or close safely', async () => {
    let transport!: TunnelTransport;
    let nested: Promise<'lan' | 'relay'> | undefined;
    const connected = environment({ onStatus(status) {
      if (status.state === 'connecting') nested = transport.connect();
    } });
    transport = connected.transport;
    expect(await transport.connect()).toBe('lan');
    expect(await nested).toBe('lan');
    expect(connected.attempted).toHaveLength(1);
    let closing!: TunnelTransport;
    const closed = environment({ onStatus(status) {
      if (status.state === 'open') closing.close();
    } });
    closing = closed.transport;
    await expect(closing.fetch(`${closing.baseUrl}/api/health`)).rejects.toThrow('Failed to fetch');
  });

  it('errors an already returned response body on channel loss', async () => {
    const { transport, peers } = environment({ handler: {
      async fetch() { return new Response(new ReadableStream({ start(controller) { controller.enqueue(utf8('first')); } })); },
      openWebSocket() { return null; },
    } });
    const response = await transport.fetch(`${transport.baseUrl}/api/stream`);
    const reader = response.body!.getReader();
    await reader.read();
    const next = reader.read();
    const failed = expect(next).rejects.toThrow('Failed to fetch');
    peers[0]!.link.close(1006, 'lost');
    await failed;
  });

  it.each(['response', 'socket'] as const)('closes with ProtocolError for a malformed %s payload', async kind => {
    const { transport, closeCodes } = environment({ accept(link, identity) {
      void acceptChannel(link, { serverId: identity.serverId, staticKey: identity.dh }).then(channel => {
        channel.onFrame = frame => {
          if (kind === 'response' && frame.type === TunnelFrameType.RequestEnd) {
            channel.send({ type: TunnelFrameType.Response, stream: frame.stream, payload: encodeJson({ status: 200, headers: 'invalid' }) });
          } else if (kind === 'socket' && frame.type === TunnelFrameType.WsOpen) {
            channel.send({ type: TunnelFrameType.WsClose, stream: frame.stream, payload: encodeJson({ code: 1006, reason: '' }) });
          }
        };
      }).catch(() => {});
      return { close() { link.close(); } };
    } });
    if (kind === 'response') {
      await expect(transport.fetch(`${transport.baseUrl}/api/malformed`)).rejects.toThrow('Failed to fetch');
    } else {
      const socket = new transport.WebSocket(socketUrl(transport));
      expect(await event(socket, 'close')).toMatchObject({ code: 1006, wasClean: false });
    }
    expect(closeCodes).toContain(TunnelCloseCode.ProtocolError);
  });
});
