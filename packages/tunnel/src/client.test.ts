import { afterEach, describe, expect, it, vi } from 'vitest';
import { TUNNEL_BODY_CHUNK, TunnelFrameType } from '@neo/protocol';
import type { TunnelReset } from '@neo/protocol';
import { toBase64Url } from './bytes.js';
import { acceptChannel } from './channel.js';
import * as channels from './channel.js';
import type { SecureChannel } from './channel.js';
import { createTunnelTransport } from './client.js';
import { decodeJson, encodeJson } from './frames.js';
import type { Frame } from './frames.js';
import { generateServerIdentity } from './identity.js';
import type { ServerIdentity } from './identity.js';
import { linkPair } from './link.js';
import type { MessageLink, WebSocketLike } from './link.js';
import { generateKeyPair } from './noise.js';
import { serveTunnel } from './server.js';
import * as links from './link.js';

const cleanup: (() => void)[] = [];
const EMPTY = new Uint8Array();
const BODY_QUEUE_BUDGET = 4 * 1024 * 1024;
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) close();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function environment(input: {
  accept: (link: MessageLink, identity: ServerIdentity) => { close(): void };
}) {
  const identity = generateServerIdentity();
  const peers: { close(): void }[] = [];
  class FakeSocket implements WebSocketLike {
    readyState = 0;
    binaryType = 'blob';
    bufferedAmount = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private link: MessageLink | null = null;
    constructor(_url: string) {
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        const [phone, server] = linkPair();
        this.link = phone;
        phone.onMessage = bytes => this.onmessage?.({ data: bytes.slice().buffer });
        phone.onClose = (code, reason) => this.finished(code, reason);
        peers.push(input.accept(server, identity));
        this.readyState = 1;
        this.onopen?.(new Event('open'));
      });
      cleanup.push(() => this.close());
    }
    send(bytes: Uint8Array) {
      if (this.readyState !== 1) throw new Error('Not open');
      this.link!.send(bytes);
    }
    close(code = 1000, reason = '') {
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
      serverId: identity.serverId, publicKey: toBase64Url(identity.dh.publicKey),
      lan: ['lan:7778'], relay: null,
    },
    WebSocket: FakeSocket,
  });
  cleanup.push(() => { transport.close(); for (const peer of peers) peer.close(); });
  return { transport };
}

async function streamingResponse() {
  let channel!: SecureChannel;
  let stream = 0;
  let observe: ((frame: Frame) => void) | null = null;
  const { transport } = environment({ accept(link, identity) {
    void acceptChannel(link, { serverId: identity.serverId, staticKey: identity.dh }).then(value => {
      channel = value;
      channel.onFrame = frame => {
        if (frame.type === TunnelFrameType.RequestEnd) {
          stream = frame.stream;
          channel.send({ type: TunnelFrameType.Response, stream, payload: encodeJson({ status: 200, headers: [] }) });
        } else if (frame.type === TunnelFrameType.Reset || frame.type === TunnelFrameType.Pong) {
          const listener = observe;
          observe = null;
          listener?.(frame);
        }
      };
    }).catch(() => {});
    return { close() { link.close(); } };
  } });
  const response = await transport.fetch(`${transport.baseUrl}/api/stream`);
  return {
    transport, response, channel, stream,
    nextControl(): Promise<Frame> { return new Promise(resolve => { observe = resolve; }); },
  };
}

const uploadServerId = '0123456789abcdef0123456789abcdef';

async function session() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const [phone, serverLink] = linkPair();
  const dh = generateKeyPair();
  const handler = vi.fn(async (request: Request) => new Response(await request.arrayBuffer()));
  const server = serveTunnel(serverLink, {
    identity: { serverId: uploadServerId, dh },
    handler: { fetch: handler, openWebSocket: () => null },
    peer: { ip: '192.0.2.1', via: 'lan' },
  });
  cleanups.push(server.close);

  let client!: SecureChannel;
  const openChannel = channels.openChannel;
  vi.spyOn(channels, 'openChannel').mockImplementation(async (link, options) => {
    client = await openChannel(link, options);
    return client;
  });

  class FakeSocket implements WebSocketLike {
    readyState = 1;
    binaryType = 'blob';
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    get bufferedAmount() { return phone.bufferedAmount; }
    constructor(_url: string) {
      phone.onMessage = (data) => this.onmessage?.({ data });
      phone.onClose = (code, reason) => {
        this.readyState = 3;
        this.onclose?.({ code, reason });
      };
    }
    send(data: Uint8Array) { phone.send(data); }
    close(code?: number, reason?: string) {
      this.readyState = 3;
      phone.close(code, reason);
    }
  }

  const transport = createTunnelTransport({
    route: { serverId: uploadServerId, publicKey: toBase64Url(dh.publicKey), lan: ['lan:7778'], relay: null },
    WebSocket: FakeSocket,
  });
  cleanups.push(() => transport.close());
  await transport.connect();
  return { transport, client, handler };
}

