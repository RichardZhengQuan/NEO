import { afterEach, describe, expect, it, vi } from 'vitest';
import { TUNNEL_BODY_CHUNK, TUNNEL_FRAME_HEADER, TUNNEL_MAX_FRAME, TunnelCloseCode, TunnelFrameType } from '@neo/protocol';
import type { TunnelReset } from '@neo/protocol';
import { openChannel } from './channel.js';
import type { SecureChannel } from './channel.js';
import { decodeJson, encodeJson } from './frames.js';
import type { Frame } from './frames.js';
import { linkPair } from './link.js';
import type { MessageLink } from './link.js';
import { generateKeyPair } from './noise.js';
import { serveTunnel } from './server.js';
import type { TunnelHandler, TunnelServerLimits, TunnelSocket } from './server.js';

const serverId = '0123456789abcdef0123456789abcdef';
const cleanups: (() => void)[] = [];
const EMPTY = new Uint8Array();

afterEach(async () => {
  for (const close of cleanups.splice(0)) close();
  await Promise.resolve();
});

function inbox(channel: SecureChannel) {
  const queue: Frame[] = [];
  const waiting: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  channel.onFrame = (frame) => {
    const index = waiting.findIndex((item) => item.match(frame));
    if (index === -1) queue.push(frame);
    else waiting.splice(index, 1)[0]!.resolve(frame);
  };
  return {
    next(type: number, stream?: number): Promise<Frame> {
      const match = (frame: Frame) => frame.type === type && (stream === undefined || frame.stream === stream);
      const index = queue.findIndex(match);
      if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]!);
      return new Promise((resolve) => waiting.push({ match, resolve }));
    },
  };
}

async function session(options: {
  handler?: TunnelHandler;
  limits?: Partial<TunnelServerLimits>;
  prepareLink?(link: MessageLink): void;
  onClose?(): void;
} = {}) {
  const [phone, serverLink] = linkPair();
  options.prepareLink?.(serverLink);
  const dh = generateKeyPair();
  const handler = options.handler ?? {
    fetch: async () => new Response('ok'),
    openWebSocket: () => null,
  };
  const server = serveTunnel(serverLink, {
    identity: { serverId, dh }, handler, peer: { ip: '192.0.2.1', via: 'relay' },
    limits: options.limits, onClose: options.onClose,
  });
  cleanups.push(server.close);
  const client = await openChannel(phone, { serverId, serverPublicKey: dh.publicKey });
  cleanups.push(() => client.close());
  const frames = inbox(client);
  const request = (stream: number, head: unknown = { method: 'GET', path: '/api/test', headers: [] }) => {
    client.send({ type: TunnelFrameType.Request, stream, payload: encodeJson(head) });
  };
  const end = (stream: number) => client.send({ type: TunnelFrameType.RequestEnd, stream, payload: EMPTY });
  return { client, frames, server, phone, serverLink, request, end };
}

