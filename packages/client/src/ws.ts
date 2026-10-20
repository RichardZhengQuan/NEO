/**
 * WebSocket connection manager for NEO real-time events.
 *
 * connect() opens /api/ws, sends the auth message, waits for ready, delivers
 * EventEnvelopes, supports subscribe(), ping, and automatic exponential-backoff
 * reconnect (1s → 30s with jitter). Stops reconnecting after close() or a 4401
 * auth-failure close code.
 */
import type { EventEnvelope, WsClientMessage, WsServerMessage } from '@neo/protocol';
import type { ConnectOptions, ConnectionStatus, EventConnection } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 25_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const AUTH_TIMEOUT_MS = 10_000;

function jitter(ms: number): number {
  // ±20% jitter.
  return ms * (0.8 + Math.random() * 0.4);
}

function backoffDelay(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return jitter(base);
}

/** Convert http(s) to ws(s). */
function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http(s?):\/\//, (_, s: string) => `ws${s}://`);
}

// ─────────────────────────────────────────────────────────────────────────────

export interface WsContext {
  baseUrl: string;
  getToken: () => string | undefined;
  WebSocketCtor: typeof WebSocket;
}

export function createConnection(ctx: WsContext, opts: ConnectOptions): EventConnection {
  const { onEvent, onStatus, conversations = 'all', reconnect = true } = opts;

  let status: ConnectionStatus = 'connecting';
  let closed = false; // set by close()
  let attempt = 0;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeq = 0;
  // The subscription to send after (re)connect.
  let currentConversations: string[] | 'all' = conversations;

  function setStatus(s: ConnectionStatus) {
    status = s;
    try {
      onStatus?.(s);
    } catch {
      // Ignore errors from status callback.
    }
  }

  function clearPing() {
    if (pingTimer !== null) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
  }

  function schedulePing() {
    clearPing();
    pingTimer = setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        const msg: WsClientMessage = { type: 'ping', id: String(Date.now()) };
        ws.send(JSON.stringify(msg));
      }
      schedulePing();
    }, PING_INTERVAL_MS);
  }

  function send(msg: WsClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function scheduleReconnect() {
    if (closed || !reconnect) return;
    if (reconnectTimer !== null) return; // already scheduled

    const delay = backoffDelay(attempt);
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) {
        setStatus('reconnecting');
        if (!closed) {
          openSocket();
        }
      }
    }, delay);
  }

  function openSocket() {
    const wsUrl = `${toWsUrl(ctx.baseUrl)}/api/ws`;
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    let ready = false;

    try {
      ws = new ctx.WebSocketCtor(wsUrl);
    } catch (err) {
      scheduleReconnect();
      return;
    }

    // Auth timeout: if the server doesn't reply ready within AUTH_TIMEOUT_MS,
    // close and reconnect.
    authTimer = setTimeout(() => {
      if (!ready && ws) {
        ws.close(1000, 'auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.onopen = () => {
      // Send auth as the first message.
      const token = ctx.getToken();
      if (token) {
        const msg: WsClientMessage = { type: 'auth', token };
        ws!.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event: { data: unknown }) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(event.data as string) as WsServerMessage;
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        if (authTimer !== null) {
          clearTimeout(authTimer);
          authTimer = null;
        }
        ready = true;
        attempt = 0; // Reset backoff on successful connect.
        lastSeq = msg.seq;
        setStatus('open');
        if (!closed) {
          schedulePing();
        }

        // Send subscription after reconnect.
        const subMsg: WsClientMessage = { type: 'subscribe', conversations: currentConversations };
        send(subMsg);
        return;
      }

      if (msg.type === 'event') {
        lastSeq = msg.envelope.seq;
        try {
          onEvent(msg.envelope);
        } catch {
          // Ignore errors in the event handler.
        }
        return;
      }

      if (msg.type === 'error') {
        // Auth error — don't reconnect.
        if (authTimer !== null) {
          clearTimeout(authTimer);
          authTimer = null;
        }
        return;
      }

      // pong — ignore.
    };

    ws.onclose = (event: { code: number; reason: string }) => {
      if (authTimer !== null) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      clearPing();

      // 4401 = auth failure (server closes with this code).
      if (event.code === 4401) {
        closed = true;
        setStatus('closed');
        return;
      }

      if (closed) {
        setStatus('closed');
        return;
      }

      // Unexpected close — close if reconnect is disabled, otherwise reconnect with backoff.
      if (!reconnect) {
        setStatus('closed');
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      // Errors are followed by close events; let the close handler decide.
    };
  }

  // Start the first connection.
  openSocket();

  return {
    get status() {
      return status;
    },
    get lastSeq() {
      return lastSeq;
    },
    subscribe(convs: string[] | 'all') {
      currentConversations = convs;
      const msg: WsClientMessage = { type: 'subscribe', conversations: convs };
      send(msg);
    },
    close() {
      closed = true;
      clearPing();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close(1000, 'client closed');
        ws = null;
      }
      setStatus('closed');
    },
  };
}
