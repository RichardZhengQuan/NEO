import { describe, expect, it } from 'vitest';
import { NOISE_MAX_MESSAGE, TunnelCloseCode, TunnelFrameType } from '@neo/protocol';
import { acceptChannel, openChannel } from './channel.js';
import { encodeFrame, TunnelProtocolError } from './frames.js';
import { linkPair, type MessageLink } from './link.js';
import { generateKeyPair, NkInitiator, tunnelPrologue } from './noise.js';

const serverId = '0123456789abcdef0123456789abcdef';

async function channels(a: MessageLink, b: MessageLink) {
  const staticKey = generateKeyPair();
  const server = acceptChannel(b, { serverId, staticKey });
  const client = openChannel(a, { serverId, serverPublicKey: staticKey.publicKey });
  return Promise.all([client, server]);
}

describe('secure channels', () => {
  it('handshakes and exchanges encrypted frames both ways', async () => {
    const [a, b] = linkPair();
    const [client, server] = await channels(a, b);
    const received: number[] = [];
    server.onFrame = (frame) => {
      received.push(frame.stream);
      server.send({ ...frame, type: TunnelFrameType.Response });
    };
    client.onFrame = (frame) => received.push(frame.stream + 10);
    client.send({ type: TunnelFrameType.Request, stream: 3, payload: new Uint8Array([1, 2]) });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([3, 13]);
    client.close();
    await Promise.resolve();
    expect(client.closed).toBe(true);
    expect(server.closed).toBe(true);
  });

  it('rejects a wrong pinned key and closes both handshake endpoints', async () => {
    const [a, b] = linkPair();
    const closed: number[] = [];
    const closeA = a.close.bind(a);
    const closeB = b.close.bind(b);
    a.close = (code, reason) => { closed.push(code!); closeA(code, reason); };
    b.close = (code, reason) => { closed.push(code!); closeB(code, reason); };
    const server = acceptChannel(b, { serverId, staticKey: generateKeyPair() });
    const client = openChannel(a, { serverId, serverPublicKey: generateKeyPair().publicKey });
    const results = await Promise.allSettled([client, server]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(closed).toContain(TunnelCloseCode.CryptoError);
    expect(() => a.send(new Uint8Array())).toThrow();
    expect(() => b.send(new Uint8Array())).toThrow();
  });

  it.each(['tamper', 'replay'] as const)('closes a %s transport message with CryptoError, once', async (kind) => {
    const [a, b] = linkPair();
    const [client, server] = await channels(a, b);
    const send = a.send.bind(a);
    let observedCode = 0;
    const close = b.close.bind(b);
    b.close = (code, reason) => { observedCode = code!; close(code, reason); };
    let closes = 0;
    server.onClose = () => { closes++; };
    a.send = (data) => {
      const bytes = data.slice();
      if (kind === 'tamper') bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      send(bytes);
      if (kind === 'replay') send(bytes);
    };
    client.send({ type: TunnelFrameType.Ping, stream: 0, payload: new Uint8Array() });
    await Promise.resolve();
    await Promise.resolve();
    expect(observedCode).toBe(TunnelCloseCode.CryptoError);
    expect(server.closed).toBe(true);
    expect(client.closed).toBe(true);
    expect(closes).toBe(1);
  });

  it('rejects authenticated handshake payloads because only empty handshakes are safe', async () => {
    const [a, b] = linkPair();
    const staticKey = generateKeyPair();
    const server = acceptChannel(b, { serverId, staticKey });
    const noise = new NkInitiator({ remoteStaticKey: staticKey.publicKey, prologue: tunnelPrologue(serverId) });
    a.send(noise.writeMessage1(new Uint8Array([1])));
    await expect(server).rejects.toThrow('Handshake payload must be empty');
  });

  it('closes semantic frame failures without letting a consumer exception escape delivery', async () => {
    const [a, b] = linkPair();
    const [client, server] = await channels(a, b);
    let code = 0;
    const close = b.close.bind(b);
    b.close = (value, reason) => { code = value!; close(value, reason); };
    server.onFrame = () => { throw new TunnelProtocolError('Malformed request head'); };
    client.send({ type: TunnelFrameType.Request, stream: 1, payload: new Uint8Array() });
    await Promise.resolve();
    await Promise.resolve();
    expect(code).toBe(TunnelCloseCode.ProtocolError);
    expect(client.closed).toBe(true);
    expect(server.closed).toBe(true);
  });

  it('closes on authenticated invalid frames, oversized link messages and closed-session messages', async () => {
    const [a, b] = linkPair();
    const staticKey = generateKeyPair();
    let closedCode = 0;
    const close = b.close.bind(b);
    b.close = (code, reason) => { closedCode = code!; close(code, reason); };
    const serverPromise = acceptChannel(b, { serverId, staticKey });
    const initiator = new NkInitiator({ remoteStaticKey: staticKey.publicKey, prologue: tunnelPrologue(serverId) });
    const reply = new Promise<Uint8Array>((resolve) => { a.onMessage = resolve; });
    a.send(initiator.writeMessage1());
    const transport = initiator.readMessage2(await reply).transport;
    const server = await serverPromise;
    a.send(transport.encrypt(new Uint8Array([255, 0, 0, 0, 1])));
    await Promise.resolve();
    expect(server.closed).toBe(true);
    expect(closedCode).toBe(TunnelCloseCode.ProtocolError);

    const [c, d] = linkPair();
    const [client2, server2] = await channels(c, d);
    d.onMessage?.(new Uint8Array(NOISE_MAX_MESSAGE + 1));
    expect(server2.closed).toBe(true);
    d.onMessage?.(encodeFrame({ type: TunnelFrameType.Ping, stream: 0, payload: new Uint8Array() }));
    await Promise.resolve();
    expect(client2.closed).toBe(true);
  });

  it('times out and closes when its peer never responds', async () => {
    const [a, b] = linkPair();
    const closed = new Promise<number>((resolve) => { b.onClose = resolve; });
    await expect(openChannel(a, { serverId, serverPublicKey: generateKeyPair().publicKey, timeoutMs: 5 }))
      .rejects.toThrow('timed out');
    expect(await closed).toBe(TunnelCloseCode.ProtocolError);
    expect(() => b.send(new Uint8Array())).toThrow();
  });
});
