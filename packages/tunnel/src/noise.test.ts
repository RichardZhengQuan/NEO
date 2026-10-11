import { describe, expect, it } from 'vitest';
import { NOISE_MAX_MESSAGE, TUNNEL_PROLOGUE_PREFIX } from '@neo/protocol';
import { bytesToHex, hexToBytes, utf8 } from './bytes.js';
import { generateKeyPair, NkInitiator, NkResponder, NoiseError, publicKeyFromPrivate, tunnelPrologue, type KeyPair } from './noise.js';
import { NK_VECTORS } from './noise-vectors.test-data.js';

function keyPair(privateHex: string): KeyPair {
  const privateKey = hexToBytes(privateHex);
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}

function peers(staticKey = generateKeyPair(), prologue = tunnelPrologue('0123456789abcdef0123456789abcdef')) {
  return {
    initiator: new NkInitiator({ remoteStaticKey: staticKey.publicKey, prologue }),
    responder: new NkResponder({ staticKey, prologue }),
  };
}

function session() {
  const { initiator, responder } = peers();
  const message1 = initiator.writeMessage1();
  responder.readMessage1(message1);
  const { message: message2, transport: server } = responder.writeMessage2();
  const { transport: phone } = initiator.readMessage2(message2);
  return { phone, server, message1, message2 };
}

function flip(bytes: Uint8Array, offset: number): Uint8Array {
  const changed = bytes.slice();
  changed[offset] = changed[offset]! ^ 1;
  return changed;
}

