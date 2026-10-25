/** WebSocket authentication, event subscriptions, and connection lifecycle. */
import { z } from 'zod';
import type { WSEvents, WSContext } from 'hono/ws';
import { eventConversationId, silentLogger } from '@neo/protocol';
import type { DeviceStore, ErrorShape, EventEnvelope, Logger, WsServerMessage } from '@neo/protocol';
import type { EventHub } from './events.js';
import { IpFailureLimiter } from './auth.js';

export const WS_MAX_PAYLOAD = 64 * 1024;
export const WS_MAX_UNAUTHENTICATED_PER_IP = 5;
export const PING_INTERVAL_MS = 30_000;

const AUTH_TIMEOUT_MS = 10_000;
const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1), device: z.string().optional() }),
  z.object({ type: z.literal('subscribe'), conversations: z.union([z.literal('all'), z.array(z.string())]) }),
  z.object({ type: z.literal('ping'), id: z.string().optional() }),
]);

interface RawSocket {
  readonly bufferedAmount?: number;
  ping(): void;
  terminate(): void;
  once?(event: 'error' | 'pong', listener: () => void): void;
}

interface Connection {
  ws: WSContext;
  authenticated: boolean;
  deviceId: string | null;
  ip: string;
  active: boolean;
  subscription: string[] | 'all';
  authTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongPending: boolean;
  unsubscribe: (() => void) | null;
  closed: Set<() => void>;
  cleanup(): void;
}

const connections = new WeakMap<EventHub, Set<Connection>>();

function rawSocket(ws: WSContext): RawSocket | null {
  const raw = ws.raw;
  if (typeof raw !== 'object' || raw === null || !('ping' in raw) || !('terminate' in raw)) return null;
  return typeof raw.ping === 'function' && typeof raw.terminate === 'function' ? raw as RawSocket : null;
}

function send(ws: WSContext, message: WsServerMessage): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Closing sockets are removed by their close/error handlers.
  }
}

function shouldDeliver(envelope: EventEnvelope, subscription: string[] | 'all'): boolean {
  const conversationId = eventConversationId(envelope.event);
  return subscription === 'all' || conversationId === null || subscription.includes(conversationId);
}

