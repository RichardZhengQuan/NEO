import { describe, it, expect, vi, afterEach } from 'vitest';
import { createConnection } from './ws.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake WebSocket
// ─────────────────────────────────────────────────────────────────────────────

const instances: FakeWebSocket[] = [];

/** Minimal fake WebSocket for connect() tests. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  private sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Test helpers: simulate server actions.
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    // Use a plain object instead of CloseEvent (not available in Node test env).
    const ev = { type: 'close', code, reason, wasClean: code === 1000 } as CloseEvent;
    this.onclose?.(ev);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket connect() tests
// ─────────────────────────────────────────────────────────────────────────────

describe('connect() WebSocket', () => {
  afterEach(() => {
    vi.useRealTimers();
    instances.length = 0;
  });

  it('subscribes and pings with the injected constructor when global WebSocket is absent', async () => {
    vi.useFakeTimers();
    const globalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    let conn: ReturnType<typeof createConnection> | undefined;

    try {
      delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      const ctx = {
        baseUrl: 'http://localhost:7777',
        getToken: () => 'ws-token',
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      };
      let resolveOpen!: () => void;
      const opened = new Promise<void>((resolve) => {
        resolveOpen = resolve;
      });
      conn = createConnection(ctx, {
        onEvent: () => {},
        onStatus: (s) => {
          if (s === 'open') {
            resolveOpen();
          }
        },
      });
      const ws = instances[0]!;

      expect(() => ws.simulateOpen()).not.toThrow();
      expect(ws['sentMessages'].map((message) => JSON.parse(message))).toContainEqual({
        type: 'auth', token: 'ws-token',
      });
      expect(() => {
        ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
      }).not.toThrow();
      await opened;
      expect(conn.status).toBe('open');
      expect(ws['sentMessages'].map((message) => JSON.parse(message))).toContainEqual({
        type: 'subscribe', conversations: 'all',
      });

      expect(() => vi.advanceTimersByTime(25_000)).not.toThrow();
      expect(ws['sentMessages'].map((message) => JSON.parse(message))).toContainEqual({
        type: 'ping', id: expect.any(String),
      });
    } finally {
      conn?.close();
      if (globalWebSocket) {
        Object.defineProperty(globalThis, 'WebSocket', globalWebSocket);
      }
    }
  });

  it('closing from inside the open listener leaves no ping timer', () => {
    vi.useFakeTimers();
    const ctx = {
      baseUrl: 'http://localhost:7777',
      getToken: () => 'ws-token',
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    };
    const conn = createConnection(ctx, {
      onEvent: () => {},
      onStatus: (s) => {
        if (s === 'open') {
          conn.close();
        }
      },
      reconnect: true,
    });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    expect(conn.status).toBe('closed');

    // Advance time well past PING_INTERVAL_MS — a leaked self-rescheduling
    // ping timer would keep scheduling itself here and leave a non-zero count.
    vi.advanceTimersByTime(100_000);
    expect(conn.status).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('status becomes closed when WebSocket constructor throws and reconnect:false', () => {
    const statuses: string[] = [];
    let throwOnConstruct = true;
    class ThrowingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        if (throwOnConstruct) {
          throw new Error('constructor error');
        }
        super(url);
      }
    }
    const ctx = {
      baseUrl: 'http://localhost:7777',
      getToken: () => 'ws-token',
      WebSocketCtor: ThrowingWebSocket as unknown as typeof WebSocket,
    };
    const conn = createConnection(ctx, {
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      reconnect: false,
    });

    expect(conn.status).toBe('closed');
    expect(statuses).toContain('closed');
  });

  it('closing from inside the reconnecting listener prevents further socket construction', () => {
    vi.useFakeTimers();
    const ctx = {
      baseUrl: 'http://localhost:7777',
      getToken: () => 'ws-token',
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    };
    const conn = createConnection(ctx, {
      onEvent: () => {},
      onStatus: (s) => {
        if (s === 'reconnecting') {
          conn.close();
        }
      },
      reconnect: true,
    });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    expect(conn.status).toBe('open');

    ws.simulateClose(1006, '');

    vi.advanceTimersByTime(2000);
    expect(instances).toHaveLength(1);
    expect(conn.status).toBe('closed');
  });
});
