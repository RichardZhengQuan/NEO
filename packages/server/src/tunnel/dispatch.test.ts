import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, silentLogger, TUNNEL_FRAME_HEADER, TUNNEL_MAX_FRAME, TunnelFrameType } from '@neo/protocol';
import type { WsServerMessage } from '@neo/protocol';
import { decodeJson, encodeJson, generateServerIdentity, linkPair, openChannel, serveTunnel } from '@neo/tunnel';
import { getClientIp, IpFailureLimiter } from '../auth.js';
import { createServices } from '../services.js';
import type { NeoServices } from '../index.js';
import { createWsHandler, PING_INTERVAL_MS, revokeDeviceWebSockets } from '../ws.js';
import { createTunnelHandler } from './dispatch.js';

let services: NeoServices | null = null;
afterEach(async () => { await services?.close(); services = null; });

describe('tunnel dispatch', () => {
  it('uses the peer address and isolates relay IPs', async () => {
    const app = new Hono();
    app.get('/api/ip', c => c.text(getClientIp(c, false)));
    const handler = createTunnelHandler({ app, wsEvents: () => ({}) });
    expect(await (await handler.fetch(new Request('http://tunnel.invalid/api/ip'), { ip: '10.0.0.2', via: 'lan' })).text()).toBe('10.0.0.2');
    expect(await (await handler.fetch(new Request('http://tunnel.invalid/api/ip'), { ip: '10.0.0.2', via: 'relay' })).text()).toBe('relay:10.0.0.2');
  });

  it('ignores tunneled forwarded headers even with trustProxy enabled', async () => {
    const app = new Hono();
    app.get('/api/ip', c => c.text(getClientIp(c, true)));
    const handler = createTunnelHandler({ app, wsEvents: () => ({}) });
    const identity = generateServerIdentity();
    const [phone, server] = linkPair();
    const session = serveTunnel(server, { identity, handler, peer: { ip: '192.168.1.5', via: 'lan' } });
    const channel = await openChannel(phone, { serverId: identity.serverId, serverPublicKey: identity.dh.publicKey });
    try {
      let response = '';
      const done = new Promise<void>((resolve) => {
        channel.onFrame = frame => {
          if (frame.type === TunnelFrameType.Response) expect(decodeJson<{ status: number }>(frame.payload).status).toBe(200);
          if (frame.type === TunnelFrameType.ResponseBody) response += new TextDecoder().decode(frame.payload);
          if (frame.type === TunnelFrameType.ResponseEnd) resolve();
        };
      });
      channel.send({ type: TunnelFrameType.Request, stream: 1, payload: encodeJson({ method: 'GET', path: '/api/ip', headers: [['X-Forwarded-For', '127.0.0.1'], ['X-Real-IP', '127.0.0.1']] }) });
      channel.send({ type: TunnelFrameType.RequestEnd, stream: 1, payload: new Uint8Array() });
      await done;
      expect(response).toBe('192.168.1.5');
    } finally { channel.close(); session.close(); }
  });

  it('drives the existing authenticated handler, subscriptions and revocation', async () => {
    services = await createServices(NeoConfigSchema.parse({}), { inMemory: true });
    const { devices, events } = services;
    const device = devices.create({ name: 'Phone', platform: 'ios' });
    const sent: string[] = [];
    const close = vi.fn();
    const limiter = new IpFailureLimiter();
    const handler = createTunnelHandler({ app: new Hono(), wsEvents: peer => createWsHandler(devices, events, silentLogger, { ip: peer.ip, limiter }) });
    expect(handler.openWebSocket('/api/elsewhere', { ip: '192.168.1.5', via: 'lan' }, { send: text => sent.push(text), close })).toBeNull();
    const socket = handler.openWebSocket('/api/ws', { ip: '192.168.1.5', via: 'lan' }, { send: text => sent.push(text), close })!;
    try {
      socket.message(JSON.stringify({ type: 'auth', token: device.token }));
      expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'ready' });
      socket.message(JSON.stringify({ type: 'subscribe', conversations: [] }));
      events.publish({ type: 'settings.updated', settings: services.settings.get() });
      expect(JSON.parse(sent[1]!)).toMatchObject({ type: 'event', envelope: { event: { type: 'settings.updated' } } });
      revokeDeviceWebSockets(events, device.device.id);
      expect(close).toHaveBeenCalledWith(4401, 'Device revoked');
      socket.message(JSON.stringify({ type: 'ping', id: 'after-close' }));
      expect(sent).toHaveLength(2);
    } finally { socket.close(4401, 'Device revoked'); }
  });

  it('shares auth failure counters and exposes live readyState on the Hono context', async () => {
    services = await createServices(NeoConfigSchema.parse({}), { inMemory: true });
    const limiter = new IpFailureLimiter();
    const handler = createTunnelHandler({ app: new Hono(), wsEvents: peer => createWsHandler(services!.devices, services!.events, silentLogger, { ip: peer.ip, limiter }) });
    const send = vi.fn();
    const close = vi.fn();
    const socket = handler.openWebSocket('/api/ws', { ip: '10.0.0.2', via: 'lan' }, { send, close })!;
    socket.message('{invalid');
    expect(close).toHaveBeenCalledWith(4401, 'First message must authenticate');
    for (let index = 0; index < 9; index++) limiter.recordFailure('10.0.0.2');
    expect(limiter.isRateLimited('10.0.0.2')).toBe(true);
    const count = send.mock.calls.length;
    socket.message(JSON.stringify({ type: 'auth', token: services.ownerToken }));
    expect(send).toHaveBeenCalledTimes(count);
    socket.close(4401, 'Closed');
  });

  it.each([
    ['ASCII', 'x'.repeat(70_000)],
    ['multibyte UTF-8', '😀'.repeat(18_000)],
  ])('keeps the socket alive when a serialised %s event exceeds the tunnel frame cap', async (_encoding, bigText) => {
    services = await createServices(NeoConfigSchema.parse({}), { inMemory: true });
    const { devices, events } = services;
    const device = devices.create({ name: 'Phone', platform: 'ios' });
    const sent: string[] = [];
    let ws: WSContext | undefined;
    const handler = createTunnelHandler({
      app: new Hono(),
      wsEvents(peer) {
        const handlers = createWsHandler(devices, events, silentLogger, { ip: peer.ip, limiter: new IpFailureLimiter() });
        return {
          ...handlers,
          onOpen(event, context) {
            ws = context;
            handlers.onOpen?.(event, context);
          },
        };
      },
    });
    let socketHandler: NonNullable<ReturnType<typeof handler.openWebSocket>> | null = null;
    const mockSocket = {
      send(text: string) {
        if (new TextEncoder().encode(text).byteLength + TUNNEL_FRAME_HEADER > TUNNEL_MAX_FRAME) {
          socketHandler?.close(1009, 'Message too large');
          return;
        }
        sent.push(text);
      },
      close: vi.fn(),
    };
    vi.useFakeTimers();
    socketHandler = handler.openWebSocket('/api/ws', { ip: '10.0.0.1', via: 'lan' }, mockSocket)!;
    try {
      socketHandler.message(JSON.stringify({ type: 'auth', token: device.token }));
      expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'ready' });
      const envelope = events.publish({ type: 'settings.updated', settings: { ...services.settings.get(), locale: bigText } });
      const message: WsServerMessage = { type: 'event', envelope };
      expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeGreaterThanOrEqual(70_000);
      expect(ws?.readyState).toBe(1);
      expect(mockSocket.close).not.toHaveBeenCalledWith(1009, expect.anything());
      expect(sent).toHaveLength(1);

      vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
      expect(ws?.readyState).toBe(1);
      expect(mockSocket.close).not.toHaveBeenCalled();
      const smallEnvelope = events.publish({ type: 'settings.updated', settings: services.settings.get() });
      expect(JSON.parse(sent[1]!)).toEqual({ type: 'event', envelope: smallEnvelope });
    } finally {
      socketHandler.close(1000, 'Done');
      vi.useRealTimers();
    }
  });
});
