import { afterEach, describe, expect, it } from 'vitest';
import { TUNNEL_BODY_CHUNK, TunnelFrameType } from '@neo/protocol';
import type { TunnelReset } from '@neo/protocol';
import { toBase64Url } from './bytes.js';
import { acceptChannel } from './channel.js';
import type { SecureChannel } from './channel.js';
import { createTunnelTransport } from './client.js';
import { decodeJson, encodeJson } from './frames.js';
import type { Frame } from './frames.js';
import { generateServerIdentity } from './identity.js';
import type { ServerIdentity } from './identity.js';
import { linkPair } from './link.js';
import type { MessageLink, WebSocketLike } from './link.js';

const cleanup: (() => void)[] = [];
const EMPTY = new Uint8Array();
const BODY_QUEUE_BUDGET = 4 * 1024 * 1024;
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function environment(input: {
  accept: (link: MessageLink, identity: ServerIdentity) => { close(): void };
}) {
  const identity = generateServerIdentity();
  const peers: { close(): void }[] = [];
  class FakeSocket implements WebSocketLike {
    readyState = 0;
    binaryType = 'blob';
    bufferedAmount = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private link: MessageLink | null = null;
    constructor(_url: string) {
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        const [phone, server] = linkPair();
        this.link = phone;
        phone.onMessage = bytes => this.onmessage?.({ data: bytes.slice().buffer });
        phone.onClose = (code, reason) => this.finished(code, reason);
        peers.push(input.accept(server, identity));
        this.readyState = 1;
        this.onopen?.(new Event('open'));
      });
      cleanup.push(() => this.close());
    }
    send(bytes: Uint8Array) {
      if (this.readyState !== 1) throw new Error('Not open');
      this.link!.send(bytes);
    }
    close(code = 1000, reason = '') {
      this.link?.close(code, reason);
      this.finished(code, reason);
    }
    private finished(code: number, reason: string) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }
  const transport = createTunnelTransport({
    route: {
      serverId: identity.serverId, publicKey: toBase64Url(identity.dh.publicKey),
      lan: ['lan:7778'], relay: null,
    },
    WebSocket: FakeSocket,
  });
  cleanup.push(() => { transport.close(); for (const peer of peers) peer.close(); });
  return { transport };
}

async function streamingResponse() {
  let channel!: SecureChannel;
  let stream = 0;
  let observe: ((frame: Frame) => void) | null = null;
  const { transport } = environment({ accept(link, identity) {
    void acceptChannel(link, { serverId: identity.serverId, staticKey: identity.dh }).then(value => {
      channel = value;
      channel.onFrame = frame => {
        if (frame.type === TunnelFrameType.RequestEnd) {
          stream = frame.stream;
          channel.send({ type: TunnelFrameType.Response, stream, payload: encodeJson({ status: 200, headers: [] }) });
        } else if (frame.type === TunnelFrameType.Reset || frame.type === TunnelFrameType.Pong) {
          const listener = observe;
          observe = null;
          listener?.(frame);
        }
      };
    }).catch(() => {});
    return { close() { link.close(); } };
  } });
  const response = await transport.fetch(`${transport.baseUrl}/api/stream`);
  return {
    transport, response, channel, stream,
    nextControl(): Promise<Frame> { return new Promise(resolve => { observe = resolve; }); },
  };
}

describe('tunnel client response body budget', () => {
  it.each(['never', 'slow'] as const)('resets an over-budget response for a %s reader and errors its body', async kind => {
    const { transport, response, channel, stream, nextControl } = await streamingResponse();
    const payload = new Uint8Array(TUNNEL_BODY_CHUNK);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    if (kind === 'slow') {
      reader = response.body!.getReader();
      const first = reader.read();
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
      expect((await first).value).toEqual(payload);
    }
    const received = nextControl();
    // For the slow-reader case one extra chunk is needed: the pending read absorbs
    // the first flood chunk directly (bypassing the queue), so the queue fills from
    // the second chunk onward and needs one more to exceed the budget.
    const flood = Math.floor(BODY_QUEUE_BUDGET / payload.length) + 1 + (kind === 'slow' ? 1 : 0);
    for (let index = 0; index < flood; index++) {
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
    }
    // Pong proves the flood was delivered if the client fails to send Reset.
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    const reset = await received;
    expect(reset.type).toBe(TunnelFrameType.Reset);
    expect(reset.stream).toBe(stream);
    expect(decodeJson<TunnelReset>(reset.payload)).toEqual({ code: 'limit' });
    reader ??= response.body!.getReader();
    await expect(reader.read()).rejects.toEqual(new TypeError('Response body too large'));

    const alive = nextControl();
    channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    expect((await alive).type).toBe(TunnelFrameType.Pong);
    expect(channel.closed).toBe(false);
    expect(transport.via).toBe('lan');
  });

  it('allows a response exactly at the byte budget', async () => {
    const { response, channel, stream, nextControl } = await streamingResponse();
    const payload = new Uint8Array(TUNNEL_BODY_CHUNK);
    const received = nextControl();
    for (let index = 0; index < BODY_QUEUE_BUDGET / payload.length; index++) {
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
    }
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    channel.send({ type: TunnelFrameType.Ping, stream: 0, payload: EMPTY });
    expect((await received).type).toBe(TunnelFrameType.Pong);
    expect((await response.arrayBuffer()).byteLength).toBe(BODY_QUEUE_BUDGET);
  });

  it('allows a fast reader to receive more than the budget in total', async () => {
    // A reader that consumes each chunk before the next arrives keeps the queue
    // empty throughout; the total bytes received may far exceed the budget without
    // triggering a reset.  This covers legitimate large responses such as memory
    // exports with embeddings and long SSE streams.
    const { response, channel, stream } = await streamingResponse();
    const payload = new Uint8Array(TUNNEL_BODY_CHUNK);
    const reader = response.body!.getReader();
    const count = Math.floor(BODY_QUEUE_BUDGET / payload.length) * 2; // 2× budget
    let totalReceived = 0;
    for (let index = 0; index < count; index++) {
      // Read is pending before the send so the chunk bypasses the queue and the
      // budget check never fires regardless of how many chunks are delivered.
      const pending = reader.read();
      channel.send({ type: TunnelFrameType.ResponseBody, stream, payload });
      const { value } = await pending;
      totalReceived += value!.byteLength;
    }
    channel.send({ type: TunnelFrameType.ResponseEnd, stream, payload: EMPTY });
    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(totalReceived).toBe(count * payload.length);
  });
});
