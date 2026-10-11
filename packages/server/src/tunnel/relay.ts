import WebSocket from 'ws';
import {
  NOISE_MAX_MESSAGE, RELAY_HEADER, RELAY_SERVER_PATH, RelayControlMessageSchema,
  RelayOp, TunnelCloseCode,
} from '@neo/protocol';
import type { Logger } from '@neo/protocol';
import {
  decodeRelayFrame, encodeRelayFrame, fromBase64Url, fromUtf8, serveTunnel,
  signRelayChallenge, toBase64Url,
} from '@neo/tunnel';
import type { MessageLink, ServerIdentity, TunnelHandler } from '@neo/tunnel';

export type RelayConnectorStatus = 'connecting' | 'connected' | 'error';
export interface RelayConnector {
  close(): Promise<void>;
}

const EMPTY = new Uint8Array();
const MAX_SESSIONS = 256;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

interface RelaySession {
  link: MessageLink;
  finish(code: number, reason: string): void;
}

/** One outbound socket multiplexes independently encrypted phone sessions. */
export function startRelayConnector(options: {
  url: string;
  identity: ServerIdentity;
  handler: TunnelHandler;
  logger: Logger;
  onStatus(status: RelayConnectorStatus, error?: string): void;
  maxRequestBodyBytes?: number;
}): RelayConnector {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let registrationTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let closePromise: Promise<void> | null = null;
  const sessions = new Map<number, RelaySession>();

  function report(status: RelayConnectorStatus, error?: string): void {
    try { options.onStatus(status, error); } catch { /* Observers cannot disrupt socket ownership. */ }
  }

  function finishSessions(code: number, reason: string): void {
    for (const session of [...sessions.values()]) session.finish(code, reason);
  }

  function reconnect(): void {
    if (stopped || reconnectTimer !== undefined) return;
    const delay = Math.min(60_000, Math.max(1000, Math.round(retryDelay * (0.8 + Math.random() * 0.4))));
    retryDelay = Math.min(60_000, retryDelay * 2);
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, delay);
    reconnectTimer.unref();
  }

  function connect(): void {
    if (stopped) return;
    report('connecting');
    let current: WebSocket;
    try {
      current = new WebSocket(options.url.replace(/\/$/, '') + RELAY_SERVER_PATH, {
        maxPayload: NOISE_MAX_MESSAGE + RELAY_HEADER,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
      });
    } catch {
      report('error', 'Could not connect to the relay.');
      reconnect();
      return;
    }
    socket = current;
    let phase: 'challenge' | 'registering' | 'registered' = 'challenge';
    let lost = false;

    function lose(message: string): void {
      if (lost) return;
      lost = true;
      clearTimeout(registrationTimer);
      registrationTimer = undefined;
      if (socket === current) socket = null;
      finishSessions(1006, 'Relay connection lost');
      if (!stopped) {
        report('error', message);
        options.logger.warn('Phone access relay connection ended.');
        reconnect();
      }
    }

    function protocolError(): void {
      lose('The relay sent an invalid message.');
      current.close(TunnelCloseCode.ProtocolError, 'Invalid relay message');
      current.terminate();
    }

    function send(op: typeof RelayOp.Data | typeof RelayOp.Close, connection: number, payload: Uint8Array = EMPTY): void {
      if (lost || stopped || current.readyState !== WebSocket.OPEN) throw new Error('Relay is disconnected');
      if (current.bufferedAmount > MAX_BUFFERED_BYTES) {
        lose('The relay connection is too busy.');
        current.terminate();
        throw new Error('Relay connection is busy');
      }
      current.send(encodeRelayFrame({ op, connection, payload }));
    }

    current.on('open', () => {
      if (stopped) { current.close(1001, 'Phone access stopped'); return; }
      registrationTimer = setTimeout(() => {
        lose('The relay did not complete registration.');
        current.terminate();
      }, 10_000);
      registrationTimer.unref();
    });

    current.on('message', (data, binary) => {
      if (lost || stopped) return;
      try {
        if (phase !== 'registered') {
          if (binary) { protocolError(); return; }
          const control = RelayControlMessageSchema.parse(JSON.parse(data.toString()));
          if (control.type === 'error') {
            lose(control.message);
            current.terminate();
          } else if (control.type === 'challenge' && phase === 'challenge') {
            phase = 'registering';
            current.send(JSON.stringify({
              type: 'register', serverId: options.identity.serverId,
              key: toBase64Url(options.identity.signing.publicKey),
              signature: toBase64Url(signRelayChallenge(options.identity, fromBase64Url(control.nonce))),
            }));
          } else if (control.type === 'registered' && phase === 'registering' && control.serverId === options.identity.serverId) {
            phase = 'registered';
            retryDelay = 1000;
            clearTimeout(registrationTimer);
            registrationTimer = undefined;
            report('connected');
          } else protocolError();
          return;
        }
        if (!binary) { protocolError(); return; }
        const frame = decodeRelayFrame(data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.concat(Array.isArray(data) ? data : [data]));
        if (frame.connection === 0) { protocolError(); return; }
        if (frame.op === RelayOp.Open) {
          if (sessions.has(frame.connection) || frame.payload.length === 0 || frame.payload.length > 256) {
            protocolError();
            return;
          }
          const ip = fromUtf8(frame.payload);
          if (sessions.size >= MAX_SESSIONS) { send(RelayOp.Close, frame.connection); return; }
          let closed = false;
          const session: RelaySession = {
            link: {
              onMessage: null, onClose: null,
              get bufferedAmount() { return current.bufferedAmount; },
              send(bytes) {
                if (closed) throw new Error('Relay session is closed');
                send(RelayOp.Data, frame.connection, bytes);
              },
              close(code = 1000, reason = '') {
                if (closed) return;
                session.finish(code, reason);
                try { send(RelayOp.Close, frame.connection); } catch { /* Already disconnected. */ }
              },
            },
            finish(code, reason) {
              if (closed) return;
              closed = true;
              sessions.delete(frame.connection);
              try { session.link.onClose?.(code, reason); } catch { /* Complete all session cleanup. */ }
            },
          };
          sessions.set(frame.connection, session);
          serveTunnel(session.link, {
            identity: options.identity, handler: options.handler, peer: { ip, via: 'relay' },
            ...(options.maxRequestBodyBytes === undefined ? {} : { limits: { maxRequestBodyBytes: options.maxRequestBodyBytes } }),
          });
        } else if (frame.op === RelayOp.Close) {
          sessions.get(frame.connection)?.finish(1000, 'Phone disconnected');
        } else {
          sessions.get(frame.connection)?.link.onMessage?.(frame.payload);
        }
      } catch { protocolError(); }
    });

    current.on('error', () => {
      lose('Could not connect to the relay.');
      current.terminate();
    });
    current.on('close', (code) => lose(code === TunnelCloseCode.Replaced ? 'Another connection replaced this relay registration.' : 'The relay connection closed.'));
  }

  connect();
  return {
    close() {
      if (closePromise) return closePromise;
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      clearTimeout(registrationTimer);
      registrationTimer = undefined;
      finishSessions(1001, 'Phone access stopped');
      const current = socket;
      socket = null;
      closePromise = new Promise<void>((resolve) => {
        if (!current || current.readyState === WebSocket.CLOSED) { resolve(); return; }
        const timeout = setTimeout(() => current.terminate(), 250);
        timeout.unref();
        current.once('close', () => { clearTimeout(timeout); resolve(); });
        if (current.readyState === WebSocket.CONNECTING) current.terminate();
        else current.close(1001, 'Phone access stopped');
      });
      return closePromise;
    },
  };
}
