import { NOISE_MAX_MESSAGE, TunnelCloseCode } from '@neo/protocol';
import { decodeFrame, encodeFrame, TunnelProtocolError, type Frame } from './frames.js';
import type { MessageLink } from './link.js';
import {
  NkInitiator,
  NkResponder,
  NoiseError,
  tunnelPrologue,
  type KeyPair,
  type NoiseTransport,
} from './noise.js';

export interface SecureChannel {
  send(frame: Frame): void;
  onFrame: ((frame: Frame) => void) | null;
  onClose: ((reason: string) => void) | null;
  close(reason?: string): void;
  readonly closed: boolean;
  readonly bufferedAmount: number;
}

function safeCall(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* Consumer callbacks must not escape link delivery. */ }
}

function makeChannel(link: MessageLink, transport: NoiseTransport): SecureChannel {
  let closed = false;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    safeCall(channel.onClose ? () => channel.onClose?.(reason) : undefined);
  };
  const fail = (code: number, reason: string) => {
    finish(reason);
    try { link.close(code, reason); } catch { /* Closure is already recorded. */ }
  };
  const channel: SecureChannel = {
    onFrame: null,
    onClose: null,
    get closed() { return closed; },
    get bufferedAmount() { return link.bufferedAmount; },
    close(reason = 'Channel closed') { fail(1000, reason); },
    send(frame) {
      if (closed) throw new TunnelProtocolError('Channel is closed');
      // Invalid local frames must not tear down the shared channel.
      const encoded = encodeFrame(frame);
      try {
        link.send(transport.encrypt(encoded));
      } catch (error) {
        fail(error instanceof NoiseError ? TunnelCloseCode.CryptoError : TunnelCloseCode.ProtocolError,
          error instanceof Error ? error.message : 'Send failed');
        throw error;
      }
    },
  };
  link.onClose = (_code, reason) => finish(reason || 'Link closed');
  link.onMessage = (message) => {
    if (closed) {
      try { link.close(TunnelCloseCode.ProtocolError, 'Message after session closure'); } catch { /* Closed. */ }
      return;
    }
    try {
      if (message.length > NOISE_MAX_MESSAGE) throw new TunnelProtocolError('Message is too large');
      const frame = decodeFrame(transport.decrypt(message));
      channel.onFrame?.(frame);
    } catch (error) {
      fail(error instanceof NoiseError ? TunnelCloseCode.CryptoError : TunnelCloseCode.ProtocolError,
        error instanceof Error ? error.message : 'Invalid message');
    }
  };
  return channel;
}

function handshake(
  link: MessageLink,
  timeoutMs: number,
  begin: () => void,
  receive: (message: Uint8Array) => NoiseTransport,
): Promise<SecureChannel> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = (error: unknown, code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const failure = error instanceof Error ? error : new Error('Handshake failed');
      // Retain a closed-session callback so late link messages cannot restart anything.
      link.onMessage = () => {
        try { link.close(TunnelCloseCode.ProtocolError, 'Message after handshake failure'); } catch { /* Closed. */ }
      };
      link.onClose = null;
      try { link.close(code, failure.message); } catch { /* Reject even if close fails. */ }
      reject(failure);
    };
    const timer = setTimeout(() => fail(new Error('Tunnel handshake timed out'), TunnelCloseCode.ProtocolError), timeoutMs);
    link.onClose = (_code, reason) => fail(new Error(reason || 'Link closed during handshake'), TunnelCloseCode.ProtocolError);
    link.onMessage = (message) => {
      if (finished) {
        try { link.close(TunnelCloseCode.ProtocolError, 'Unexpected handshake message'); } catch { /* Closed. */ }
        return;
      }
      try {
        if (message.length > NOISE_MAX_MESSAGE) throw new TunnelProtocolError('Message is too large');
        const transport = receive(message);
        const channel = makeChannel(link, transport);
        finished = true;
        clearTimeout(timer);
        resolve(channel);
      } catch (error) {
        fail(error, error instanceof NoiseError ? TunnelCloseCode.CryptoError : TunnelCloseCode.ProtocolError);
      }
    };
    try {
      begin();
    } catch (error) {
      fail(error, error instanceof NoiseError ? TunnelCloseCode.CryptoError : TunnelCloseCode.ProtocolError);
    }
  });
}

export function openChannel(link: MessageLink, options: {
  serverId: string;
  serverPublicKey: Uint8Array;
  timeoutMs?: number;
}): Promise<SecureChannel> {
  let initiator: NkInitiator;
  return handshake(link, options.timeoutMs ?? 10_000, () => {
    initiator = new NkInitiator({ remoteStaticKey: options.serverPublicKey, prologue: tunnelPrologue(options.serverId) });
    link.send(initiator.writeMessage1());
  }, (message) => {
    const { payload, transport } = initiator.readMessage2(message);
    if (payload.length !== 0) throw new TunnelProtocolError('Handshake payload must be empty');
    return transport;
  });
}

export function acceptChannel(link: MessageLink, options: {
  serverId: string;
  staticKey: KeyPair;
  timeoutMs?: number;
}): Promise<SecureChannel> {
  let responder: NkResponder;
  return handshake(link, options.timeoutMs ?? 10_000, () => {
    responder = new NkResponder({ staticKey: options.staticKey, prologue: tunnelPrologue(options.serverId) });
  }, (message) => {
    const payload = responder.readMessage1(message);
    if (payload.length !== 0) throw new TunnelProtocolError('Handshake payload must be empty');
    const reply = responder.writeMessage2();
    link.send(reply.message);
    return reply.transport;
  });
}
