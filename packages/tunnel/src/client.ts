import {
  RELAY_CONNECT_PATH, TUNNEL_BODY_CHUNK, TUNNEL_LAN_PATH, TunnelFrameType,
} from '@neo/protocol';
import type { TunnelRoute, TunnelResponseHead, TunnelReset, TunnelWsClose } from '@neo/protocol';
import { equalBytes, fromBase64Url, fromUtf8, utf8 } from './bytes.js';
import { openChannel } from './channel.js';
import type { SecureChannel } from './channel.js';
import { decodeJson, encodeJson, TunnelProtocolError } from './frames.js';
import type { Frame } from './frames.js';
import { webSocketLink } from './link.js';
import type { WebSocketLike } from './link.js';

export function tunnelBaseUrl(serverId: string): string {
  if (!/^[0-9a-f]{32}$/.test(serverId)) throw new TypeError('Invalid server id');
  return `https://${serverId}.tunnel.invalid`;
}

export interface TunnelTransportOptions {
  route: TunnelRoute;
  WebSocket?: new (url: string) => WebSocketLike;
  lanTimeoutMs?: number;
  connectTimeoutMs?: number;
  onStatus?(status: { state: 'connecting' | 'open' | 'closed'; via: 'lan' | 'relay' | null }): void;
}

export interface TunnelTransport {
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly WebSocket: typeof WebSocket;
  readonly via: 'lan' | 'relay' | null;
  connect(): Promise<'lan' | 'relay'>;
  close(): void;
}

interface Stream {
  frame(frame: Frame): void;
  fail(error: unknown): void;
}

interface Session {
  channel: SecureChannel;
  via: 'lan' | 'relay';
  nextStream: number;
  streams: Map<number, Stream>;
  pingTimer: ReturnType<typeof setInterval>;
}

const EMPTY = new Uint8Array();
const BODY_QUEUE_BUDGET = 4 * 1024 * 1024;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function networkError(): TypeError {
  return new TypeError('Failed to fetch');
}

function responseHead(payload: Uint8Array): TunnelResponseHead {
  const value = decodeJson<TunnelResponseHead>(payload);
  if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 ||
      !Array.isArray(value.headers) || !value.headers.every(pair =>
        Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === 'string'))) {
    throw new TunnelProtocolError('Invalid response head');
  }
  return value;
}

function wsClose(payload: Uint8Array): TunnelWsClose {
  const value = decodeJson<TunnelWsClose>(payload);
  if (!value || !Number.isInteger(value.code) || value.code < 1000 || value.code > 4999 ||
      [1004, 1005, 1006, 1015].includes(value.code) || typeof value.reason !== 'string' ||
      utf8(value.reason).length > 123) throw new TunnelProtocolError('Invalid WebSocket close');
  return value;
}

/** Node has MessageEvent but no CloseEvent, so the shim only depends on Event. */
class SocketCloseEvent extends Event {
  constructor(readonly code: number, readonly reason: string, readonly wasClean: boolean) {
    super('close');
  }
}

