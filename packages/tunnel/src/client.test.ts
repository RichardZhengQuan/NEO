import { afterEach, describe, expect, it, vi } from 'vitest';
import { TUNNEL_BODY_CHUNK, TUNNEL_MAX_FRAME, TunnelFrameType } from '@neo/protocol';
import type { TunnelReset } from '@neo/protocol';
import { toBase64Url, utf8 } from './bytes.js';
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
  relayOnly?: boolean;
  onStatus?: (status: { state: string }) => void;
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
      lan: input.relayOnly ? [] : ['lan:7778'], relay: input.relayOnly ? 'wss://relay.example' : null,
    },
    WebSocket: FakeSocket,
    onStatus: input.onStatus,
  });
  cleanup.push(() => { transport.close(); for (const peer of peers) peer.close(); });
  return { transport };
}

function trackedAbortController() {
  const controller = new AbortController();
  const tracked = new WeakSet<AbortSignal>();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let adds = 0;
  let removes = 0;
  const getSignal = Object.getOwnPropertyDescriptor(Request.prototype, 'signal')!.get!;
  // Request derives a signal; wrap its public signal without changing abort propagation.
  vi.spyOn(Request.prototype, 'signal', 'get').mockImplementation(function(this: Request) {
    const signal = getSignal.call(this) as AbortSignal;
    if (!tracked.has(signal)) {
      tracked.add(signal);
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'abort' && listener) { adds++; listeners.add(listener); }
        add(type, listener, options);
      });
      vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
        if (type === 'abort' && listener) { removes++; listeners.delete(listener); }
        remove(type, listener, options);
      });
    }
    return signal;
  });
  return { controller, signal: controller.signal,
    get listeners() { return listeners.size; }, get adds() { return adds; }, get removes() { return removes; } };
}