describe('Noise NK', () => {
  for (const vector of NK_VECTORS) {
    it(`matches every ${vector.source} official ciphertext, plaintext and handshake hash`, () => {
      const prologue = hexToBytes(vector.prologue);
      const initiator = new NkInitiator({
        remoteStaticKey: hexToBytes(vector.respPublic), prologue, ephemeral: keyPair(vector.initEphemeral),
      });
      const responder = new NkResponder({
        staticKey: { privateKey: hexToBytes(vector.respStatic), publicKey: hexToBytes(vector.respPublic) },
        prologue, ephemeral: keyPair(vector.respEphemeral),
      });
      const first = vector.messages[0]!;
      const message1 = initiator.writeMessage1(hexToBytes(first.payload));
      expect(bytesToHex(message1)).toBe(first.ciphertext);
      expect(bytesToHex(responder.readMessage1(message1))).toBe(first.payload);
      const second = vector.messages[1]!;
      const { message: message2, transport: server } = responder.writeMessage2(hexToBytes(second.payload));
      expect(bytesToHex(message2)).toBe(second.ciphertext);
      const { payload, transport: phone } = initiator.readMessage2(message2);
      expect(bytesToHex(payload)).toBe(second.payload);
      expect(phone.handshakeHash).toEqual(server.handshakeHash);
      if (vector.handshakeHash) expect(bytesToHex(phone.handshakeHash)).toBe(vector.handshakeHash);
      for (let i = 2; i < vector.messages.length; i++) {
        const expected = vector.messages[i]!;
        const [sender, receiver] = i % 2 === 0 ? [phone, server] : [server, phone];
        const ciphertext = sender.encrypt(hexToBytes(expected.payload));
        expect(bytesToHex(ciphertext)).toBe(expected.ciphertext);
        expect(bytesToHex(receiver.decrypt(ciphertext))).toBe(expected.payload);
      }
    });
  }

  it('authenticates empty handshake payloads and the pinned static key', () => {
    const actual = generateKeyPair();
    const wrong = generateKeyPair();
    const prologue = tunnelPrologue('server');
    const initiator = new NkInitiator({ remoteStaticKey: wrong.publicKey, prologue });
    const responder = new NkResponder({ staticKey: actual, prologue });
    const message1 = initiator.writeMessage1();
    expect(message1.length).toBe(48);
    expect(() => responder.readMessage1(message1)).toThrow(NoiseError);
    expect(() => responder.writeMessage2()).toThrow(NoiseError);
    expect(() => initiator.readMessage2(new Uint8Array(48))).toThrow(NoiseError);
  });

  it('rejects a responder that does not own the pinned private key', () => {
    const pinned = generateKeyPair();
    const thief = generateKeyPair();
    const prologue = tunnelPrologue('server');
    const initiator = new NkInitiator({ remoteStaticKey: pinned.publicKey, prologue });
    const responder = new NkResponder({ staticKey: thief, prologue });
    const message1 = initiator.writeMessage1();
    expect(() => responder.readMessage1(message1)).toThrow(NoiseError);
    // Even an otherwise valid second message from the thief's session cannot authenticate.
    const thiefPhone = new NkInitiator({ remoteStaticKey: thief.publicKey, prologue });
    const thiefServer = new NkResponder({ staticKey: thief, prologue });
    thiefServer.readMessage1(thiefPhone.writeMessage1());
    expect(() => initiator.readMessage2(thiefServer.writeMessage2().message)).toThrow(NoiseError);
  });

  it('rejects tampering at every byte of either handshake message', () => {
    for (let offset = 0; offset < 48; offset++) {
      const { initiator, responder } = peers();
      expect(() => responder.readMessage1(flip(initiator.writeMessage1(), offset))).toThrow(NoiseError);
      const next = peers();
      next.responder.readMessage1(next.initiator.writeMessage1());
      expect(() => next.initiator.readMessage2(flip(next.responder.writeMessage2().message, offset))).toThrow(NoiseError);
    }
  });

  it('rejects every tampered transport byte and permanently kills that session', () => {
    for (let offset = 0; offset < 24; offset++) {
      const { phone, server } = session();
      const ciphertext = phone.encrypt(utf8('12345678'));
      expect(() => server.decrypt(flip(ciphertext, offset))).toThrow(NoiseError);
      expect(() => server.decrypt(ciphertext)).toThrow(NoiseError);
      expect(() => server.encrypt(utf8('dead'))).toThrow(NoiseError);
    }
  });

  it('rejects replay and reordered transport messages without recovering', () => {
    const first = session();
    const ciphertext = first.phone.encrypt(utf8('hello'));
    expect(first.server.decrypt(ciphertext)).toEqual(utf8('hello'));
    expect(() => first.server.decrypt(ciphertext)).toThrow(NoiseError);
    expect(() => first.server.decrypt(first.phone.encrypt(utf8('next')))).toThrow(NoiseError);
    const second = session();
    const earlier = second.phone.encrypt(utf8('earlier'));
    const later = second.phone.encrypt(utf8('later'));
    expect(() => second.server.decrypt(later)).toThrow(NoiseError);
    expect(() => second.server.decrypt(earlier)).toThrow(NoiseError);
  });

  it('gives a replayed first message a fresh session with incompatible transport keys', () => {
    const staticKey = generateKeyPair();
    const prologue = tunnelPrologue('server');
    const { initiator, responder } = peers(staticKey, prologue);
    const message1 = initiator.writeMessage1();
    responder.readMessage1(message1);
    const original = responder.writeMessage2();
    const phone = initiator.readMessage2(original.message).transport;
    const replayResponder = new NkResponder({ staticKey, prologue });
    expect(replayResponder.readMessage1(message1)).toEqual(new Uint8Array());
    const replay = replayResponder.writeMessage2();
    expect(replay.message).not.toEqual(original.message);
    expect(replay.transport.handshakeHash).not.toEqual(original.transport.handshakeHash);
    expect(() => replay.transport.decrypt(phone.encrypt(utf8('old session')))).toThrow(NoiseError);
  });

  it('binds the handshake to the server id prologue', () => {
    const staticKey = generateKeyPair();
    const initiator = new NkInitiator({ remoteStaticKey: staticKey.publicKey, prologue: tunnelPrologue('first') });
    const responder = new NkResponder({ staticKey, prologue: tunnelPrologue('second') });
    expect(() => responder.readMessage1(initiator.writeMessage1())).toThrow(NoiseError);
    expect(tunnelPrologue('id')).toEqual(utf8(TUNNEL_PROLOGUE_PREFIX + 'id'));
  });

  it('enforces method order and single use', () => {
    const first = peers();
    expect(() => first.initiator.readMessage2(new Uint8Array(48))).toThrow(NoiseError);
    expect(() => first.responder.writeMessage2()).toThrow(NoiseError);
    const second = peers();
    second.initiator.writeMessage1();
    expect(() => second.initiator.writeMessage1()).toThrow(NoiseError);
    const third = peers();
    const message1 = third.initiator.writeMessage1();
    third.responder.readMessage1(message1);
    expect(() => third.responder.readMessage1(message1)).toThrow(NoiseError);
    const fourth = peers();
    fourth.responder.readMessage1(fourth.initiator.writeMessage1());
    const message2 = fourth.responder.writeMessage2().message;
    fourth.initiator.readMessage2(message2);
    expect(() => fourth.initiator.readMessage2(message2)).toThrow(NoiseError);
    expect(() => fourth.responder.writeMessage2()).toThrow(NoiseError);
  });

  it('checks message and key lengths, including the tag overhead', () => {
    const largest = peers();
    const maximumPayload = new Uint8Array(NOISE_MAX_MESSAGE - 48);
    const message1 = largest.initiator.writeMessage1(maximumPayload);
    expect(message1.length).toBe(NOISE_MAX_MESSAGE);
    expect(largest.responder.readMessage1(message1)).toEqual(maximumPayload);
    const second = largest.responder.writeMessage2(maximumPayload);
    expect(second.message.length).toBe(NOISE_MAX_MESSAGE);
    const phone = largest.initiator.readMessage2(second.message).transport;
    const transportPayload = new Uint8Array(NOISE_MAX_MESSAGE - 16);
    expect(second.transport.decrypt(phone.encrypt(transportPayload))).toEqual(transportPayload);
    expect(() => peers().initiator.writeMessage1(new Uint8Array(NOISE_MAX_MESSAGE - 47))).toThrow(NoiseError);
    for (const length of [0, 47, NOISE_MAX_MESSAGE + 1]) {
      expect(() => peers().responder.readMessage1(new Uint8Array(length))).toThrow(NoiseError);
      const pair = peers();
      pair.initiator.writeMessage1();
      expect(() => pair.initiator.readMessage2(new Uint8Array(length))).toThrow(NoiseError);
    }
    expect(() => session().phone.encrypt(new Uint8Array(NOISE_MAX_MESSAGE - 15))).toThrow(NoiseError);
    expect(() => session().server.decrypt(new Uint8Array(15))).toThrow(NoiseError);
    expect(() => session().server.decrypt(new Uint8Array(NOISE_MAX_MESSAGE + 1))).toThrow(NoiseError);
    expect(() => publicKeyFromPrivate(new Uint8Array(31))).toThrow(NoiseError);
    expect(() => new NkInitiator({ remoteStaticKey: new Uint8Array(33), prologue: new Uint8Array() })).toThrow(NoiseError);
    const invalid = generateKeyPair();
    invalid.publicKey[0] = invalid.publicKey[0]! ^ 1;
    expect(() => new NkResponder({ staticKey: invalid, prologue: new Uint8Array() })).toThrow(NoiseError);
  });

  it('refuses either nonce before the integer counter could lose precision', () => {
    const { phone, server } = session();
    const sending = phone as unknown as { sending: { nonce: number } };
    sending.sending.nonce = Number.MAX_SAFE_INTEGER;
    expect(() => phone.encrypt(utf8('exhausted'))).toThrow(NoiseError);
    const receiving = server as unknown as { receiving: { nonce: number } };
    receiving.receiving.nonce = Number.MAX_SAFE_INTEGER;
    expect(() => server.decrypt(new Uint8Array(16))).toThrow(NoiseError);
  });

  it('rejects low-order peer keys and keeps the handshake hash immutable', () => {
    const initiator = new NkInitiator({ remoteStaticKey: new Uint8Array(32), prologue: new Uint8Array() });
    expect(() => initiator.writeMessage1()).toThrow(NoiseError);
    const { phone, server } = session();
    phone.handshakeHash.fill(0);
    expect(phone.handshakeHash).toEqual(server.handshakeHash);
  });
});
