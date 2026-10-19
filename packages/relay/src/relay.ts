import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { isIP } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import {
  NOISE_MAX_MESSAGE, RELAY_CONNECT_PATH, RELAY_HEADER, RELAY_SERVER_PATH,
  RelayControlMessageSchema, RelayOp, ServerIdSchema, silentLogger, systemClock, TunnelCloseCode,
} from '@neo/protocol';
import type { Clock, Logger } from '@neo/protocol';
import { decodeRelayFrame, encodeRelayFrame, verifyRelayRegistration } from '@neo/tunnel';

export interface RelayLimits {
  perIpPhoneConnections: number;
  perIpPhoneConnectionsPerMinute: number;
  perIpServerRegistrationsPerMinute: number;
  perServerPhoneConnections: number;
  maxServers: number;
  maxPhones: number;
  bytesPerSecond: number;
  burstBytes: number;
  maxBufferedBytes: number;
  registrationTimeoutMs: number;
  phoneIdleTimeoutMs: number;
  heartbeatIntervalMs: number;
}

export const DEFAULT_RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  perIpPhoneConnections: 20,
  perIpPhoneConnectionsPerMinute: 60,
  perIpServerRegistrationsPerMinute: 10,
  perServerPhoneConnections: 64,
  maxServers: 10_000,
  maxPhones: 50_000,
  bytesPerSecond: 4 * 1024 * 1024,
  burstBytes: 16 * 1024 * 1024,
  maxBufferedBytes: 8 * 1024 * 1024,
  registrationTimeoutMs: 10_000,
  phoneIdleTimeoutMs: 120_000,
  heartbeatIntervalMs: 30_000,
});

const MAX_TIMER_MS = 2_147_483_647;
const MS_LIMIT_FIELDS: ReadonlySet<keyof RelayLimits> = new Set([
  'registrationTimeoutMs',
  'phoneIdleTimeoutMs',
  'heartbeatIntervalMs',
]);

export interface RelayStats {
  servers: number;
  phones: number;
  pendingRegistrations: number;
  registrations: number;
  rejectedConnections: number;
  /** Successfully forwarded opaque messages and payload bytes, in both directions. */
  messages: number;
  bytes: number;
}

export interface RelayOptions {
  host?: string;
  port?: number;
  trustProxy?: boolean;
  logger?: Logger;
  limits?: Partial<RelayLimits>;
  clock?: Clock;
}

export interface Relay {
  port: number;
  url: string;
  close(): Promise<void>;
  stats(): RelayStats;
}

interface RegisteredServer {
  socket: WebSocket;
  serverId: string;
  phones: Map<number, Phone>;
  alive: boolean;
}

interface Phone {
  socket: WebSocket;
  server: RegisteredServer;
  connection: number;
  ip: string;
  active: boolean;
  lastActivity: number;
  tokens: number;
  tokenTime: number;
}

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

function canonicalizeIp(ip: string): string {
  const kind = isIP(ip);
  if (!kind) return ip;
  // URL rejects zone-id IPv6 like fe80::1%eth0, so split the zone off, canonicalize the address,
  // and re-attach the zone verbatim — the zone is a textual interface label, not part of the IP.
  try {
    if (kind === 6) {
      const zoneAt = ip.indexOf('%');
      const addr = zoneAt === -1 ? ip : ip.slice(0, zoneAt);
      const zone = zoneAt === -1 ? '' : ip.slice(zoneAt);
      const hostname = new URL(`http://[${addr}]/`).hostname;
      const inner = hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
      return inner + zone;
    }
    return new URL(`http://${ip}/`).hostname;
  } catch {
    return ip;
  }
}

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = request.headers['x-forwarded-for'];
    const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
    if (first && isIP(first)) return canonicalizeIp(first);
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Relay has no TCP address'));
      else resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** The relay understands routing headers and registration proofs, never Noise plaintext. */