async function streamingResponse(init: RequestInit = {}, status = 200, respondOn: Frame['type'] = TunnelFrameType.RequestEnd) {
  let channel!: SecureChannel;
  let stream = 0;
  let observe: { resolve(frame: Frame): void; type?: Frame['type'] } | null = null;
  const controls: Frame[] = [];
  let notifyClosed!: () => void;
  const closed = new Promise<void>(resolve => { notifyClosed = resolve; });
  const { transport } = environment({ onStatus({ state }) { if (state === 'closed') notifyClosed(); }, accept(link, identity) {
    void acceptChannel(link, { serverId: identity.serverId, staticKey: identity.dh }).then(value => {
      channel = value;
      channel.onFrame = frame => {
        if (frame.type === respondOn) {
          stream = frame.stream;
          channel.send({ type: TunnelFrameType.Response, stream, payload: encodeJson({ status, headers: [] }) });
        } else if (frame.type === TunnelFrameType.Reset || frame.type === TunnelFrameType.Pong) {
          controls.push(frame);
          if (observe?.type !== undefined && observe.type !== frame.type) return;
          const listener = observe;
          observe = null;
          listener?.resolve(frame);
        }
      };
    }).catch(() => {});
    return { close() { link.close(); } };
  } });
  const response = await transport.fetch(`${transport.baseUrl}/api/stream`, init);
  return {
    transport, response, channel, stream, controls, closed,
    nextControl(type?: Frame['type']): Promise<Frame> { return new Promise(resolve => { observe = { resolve, type }; }); },
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

async function keepaliveSession(via: 'lan' | 'relay' = 'lan') {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  let channel!: SecureChannel;
  const frames: Frame[] = [];
  const { transport } = environment({ relayOnly: via === 'relay', accept(link, identity) {
    void acceptChannel(link, { serverId: identity.serverId, staticKey: identity.dh }).then(value => {
      channel = value;
      channel.onFrame = frame => { frames.push(frame); };
    }).catch(() => {});
    return { close() { link.close(); } };
  } });
  await transport.connect();
  return { transport, channel, frames };
}

describe('tunnel client keepalive', () => {
  it.each(['lan', 'relay'] as const)('accepts a delayed Pong for the previous Ping and sends the third Ping over %s', async via => {
    const { transport, channel, frames } = await keepaliveSession(via);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(frames.map(frame => frame.payload)).toEqual([utf8('1')]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(frames.map(frame => frame.payload)).toEqual([utf8('1'), utf8('2')]);

    await vi.advanceTimersByTimeAsync(2_000);
    channel.send({ type: TunnelFrameType.Pong, stream: 0, payload: frames[0]!.payload });
    await vi.advanceTimersByTimeAsync(23_000);

    expect(channel.closed).toBe(false);
    expect(transport.via).toBe(via);
    expect(frames.map(frame => [frame.type, frame.payload])).toEqual([
      [TunnelFrameType.Ping, utf8('1')],
      [TunnelFrameType.Ping, utf8('2')],
      [TunnelFrameType.Ping, utf8('3')],
    ]);
    // Matching Ping #1 must leave Ping #2 available for its own delayed answer.
    channel.send({ type: TunnelFrameType.Pong, stream: 0, payload: frames[1]!.payload });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(channel.closed).toBe(false);
    expect(frames[3]?.payload).toEqual(utf8('4'));
  });

  it('closes after two unanswered Ping intervals', async () => {
    const { transport, channel, frames } = await keepaliveSession();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(channel.closed).toBe(true);
    expect(transport.via).toBeNull();
    expect(frames.map(frame => frame.payload)).toEqual([utf8('1'), utf8('2')]);
  });

  it.each(['', 'unknown', '3'])('ignores an unsolicited Pong with payload %j', async payload => {
    const { channel, frames } = await keepaliveSession();
    await vi.advanceTimersByTimeAsync(50_000);
    channel.send({ type: TunnelFrameType.Pong, stream: 0, payload: utf8(payload) });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(channel.closed).toBe(true);
    expect(frames).toHaveLength(2);
  });

  it('does not let an answer to a newer Ping extend an older Ping deadline', async () => {
    const { channel, frames } = await keepaliveSession();
    await vi.advanceTimersByTimeAsync(50_000);
    channel.send({ type: TunnelFrameType.Pong, stream: 0, payload: frames[1]!.payload });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(channel.closed).toBe(true);
    expect(frames).toHaveLength(2);
  });

  it('does not count a replayed Pong as another answer', async () => {
    const { channel, frames } = await keepaliveSession();
    await vi.advanceTimersByTimeAsync(25_000);
    const pong = { type: TunnelFrameType.Pong, stream: 0, payload: frames[0]!.payload };
    channel.send(pong);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(channel.closed).toBe(false);
    expect(frames).toHaveLength(3);
    channel.send(pong);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(channel.closed).toBe(true);
    expect(frames).toHaveLength(3);
  });

  it('echoes a peer Ping without counting it as an answer to a client Ping', async () => {
    const { channel, frames } = await keepaliveSession();
    await vi.advanceTimersByTimeAsync(50_000);
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: utf8('peer') });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames[2]).toEqual({ type: TunnelFrameType.Pong, stream: 0, payload: utf8('peer') });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(channel.closed).toBe(true);
    expect(frames).toHaveLength(3);
  });
});