/** The same handler can serve many sockets; state is held per connection. */
export function createWsHandler(devices: DeviceStore, events: EventHub, logger: Logger = silentLogger, options: { ip?: string; limiter?: IpFailureLimiter } = {}): WSEvents {
  const ip = options.ip ?? '127.0.0.1';
  const limiter = options.limiter ?? new IpFailureLimiter();
  const states = new WeakMap<WSContext, Connection>();
  let clients = connections.get(events);
  if (!clients) {
    clients = new Set();
    connections.set(events, clients);
  }
  const registeredClients = clients;

  function reject(state: Connection, error: ErrorShape): void {
    send(state.ws, { type: 'error', error });
    state.cleanup();
    state.ws.close(4401, error.message);
  }

  function rejectAuthentication(state: Connection, message: string): void {
    if (!state.active) return;
    const limited = limiter.isRateLimited(state.ip);
    if (!limited) limiter.recordFailure(state.ip);
    reject(state, limited
      ? { code: 'rate_limited', message: 'Too many failed auth attempts', retryable: true }
      : { code: 'unauthorized', message });
  }

  function transportError(state: Connection): void {
    if (state.active && !state.authenticated && !limiter.isRateLimited(state.ip)) limiter.recordFailure(state.ip);
    state.cleanup();
    // ws sends its own protocol close (including 1009) on payload errors.
    if (state.ws.readyState === 1) rawSocket(state.ws)?.terminate();
  }

  return {
    onOpen(_event, ws) {
      const state: Connection = {
        ws,
        authenticated: false,
        deviceId: null,
        ip,
        active: true,
        subscription: 'all',
        authTimer: null,
        pingTimer: null,
        pongPending: false,
        unsubscribe: null,
        closed: new Set(),
        cleanup() {
          state.active = false;
          if (state.authTimer) clearTimeout(state.authTimer);
          if (state.pingTimer) clearInterval(state.pingTimer);
          state.authTimer = null;
          state.pingTimer = null;
          state.unsubscribe?.();
          state.unsubscribe = null;
        },
      };
      states.set(ws, state);
      // Observe native errors too: the Node adapter's ErrorEvent wrapper is
      // unavailable on some supported Node runtimes, including Node 22.
      rawSocket(ws)?.once?.('error', () => transportError(state));
      if ([...registeredClients].filter(client => client.active && !client.authenticated && client.ip === ip).length >= WS_MAX_UNAUTHENTICATED_PER_IP) {
        send(ws, { type: 'error', error: { code: 'rate_limited', message: 'Too many unauthenticated sockets', retryable: true } });
        state.cleanup();
        ws.close(4429, 'Too many unauthenticated sockets');
        return;
      }
      registeredClients.add(state);
      state.authTimer = setTimeout(() => rejectAuthentication(state, 'Authentication timed out'), AUTH_TIMEOUT_MS);
      state.authTimer.unref();
    },

    onMessage(event, ws) {
      const state = states.get(ws);
      if (!state?.active || ws.readyState !== 1) return;
      let data: unknown;
      try {
        if (typeof event.data !== 'string') throw new Error('Expected a text message');
        data = JSON.parse(event.data);
      } catch {
        if (!state.authenticated) rejectAuthentication(state, 'First message must authenticate');
        else send(ws, { type: 'error', error: { code: 'bad_request', message: 'Invalid JSON message' } });
        return;
      }
      const parsed = ClientMessageSchema.safeParse(data);
      if (!parsed.success) {
        if (!state.authenticated) rejectAuthentication(state, 'First message must authenticate');
        else send(ws, { type: 'error', error: { code: 'bad_request', message: 'Invalid WebSocket message', details: z.treeifyError(parsed.error) } });
        return;
      }
      const message = parsed.data;
      if (!state.authenticated) {
        if (message.type !== 'auth') {
          rejectAuthentication(state, 'First message must authenticate');
          return;
        }
        try {
          const device = devices.verify(message.token);
          if (!device) {
            rejectAuthentication(state, 'Invalid token');
            return;
          }
          state.deviceId = device.id;
        } catch (error) {
          logger.warn('WebSocket authentication failed', { error: String(error) });
          rejectAuthentication(state, 'Authentication failed');
          return;
        }
        if (state.authTimer) clearTimeout(state.authTimer);
        state.authTimer = null;
        state.authenticated = true;
        send(ws, { type: 'ready', serverVersion: '0.1.0', seq: events.seq });
        state.unsubscribe = events.subscribe((envelope) => {
          if (!devices.list().some(device => device.id === state.deviceId)) {
            reject(state, { code: 'unauthorized', message: 'Device revoked' });
            return;
          }
          const raw = rawSocket(state.ws);
          if ((raw?.bufferedAmount ?? 0) > WS_MAX_PAYLOAD) {
            logger.warn('WebSocket outbound buffer limit exceeded; dropping slow client');
            state.cleanup();
            raw?.terminate();
            return;
          }
          if (shouldDeliver(envelope, state.subscription)) send(ws, { type: 'event', envelope });
        });
        state.pingTimer = setInterval(() => {
          if (ws.readyState !== 1) return;
          const raw = rawSocket(ws);
          if (state.pongPending) {
            logger.debug('WebSocket pong timeout; dropping silent client');
            state.cleanup();
            raw?.terminate();
            return;
          }
          try {
            // Tunnel adapters have no native ping/pong frames to observe.
            state.pongPending = typeof raw?.once === 'function';
            raw?.once?.('pong', () => { state.pongPending = false; });
            raw?.ping();
          } catch (error) {
            logger.debug('WebSocket ping failed', { error: String(error) });
            state.cleanup();
            raw?.terminate();
          }
        }, PING_INTERVAL_MS);
        state.pingTimer.unref();
        return;
      }
      if (message.type === 'auth') {
        send(ws, { type: 'error', error: { code: 'bad_request', message: 'Already authenticated' } });
      } else if (message.type === 'subscribe') {
        state.subscription = message.conversations;
      } else {
        send(ws, { type: 'pong', id: message.id });
      }
    },

    onClose(_event, ws) {
      const state = states.get(ws);
      state?.cleanup();
      if (state) registeredClients.delete(state);
      for (const resolve of state?.closed ?? []) resolve();
      states.delete(ws);
    },

    onError(_event, ws) {
      const state = states.get(ws);
      if (state) transportError(state);
    },
  };
}

/** Stop event delivery immediately, before the peer completes its close handshake. */
export function revokeDeviceWebSockets(events: EventHub, deviceId: string): void {
  for (const state of connections.get(events) ?? []) {
    if (state.deviceId !== deviceId || !state.active) continue;
    state.cleanup();
    try { state.ws.close(4401, 'Device revoked'); }
    catch { rawSocket(state.ws)?.terminate(); }
  }
}

/** Finish the close handshake, then terminate peers that do not respond. */
export async function closeWebSockets(events: EventHub): Promise<void> {
  await Promise.all([...connections.get(events) ?? []].map((state) => new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      state.closed.delete(finish);
      connections.get(events)?.delete(state);
      resolve();
    };
    const timeout = setTimeout(() => {
      rawSocket(state.ws)?.terminate();
      finish();
    }, 250);
    state.closed.add(finish);
    state.cleanup();
    if (state.ws.readyState === 3) finish();
    else {
      try {
        state.ws.close(1001, 'Server shutting down');
      } catch {
        rawSocket(state.ws)?.terminate();
        finish();
      }
    }
  })));
}