export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const host = options.host ?? '0.0.0.0';
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const limits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid relay limit: ${name}`);
    if (MS_LIMIT_FIELDS.has(name as keyof RelayLimits) && value > MAX_TIMER_MS) {
      throw new Error(`Invalid relay limit: ${name}`);
    }
  }
  const http = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: NOISE_MAX_MESSAGE + RELAY_HEADER, perMessageDeflate: false, autoPong: false });
  const servers = new Map<string, RegisteredServer>();
  const phones = new Map<number, Phone>();
  const perIpPhones = new Map<string, number>();
  const phoneAttempts = new Map<string, number[]>();
  const registrationAttempts = new Map<string, number[]>();
  const counts = { pendingRegistrations: 0, registrations: 0, rejectedConnections: 0, messages: 0, bytes: 0 };
  let nextConnection = 0;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  function prune(map: Map<string, number[]>, now: number): void {
    for (const [ip, times] of map) {
      const recent = times.filter(time => now - time < 60_000);
      if (recent.length) map.set(ip, recent);
      else map.delete(ip);
    }
  }

  function admit(map: Map<string, number[]>, ip: string, maximum: number): boolean {
    const now = clock();
    const recent = (map.get(ip) ?? []).filter(time => now - time < 60_000);
    if (recent.length >= maximum) return false;
    recent.push(now);
    map.set(ip, recent);
    return true;
  }

  function closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.CLOSED) return;
    const timeout = setTimeout(() => socket.terminate(), 250);
    timeout.unref();
    socket.once('close', () => clearTimeout(timeout));
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  }

  function send(socket: WebSocket, data: string | Uint8Array): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(data, error => { if (error) socket.terminate(); });
      return true;
    } catch {
      socket.terminate();
      return false;
    }
  }

  function sendClose(phone: Phone): void {
    if (servers.get(phone.server.serverId) === phone.server) {
      send(phone.server.socket, encodeRelayFrame({ op: RelayOp.Close, connection: phone.connection, payload: new Uint8Array() }));
    }
  }

  function closePhone(phone: Phone, code: number, reason: string, notifyServer = true): void {
    if (!phone.active) return;
    phone.active = false;
    phones.delete(phone.connection);
    phone.server.phones.delete(phone.connection);
    const count = (perIpPhones.get(phone.ip) ?? 1) - 1;
    if (count) perIpPhones.set(phone.ip, count);
    else perIpPhones.delete(phone.ip);
    if (notifyServer) sendClose(phone);
    closeSocket(phone.socket, code, reason);
    logger.debug('Relay phone closed', { serverId: phone.server.serverId.slice(0, 8), phones: phones.size, code });
  }

  function dropServer(server: RegisteredServer): void {
    if (servers.get(server.serverId) === server) servers.delete(server.serverId);
    for (const phone of server.phones.values()) closePhone(phone, TunnelCloseCode.UnknownServer, 'Server disconnected', false);
  }

  function protocolError(socket: WebSocket, code: string, message: string): void {
    send(socket, JSON.stringify({ type: 'error', code, message }));
    closeSocket(socket, TunnelCloseCode.ProtocolError, message);
  }

  function consume(phone: Phone, size: number): boolean {
    const now = clock();
    phone.tokens = Math.min(limits.burstBytes, phone.tokens + Math.max(0, now - phone.tokenTime) * limits.bytesPerSecond / 1000);
    phone.tokenTime = now;
    if (size > phone.tokens) {
      closePhone(phone, TunnelCloseCode.RateLimited, 'Byte rate limit exceeded');
      return false;
    }
    phone.tokens -= size;
    phone.lastActivity = now;
    return true;
  }

  function forward(phone: Phone, destination: WebSocket, payload: Uint8Array, framed: boolean): void {
    if (!phone.active || !consume(phone, payload.length)) return;
    if (destination.bufferedAmount > limits.maxBufferedBytes) {
      closePhone(phone, TunnelCloseCode.RateLimited, 'Destination is busy');
      return;
    }
    const data = framed ? encodeRelayFrame({ op: RelayOp.Data, connection: phone.connection, payload }) : payload;
    if (!send(destination, data)) {
      closePhone(phone, TunnelCloseCode.UnknownServer, 'Connection unavailable');
      return;
    }
    counts.messages++;
    counts.bytes += payload.length;
  }

  function serverSocket(socket: WebSocket, ip: string): void {
    if (!admit(registrationAttempts, ip, limits.perIpServerRegistrationsPerMinute)
      || counts.pendingRegistrations >= limits.maxServers) {
      counts.rejectedConnections++;
      closeSocket(socket, TunnelCloseCode.RateLimited, 'Too many server registrations');
      return;
    }
    counts.pendingRegistrations++;
    let pending = true;
    let registered: RegisteredServer | null = null;
    const nonce = randomBytes(32);
    const timeout = setTimeout(() => {
      finishPending();
      protocolError(socket, 'registration_timeout', 'Registration timed out');
    }, limits.registrationTimeoutMs);
    timeout.unref();
    const finishPending = () => {
      clearTimeout(timeout);
      if (pending) { pending = false; counts.pendingRegistrations--; }
    };
    socket.once('close', () => {
      finishPending();
      if (registered) {
        dropServer(registered);
        logger.info('Relay server disconnected', { serverId: registered.serverId.slice(0, 8), servers: servers.size });
      }
    });
    socket.on('pong', () => { if (registered) registered.alive = true; });
    socket.on('ping', (data: Buffer) => {
      if (socket.bufferedAmount > limits.maxBufferedBytes) {
        closeSocket(socket, TunnelCloseCode.RateLimited, 'Destination is busy');
      } else socket.pong(data);
    });
    socket.on('message', (data: RawData, binary: boolean) => {
      if (closing || socket.readyState !== WebSocket.OPEN) return;
      if (!registered) {
        // Consume the one registration opportunity before parsing untrusted input.
        if (!pending) { protocolError(socket, 'invalid_registration', 'Expected one registration'); return; }
        finishPending();
        if (binary) { protocolError(socket, 'invalid_registration', 'Expected a registration message'); return; }
        let message;
        try { message = RelayControlMessageSchema.safeParse(JSON.parse(Buffer.from(bytes(data)).toString('utf8'))); }
        catch { protocolError(socket, 'invalid_registration', 'Invalid registration'); return; }
        if (!message.success || message.data.type !== 'register'
          || !verifyRelayRegistration({ ...message.data, nonce })) {
          protocolError(socket, 'invalid_registration', 'Invalid registration proof');
          return;
        }
        const existing = servers.get(message.data.serverId);
        if (!existing && servers.size >= limits.maxServers) {
          counts.rejectedConnections++;
          closeSocket(socket, TunnelCloseCode.RateLimited, 'Too many registered servers');
          return;
        }
        if (existing) {
          dropServer(existing);
          closeSocket(existing.socket, TunnelCloseCode.Replaced, 'Registration replaced');
        }
        registered = { socket, serverId: message.data.serverId, phones: new Map(), alive: true };
        servers.set(registered.serverId, registered);
        counts.registrations++;
        send(socket, JSON.stringify({ type: 'registered', serverId: registered.serverId }));
        logger.info('Relay server registered', { serverId: registered.serverId.slice(0, 8), servers: servers.size });
        return;
      }
      if (!binary) { protocolError(socket, 'invalid_frame', 'Expected a binary relay frame'); return; }
      try {
        const frame = decodeRelayFrame(bytes(data));
        if (!frame.connection || frame.op === RelayOp.Open) {
          protocolError(socket, 'invalid_frame', 'Invalid server relay frame');
          return;
        }
        const phone = registered.phones.get(frame.connection);
        if (!phone) return;
        if (frame.op === RelayOp.Data) forward(phone, phone.socket, frame.payload, false);
        else closePhone(phone, 1000, 'Server closed connection', false);
      } catch {
        protocolError(socket, 'invalid_frame', 'Invalid relay frame');
      }
    });
    send(socket, JSON.stringify({ type: 'challenge', version: 1, nonce: nonce.toString('base64url') }));
  }

  function phoneSocket(socket: WebSocket, serverId: string, ip: string): void {
    const admitted = admit(phoneAttempts, ip, limits.perIpPhoneConnectionsPerMinute);
    const server = servers.get(serverId);
    if (!server) {
      counts.rejectedConnections++;
      closeSocket(socket, TunnelCloseCode.UnknownServer, 'Unknown server');
      return;
    }
    if (!admitted || phones.size >= limits.maxPhones || server.phones.size >= limits.perServerPhoneConnections
      || (perIpPhones.get(ip) ?? 0) >= limits.perIpPhoneConnections || server.socket.bufferedAmount > limits.maxBufferedBytes) {
      counts.rejectedConnections++;
      closeSocket(socket, TunnelCloseCode.RateLimited, 'Too many phone connections');
      return;
    }
    // Global uniqueness also makes another server's connection ids unaddressable.
    do { nextConnection = (nextConnection + 1) >>> 0; } while (!nextConnection || phones.has(nextConnection));
    const now = clock();
    const phone: Phone = { socket, server, connection: nextConnection, ip, active: true, lastActivity: now, tokens: limits.burstBytes, tokenTime: now };
    phones.set(phone.connection, phone);
    server.phones.set(phone.connection, phone);
    perIpPhones.set(ip, (perIpPhones.get(ip) ?? 0) + 1);
    socket.once('close', () => closePhone(phone, 1000, 'Phone disconnected'));
    socket.on('ping', (data: Buffer) => {
      if (phone.socket.bufferedAmount > limits.maxBufferedBytes) {
        closePhone(phone, TunnelCloseCode.RateLimited, 'Destination is busy');
      } else socket.pong(data);
    });
    socket.on('message', (data: RawData, binary: boolean) => {
      if (!phone.active || socket.readyState !== WebSocket.OPEN) return;
      if (!binary) { closePhone(phone, TunnelCloseCode.ProtocolError, 'Expected a binary message'); return; }
      const payload = bytes(data);
      if (payload.length > NOISE_MAX_MESSAGE) { closePhone(phone, TunnelCloseCode.ProtocolError, 'Message is too large'); return; }
      forward(phone, server.socket, payload, true);
    });
    if (!send(server.socket, encodeRelayFrame({ op: RelayOp.Open, connection: phone.connection, payload: new TextEncoder().encode(ip) }))) {
      closePhone(phone, TunnelCloseCode.UnknownServer, 'Server disconnected');
    }
    logger.debug('Relay phone opened', { serverId: server.serverId.slice(0, 8), phones: phones.size });
  }

  http.on('upgrade', (request, socket, head) => {
    const path = request.url ?? '';
    const id = path.startsWith(RELAY_CONNECT_PATH) ? path.slice(RELAY_CONNECT_PATH.length) : '';
    if (closing || (path !== RELAY_SERVER_PATH && !ServerIdSchema.safeParse(id).success)) {
      // Upgrade sockets are no longer owned by HTTP shutdown. Do not wait for
      // an untrusted half-open peer to acknowledge the refusal or send FIN.
      const timeout = setTimeout(() => socket.destroy(), 250);
      timeout.unref();
      socket.once('close', () => clearTimeout(timeout));
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      return;
    }
    const ip = clientIp(request, options.trustProxy ?? false);
    sockets.handleUpgrade(request, socket, head, ws => {
      // ws emits an error for oversized/invalid wire frames; never log its contents.
      ws.on('error', () => {});
      if (closing) { closeSocket(ws, 1001, 'Relay stopped'); return; }
      if (path === RELAY_SERVER_PATH) serverSocket(ws, ip);
      else phoneSocket(ws, id, ip);
    });
  });

  let port: number;
  try { port = await listen(http, host, options.port ?? 8787); }
  catch (error) { sockets.close(); http.close(); throw error; }
  const heartbeat = setInterval(() => {
    for (const server of servers.values()) {
      if (!server.alive) { server.socket.terminate(); continue; }
      server.alive = false;
      if (server.socket.readyState === WebSocket.OPEN) server.socket.ping();
    }
  }, limits.heartbeatIntervalMs);
  heartbeat.unref();
  const housekeeping = setInterval(() => {
    const now = clock();
    prune(phoneAttempts, now);
    prune(registrationAttempts, now);
    for (const phone of phones.values()) {
      if (now - phone.lastActivity >= limits.phoneIdleTimeoutMs) closePhone(phone, 1000, 'Connection idle');
    }
  }, Math.min(1000, limits.phoneIdleTimeoutMs));
  housekeeping.unref();
  const url = `ws://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return {
    port,
    url,
    stats: () => ({ servers: servers.size, phones: phones.size, ...counts }),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(heartbeat);
      clearInterval(housekeeping);
      closePromise = new Promise(resolve => {
        for (const ws of sockets.clients) closeSocket(ws, 1001, 'Relay stopped');
        sockets.close(() => {
          http.close(() => resolve());
          http.closeIdleConnections();
          http.closeAllConnections();
        });
      });
      return closePromise;
    },
  };
}
