import { describe, expect, it } from 'vitest';
import { NOISE_MAX_MESSAGE, TunnelCloseCode } from '@neo/protocol';
import { linkPair, webSocketLink, type WebSocketLike } from './link.js';

class FakeSocket implements WebSocketLike {
  readyState = 1;
  binaryType = 'blob';
  bufferedAmount = 0;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: Uint8Array[] = [];
  closes: { code: number | undefined; reason: string | undefined }[] = [];
  send(data: Uint8Array) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); }
}

describe('message links', () => {
  it('delivers memory-link messages asynchronously in order and copies sender bytes', async () => {
    const [a, b] = linkPair();
    const values: number[] = [];
    b.onMessage = (data) => values.push(data[0]!);
    const bytes = new Uint8Array([1]);
    a.send(bytes);
    bytes[0] = 9;
    a.send(new Uint8Array([2]));
    expect(values).toEqual([]);
    expect(a.bufferedAmount).toBe(2);
    await Promise.resolve();
    expect(values).toEqual([1, 2]);
    expect(a.bufferedAmount).toBe(0);
  });

  it('closes both memory endpoints once and refuses further sends', async () => {
    const [a, b] = linkPair();
    const closes: number[] = [];
    a.onClose = (code) => closes.push(code);
    b.onClose = (code) => closes.push(code);
    a.close(4400, 'bad frame');
    b.close();
    await Promise.resolve();
    expect(closes).toEqual([4400, 4400]);
    expect(() => a.send(new Uint8Array())).toThrow();
    expect(() => b.send(new Uint8Array())).toThrow();
  });

  it('adapts binary views and reports buffered bytes', () => {
    // Compile-time proof that the browser constructor can be supplied directly.
    const compatible: (socket: WebSocket) => WebSocketLike = (socket) => socket;
    expect(compatible).toBeTypeOf('function');
    const socket = new FakeSocket();
    const link = webSocketLink(socket);
    const messages: Uint8Array[] = [];
    link.onMessage = (data) => messages.push(data);
    socket.bufferedAmount = 7;
    expect(socket.binaryType).toBe('arraybuffer');
    expect(link.bufferedAmount).toBe(7);
    socket.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    socket.onmessage?.({ data: new Uint8Array([0, 3, 4]).subarray(1) });
    expect(messages).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    link.send(new Uint8Array([5]));
    expect(socket.sent).toEqual([new Uint8Array([5])]);
  });

  it.each(['text', new Uint8Array(NOISE_MAX_MESSAGE + 1).buffer])('rejects nonbinary or oversized messages', (data) => {
    const socket = new FakeSocket();
    const link = webSocketLink(socket);
    const codes: number[] = [];
    link.onClose = (code) => codes.push(code);
    socket.onmessage?.({ data });
    socket.onclose?.({ code: 1006, reason: '' });
    expect(codes).toEqual([TunnelCloseCode.ProtocolError]);
    expect(socket.closes[0]?.code).toBe(TunnelCloseCode.ProtocolError);
  });
});