function stallUpload(client: SecureChannel, after: number) {
  let buffered = 0;
  const bufferedAmount = vi.spyOn(client, 'bufferedAmount', 'get').mockImplementation(() => buffered);
  const frames: Frame[] = [];
  let bodyCount = 0;
  let bodySent!: () => void;
  const stalled = new Promise<void>((resolve) => { bodySent = resolve; });
  let release!: () => void;
  const drained = new Promise<void>((resolve) => { release = resolve; }).then(() => { buffered = 0; });
  const send = client.send.bind(client);
  vi.spyOn(client, 'send').mockImplementation((frame) => {
    send(frame);
    if (frame.type !== TunnelFrameType.RequestBody && frame.type !== TunnelFrameType.RequestEnd) return;
    frames.push(frame);
    if (frame.type === TunnelFrameType.RequestBody && ++bodyCount === after) {
      buffered = 2 * 1024 * 1024;
      bodySent();
    }
  });
  return { frames, stalled, release, drained, bufferedAmount };
}

describe('tunnel client response body budget', () => {
  it.each(['never', 'slow'] as const)('resets an over-budget response for a %s reader and errors its body', async kind => {
    const { transport, response, channel, stream, nextControl } = await streamingResponse();
    const payload = new Uint8Array(TUNNEL_BODY_CHUNK);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    if (kind === 'slow') {
      reader = response.body!.getReader();
      const first = reader.read();
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
      expect((await first).value).toEqual(payload);
    }
    const received = nextControl();
    // For the slow-reader case one extra chunk is needed: the pending read absorbs
    // the first flood chunk directly (bypassing the queue), so the queue fills from
    // the second chunk onward and needs one more to exceed the budget.
    const flood = Math.floor(BODY_QUEUE_BUDGET / payload.length) + 1 + (kind === 'slow' ? 1 : 0);
    for (let index = 0; index < flood; index++) {
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
    }
    // Pong proves the flood was delivered if the client fails to send Reset.
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    const reset = await received;
    expect(reset.type).toBe(TunnelFrameType.Reset);
    expect(reset.stream).toBe(stream);
    expect(decodeJson<TunnelReset>(reset.payload)).toEqual({ code: 'limit' });
    reader ??= response.body!.getReader();
    await expect(reader.read()).rejects.toEqual(new TypeError('Response body too large'));

    const alive = nextControl();
    channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    expect((await alive).type).toBe(TunnelFrameType.Pong);
    expect(channel.closed).toBe(false);
    expect(transport.via).toBe('lan');
  });

  it('allows a response exactly at the byte budget', async () => {
    const { response, channel, stream, nextControl } = await streamingResponse();
    const payload = new Uint8Array(TUNNEL_BODY_CHUNK);
    const received = nextControl();
    for (let index = 0; index < BODY_QUEUE_BUDGET / payload.length; index++) {
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
    }
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    expect((await received).type).toBe(TunnelFrameType.Pong);
    expect((await response.arrayBuffer()).byteLength).toBe(BODY_QUEUE_BUDGET);
  });

  it('allows a fast reader to receive more than the budget in total', async () => {
    // A reader that consumes each chunk before the next arrives keeps the queue
    // empty throughout; the total bytes received may far exceed the budget without
    // triggering a reset.  This covers legitimate large responses such as memory
    // exports with embeddings and long SSE streams.
    const { response, channel, stream } = await streamingResponse();
    const payload = new Uint8Array(TUNNEL_BODY_CHUNK);
    const reader = response.body!.getReader();
    const count = Math.floor(BODY_QUEUE_BUDGET / payload.length) * 2; // 2× budget
    let totalReceived = 0;
    for (let index = 0; index < count; index++) {
      // Read is pending before the send so the chunk bypasses the queue and the
      // budget check never fires regardless of how many chunks are delivered.
      const pending = reader.read();
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
      const { value } = await pending;
      totalReceived += value!.byteLength;
    }
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(totalReceived).toBe(count * payload.length);
  });
});

