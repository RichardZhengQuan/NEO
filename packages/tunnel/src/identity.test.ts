import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { RELAY_REGISTER_CONTEXT, SERVER_ID_CONTEXT } from '@neo/protocol';
import { bytesToHex, concatBytes, toBase64Url, utf8 } from './bytes.js';
import { deriveServerId, generateServerIdentity, parseServerIdentity, serializeServerIdentity, signRelayChallenge, verifyRelayRegistration } from './identity.js';

describe('server identity', () => {
  it('round trips through JSON and derives the contextual signing-key id', () => {
    const identity = generateServerIdentity();
    const stored = serializeServerIdentity(identity);
    expect(Object.keys(stored)).toEqual(['version', 'dh', 'signing']);
    expect(parseServerIdentity(JSON.parse(JSON.stringify(stored)))).toEqual(identity);
    expect(identity.serverId).toBe(bytesToHex(sha256(concatBytes(utf8(SERVER_ID_CONTEXT), identity.signing.publicKey)).slice(0, 16)));
    expect(identity.serverId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseServerIdentity({ ...stored, serverId: identity.serverId })).toEqual(identity);
    expect(identity.dh.privateKey).not.toEqual(identity.signing.privateKey);
  });

  it('rejects malformed shape, version, encoding, lengths and a stored id mismatch', () => {
    const identity = generateServerIdentity();
    const stored = serializeServerIdentity(identity);
    for (const value of [null, 1, 'identity', [], {}, { ...stored, version: 2 }, { ...stored, serverId: '0'.repeat(32) },
      { ...stored, dh: null }, { ...stored, dh: { ...stored.dh, publicKey: 3 } },
      { ...stored, extra: true }, { ...stored, dh: { ...stored.dh, privateKey: 'invalid=' } }]) {
      expect(() => parseServerIdentity(value)).toThrow();
    }
    for (const kind of ['dh', 'signing'] as const) {
      for (const key of ['privateKey', 'publicKey'] as const) {
        for (const length of [0, 31, 33, 64]) {
          expect(() => parseServerIdentity({ ...stored, [kind]: { ...stored[kind], [key]: toBase64Url(new Uint8Array(length)) } })).toThrow();
        }
      }
    }
    expect(() => deriveServerId(new Uint8Array(31))).toThrow();
  });

  it('rejects swapped and mismatched public/private keys', () => {
    const identity = generateServerIdentity();
    const stored = serializeServerIdentity(identity);
    const other = serializeServerIdentity(generateServerIdentity());
    expect(() => parseServerIdentity({ ...stored, dh: stored.signing, signing: stored.dh })).toThrow();
    expect(() => parseServerIdentity({ ...stored, dh: { ...stored.dh, publicKey: other.dh.publicKey } })).toThrow();
    expect(() => parseServerIdentity({ ...stored, signing: { ...stored.signing, privateKey: other.signing.privateKey } })).toThrow();
    expect(() => serializeServerIdentity({ ...identity, serverId: '0'.repeat(32) })).toThrow();
  });

  it('accepts only a genuine registration bound to the nonce and claimed id', () => {
    const identity = generateServerIdentity();
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const signature = signRelayChallenge(identity, nonce);
    expect(ed25519.verify(signature, concatBytes(utf8(RELAY_REGISTER_CONTEXT), nonce), identity.signing.publicKey)).toBe(true);
    const registration = { serverId: identity.serverId, key: toBase64Url(identity.signing.publicKey), signature: toBase64Url(signature), nonce };
    expect(verifyRelayRegistration(registration)).toBe(true);
    const changed = nonce.slice();
    changed[0] = changed[0]! ^ 1;
    expect(verifyRelayRegistration({ ...registration, nonce: changed })).toBe(false);
    const thief = generateServerIdentity();
    expect(verifyRelayRegistration({ ...registration, key: toBase64Url(thief.signing.publicKey), signature: toBase64Url(signRelayChallenge(thief, nonce)) })).toBe(false);
    expect(verifyRelayRegistration({ ...registration, signature: toBase64Url(signRelayChallenge(thief, nonce)) })).toBe(false);
  });

  it('never throws for garbage registration input or invalid signature encodings', () => {
    const identity = generateServerIdentity();
    const nonce = new Uint8Array(32);
    const valid = { serverId: identity.serverId, key: toBase64Url(identity.signing.publicKey), signature: toBase64Url(signRelayChallenge(identity, nonce)), nonce };
    const garbage: unknown[] = [null, undefined, 4, {}, { ...valid, nonce: 'nonce' }, { ...valid, nonce: new Uint8Array(31) },
      { ...valid, key: 'garbage!' }, { ...valid, key: toBase64Url(new Uint8Array(31)) },
      { ...valid, signature: 'bad=' }, { ...valid, signature: toBase64Url(new Uint8Array(63)) },
      { ...valid, signature: toBase64Url(new Uint8Array(64)) }, { ...valid, serverId: 'stolen' }];
    for (const input of garbage) {
      expect(verifyRelayRegistration(input as typeof valid)).toBe(false);
    }
    expect(() => signRelayChallenge(identity, new Uint8Array(31))).toThrow();
  });
});
