import type { Hono } from 'hono';
import { WSContext } from 'hono/ws';
import type { WSEvents, WSReadyState } from 'hono/ws';
import type { TunnelHandler, TunnelPeer } from '@neo/tunnel';

/** Adapt encrypted streams to the same HTTP and event handlers as the main listener. */
export function createTunnelHandler(options: { app: Hono; wsEvents: (peer: TunnelPeer) => WSEvents }): TunnelHandler {
  return {
    async fetch(request, peer) {
      const remoteAddress = peer.via === 'relay' ? `relay:${peer.ip}` : peer.ip;
      return options.app.fetch(request, { incoming: { socket: { remoteAddress } } });
    },
    openWebSocket(path, peer, socket) {
      if (path !== '/api/ws') return null;
      const events = options.wsEvents(peer);
      let readyState: WSReadyState = 1;
      const ws = new WSContext({
        get readyState() { return readyState; },
        send(data) {
          if (typeof data !== 'string') throw new TypeError('Expected a text WebSocket message');
          if (readyState === 1) socket.send(data);
        },
        close(code = 1000, reason = '') {
          if (readyState !== 1) return;
          readyState = 2;
          socket.close(code, reason);
        },
        raw: {
          ping() {},
          terminate() {
            if (readyState === 3) return;
            readyState = 2;
            socket.close(1006, 'WebSocket terminated');
          },
          once() {},
        },
      });
      events.onOpen?.(new Event('open'), ws);
      return {
        message(text) {
          if (readyState === 1) events.onMessage?.(new MessageEvent('message', { data: text }), ws);
        },
        close(code, reason) {
          if (readyState === 3) return;
          readyState = 3;
          const event = Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }) as Parameters<NonNullable<WSEvents['onClose']>>[0];
          events.onClose?.(event, ws);
        },
      };
    },
  };
}