export function createTunnelTransport(options: TunnelTransportOptions): TunnelTransport {
  const route = options.route;
  const baseUrl = tunnelBaseUrl(route.serverId);
  const pinnedKey = fromBase64Url(route.publicKey);
  if (pinnedKey.length !== 32) throw new TypeError('Invalid pinned key');
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const lanTimeoutMs = options.lanTimeoutMs ?? 2500;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  if (!Number.isFinite(lanTimeoutMs) || lanTimeoutMs < 0 ||
      !Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) throw new TypeError('Invalid timeout');
  let session: Session | null = null;
  let connecting: Promise<Session> | null = null;
  let cancelConnect: (() => void) | null = null;
  let disposed = false;

  function status(state: 'connecting' | 'open' | 'closed', via: 'lan' | 'relay' | null) {
    // Defer observers until connection ownership is installed, including reentrant connect calls.
    queueMicrotask(() => {
      try { options.onStatus?.({ state, via }); } catch { /* Observers cannot interrupt cleanup. */ }
    });
  }

  function install(channel: SecureChannel, via: 'lan' | 'relay'): Session {
    let unanswered = 0;
    let ping: Uint8Array = EMPTY;
    let pingSequence = 0;
    const current: Session = {
      channel, via, nextStream: 1, streams: new Map(),
      pingTimer: setInterval(() => {
        if (unanswered >= 2) { channel.close('Keepalive timeout'); return; }
        unanswered++;
        ping = utf8(String(++pingSequence));
        try { channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: ping }); }
        catch { channel.close('Keepalive failed'); }
      }, 25_000),
    };
    channel.onFrame = frame => {
      try {
        if (frame.type === TunnelFrameType.Ping || frame.type === TunnelFrameType.Pong) {
          if (frame.stream !== 0) throw new TunnelProtocolError('Session frame on a stream');
          if (frame.type === TunnelFrameType.Pong && equalBytes(frame.payload, ping)) unanswered = 0;
          else if (frame.type === TunnelFrameType.Ping) {
            channel.send({ type: TunnelFrameType.Pong, stream: 0, payload: frame.payload });
          }
          return;
        }
        if (frame.stream === 0) throw new TunnelProtocolError('Stream frame on session');
        current.streams.get(frame.stream)?.frame(frame);
      } catch { throw new TunnelProtocolError('Invalid tunnel response'); }
    };
    channel.onClose = () => {
      clearInterval(current.pingTimer);
      for (const stream of [...current.streams.values()]) stream.fail(networkError());
      current.streams.clear();
      if (session === current) { session = null; status('closed', null); }
    };
    return current;
  }

  function attemptConnection(): Promise<Session> {
    status('connecting', null);
    return new Promise((resolve, reject) => {
      let finished = false;
      let active = 0;
      let relayStarted = false;
      const cancellations = new Set<() => void>();
      let lanTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = Date.now() + connectTimeoutMs;
      const wholeTimer = setTimeout(() => finish(null), connectTimeoutMs);

      function finish(winner: { channel: SecureChannel; via: 'lan' | 'relay'; cancel: () => void } | null) {
        if (finished) { winner?.channel.close('Connection race lost'); return; }
        finished = true;
        clearTimeout(wholeTimer);
        if (lanTimer !== undefined) clearTimeout(lanTimer);
        cancelConnect = null;
        for (const cancel of cancellations) if (cancel !== winner?.cancel) cancel();
        cancellations.clear();
        if (winner && !disposed) {
          session = install(winner.channel, winner.via);
          status('open', winner.via);
          resolve(session);
        } else {
          winner?.channel.close('Transport closed');
          status('closed', null);
          reject(networkError());
        }
      }

      function startRelay() {
        if (finished || relayStarted) return;
        relayStarted = true;
        if (route.relay) start(route.relay.replace(/\/$/, '') + RELAY_CONNECT_PATH + route.serverId, 'relay');
        if (active === 0) finish(null);
      }

      function start(url: string, via: 'lan' | 'relay') {
        active++;
        let socket: WebSocketLike | undefined;
        let channel: SecureChannel | undefined;
        let cancelled = false;
        let cancelOpen: (() => void) | undefined;
        const cancel = () => {
          cancelled = true;
          cancelOpen?.();
          try {
            if (channel) channel.close('Connection race lost');
            else socket?.close(1000, 'Connection cancelled');
          } catch { /* A socket can already be closed. */ }
        };
        cancellations.add(cancel);
        void (async () => {
          if (!Socket) throw networkError();
          socket = new Socket(url);
          await new Promise<void>((opened, failed) => {
            const cleanup = () => { socket!.onopen = null; socket!.onclose = null; socket!.onerror = null; };
            const fail = () => { cleanup(); failed(networkError()); };
            cancelOpen = fail;
            socket!.onopen = () => { cleanup(); opened(); };
            socket!.onclose = fail;
            socket!.onerror = fail;
            if (socket!.readyState === 1) { cleanup(); opened(); }
            else if (socket!.readyState > 1) fail();
          });
          cancelOpen = undefined;
          if (cancelled || finished) throw networkError();
          const link = webSocketLink(socket);
          channel = await openChannel(link, {
            serverId: route.serverId, serverPublicKey: pinnedKey,
            timeoutMs: Math.max(1, deadline - Date.now()),
          });
          if (cancelled || finished || channel.closed) { channel.close('Connection race lost'); return; }
          finish({ channel, via, cancel });
        })().catch(() => {
          cancel();
        }).finally(() => {
          cancellations.delete(cancel);
          active--;
          if (!finished && active === 0) {
            if (!relayStarted) startRelay();
            else finish(null);
          }
        });
      }

      cancelConnect = () => finish(null);
      for (const address of route.lan) start(`ws://${address}${TUNNEL_LAN_PATH}`, 'lan');
      if (route.lan.length === 0) startRelay();
      else lanTimer = setTimeout(startRelay, lanTimeoutMs);
    });
  }

  function connectSession(): Promise<Session> {
    if (disposed) return Promise.reject(networkError());
    if (session && !session.channel.closed) return Promise.resolve(session);
    if (!connecting) {
      const attempt = attemptConnection();
      connecting = attempt;
      void attempt.finally(() => { if (connecting === attempt) connecting = null; }).catch(() => {});
    }
    return connecting;
  }

  function allocate(current: Session, stream: Stream): number {
    if (current.channel.closed || current.nextStream > 0xffffffff) throw networkError();
    const id = current.nextStream++;
    current.streams.set(id, stream);
    return id;
  }

  const tunnelFetch: typeof fetch = (input, init) => {
    return new Promise<Response>((resolve, reject) => {
      let request: Request;
      try {
        request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== baseUrl || !url.pathname.startsWith('/api/')) throw new TypeError('Invalid tunnel URL');
      } catch (error) { reject(error); return; }
      let current: Session | null = null;
      let id: number | null = null;
      let done = false;
      let hasHead = false;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let bodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const signal = request.signal;
      const cleanup = () => {
        done = true;
        signal.removeEventListener('abort', abort);
        if (id !== null) current?.streams.delete(id);
      };
      const reset = (code: TunnelReset['code'] = 'aborted') => {
        if (id !== null && current && !current.channel.closed) {
          try { current.channel.send({ type: TunnelFrameType.Reset, stream: id, payload: encodeJson({ code }) }); }
          catch { current.channel.close('Reset failed'); }
        }
      };
      const fail = (error: unknown) => {
        if (done) return;
        cleanup();
        if (!hasHead) reject(error);
        else { try { controller?.error(error); } catch { /* The reader may have cancelled. */ } }
      };
      const abort = () => {
        reset();
        const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
        if (bodyReader) {
          void bodyReader.cancel(reason).catch(() => {});
          bodyReader = null;
        }
        fail(reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void (async () => {
        current = await connectSession();
        if (done) return;
        id = allocate(current, {
          fail,
          frame(frame) {
            if (done) return;
            switch (frame.type) {
              case TunnelFrameType.Response: {
                if (hasHead) throw new TunnelProtocolError('Repeated response head');
                const head = responseHead(frame.payload);
                const noBody = NULL_BODY.has(head.status) || request.method === 'HEAD';
                const bodyStream = noBody ? null : new ReadableStream<Uint8Array>({
                  start(value) { controller = value; },
                  cancel() { reset(); cleanup(); },
                }, new ByteLengthQueuingStrategy({ highWaterMark: BODY_QUEUE_BUDGET }));
                const response = new Response(bodyStream, { status: head.status, headers: head.headers });
                hasHead = true;
                resolve(response);
                break;
              }
              case TunnelFrameType.ResponseBody:
                if (!hasHead) throw new TunnelProtocolError('Body before response head');
                controller?.enqueue(frame.payload);
                // Bound current queue occupancy, including when the caller never reads the body.
                // ByteLengthQueuingStrategy tracks actual bytes in the queue; desiredSize goes
                // negative only when the consumer is slow and the queue exceeds the budget,
                // so a fast reader that drains chunks as they arrive is never incorrectly reset.
                if ((controller?.desiredSize ?? 0) < 0) {
                  reset('limit');
                  fail(new TypeError('Response body too large'));
                }
                break;
              case TunnelFrameType.ResponseEnd:
                if (!hasHead) { fail(networkError()); break; }
                controller?.close();
                cleanup();
                break;
              case TunnelFrameType.Reset: fail(networkError()); break;
              default: throw new TunnelProtocolError('Unexpected HTTP frame');
            }
          },
        });
        let body = EMPTY;
        if (request.body) {
          const reader = bodyReader = request.body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          try {
            while (!done) {
              const chunk = await reader.read();
              if (chunk.done || done) break;
              if (!(chunk.value instanceof Uint8Array)) throw new TypeError('Body chunk must be a Uint8Array');
              chunks.push(chunk.value);
              total += chunk.value.length;
            }
          } finally {
            reader.releaseLock();
            bodyReader = null;
          }
          body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
        }
        if (done) return;
        const url = new URL(request.url);
        const excluded = new Set(HOP_HEADERS);
        for (const name of (request.headers.get('connection') ?? '').split(',')) excluded.add(name.trim().toLowerCase());
        const headers: [string, string][] = [];
        request.headers.forEach((value, name) => {
          if (!excluded.has(name.toLowerCase())) headers.push([name, value]);
        });
        current.channel.send({ type: TunnelFrameType.Request, stream: id, payload: encodeJson({
          method: request.method, path: url.pathname + url.search, headers,
        }) });
        for (let offset = 0; offset < body.length && !done; offset += TUNNEL_BODY_CHUNK) {
          current.channel.send({ type: TunnelFrameType.RequestBody, stream: id, payload: body.subarray(offset, offset + TUNNEL_BODY_CHUNK) });
        }
        if (!done) current.channel.send({ type: TunnelFrameType.RequestEnd, stream: id, payload: EMPTY });
      })().catch(() => { reset(); fail(signal.aborted ? signal.reason : networkError()); });
    });
  };

  class TunnelWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = '';
    readonly extensions = '';
    binaryType: 'arraybuffer' | 'blob' = 'blob';
    readyState: number = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent & { readonly data: string }) => void) | null = null;
    onclose: ((event: SocketCloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private current: Session | null = null;
    private id: number | null = null;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      const parsed = new URL(this.url);
      if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.hostname !== new URL(baseUrl).hostname ||
          parsed.port || parsed.username || parsed.password || parsed.pathname !== '/api/ws' || parsed.search || parsed.hash) {
        throw new DOMException('Invalid tunnel WebSocket URL', 'SyntaxError');
      }
      void connectSession().then(current => {
        if (this.readyState !== this.CONNECTING) return;
        this.current = current;
        this.id = allocate(current, {
          fail: () => this.finish(1006, 'Channel lost', false),
          frame: frame => {
            switch (frame.type) {
              case TunnelFrameType.WsOpened:
                if (frame.payload.length) throw new TunnelProtocolError('Invalid WebSocket open');
                if (this.readyState === this.CLOSING) break;
                if (this.readyState !== this.CONNECTING) throw new TunnelProtocolError('Invalid WebSocket open');
                this.readyState = this.OPEN;
                this.emit(new Event('open'));
                break;
              case TunnelFrameType.WsMessage:
                if (this.readyState === this.CLOSING) break;
                if (this.readyState !== this.OPEN) throw new TunnelProtocolError('Message before WebSocket open');
                this.emit(new MessageEvent('message', { data: fromUtf8(frame.payload) }));
                break;
              case TunnelFrameType.WsClose: {
                const close = wsClose(frame.payload);
                this.finish(close.code, close.reason, true);
                break;
              }
              case TunnelFrameType.Reset: this.finish(1006, 'WebSocket refused', false); break;
              default: throw new TunnelProtocolError('Unexpected WebSocket frame');
            }
          },
        });
        current.channel.send({ type: TunnelFrameType.WsOpen, stream: this.id, payload: encodeJson({ path: '/api/ws' }) });
      }).catch(() => this.finish(1006, 'Connection failed', false));
    }

    get bufferedAmount(): number { return this.current?.channel.bufferedAmount ?? 0; }

    send(data: string): void {
      if (this.readyState === this.CONNECTING) throw new DOMException('WebSocket is connecting', 'InvalidStateError');
      if (this.readyState !== this.OPEN) return;
      if (typeof data !== 'string') throw new TypeError('Only text messages are supported');
      this.current!.channel.send({ type: TunnelFrameType.WsMessage, stream: this.id!, payload: utf8(data) });
    }

    close(code = 1000, reason = ''): void {
      if (code !== 1000 && (code < 3000 || code > 4999 || !Number.isInteger(code))) {
        throw new DOMException('Invalid close code', 'InvalidAccessError');
      }
      if (utf8(reason).length > 123) throw new DOMException('Close reason too long', 'SyntaxError');
      if (this.readyState >= this.CLOSING) return;
      this.readyState = this.CLOSING;
      if (this.id !== null && this.current && !this.current.channel.closed) {
        try { this.current.channel.send({ type: TunnelFrameType.WsClose, stream: this.id, payload: encodeJson({ code, reason }) }); }
        catch { this.finish(1006, 'Channel lost', false); return; }
        return;
      }
      queueMicrotask(() => this.finish(code, reason, true));
    }

    private emit(event: Event): void {
      try {
        if (event.type === 'open') this.onopen?.(event);
        else if (event.type === 'message') this.onmessage?.(event as MessageEvent & { readonly data: string });
        else if (event.type === 'close') this.onclose?.(event as SocketCloseEvent);
        else if (event.type === 'error') this.onerror?.(event);
      } catch { /* Application observers cannot interrupt stream cleanup. */ }
      this.dispatchEvent(event);
    }

    private finish(code: number, reason: string, clean: boolean): void {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.CLOSED;
      if (this.id !== null) this.current?.streams.delete(this.id);
      if (!clean) this.emit(new Event('error'));
      this.emit(new SocketCloseEvent(code, reason, clean));
    }
  }

  return {
    baseUrl,
    fetch: tunnelFetch,
    WebSocket: TunnelWebSocket as unknown as typeof WebSocket,
    get via() { return session?.via ?? null; },
    async connect() { return (await connectSession()).via; },
    close() {
      if (disposed) return;
      disposed = true;
      cancelConnect?.();
      session?.channel.close('Transport closed');
    },
  };
}
