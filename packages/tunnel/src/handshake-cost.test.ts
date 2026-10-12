import { afterEach, describe, expect, it, vi } from 'vitest';
import { TunnelCloseCode } from '@neo/protocol';
import { linkPair } from './link.js';
import { generateKeyPair, NkInitiator, NkResponder, tunnelPrologue } from './noise.js';
import { serveTunnel } from './server.js';

const curve = vi.hoisted(() => ({ calls: [] as string[] }));

// Pass-through wrappers record every X25519 call, including key generation, without changing any result.
vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/ed25519.js')>();
  const x25519 = actual.x25519;
  function counted<A extends unknown[], R>(name: string, operation: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      curve.calls.push(name);
      return operation(...args);
    };
  }
  return {
    ...actual,
    x25519: {
      ...x25519,
      keygen: counted('keygen', x25519.keygen),
      getPublicKey: counted('getPublicKey', x25519.getPublicKey),
      getSharedSecret: counted('getSharedSecret', x25519.getSharedSecret),
      scalarMult: counted('scalarMult', x25519.scalarMult),
      scalarMultBase: counted('scalarMultBase', x25519.scalarMultBase),
      utils: { ...x25519.utils, randomSecretKey: counted('randomSecretKey', x25519.utils.randomSecretKey) },
    },
  };
});

const serverId = '0123456789abcdef0123456789abcdef';
const prologue = tunnelPrologue(serverId);

afterEach(() => {
  vi.useRealTimers();
  curve.calls = [];
});

describe('responder handshake cost', () => {
  it('builds responders without curve work and generates the ephemeral only for message 2', () => {
    const staticKey = generateKeyPair();
    curve.calls = [];
    const first = new NkResponder({ staticKey, prologue });
    expect(curve.calls).toEqual(['getPublicKey']);
    curve.calls = [];
    for (let i = 0; i < 256; i++) new NkResponder({ staticKey, prologue });
    expect(curve.calls).toEqual([]);

    const initiator = new NkInitiator({ remoteStaticKey: staticKey.publicKey, prologue });
    const message1 = initiator.writeMessage1();
    curve.calls = [];
    first.readMessage1(message1);
    expect(curve.calls).toEqual(['getSharedSecret']);
    curve.calls = [];
    const { message, transport } = first.writeMessage2();
    expect(curve.calls).toEqual(['randomSecretKey', 'getPublicKey', 'getSharedSecret']);
    expect(initiator.readMessage2(message).transport.handshakeHash).toEqual(transport.handshakeHash);
  });

  it('costs sessions that never send message 1 no curve work, through their handshake timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const identity = { serverId, dh: generateKeyPair() };
    const handler = { fetch: async () => new Response(), openWebSocket: () => null };
    const phoneCloses: [number, string][] = [];
    let ended = 0;
    curve.calls = [];
    for (let i = 0; i < 256; i++) {
      const [phone, server] = linkPair();
      phone.onClose = (code, reason) => phoneCloses.push([code, reason]);
      serveTunnel(server, {
        identity, handler, peer: { ip: '127.0.0.1', via: 'relay' },
        limits: { handshakeTimeoutMs: 1000 },
        onClose: () => { ended++; },
      });
    }
    // The static pair's one-time check is the only curve operation across all 256 sessions.
    expect(curve.calls).toEqual(['getPublicKey']);

    await vi.advanceTimersByTimeAsync(999);
    expect(ended).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toBe(256);
    expect(phoneCloses).toEqual(Array(256).fill([TunnelCloseCode.ProtocolError, 'Tunnel handshake timed out']));
    expect(curve.calls).toEqual(['getPublicKey']);
  });
});
