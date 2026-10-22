import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { NOISE_MAX_MESSAGE, systemClock, TUNNEL_LAN_PATH, TunnelCloseCode } from '@neo/protocol';
import type { Clock, Logger } from '@neo/protocol';
import { serveTunnel, webSocketLink } from '@neo/tunnel';
import type { ServerIdentity, TunnelHandler } from '@neo/tunnel';

export interface LanListener {
  port: number;
  close(): Promise<void>;
  sessions(): number;
}

/** Sliding-window admission limits include sessions still performing their handshake. */
export class LanConnectionLimiter {
  private readonly perIp = new Map<string, number>();
  private readonly attempts = new Map<string, number[]>();
  private total = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  accept(ip: string): boolean {
    const now = this.clock();
    for (const [address, times] of this.attempts) {
      const recent = times.filter(time => now - time < 60_000);
      if (recent.length) this.attempts.set(address, recent);
      else this.attempts.delete(address);
    }
    const recent = this.attempts.get(ip) ?? [];
    const limited = this.total >= 256 || (this.perIp.get(ip) ?? 0) >= 16 || recent.length >= 60;
    if (recent.length < 60) recent.push(now);
    this.attempts.set(ip, recent);
    if (limited) return false;
    this.total++;
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    return true;
  }

  release(ip: string): void {
    const count = this.perIp.get(ip);
    if (!count) return;
    this.total--;
    if (count > 1) this.perIp.set(ip, count - 1);
    else this.perIp.delete(ip);
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Tunnel listener has no TCP address'));
      else resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** A separate listener that exposes ciphertext only, never the HTTP API. */
export async function startLanListener(options: {
  host: string;
  port: number;
  identity: ServerIdentity;
  handler: TunnelHandler;
  logger: Logger;
  clock?: Clock;
  maxRequestBodyBytes?: number;
}): Promise<LanListener> {
  const clock = options.clock ?? systemClock;
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: NOISE_MAX_MESSAGE });
  const sockets = new Set<WebSocket>();
  const limits = new LanConnectionLimiter(clock);
  let closing = false;
  let closePromise: Promise<void> | null = null;

  server.on('upgrade', (request, socket, head) => {
    if (closing || request.url !== TUNNEL_LAN_PATH) {
      const timeout = setTimeout(() => socket.destroy(), 250);
      timeout.unref();
      socket.once('close', () => clearTimeout(timeout));
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      return;
    }
    const ip = request.socket.remoteAddress ?? 'unknown';
    webSockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => {});
      if (closing || !limits.accept(ip)) {
        const timeout = setTimeout(() => ws.terminate(), 250);
        timeout.unref();
        ws.once('close', () => clearTimeout(timeout));
        ws.close(TunnelCloseCode.RateLimited, 'Too many tunnel connections');
        return;
      }
      sockets.add(ws);
      ws.once('close', () => {
        sockets.delete(ws);
        limits.release(ip);
      });
      serveTunnel(webSocketLink(ws), {
        identity: options.identity,
        handler: options.handler,
        peer: { ip, via: 'lan' },
        ...(options.maxRequestBodyBytes === undefined ? {} : { limits: { maxRequestBodyBytes: options.maxRequestBodyBytes } }),
      });
    });
  });

  let port: number;
  try {
    try {
      port = await listen(server, options.host, options.port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || options.port === 0) throw error;
      options.logger.warn('Phone access port is in use; using an available port instead.', { port: options.port });
      port = await listen(server, options.host, 0);
    }
  } catch (error) {
    webSockets.close();
    server.close();
    throw error;
  }

  return {
    port,
    sessions: () => sockets.size,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { for (const ws of webSockets.clients) ws.terminate(); }, 250);
        for (const ws of webSockets.clients) ws.close(1001, 'Phone access stopped');
        webSockets.close(() => {
          clearTimeout(timeout);
          server.close(() => resolve());
          server.closeIdleConnections();
          server.closeAllConnections();
        });
      });
      return closePromise;
    },
  };
}
