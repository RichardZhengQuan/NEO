import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, TunnelCloseCode } from '@neo/protocol';
import { generateServerIdentity } from '@neo/tunnel';
import type { TunnelHandler } from '@neo/tunnel';
import { LanConnectionLimiter, startLanListener } from './lan.js';
import type { LanListener } from './lan.js';

const listeners: LanListener[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  await Promise.all(listeners.splice(0).map(listener => listener.close()));
  for (const socket of sockets.splice(0)) socket.terminate();
});
const handler: TunnelHandler = { fetch: async () => new Response('API secret'), openWebSocket: () => null };
async function start(options: Partial<Parameters<typeof startLanListener>[0]> = {}): Promise<LanListener> {
  const listener = await startLanListener({ host: '127.0.0.1', port: 0, identity: generateServerIdentity(), handler, logger: silentLogger, ...options });
  listeners.push(listener);
  return listener;
}
async function connect(listener: LanListener): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${listener.port}/v1/tunnel`);
  sockets.push(ws);
  await once(ws, 'open');
  return ws;
}
async function close(ws: WebSocket): Promise<void> {
  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

describe('LAN listener', () => {
  it('never serves plaintext API requests and closes live sessions with 1001', async () => {
    const listener = await start();
    expect((await fetch(`http://127.0.0.1:${listener.port}/api/health`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${listener.port}/api/settings`)).status).toBe(404);
    const ws = await connect(listener);
    expect(listener.sessions()).toBe(1);
    const closed = once(ws, 'close');
    await listener.close();
    expect((await closed)[0]).toBe(1001);
    expect(listener.sessions()).toBe(0);
    await listener.close();
  });

  it('accepts upgrades only at the tunnel path', async () => {
    const listener = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/api/ws`);
    sockets.push(socket);
    await expect(once(socket, 'open')).rejects.toThrow('404');
    expect(listener.sessions()).toBe(0);
  });

  it('falls back to a free port when the configured port is occupied', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const port = (occupied.address() as { port: number }).port;
    const warn = vi.fn();
    try {
      const listener = await start({ port, logger: { ...silentLogger, warn } });
      expect(listener.port).not.toBe(port);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('port is in use'), { port });
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });

  it('caps concurrent sessions per IP at sixteen', async () => {
    const listener = await start();
    await Promise.all(Array.from({ length: 16 }, () => connect(listener)));
    expect(listener.sessions()).toBe(16);
    const refused = await connect(listener);
    expect((await once(refused, 'close'))[0]).toBe(TunnelCloseCode.RateLimited);
    expect(listener.sessions()).toBe(16);
    // A peer that ignores the refusal close frame must not occupy a native socket.
    const unresponsive = createConnection({ host: '127.0.0.1', port: listener.port });
    unresponsive.on('data', () => {});
    const terminated = once(unresponsive, 'close');
    await once(unresponsive, 'connect');
    unresponsive.write(`GET /v1/tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16).toString('base64')}\r\n\r\n`);
    await terminated;
    expect(unresponsive.destroyed).toBe(true);
  });

  it('caps sessions across all IPs at 256 and releases admission slots', () => {
    const limits = new LanConnectionLimiter(() => 1000);
    for (let index = 0; index < 256; index++) expect(limits.accept(`192.168.1.${Math.floor(index / 16) + 1}`)).toBe(true);
    expect(limits.accept('192.168.1.30')).toBe(false);
    limits.release('192.168.1.1');
    expect(limits.accept('192.168.1.30')).toBe(true);
    expect(limits.accept('192.168.1.31')).toBe(false);
  });

  it('caps new connections per minute and expires the sliding window using the clock', async () => {
    let now = 1000;
    const listener = await start({ clock: () => now });
    for (let index = 0; index < 60; index++) await close(await connect(listener));
    const refused = await connect(listener);
    expect((await once(refused, 'close'))[0]).toBe(TunnelCloseCode.RateLimited);
    now += 60_000;
    const accepted = await connect(listener);
    expect(listener.sessions()).toBe(1);
    await close(accepted);
  });
});