describe('tunnel server validation and ownership', () => {
  it.each([
    { method: 'GET', path: '/api/../private', headers: [] },
    { method: 'GET', path: 'http://evil.invalid/api/test', headers: [] },
    { method: 'GET', path: '//evil.invalid/api/test', headers: [] },
    { method: 'GET', path: '/api/test#hidden', headers: [] },
    { method: 'TRACE', path: '/api/test', headers: [] },
    { method: 'get', path: '/api/test', headers: [] },
    { method: 'GET', path: '/api/test', headers: [['x-test', 'one\r\ntwo']] },
    { method: 'GET', path: '/api/test', headers: [['x-test', 123]] },
    { method: 'GET', path: '/api/test', headers: Array.from({ length: 65 }, () => ['x-test', 'yes']) },
    { method: 'GET', path: '/api/test', headers: [], extra: true },
    null,
  ])('resets malformed request heads without dispatching: %j', async (head) => {
    const fetch = vi.fn(async () => new Response('must not run'));
    const { client, frames, request } = await session({ handler: { fetch, openWebSocket: () => null } });
    request(1, head);
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 1)).payload).code).toBe('bad_request');
    expect(fetch).not.toHaveBeenCalled();
    expect(client.closed).toBe(false);
  });

  it('limits encoded head bytes and rejects invalid header names even when they would be discarded', async () => {
    const { frames, request } = await session({ limits: { maxHeaderBytes: 80 } });
    request(1, { method: 'GET', path: '/api/test', headers: [['x-big', 'x'.repeat(100)]] });
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 1)).payload).code).toBe('bad_request');
    request(2, { method: 'GET', path: '/api/test', headers: [['host ', 'evil']] });
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 2)).payload).code).toBe('bad_request');
  });

  it('canonicalizes paths, strips all trust headers and preserves ordinary duplicates', async () => {
    let dispatched: Request | undefined;
    const { frames, request, end } = await session({
      handler: {
        fetch: async (value, peer) => {
          dispatched = value;
          expect(peer).toEqual({ ip: '192.0.2.1', via: 'relay' });
          return new Response(null, { status: 204 });
        },
        openWebSocket: () => null,
      },
    });
    const blocked = ['host', 'connection', 'upgrade', 'forwarded', 'x-forwarded-for',
      'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'content-length', 'transfer-encoding', 'expect'];
    request(1, {
      method: 'GET', path: '/api/x/../test?q=hello',
      headers: [...blocked.map((name) => [name.toUpperCase(), 'forged']), ['x-test', 'a'], ['x-test', 'b']],
    });
    end(1);
    await frames.next(TunnelFrameType.ResponseEnd, 1);
    expect(dispatched!.url).toBe('http://tunnel.invalid/api/test?q=hello');
    for (const name of blocked) expect(dispatched!.headers.has(name)).toBe(false);
    expect(dispatched!.headers.get('x-test')).toBe('a, b');
  });

  it('drops over-cap request bodies and makes that stream slot available again', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const { client, frames, request, end } = await session({
      handler: { fetch, openWebSocket: () => null },
      limits: { maxStreams: 1, maxRequestBodyBytes: 4 },
    });
    request(1, { method: 'POST', path: '/api/test', headers: [] });
    client.send({ type: TunnelFrameType.RequestBody, stream: 1, payload: new Uint8Array(5) });
    end(1);
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 1)).payload).code).toBe('too_large');
    expect(fetch).not.toHaveBeenCalled();
    request(2);
    end(2);
    await frames.next(TunnelFrameType.ResponseEnd, 2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('caps request bodies buffered across streams and frees the budget on dispatch or reset', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const { client, frames, request, end } = await session({
      handler: { fetch, openWebSocket: () => null },
      limits: { maxRequestBodyBytes: 8, maxBufferedBodyBytes: 10 },
    });
    const body = (stream: number, size: number) => client.send({ type: TunnelFrameType.RequestBody, stream, payload: new Uint8Array(size) });
    request(1, { method: 'POST', path: '/api/test', headers: [] });
    request(2, { method: 'POST', path: '/api/test', headers: [] });
    body(1, 6);
    body(2, 6);
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 2)).payload).code).toBe('limit');
    end(1);
    await frames.next(TunnelFrameType.ResponseEnd, 1);
    request(3, { method: 'POST', path: '/api/test', headers: [] });
    request(4, { method: 'POST', path: '/api/test', headers: [] });
    body(3, 5);
    body(4, 5);
    end(3);
    end(4);
    await frames.next(TunnelFrameType.ResponseEnd, 3);
    await frames.next(TunnelFrameType.ResponseEnd, 4);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('holds request slots until completion and releases them on Reset', async () => {
    const { client, frames, request, end } = await session({ limits: { maxStreams: 1 } });
    request(1);
    request(2);
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 2)).payload).code).toBe('limit');
    client.send({ type: TunnelFrameType.Reset, stream: 1, payload: encodeJson({ code: 'aborted' }) });
    request(3);
    end(3);
    await frames.next(TunnelFrameType.ResponseEnd, 3);
    expect(client.closed).toBe(false);
  });

  it('closes duplicate stream creation across HTTP and WebSockets with ProtocolError', async () => {
    let closeCode = 0;
    const { client, request } = await session({ prepareLink(link) {
      const close = link.close.bind(link);
      link.close = (code, reason) => { closeCode = code!; close(code, reason); };
    } });
    request(1);
    client.send({ type: TunnelFrameType.WsOpen, stream: 1, payload: encodeJson({ path: '/api/ws' }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.closed).toBe(true);
    expect(closeCode).toBe(TunnelCloseCode.ProtocolError);
  });

  it('returns 500 for a throwing handler and internal Reset for a failed response stream', async () => {
    const { frames, request, end } = await session({ handler: {
      fetch: async (value) => {
        if (new URL(value.url).pathname.endsWith('throw')) throw new Error('private details');
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')); } }));
      },
      openWebSocket: () => null,
    } });
    request(1, { method: 'GET', path: '/api/throw', headers: [] });
    end(1);
    expect(decodeJson<{ status: number }>((await frames.next(TunnelFrameType.Response, 1)).payload).status).toBe(500);
    await frames.next(TunnelFrameType.ResponseEnd, 1);
    request(2);
    end(2);
    expect(decodeJson<{ status: number }>((await frames.next(TunnelFrameType.Response, 2)).payload).status).toBe(200);
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 2)).payload).code).toBe('internal');
  });

  it('aborts request signals and cancels body readers on Reset or session close', async () => {
    const signals: AbortSignal[] = [];
    const canceled = vi.fn();
    const { client, frames, request, end, server } = await session({ handler: {
      fetch: async (value) => {
        signals.push(value.signal);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array([1])); },
          cancel: canceled,
        }));
      },
      openWebSocket: () => null,
    } });
    request(1);
    end(1);
    await frames.next(TunnelFrameType.ResponseBody, 1);
    client.send({ type: TunnelFrameType.Reset, stream: 1, payload: encodeJson({ code: 'aborted' }) });
    await Promise.resolve();
    expect(signals[0]!.aborted).toBe(true);
    expect(canceled).toHaveBeenCalledOnce();
    request(2);
    end(2);
    await frames.next(TunnelFrameType.ResponseBody, 2);
    server.close();
    expect(signals[1]!.aborted).toBe(true);
    expect(canceled).toHaveBeenCalledTimes(2);
  });

  it('waits for backpressure before reading and splits large response chunks', async () => {
    let buffered = 2 * 1024 * 1024;
    let pulls = 0;
    const { frames, request, end } = await session({
      prepareLink: (link) => Object.defineProperty(link, 'bufferedAmount', { get: () => buffered }),
      handler: {
        fetch: async () => new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(TUNNEL_BODY_CHUNK * 2 + 1));
            controller.close();
          },
        }, { highWaterMark: 0 })),
        openWebSocket: () => null,
      },
    });
    request(1);
    end(1);
    await frames.next(TunnelFrameType.Response, 1);
    expect(pulls).toBe(0);
    buffered = 0;
    expect((await frames.next(TunnelFrameType.ResponseBody, 1)).payload.byteLength).toBe(TUNNEL_BODY_CHUNK);
    expect((await frames.next(TunnelFrameType.ResponseBody, 1)).payload.byteLength).toBe(TUNNEL_BODY_CHUNK);
    expect((await frames.next(TunnelFrameType.ResponseBody, 1)).payload.byteLength).toBe(1);
    await frames.next(TunnelFrameType.ResponseEnd, 1);
    expect(pulls).toBe(1);
  });

  it('restricts WsOpen to the API event endpoint and enforces its separate capacity', async () => {
    const openWebSocket = vi.fn(() => ({ message() {}, close() {} }));
    const { client, frames } = await session({
      handler: { fetch: async () => new Response(), openWebSocket },
      limits: { maxWebSockets: 1 },
    });
    client.send({ type: TunnelFrameType.WsOpen, stream: 1, payload: encodeJson({ path: '/private' }) });
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 1)).payload).code).toBe('not_found');
    expect(openWebSocket).not.toHaveBeenCalled();
    client.send({ type: TunnelFrameType.WsOpen, stream: 2, payload: encodeJson({ path: '/api/ws' }) });
    await frames.next(TunnelFrameType.WsOpened, 2);
    client.send({ type: TunnelFrameType.WsOpen, stream: 3, payload: encodeJson({ path: '/api/ws' }) });
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 3)).payload).code).toBe('limit');
    expect(openWebSocket).toHaveBeenCalledOnce();
  });

  it('resets an oversized WebSocket message and keeps the tunnel open', async () => {
    const sockets: TunnelSocket[] = [];
    const handlerClosed = [vi.fn(), vi.fn()];
    const onClose = vi.fn();
    const { client, frames, request, end } = await session({ onClose, handler: {
      fetch: async () => new Response('ok'),
      openWebSocket: (_path, _peer, socket) => {
        const close = handlerClosed[sockets.length]!;
        sockets.push(socket);
        return { message(text) { socket.send(text); }, close };
      },
    } });
    for (const stream of [1, 2]) {
      const opened = frames.next(TunnelFrameType.WsOpened, stream);
      client.send({ type: TunnelFrameType.WsOpen, stream, payload: encodeJson({ path: '/api/ws' }) });
      await opened;
    }
    request(3);

    const maxPayload = TUNNEL_MAX_FRAME - TUNNEL_FRAME_HEADER;
    const message = 'x'.repeat(maxPayload);
    const delivered = frames.next(TunnelFrameType.WsMessage, 1);
    sockets[0]!.send(message);
    expect(new TextDecoder().decode((await delivered).payload)).toBe(message);

    // ASCII is one byte per character, so this is one byte over the payload limit.
    const reset = frames.next(TunnelFrameType.Reset, 1);
    sockets[0]!.send(message + 'x');
    expect(handlerClosed[0]).toHaveBeenCalledExactlyOnceWith(1009, 'Message too large');
    expect(decodeJson<TunnelReset>((await reset).payload).code).toBe('too_large');
    expect(client.closed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(handlerClosed[1]).not.toHaveBeenCalled();

    const echo = frames.next(TunnelFrameType.WsMessage, 2);
    client.send({ type: TunnelFrameType.WsMessage, stream: 2, payload: new TextEncoder().encode('still connected') });
    expect(new TextDecoder().decode((await echo).payload)).toBe('still connected');
    const response = frames.next(TunnelFrameType.ResponseEnd, 3);
    end(3);
    await response;
    expect(client.closed).toBe(false);
    expect(handlerClosed[1]).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('applies the WebSocket payload limit to UTF-8 bytes rather than characters', async () => {
    let serverSocket: TunnelSocket | undefined;
    const handlerClosed = vi.fn();
    const { client, frames } = await session({ handler: {
      fetch: async () => new Response(),
      openWebSocket: (_path, _peer, socket) => {
        serverSocket = socket;
        return { message() {}, close: handlerClosed };
      },
    } });
    const opened = frames.next(TunnelFrameType.WsOpened, 1);
    client.send({ type: TunnelFrameType.WsOpen, stream: 1, payload: encodeJson({ path: '/api/ws' }) });
    await opened;

    // Each é takes two UTF-8 bytes; the extra ASCII byte puts the message just over the limit.
    const message = 'é'.repeat((TUNNEL_MAX_FRAME - TUNNEL_FRAME_HEADER) / 2);
    const delivered = frames.next(TunnelFrameType.WsMessage, 1);
    serverSocket!.send(message);
    expect(new TextDecoder().decode((await delivered).payload)).toBe(message);
    const reset = frames.next(TunnelFrameType.Reset, 1);
    serverSocket!.send(message + 'x');
    expect(handlerClosed).toHaveBeenCalledExactlyOnceWith(1009, 'Message too large');
    expect(decodeJson<TunnelReset>((await reset).payload).code).toBe('too_large');
    expect(client.closed).toBe(false);
  });

  it('sends WsOpened before synchronous handler messages, isolates throws, and closes handlers once', async () => {
    let serverSocket: TunnelSocket | undefined;
    const handlerClosed = vi.fn();
    const onClose = vi.fn();
    const { client, frames, server } = await session({ onClose, handler: {
      fetch: async () => new Response(),
      openWebSocket: (_path, _peer, socket) => {
        serverSocket = socket;
        socket.send('welcome');
        return { message() { throw new Error('message failed'); }, close: handlerClosed };
      },
    } });
    client.send({ type: TunnelFrameType.WsOpen, stream: 1, payload: encodeJson({ path: '/api/ws' }) });
    await frames.next(TunnelFrameType.WsOpened, 1);
    expect(new TextDecoder().decode((await frames.next(TunnelFrameType.WsMessage, 1)).payload)).toBe('welcome');
    client.send({ type: TunnelFrameType.WsMessage, stream: 1, payload: new TextEncoder().encode('throw') });
    expect(decodeJson<TunnelReset>((await frames.next(TunnelFrameType.Reset, 1)).payload).code).toBe('internal');
    expect(handlerClosed).toHaveBeenCalledWith(1011, 'WebSocket handler failed');
    serverSocket!.close(1000, 'already closed');
    server.close();
    server.close();
    expect(handlerClosed).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes every remaining WebSocket handler with 1006 when the session ends', async () => {
    const handlerClosed = vi.fn((_code: number, _reason: string) => { throw new Error('cleanup failed'); });
    const onClose = vi.fn();
    const { client, frames, server } = await session({ onClose, handler: {
      fetch: async () => new Response(),
      openWebSocket: () => ({ message() {}, close: handlerClosed }),
    } });
    for (const stream of [1, 2]) {
      client.send({ type: TunnelFrameType.WsOpen, stream, payload: encodeJson({ path: '/api/ws' }) });
      await frames.next(TunnelFrameType.WsOpened, stream);
    }
    server.close();
    expect(handlerClosed).toHaveBeenCalledTimes(2);
    expect(handlerClosed.mock.calls.every((call) => call[0] === 1006)).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('cleans up a WebSocket whose opening handler synchronously ends the session', async () => {
    let shutdown: (() => void) | undefined;
    const handlerClosed = vi.fn();
    const { client, server } = await session({ handler: {
      fetch: async () => new Response(),
      openWebSocket: () => {
        shutdown!();
        return { message() {}, close: handlerClosed };
      },
    } });
    shutdown = server.close;
    const closed = new Promise<void>((resolve) => { client.onClose = () => resolve(); });
    client.send({ type: TunnelFrameType.WsOpen, stream: 1, payload: encodeJson({ path: '/api/ws' }) });
    await closed;
    expect(handlerClosed).toHaveBeenCalledExactlyOnceWith(1006, 'Tunnel session closed');
  });

  it('echoes opaque Ping payloads and closes idle sessions', async () => {
    const { client, frames } = await session({ limits: { idleTimeoutMs: 20 } });
    client.send({ type: TunnelFrameType.Ping, stream: 0, payload: new Uint8Array([42]) });
    expect((await frames.next(TunnelFrameType.Pong, 0)).payload).toEqual(new Uint8Array([42]));
    await new Promise<void>((resolve) => { client.onClose = () => resolve(); });
    expect(client.closed).toBe(true);
  });

  it('expires incomplete handshakes and reports server closure exactly once', async () => {
    const [phone, serverLink] = linkPair();
    const onClose = vi.fn();
    const dh = generateKeyPair();
    const server = serveTunnel(serverLink, {
      identity: { serverId, dh },
      peer: { ip: '192.0.2.1', via: 'lan' },
      handler: { fetch: async () => new Response(), openWebSocket: () => null },
      limits: { handshakeTimeoutMs: 5 }, onClose,
    });
    cleanups.push(server.close);
    const code = await new Promise<number>((resolve) => { phone.onClose = resolve; });
    await Promise.resolve();
    expect(code).toBe(TunnelCloseCode.ProtocolError);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('resets the WebSocket stream and keeps the tunnel open when the outbound buffer limit is exceeded', async () => {
    let serverSocket: TunnelSocket | undefined;
    const handlerClosed = vi.fn();
    const onClose = vi.fn();
    const { client, frames, serverLink } = await session({ onClose,
      prepareLink: (link) => Object.defineProperty(link, 'bufferedAmount', { get: () => 2 * 1024 * 1024 }),
      handler: {
        fetch: async () => new Response(),
        openWebSocket: (_path, _peer, socket) => {
          serverSocket = socket;
          return { message() {}, close: handlerClosed };
        },
      },
    });
    const opened = frames.next(TunnelFrameType.WsOpened, 1);
    client.send({ type: TunnelFrameType.WsOpen, stream: 1, payload: encodeJson({ path: '/api/ws' }) });
    await opened;
    const sent = vi.spyOn(serverLink, 'send');

    const maxPayload = TUNNEL_MAX_FRAME - TUNNEL_FRAME_HEADER;
    const text = 'x'.repeat(maxPayload);
    const reset = frames.next(TunnelFrameType.Reset, 1);
    for (let i = 0; i < 1000; i++) serverSocket!.send(text);
    expect(decodeJson<TunnelReset>((await reset).payload).code).toBe('limit');
    expect(sent.mock.calls.length).toBeLessThan(1000);
    expect(handlerClosed).toHaveBeenCalledExactlyOnceWith(1013, expect.stringMatching(/\S/));
    expect(client.closed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
