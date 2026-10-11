import {
  TUNNEL_BODY_CHUNK,
  TunnelCloseCode,
  TunnelFrameType,
} from '@neo/protocol';
import type {
  TunnelRequestHead,
  TunnelReset,
  TunnelWsClose,
} from '@neo/protocol';
import { acceptChannel } from './channel.js';
import type { SecureChannel } from './channel.js';
import { decodeJson, encodeJson } from './frames.js';
import type { Frame } from './frames.js';
import type { MessageLink } from './link.js';
import type { KeyPair } from './noise.js';

export interface TunnelPeer {
  ip: string;
  via: 'lan' | 'relay';
}

export interface TunnelSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface TunnelHandler {
  /** The ordinary API handler retains responsibility for authentication. */
  fetch(request: Request, peer: TunnelPeer): Promise<Response>;
  openWebSocket(path: string, peer: TunnelPeer, socket: TunnelSocket): {
    message(text: string): void;
    close(code: number, reason: string): void;
  } | null;
}

export interface TunnelServerLimits {
  maxStreams: number;
  maxWebSockets: number;
  maxRequestBodyBytes: number;
  /** Request bodies buffered at once across the session's streams (bodies arrive before auth runs). */
  maxBufferedBodyBytes: number;
  maxHeaderBytes: number;
  idleTimeoutMs: number;
  handshakeTimeoutMs: number;
}

