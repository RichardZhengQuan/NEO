import { describe, expect, it, vi } from 'vitest';
import { WSContext } from 'hono/ws';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import { createServices } from './services.js';
import { createWsHandler, PING_INTERVAL_MS, WS_MAX_PAYLOAD } from './ws.js';

function makeRaw(bufferedAmount = 0, respondsToPing = false) {
  let pongListener: (() => void) | null = null;
  return {
    bufferedAmount,
    ping: vi.fn(() => {
      if (respondsToPing) {
        const listener = pongListener;
        pongListener = null;
        listener?.();
      }
    }),
    terminate: vi.fn(),
    once: vi.fn((event: 'error' | 'pong', listener: () => void) => {
      if (event === 'pong') pongListener = listener;
    }),
  };
}

function makeWs(raw: ReturnType<typeof makeRaw>): WSContext {
  let readyState: 0 | 1 | 2 | 3 = 1;
  return new WSContext({
    get readyState() { return readyState; },
    send: vi.fn(),
    close() { readyState = 3; },
    raw,
  });
}

describe('ws bufferedAmount ceiling', () => {
  it('terminates a slow client whose bufferedAmount exceeds WS_MAX_PAYLOAD', async () => {
    const services = await createServices(NeoConfigSchema.parse({}), { inMemory: true, logger: silentLogger });
    const { devices, events } = services;
    const device = devices.create({ name: 'App', platform: 'web' });
    const raw = makeRaw(WS_MAX_PAYLOAD + 1);
    const ws = makeWs(raw);
    const send = vi.spyOn(ws, 'send');
    const handler = createWsHandler(devices, events, silentLogger);
    try {
      handler.onOpen?.(new Event('open'), ws);
      handler.onMessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'auth', token: device.token }) }), ws);
      expect(send).toHaveBeenCalledWith(expect.stringContaining('"type":"ready"'));
      send.mockClear();
      const terminated = new Promise<void>((resolve) => { raw.terminate.mockImplementationOnce(resolve); });
      events.publish({ type: 'settings.updated', settings: services.settings.get() });
      // EventHub dispatch is synchronous, so a missing guard fails immediately.
      expect(raw.terminate).toHaveBeenCalledTimes(1);
      await terminated;
      expect(send).not.toHaveBeenCalled();
      events.publish({ type: 'settings.updated', settings: services.settings.get() });
      expect(raw.terminate).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      handler.onClose?.(new Event('close') as Parameters<NonNullable<typeof handler.onClose>>[0], ws);
      await services.close();
    }
  });
});

describe('ws pong deadline', () => {
  it('terminates a client that never responds to ping', async () => {
    const services = await createServices(NeoConfigSchema.parse({}), { inMemory: true, logger: silentLogger });
    const { devices, events } = services;
    const device = devices.create({ name: 'App', platform: 'web' });
    const raw = makeRaw();
    const ws = makeWs(raw);
    const responsiveRaw = makeRaw(0, true);
    const responsiveWs = makeWs(responsiveRaw);
    const handler = createWsHandler(devices, events, silentLogger);
    vi.useFakeTimers();
    try {
      for (const connection of [ws, responsiveWs]) {
        handler.onOpen?.(new Event('open'), connection);
        handler.onMessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'auth', token: device.token }) }), connection);
      }
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      expect(raw.ping).toHaveBeenCalledTimes(1);
      expect(responsiveRaw.ping).toHaveBeenCalledTimes(1);
      expect(raw.terminate).not.toHaveBeenCalled();
      expect(responsiveRaw.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      expect(raw.terminate).toHaveBeenCalledTimes(1);
      expect(responsiveRaw.ping).toHaveBeenCalledTimes(2);
      expect(responsiveRaw.terminate).not.toHaveBeenCalled();
    } finally {
      handler.onClose?.(new Event('close') as Parameters<NonNullable<typeof handler.onClose>>[0], ws);
      handler.onClose?.(new Event('close') as Parameters<NonNullable<typeof handler.onClose>>[0], responsiveWs);
      vi.useRealTimers();
      await services.close();
    }
  });
});