describe('tunnel client isolates oversized stream from channel-wide failure', () => {
  it('resets an oversized WebSocket while another WebSocket and an in-flight fetch complete', async () => {
    let releaseResponse!: () => void;
    const responseReady = new Promise<void>(resolve => { releaseResponse = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    const messages: string[] = [];
    const socketCloses: ReturnType<typeof vi.fn>[] = [];
    const accept = vi.fn((link: MessageLink, identity: ServerIdentity) => serveTunnel(link, {
      identity,
      peer: { ip: '192.0.2.1', via: 'lan' },
      handler: {
        async fetch(request) {
          expect(request.headers.get('authorization')).toBe('Bearer test-token');
          requestStarted();
          await responseReady;
          return new Response('fetch completed');
        },
        openWebSocket(_path, _peer, socket) {
          let authenticated = false;
          const close = vi.fn();
          socketCloses.push(close);
          return {
            message(text) {
              if (!authenticated) {
                expect(text).toBe('auth:test-token');
                authenticated = true;
                socket.send('authenticated');
              } else {
                messages.push(text);
                socket.send(text);
              }
            },
            close,
          };
        },
      },
    }));
    const { transport } = environment({ accept });
    const url = transport.baseUrl.replace('https:', 'wss:') + '/api/ws';
    const a = new transport.WebSocket(url);
    const b = new transport.WebSocket(url);
    await Promise.all([a, b].map(socket => new Promise<void>(resolve => {
      socket.addEventListener('open', () => resolve(), { once: true });
    })));
    const authenticated = Promise.all([a, b].map(socket => new Promise<void>(resolve => {
      socket.addEventListener('message', event => {
        expect(event.data).toBe('authenticated');
        resolve();
      }, { once: true });
    })));
    a.send('auth:test-token');
    b.send('auth:test-token');
    await authenticated;

    const response = transport.fetch(`${transport.baseUrl}/api/pending`, {
      headers: { authorization: 'Bearer test-token' },
    });
    // The red check closes the channel and rejects this pending request.
    void response.catch(() => {});
    await started;

    expect(() => a.send('x'.repeat(TUNNEL_MAX_FRAME + 1))).toThrow('Frame is too large');
    expect(a.readyState).toBe(a.CLOSED);
    expect(b.readyState).toBe(b.OPEN);
    const delivered = new Promise<string>(resolve => {
      b.addEventListener('message', event => resolve(event.data), { once: true });
    });
    b.send('hello');
    expect(await delivered).toBe('hello');
    expect(messages).toEqual(['hello']);
    expect(socketCloses[0]).toHaveBeenCalledExactlyOnceWith(1006, 'WebSocket reset');
    expect(socketCloses[1]).not.toHaveBeenCalled();

    releaseResponse();
    const completed = await response;
    expect(completed.status).toBe(200);
    expect(await completed.text()).toBe('fetch completed');
    expect(transport.via).toBe('lan');
    expect(accept).toHaveBeenCalledOnce();
  });
});

describe('tunnel client abort listener lifecycle', () => {
  it.each(['text', 'reader', 'empty'] as const)('removes the listener after %s reaches EOF and never resets the completed response', async kind => {
    const abort = trackedAbortController();
    const { response, channel, stream, nextControl, controls } = await streamingResponse({ signal: abort.signal });
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([1, 1, 0]);
    const delivered = nextControl(TunnelFrameType.Pong);
    if (kind !== 'empty') {
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload: utf8('hello') });
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload: utf8(' world') });
    }
    channel.send({ type: TunnelFrameType.ResponseBody, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await delivered;
    if (kind === 'text') {
      expect(await response.text()).toBe('hello world');
    } else {
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      expect(Buffer.concat(chunks).toString()).toBe(kind === 'empty' ? '' : 'hello world');
      reader.releaseLock();
      await response.body!.cancel();
    }
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    const alive = nextControl(TunnelFrameType.Pong);
    abort.controller.abort(new Error('Already drained'));
    channel.send({ type: TunnelFrameType.Reset, stream, payload: encodeJson({ code: 'aborted' }) });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await alive;
    expect(abort.removes).toBe(1);
    expect(controls.filter(frame => frame.type === TunnelFrameType.Reset)).toHaveLength(0);
  });

  it('balances listeners across requests sharing one signal', async () => {
    const { transport } = await session();
    const abort = trackedAbortController();
    for (let index = 1; index <= 3; index++) {
      const response = await transport.fetch(`${transport.baseUrl}/api/echo`, {
        method: 'POST', body: 'shared signal', signal: abort.signal,
      });
      expect(await response.text()).toBe('shared signal');
      expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, index, index]);
    }
  });

  it.each([
    ['HEAD', 200], ['GET', 204], ['GET', 205], ['GET', 304],
  ] as const)('removes the listener when %s %i ends without a body', async (method, status) => {
    const abort = trackedAbortController();
    const { response, channel, stream, nextControl, controls } = await streamingResponse({ method, signal: abort.signal }, status);
    expect(response.body).toBeNull();
    expect(abort.listeners).toBe(1);
    const delivered = nextControl(TunnelFrameType.Pong);
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await delivered;
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    const alive = nextControl(TunnelFrameType.Pong);
    abort.controller.abort();
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await alive;
    expect(abort.removes).toBe(1);
    expect(controls.filter(frame => frame.type === TunnelFrameType.Reset)).toHaveLength(0);
  });

  it.each([101, 103])('rejects informational status %i and removes the listener', async status => {
    const abort = trackedAbortController();
    await expect(streamingResponse({ signal: abort.signal }, status)).rejects.toEqual(new TypeError('Failed to fetch'));
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
  });

  it.each(['reset', 'channel close', 'transport close', 'cancel', 'abort'] as const)('cleans up once for %s while bytes are queued before ResponseEnd', async exit => {
    const abort = trackedAbortController();
    const { transport, response, channel, stream, nextControl, controls, closed } = await streamingResponse({ signal: abort.signal });
    const delivered = nextControl(TunnelFrameType.Pong);
    channel.send({ type: TunnelFrameType.ResponseBody, stream, payload: utf8('queued') });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await delivered;
    const reason = new Error('Stopped');
    const alive = nextControl(TunnelFrameType.Pong);
    if (exit === 'reset') channel.send({ type: TunnelFrameType.Reset, stream, payload: encodeJson({ code: 'aborted' }) });
    else if (exit === 'channel close') channel.close();
    else if (exit === 'transport close') transport.close();
    else if (exit === 'cancel') await response.body!.cancel(reason);
    else abort.controller.abort(reason);
    if (exit === 'channel close' || exit === 'transport close') await closed;
    else {
      channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
      await alive;
    }
    if (exit !== 'cancel') await expect(response.text()).rejects.toEqual(exit === 'abort' ? reason : new TypeError('Failed to fetch'));
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    abort.controller.abort();
    expect(abort.removes).toBe(1);
    expect(controls.filter(frame => frame.type === TunnelFrameType.Reset)).toHaveLength(exit === 'cancel' || exit === 'abort' ? 1 : 0);
  });

  it.each(['channel', 'transport'] as const)('drains a queued response after ResponseEnd and %s close, then removes the listener', async close => {
    const abort = trackedAbortController();
    const { transport, response, channel, stream, nextControl, closed } = await streamingResponse({ signal: abort.signal });
    const delivered = nextControl(TunnelFrameType.Pong);
    channel.send({ type: TunnelFrameType.ResponseBody, stream, payload: utf8('queued') });
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await delivered;
    if (close === 'channel') channel.close();
    else transport.close();
    await closed;
    expect(abort.listeners).toBe(1);
    expect(await response.text()).toBe('queued');
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    abort.controller.abort();
    expect(abort.removes).toBe(1);
  });

  it.each(['cancel', 'abort'] as const)('cleans up a queued response on %s after ResponseEnd without sending Reset', async exit => {
    const abort = trackedAbortController();
    const { response, channel, stream, nextControl, controls } = await streamingResponse({ signal: abort.signal });
    const delivered = nextControl(TunnelFrameType.Pong);
    channel.send({ type: TunnelFrameType.ResponseBody, stream, payload: utf8('queued') });
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await delivered;
    expect(abort.listeners).toBe(1);
    const reason = new Error('Stopped');
    const alive = nextControl(TunnelFrameType.Pong);
    if (exit === 'cancel') await response.body!.cancel(reason);
    else {
      abort.controller.abort(reason);
      await expect(response.text()).rejects.toBe(reason);
    }
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await alive;
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    expect(controls.filter(frame => frame.type === TunnelFrameType.Reset)).toHaveLength(0);
  });
});