const DEFAULT_LIMITS: TunnelServerLimits = {
  maxStreams: 32,
  maxWebSockets: 4,
  maxRequestBodyBytes: 20 * 1024 * 1024,
  maxBufferedBodyBytes: 32 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  idleTimeoutMs: 90_000,
  handshakeTimeoutMs: 10_000,
};

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Proxy/trust headers must never come from a tunnel; framing headers are recomputed from the buffered body. */
const UNTRUSTED_HEADERS = new Set([
  'host', 'connection', 'upgrade', 'forwarded', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'content-length', 'transfer-encoding', 'keep-alive', 'te', 'trailer', 'expect',
  'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const EMPTY = new Uint8Array();
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

interface HttpStream {
  head: TunnelRequestHead;
  headers: Headers;
  chunks: Uint8Array[];
  size: number;
  dispatched: boolean;
  headSent: boolean;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

interface WsStream {
  handler: ReturnType<TunnelHandler['openWebSocket']>;
  ready: boolean;
  closed: boolean;
  closure: TunnelWsClose | null;
  pending: Frame[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requestHead(payload: Uint8Array, maxBytes: number): { head: TunnelRequestHead; headers: Headers } {
  if (payload.byteLength > maxBytes) throw new Error('Request head is too large');
  const value = decodeJson<unknown>(payload);
  if (!record(value) || !exactKeys(value, ['method', 'path', 'headers']) ||
      typeof value.method !== 'string' || !METHODS.has(value.method) ||
      typeof value.path !== 'string' || !value.path.startsWith('/') ||
      !Array.isArray(value.headers) || value.headers.length > 64) {
    throw new Error('Invalid request head');
  }
  const url = new URL(value.path, 'http://tunnel.invalid');
  if (url.origin !== 'http://tunnel.invalid' || !url.pathname.startsWith('/api/') || url.hash !== '') {
    throw new Error('Invalid API path');
  }
  const pairs: [string, string][] = [];
  const headers = new Headers();
  for (const pair of value.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 ||
        typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new Error('Invalid header pair');
    }
    // Validate even discarded headers so malformed wire input cannot slip through.
    const validated = new Headers([[pair[0], pair[1]]]);
    if (!UNTRUSTED_HEADERS.has(pair[0].toLowerCase())) {
      validated.forEach((text, name) => headers.append(name, text));
    }
    pairs.push([pair[0], pair[1]]);
  }
  return {
    head: { method: value.method, path: url.pathname + url.search, headers: pairs },
    headers,
  };
}

function wsClose(payload: Uint8Array): TunnelWsClose {
  const value = decodeJson<unknown>(payload);
  if (!record(value) || !exactKeys(value, ['code', 'reason']) ||
      typeof value.code !== 'number' || !Number.isInteger(value.code) ||
      value.code < 1000 || value.code > 4999 || [1004, 1005, 1006, 1015].includes(value.code) ||
      typeof value.reason !== 'string' || utf8Encoder.encode(value.reason).byteLength > 123) {
    throw new Error('Invalid WebSocket close');
  }
  return { code: value.code, reason: value.reason };
}

function serverLimits(overrides: Partial<TunnelServerLimits> | undefined): TunnelServerLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const minimum = name.endsWith('TimeoutMs') ? 1 : 0;
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Invalid tunnel limit: ${name}`);
  }
  return limits;
}

/** Each session owns its requests, readers and sockets, including their cancellation. */
export function serveTunnel(link: MessageLink, options: {
  identity: { serverId: string; dh: KeyPair };
  handler: TunnelHandler;
  peer: TunnelPeer;
  limits?: Partial<TunnelServerLimits>;
  onClose?(): void;
}): { close(): void } {
  const limits = serverLimits(options.limits);
  const requests = new Map<number, HttpStream>();
  const sockets = new Map<number, WsStream>();
  let channel: SecureChannel | null = null;
  let closed = false;
  /** Bytes held by undispatched request bodies. */
  let buffered = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelRequest(stream: number, reason = 'Tunnel request closed') {
    const state = requests.get(stream);
    if (!state) return;
    requests.delete(stream);
    if (!state.dispatched) buffered -= state.size;
    state.chunks = [];
    state.controller.abort(new DOMException(reason, 'AbortError'));
    void state.reader?.cancel(reason).catch(() => {});
  }

  function finishSocket(stream: number, code: number, reason: string) {
    const state = sockets.get(stream);
    if (!state || state.closed) return;
    state.closed = true;
    state.closure = { code, reason };
    sockets.delete(stream);
    state.pending = [];
    try {
      state.handler?.close(code, reason);
    } catch {
      // Cleanup must finish even if application callbacks throw.
    }
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    for (const stream of requests.keys()) cancelRequest(stream, 'Tunnel session closed');
    for (const stream of sockets.keys()) finishSocket(stream, 1006, 'Tunnel session closed');
    try {
      options.onClose?.();
    } catch {
      // Session ownership must not depend on user callbacks succeeding.
    }
  }

  function close(reason: string, code?: number) {
    if (closed) return;
    cleanup();
    try {
      if (code !== undefined || !channel) link.close(code, reason);
      else channel.close(reason);
    } catch {
      // A disconnected transport can already have rejected further operations.
    }
  }

  function send(frame: Frame): boolean {
    if (closed || !channel || channel.closed) return false;
    try {
      channel.send(frame);
      return true;
    } catch {
      close('Failed to send tunnel frame', TunnelCloseCode.ProtocolError);
      return false;
    }
  }

  function reset(stream: number, code: TunnelReset['code']) {
    send({ type: TunnelFrameType.Reset, stream, payload: encodeJson({ code }) });
    cancelRequest(stream);
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close('Tunnel idle timeout'), limits.idleTimeoutMs);
  }

  function active(stream: number, state: HttpStream): boolean {
    return !closed && requests.get(stream) === state && !state.controller.signal.aborted;
  }

  async function waitForBuffer(stream: number, state: HttpStream): Promise<boolean> {
    while (active(stream, state) && channel!.bufferedAmount > 1024 * 1024) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return active(stream, state);
  }

  async function respond(stream: number, state: HttpStream, response: Response): Promise<void> {
    if (!active(stream, state)) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const headers: [string, string][] = [];
    response.headers.forEach((value, name) => headers.push([name, value]));
    if (!send({
      type: TunnelFrameType.Response,
      stream,
      payload: encodeJson({ status: response.status, headers }),
    })) return;
    state.headSent = true;
    if (response.body && state.head.method !== 'HEAD' && !NULL_BODY_STATUSES.has(response.status)) {
      const reader = response.body.getReader();
      state.reader = reader;
      try {
        while (await waitForBuffer(stream, state)) {
          const next = await reader.read();
          if (!active(stream, state) || next.done) break;
          for (let offset = 0; offset < next.value.byteLength; offset += TUNNEL_BODY_CHUNK) {
            if (!await waitForBuffer(stream, state)) return;
            if (!send({
              type: TunnelFrameType.ResponseBody,
              stream,
              payload: next.value.subarray(offset, offset + TUNNEL_BODY_CHUNK),
            })) return;
          }
        }
      } finally {
        state.reader = null;
        reader.releaseLock();
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    if (active(stream, state)) {
      send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
      requests.delete(stream);
    }
  }

  async function dispatch(stream: number, state: HttpStream): Promise<void> {
    try {
      let body: ArrayBuffer | undefined;
      if (state.head.method !== 'GET' && state.head.method !== 'HEAD' && state.size !== 0) {
        const bytes = new Uint8Array(state.size);
        let offset = 0;
        for (const chunk of state.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        body = bytes.buffer;
      }
      state.chunks = [];
      const request = new Request('http://tunnel.invalid' + state.head.path, {
        method: state.head.method,
        headers: state.headers,
        body,
        signal: state.controller.signal,
      });
      const response = await options.handler.fetch(request, options.peer);
      await respond(stream, state, response);
    } catch {
      if (!active(stream, state)) return;
      if (state.headSent) {
        reset(stream, 'internal');
      } else {
        try {
          await respond(stream, state, new Response('Internal Server Error', { status: 500 }));
        } catch {
          if (active(stream, state)) reset(stream, 'internal');
        }
      }
    }
  }

  function openSocket(stream: number, payload: Uint8Array) {
    let path: string;
    try {
      const value = decodeJson<unknown>(payload);
      if (!record(value) || !exactKeys(value, ['path']) || value.path !== '/api/ws') {
        reset(stream, 'not_found');
        return;
      }
      path = value.path;
    } catch {
      reset(stream, 'bad_request');
      return;
    }
    if (sockets.size >= limits.maxWebSockets) {
      reset(stream, 'limit');
      return;
    }
    const state: WsStream = { handler: null, ready: false, closed: false, closure: null, pending: [] };
    sockets.set(stream, state);
    function outgoing(frame: Frame) {
      if (closed || state.closed) return;
      if (state.ready) send(frame);
      else state.pending.push(frame);
    }
    const socket: TunnelSocket = {
      send(text) {
        if (typeof text !== 'string') {
          reset(stream, 'internal');
          finishSocket(stream, 1011, 'Invalid WebSocket message');
          return;
        }
        outgoing({ type: TunnelFrameType.WsMessage, stream, payload: utf8Encoder.encode(text) });
      },
      close(code, reason) {
        if (closed || state.closed) return;
        try {
          const payload = encodeJson({ code, reason });
          wsClose(payload);
          outgoing({ type: TunnelFrameType.WsClose, stream, payload });
          if (state.ready) finishSocket(stream, code, reason);
        } catch {
          reset(stream, 'internal');
          finishSocket(stream, 1011, 'Invalid WebSocket close');
        }
      },
    };
    try {
      state.handler = options.handler.openWebSocket(path, options.peer, socket);
      if (state.closed) {
        // Opening can synchronously trigger session shutdown before the callback exists.
        try { state.handler?.close(state.closure!.code, state.closure!.reason); } catch { /* Closed. */ }
        state.handler = null;
        return;
      }
      if (!state.handler) {
        reset(stream, 'not_found');
        finishSocket(stream, 1008, 'WebSocket refused');
        return;
      }
      state.ready = true;
      send({ type: TunnelFrameType.WsOpened, stream, payload: EMPTY });
      const pending = state.pending;
      state.pending = [];
      for (const frame of pending) {
        if (state.closed || closed) break;
        send(frame);
        if (frame.type === TunnelFrameType.WsClose) {
          const value = decodeJson<TunnelWsClose>(frame.payload);
          finishSocket(stream, value.code, value.reason);
        }
      }
    } catch {
      reset(stream, 'internal');
      finishSocket(stream, 1011, 'WebSocket handler failed');
    }
  }

  function receive(frame: Frame) {
    if (closed) return;
    touch();
    const { type, stream, payload } = frame;
    if (type === TunnelFrameType.Ping || type === TunnelFrameType.Pong) {
      if (stream !== 0) {
        close('Session frame on a stream', TunnelCloseCode.ProtocolError);
      } else if (type === TunnelFrameType.Ping) {
        send({ type: TunnelFrameType.Pong, stream: 0, payload });
      }
      return;
    }
    if (stream === 0) {
      close('Stream frame on session', TunnelCloseCode.ProtocolError);
      return;
    }
    if (type === TunnelFrameType.Request || type === TunnelFrameType.WsOpen) {
      if (requests.has(stream) || sockets.has(stream)) {
        close('Tunnel stream is already in use', TunnelCloseCode.ProtocolError);
        return;
      }
      if (type === TunnelFrameType.WsOpen) {
        openSocket(stream, payload);
        return;
      }
      let validated: ReturnType<typeof requestHead>;
      try {
        validated = requestHead(payload, limits.maxHeaderBytes);
      } catch {
        reset(stream, 'bad_request');
        return;
      }
      if (requests.size >= limits.maxStreams) {
        reset(stream, 'limit');
        return;
      }
      requests.set(stream, {
        ...validated,
        chunks: [],
        size: 0,
        dispatched: false,
        headSent: false,
        controller: new AbortController(),
        reader: null,
      });
      return;
    }
    const request = requests.get(stream);
    const socket = sockets.get(stream);
    if (!request && !socket) return;
    if (type === TunnelFrameType.Reset) {
      cancelRequest(stream);
      finishSocket(stream, 1006, 'WebSocket reset');
      return;
    }
    if (request) {
      if (request.dispatched || (type !== TunnelFrameType.RequestBody && type !== TunnelFrameType.RequestEnd)) {
        close('Invalid request frame sequence', TunnelCloseCode.ProtocolError);
      } else if (type === TunnelFrameType.RequestBody) {
        request.size += payload.byteLength;
        buffered += payload.byteLength;
        if (request.size > limits.maxRequestBodyBytes) reset(stream, 'too_large');
        else if (buffered > limits.maxBufferedBodyBytes) reset(stream, 'limit');
        else request.chunks.push(payload);
      } else if (payload.byteLength !== 0) {
        reset(stream, 'bad_request');
      } else {
        request.dispatched = true;
        buffered -= request.size;
        void dispatch(stream, request);
      }
      return;
    }
    try {
      if (type === TunnelFrameType.WsMessage) {
        socket!.handler?.message(utf8Decoder.decode(payload));
      } else if (type === TunnelFrameType.WsClose) {
        const value = wsClose(payload);
        send({ type: TunnelFrameType.WsClose, stream, payload });
        finishSocket(stream, value.code, value.reason);
      } else {
        close('Invalid WebSocket frame sequence', TunnelCloseCode.ProtocolError);
      }
    } catch {
      reset(stream, 'internal');
      finishSocket(stream, 1011, 'WebSocket handler failed');
    }
  }

  void acceptChannel(link, {
    serverId: options.identity.serverId,
    staticKey: options.identity.dh,
    timeoutMs: limits.handshakeTimeoutMs,
  }).then((accepted) => {
    if (closed) {
      accepted.close('Tunnel server closed');
      return;
    }
    channel = accepted;
    accepted.onClose = cleanup;
    accepted.onFrame = (frame) => {
      try {
        receive(frame);
      } catch {
        close('Invalid tunnel frame', TunnelCloseCode.ProtocolError);
      }
    };
    if (accepted.closed) cleanup();
    else touch();
  }).catch(cleanup);

  return { close: () => close('Tunnel server closed') };
}
