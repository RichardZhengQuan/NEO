import { NOISE_MAX_MESSAGE, TunnelCloseCode } from '@neo/protocol';

export interface MessageLink {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** A zero value also covers links without a write queue. */
  readonly bufferedAmount: number;
  onMessage: ((data: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

/** Event types differ between DOM and ws; consumers only inspect their shared fields. */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  onopen?: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
}

function notify(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // A consumer callback cannot disrupt link cleanup or the delivery queue.
  }
}

export function webSocketLink(socket: WebSocketLike): MessageLink {
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    notify(link.onClose ? () => link.onClose?.(code, reason) : undefined);
  };
  const link: MessageLink = {
    onMessage: null,
    onClose: null,
    get bufferedAmount() {
      return socket.bufferedAmount || 0;
    },
    send(data) {
      if (closed || socket.readyState !== 1) throw new Error('Link is closed');
      if (data.length > NOISE_MAX_MESSAGE) {
        link.close(TunnelCloseCode.ProtocolError, 'Message is too large');
        throw new Error('Message is too large');
      }
      socket.send(data);
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      // Report closure even when a broken socket never produces its close event.
      finish(code, reason);
      try {
        socket.close(code, reason);
      } catch {
        try { socket.close(); } catch { /* The link is already closed. */ }
      }
    },
  };
  socket.binaryType = 'arraybuffer';
  socket.onmessage = (event: { data: unknown }) => {
    if (closed) return;
    const data = event.data;
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      link.close(TunnelCloseCode.ProtocolError, 'Expected a binary message');
      return;
    }
    if (bytes.length > NOISE_MAX_MESSAGE) {
      link.close(TunnelCloseCode.ProtocolError, 'Message is too large');
      return;
    }
    notify(link.onMessage ? () => link.onMessage?.(bytes) : undefined);
  };
  socket.onclose = (event: { code: number; reason: string }) => finish(event.code, event.reason);
  socket.onerror = () => {
    finish(1006, 'WebSocket error');
    try { socket.close(); } catch { /* The link is already closed. */ }
  };
  return link;
}

export function linkPair(): [MessageLink, MessageLink] {
  const state = [{ closed: false, buffered: 0 }, { closed: false, buffered: 0 }];
  const links = [0, 1].map((index): MessageLink => ({
    onMessage: null,
    onClose: null,
    get bufferedAmount() { return state[index]!.buffered; },
    send(data) {
      if (state[index]!.closed) throw new Error('Link is closed');
      const copy = data.slice();
      state[index]!.buffered += copy.length;
      queueMicrotask(() => {
        state[index]!.buffered -= copy.length;
        const other = links[1 - index]!;
        if (!state[1 - index]!.closed) {
          notify(other.onMessage ? () => other.onMessage?.(copy) : undefined);
        }
      });
    },
    close(code = 1000, reason = '') {
      if (state[index]!.closed) return;
      for (const item of state) item.closed = true;
      queueMicrotask(() => {
        for (const link of links) {
          notify(link.onClose ? () => link.onClose?.(code, reason) : undefined);
        }
      });
    },
  }));
  return [links[0]!, links[1]!];
}