describe('tunnel client response body budget', () => {
  it.each(['never', 'slow'] as const)('resets an over-budget response for a %s reader and errors its body', async kind => {
    const abort = trackedAbortController();
    const { transport, response, channel, stream, nextControl, controls } = await streamingResponse({ signal: abort.signal });
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
    abort.controller.abort();
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    expect(controls.filter(frame => frame.type === TunnelFrameType.Reset)).toHaveLength(1);
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

    const abort = trackedAbortController();
    const response = transport.fetch(`${transport.baseUrl}/api/upload`, {
      method: 'POST', body, duplex: 'half', signal: abort.signal,
    } as RequestInit);
    void response.catch(() => {});

    // Reach the stalled handshake before aborting, while no body reader exists.
    await Promise.resolve();
    expect(openChannel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    const reason = new DOMException('User abort', 'AbortError');
    abort.controller.abort(reason);
    await Promise.resolve();
    await Promise.resolve();

    expect(await cancelCalled).toBe(reason);
    await expect(response).rejects.toBe(reason);
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
  });
});

describe('tunnel client upload backpressure', () => {
  it.each([1, 4])('waits for the queue to drain after body chunk %i before sending more body or RequestEnd', async (after) => {
    const { transport, client, handler } = await session();
    const abort = trackedAbortController();
    const { frames, stalled, release, drained } = stallUpload(client, after);
    const body = new Uint8Array(TUNNEL_BODY_CHUNK * 4);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;

    const response = transport.fetch(`${transport.baseUrl}/api/echo`, { method: 'POST', body, signal: abort.signal });
    // Cleanup can reject this promise if the regression assertion fails first.
    void response.catch(() => {});
    await stalled;
    // The old synchronous loop sends all four chunks and RequestEnd before this resumes.
    expect(frames.map(frame => frame.type)).toEqual(Array(after).fill(TunnelFrameType.RequestBody));
    await vi.advanceTimersByTimeAsync(30);
    expect(frames.map(frame => frame.type)).toEqual(Array(after).fill(TunnelFrameType.RequestBody));
    expect(handler).not.toHaveBeenCalled();
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([1, 1, 0]);

    release();
    await drained;
    await vi.advanceTimersByTimeAsync(10);
    expect(new Uint8Array(await (await response).arrayBuffer())).toEqual(body);
    expect(frames.map(frame => frame.type)).toEqual([
      ...Array(4).fill(TunnelFrameType.RequestBody), TunnelFrameType.RequestEnd,
    ]);
    expect(handler).toHaveBeenCalledOnce();
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
  });

  it('stops draining and sends no further upload frames when aborted while the queue is full', async () => {
    const { transport, client, handler } = await session();
    const { frames, stalled, bufferedAmount } = stallUpload(client, 1);
    const abort = trackedAbortController();
    const response = transport.fetch(`${transport.baseUrl}/api/echo`, {
      method: 'POST', body: new Uint8Array(TUNNEL_BODY_CHUNK * 4), signal: abort.signal,
    });
    void response.catch(() => {});
    await stalled;
    expect(frames.map(frame => frame.type)).toEqual([TunnelFrameType.RequestBody]);
    const rejected = expect(response).rejects.toMatchObject({ name: 'AbortError' });
    abort.controller.abort();
    await rejected;

    const reads = bufferedAmount.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30);
    expect(bufferedAmount).toHaveBeenCalledTimes(reads);
    expect(frames.map(frame => frame.type)).toEqual([TunnelFrameType.RequestBody]);
    expect(handler).not.toHaveBeenCalled();
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    expect(vi.mocked(client.send).mock.calls.filter(([frame]) => frame.type === TunnelFrameType.Reset)).toHaveLength(1);
  });

  it('stops the upload at an early ResponseEnd and cleans up when its queued response drains', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const abort = trackedAbortController();
    const openChannel = channels.openChannel;
    let client!: SecureChannel;
    let upload!: ReturnType<typeof stallUpload>;
    vi.spyOn(channels, 'openChannel').mockImplementation(async (link, options) => {
      client = await openChannel(link, options);
      upload = stallUpload(client, 1);
      return client;
    });
    const { response, channel, stream, nextControl, controls } = await streamingResponse({
      method: 'POST', body: new Uint8Array(TUNNEL_BODY_CHUNK * 4), signal: abort.signal,
    }, 200, TunnelFrameType.Request);
    await upload.stalled;
    const delivered = nextControl(TunnelFrameType.Pong);
    channel.send({ type: TunnelFrameType.ResponseBody, stream, payload: utf8('early response') });
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    await delivered;
    expect(abort.listeners).toBe(1);
    upload.release();
    await upload.drained;
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(client.send).mock.calls.filter(([frame]) =>
      frame.type === TunnelFrameType.RequestBody || frame.type === TunnelFrameType.RequestEnd)).toHaveLength(1);
    expect(await response.text()).toBe('early response');
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    expect(controls.filter(frame => frame.type === TunnelFrameType.Reset)).toHaveLength(0);
  });

  it.each(['read', 'chunk', 'send'] as const)('removes the listener and sends one Reset when the upload fails at %s', async failure => {
    const { transport, client, handler } = await session();
    const abort = trackedAbortController();
    const send = client.send.bind(client);
    const sent = vi.spyOn(client, 'send').mockImplementation(frame => {
      if (failure === 'send' && frame.type === TunnelFrameType.RequestBody) throw new Error('Upload failed');
      send(frame);
    });
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      if (failure === 'read') controller.error(new Error('Read failed'));
      else {
        controller.enqueue(failure === 'chunk' ? 'invalid' as unknown as Uint8Array : utf8('upload'));
        controller.close();
      }
    } });
    await expect(transport.fetch(`${transport.baseUrl}/api/upload`, {
      method: 'POST', body, duplex: 'half', signal: abort.signal,
    } as RequestInit)).rejects.toEqual(new TypeError('Failed to fetch'));
    abort.controller.abort();
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    expect(sent.mock.calls.filter(([frame]) => frame.type === TunnelFrameType.Reset)).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
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

    const abort = trackedAbortController();
    const fetchPromise = transport.fetch(`${transport.baseUrl}/api/test`, { signal: abort.signal });
    void fetchPromise.catch(() => {});

    await handlerReady;

    const reason = new Error('Stopped');
    abort.controller.abort(reason);
    await expect(fetchPromise).rejects.toBe(reason);
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    expect(vi.mocked(client.send).mock.calls.filter(([frame]) => frame.type === TunnelFrameType.Reset)).toHaveLength(1);
  });

  it('removes the listener once when cancelling the body closes the channel during Reset', async () => {
    const { transport, client, handler } = await session();
    const abort = trackedAbortController();
    handler.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(utf8('queued')); },
    })));
    const send = client.send.bind(client);
    const sent = vi.spyOn(client, 'send').mockImplementation(frame => {
      if (frame.type === TunnelFrameType.Reset) throw new Error('Reset failed');
      send(frame);
    });
    const response = await transport.fetch(`${transport.baseUrl}/api/test`, { signal: abort.signal });
    await response.body!.cancel();
    abort.controller.abort();
    expect(client.closed).toBe(true);
    expect([abort.listeners, abort.adds, abort.removes]).toEqual([0, 1, 1]);
    expect(sent.mock.calls.filter(([frame]) => frame.type === TunnelFrameType.Reset)).toHaveLength(1);
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