describe('tunnel client upload abort body cancellation', () => {
  it('cancels request.body when aborted before connectSession resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let cancelSpyResolve!: (reason: unknown) => void;
    const cancelCalled = new Promise<unknown>((resolve) => { cancelSpyResolve = resolve; });
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) { cancelSpyResolve(reason); },
    });

    const openChannel = vi.spyOn(channels, 'openChannel').mockReturnValue(new Promise(() => {}));
    const dh = generateKeyPair();
    class ImmediateSocket implements WebSocketLike {
      readyState = 1;
      binaryType = 'blob';
      get bufferedAmount() { return 0; }
      onopen: WebSocketLike['onopen'] = null;
      onmessage: WebSocketLike['onmessage'] = null;
      onclose: WebSocketLike['onclose'] = null;
      onerror: WebSocketLike['onerror'] = null;
      send() {}
      close() { this.readyState = 3; }
    }
    const transport = createTunnelTransport({
      route: { serverId: uploadServerId, publicKey: toBase64Url(dh.publicKey), lan: ['lan:7778'], relay: null },
      WebSocket: ImmediateSocket,
    });
    cleanups.push(() => transport.close());

    const abort = new AbortController();
    const response = transport.fetch(`${transport.baseUrl}/api/upload`, {
      method: 'POST', body, duplex: 'half', signal: abort.signal,
    } as RequestInit);
    void response.catch(() => {});

    // Reach the stalled handshake before aborting, while no body reader exists.
    await Promise.resolve();
    expect(openChannel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    const reason = new DOMException('User abort', 'AbortError');
    abort.abort(reason);
    await Promise.resolve();
    await Promise.resolve();

    expect(await cancelCalled).toBe(reason);
    await expect(response).rejects.toBe(reason);
  });
});

describe('tunnel client upload backpressure', () => {
  it.each([1, 4])('waits for the queue to drain after body chunk %i before sending more body or RequestEnd', async (after) => {
    const { transport, client, handler } = await session();
    const { frames, stalled, release, drained } = stallUpload(client, after);
    const body = new Uint8Array(TUNNEL_BODY_CHUNK * 4);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;

    const response = transport.fetch(`${transport.baseUrl}/api/echo`, { method: 'POST', body });
    // Cleanup can reject this promise if the regression assertion fails first.
    void response.catch(() => {});
    await stalled;
    // The old synchronous loop sends all four chunks and RequestEnd before this resumes.
    expect(frames.map(frame => frame.type)).toEqual(Array(after).fill(TunnelFrameType.RequestBody));
    await vi.advanceTimersByTimeAsync(30);
    expect(frames.map(frame => frame.type)).toEqual(Array(after).fill(TunnelFrameType.RequestBody));
    expect(handler).not.toHaveBeenCalled();

    release();
    await drained;
    await vi.advanceTimersByTimeAsync(10);
    expect(new Uint8Array(await (await response).arrayBuffer())).toEqual(body);
    expect(frames.map(frame => frame.type)).toEqual([
      ...Array(4).fill(TunnelFrameType.RequestBody), TunnelFrameType.RequestEnd,
    ]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('stops draining and sends no further upload frames when aborted while the queue is full', async () => {
    const { transport, client, handler } = await session();
    const { frames, stalled, bufferedAmount } = stallUpload(client, 1);
    const abort = new AbortController();
    const response = transport.fetch(`${transport.baseUrl}/api/echo`, {
      method: 'POST', body: new Uint8Array(TUNNEL_BODY_CHUNK * 4), signal: abort.signal,
    });
    void response.catch(() => {});
    await stalled;
    expect(frames.map(frame => frame.type)).toEqual([TunnelFrameType.RequestBody]);
    const rejected = expect(response).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await rejected;

    const reads = bufferedAmount.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30);
    expect(bufferedAmount).toHaveBeenCalledTimes(reads);
    expect(frames.map(frame => frame.type)).toEqual([TunnelFrameType.RequestBody]);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('tunnel client abort race', () => {
  it('rejects with the caller\'s abort reason when Reset send closes the channel', async () => {
    const { transport, client, handler } = await session();

    let notifyHandlerCalled!: () => void;
    const handlerReady = new Promise<void>(resolve => { notifyHandlerCalled = resolve; });
    handler.mockImplementation(async () => {
      notifyHandlerCalled();
      return new Promise<Response>(() => {});
    });

    const origSend = client.send.bind(client);
    vi.spyOn(client, 'send').mockImplementation(frame => {
      if (frame.type === TunnelFrameType.Reset) throw new Error('Reset failed');
      return origSend(frame);
    });

    const abort = new AbortController();
    const fetchPromise = transport.fetch(`${transport.baseUrl}/api/test`, { signal: abort.signal });
    void fetchPromise.catch(() => {});

    await handlerReady;

    const reason = new Error('Stopped');
    abort.abort(reason);
    await expect(fetchPromise).rejects.toBe(reason);
  });

  it('body reader throws abort reason when aborted after ResponseEnd', async () => {
    let serverChannel!: SecureChannel;
    let streamId = 0;

    const { transport } = environment({ accept(link, identity) {
      void acceptChannel(link, { serverId: identity.serverId, staticKey: identity.dh }).then(ch => {
        serverChannel = ch;
        ch.onFrame = frame => {
          if (frame.type === TunnelFrameType.RequestEnd) {
            streamId = frame.stream;
            ch.send({ type: TunnelFrameType.Response, stream: streamId,
              payload: encodeJson({ status: 200, headers: [] }) });
          }
        };
      }).catch(() => {});
      return { close() { link.close(); } };
    } });

    const abort = new AbortController();
    const response = await transport.fetch(`${transport.baseUrl}/api/test`, { signal: abort.signal });

    const bodyPayload = new Uint8Array([1, 2, 3]);
    serverChannel.send({ type: TunnelFrameType.ResponseBody, stream: streamId, payload: bodyPayload });
    serverChannel.send({ type: TunnelFrameType.ResponseEnd, stream: streamId, payload: EMPTY });

    // Deliver both frames to the client (each linkPair.send queues one microtask).
    await Promise.resolve();

    const reader = response.body!.getReader();
    const reason = new DOMException('Aborted', 'AbortError');
    abort.abort(reason);

    await expect(reader.read()).rejects.toBe(reason);
  });
});

describe('tunnel client handshake budget is monotonic', () => {
  it('uses the elapsed-time budget when Date.now() jumps forward before openChannel', async () => {
    const connectTimeoutMs = 5_000;
    // Fake wall-clock time and timers, leaving performance.now() monotonic.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(0);

    const [phone, serverLink] = linkPair();
    const dh = generateKeyPair();
    const server = serveTunnel(serverLink, {
      identity: { serverId: uploadServerId, dh },
      handler: { fetch: vi.fn(async () => new Response()), openWebSocket: () => null },
      peer: { ip: '192.0.2.1', via: 'lan' },
    });
    cleanups.push(server.close);

    let capturedTimeoutMs: number | undefined;
    let handshakeError: unknown;
    const realOpenChannel = channels.openChannel;
    vi.spyOn(channels, 'openChannel').mockImplementation(async (link, options) => {
      capturedTimeoutMs = options.timeoutMs;
      try {
        return await realOpenChannel(link, options);
      } catch (error) {
        handshakeError = error;
        throw error;
      }
    });

    const realWebSocketLink = links.webSocketLink;
    vi.spyOn(links, 'webSocketLink').mockImplementation((socket) => {
      vi.setSystemTime(connectTimeoutMs + 1_000);
      return realWebSocketLink(socket);
    });

    let releaseHandshake!: () => void;
    let handshakeSent!: () => void;
    const sent = new Promise<void>((resolve) => { handshakeSent = resolve; });
    class FakeSocket implements WebSocketLike {
      readyState = 1;
      binaryType = 'blob';
      onmessage: WebSocketLike['onmessage'] = null;
      onclose: WebSocketLike['onclose'] = null;
      onerror: WebSocketLike['onerror'] = null;
      onopen: WebSocketLike['onopen'] = null;
      get bufferedAmount() { return phone.bufferedAmount; }
      constructor(_url: string) {
        phone.onMessage = (data) => this.onmessage?.({ data });
        phone.onClose = (code, reason) => {
          this.readyState = 3;
          this.onclose?.({ code, reason });
        };
      }
      send(data: Uint8Array) {
        // Keep the handshake pending so a collapsed 1-ms budget really expires.
        releaseHandshake = () => phone.send(data);
        handshakeSent();
      }
      close(code?: number, reason?: string) {
        this.readyState = 3;
        phone.close(code, reason);
      }
    }

    const transport = createTunnelTransport({
      route: { serverId: uploadServerId, publicKey: toBase64Url(dh.publicKey), lan: ['lan:7778'], relay: null },
      WebSocket: FakeSocket,
      connectTimeoutMs,
    });
    cleanups.push(() => transport.close());

    const connectP = transport.connect();
    void connectP.catch(() => {});
    await sent;
    await vi.advanceTimersByTimeAsync(1);

    expect(handshakeError, `openChannel timeoutMs: ${capturedTimeoutMs}`).toBeUndefined();
    expect(capturedTimeoutMs).toBeGreaterThan(connectTimeoutMs / 2);
    releaseHandshake();
    await expect(connectP).resolves.toBe('lan');
  });
});
