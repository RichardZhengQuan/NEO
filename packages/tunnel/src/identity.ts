import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { RELAY_REGISTER_CONTEXT, SERVER_ID_CONTEXT } from '@neo/protocol';
import { bytesToHex, concatBytes, equalBytes, fromBase64Url, toBase64Url, utf8 } from './bytes.js';
import { generateKeyPair, publicKeyFromPrivate, type KeyPair } from './noise.js';

export interface ServerIdentity {
  serverId: string;
  dh: KeyPair;
  signing: KeyPair;
}

function requireLength(bytes: Uint8Array, length: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('Invalid identity key length');
}

export function generateServerIdentity(): ServerIdentity {
  const privateKey = ed25519.utils.randomSecretKey();
  const signing = { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
  return { serverId: deriveServerId(signing.publicKey), dh: generateKeyPair(), signing };
}

export function deriveServerId(signingPublicKey: Uint8Array): string {
  requireLength(signingPublicKey, 32);
  return bytesToHex(sha256(concatBytes(utf8(SERVER_ID_CONTEXT), signingPublicKey)).subarray(0, 16));
}

function validateIdentity(identity: ServerIdentity): void {
  for (const pair of [identity.dh, identity.signing]) {
    requireLength(pair.publicKey, 32);
    requireLength(pair.privateKey, 32);
  }
  if (identity.serverId !== deriveServerId(identity.signing.publicKey)
    || !equalBytes(publicKeyFromPrivate(identity.dh.privateKey), identity.dh.publicKey)
    || !equalBytes(ed25519.getPublicKey(identity.signing.privateKey), identity.signing.publicKey)) {
    throw new Error('Mismatched server identity');
  }
}

export function serializeServerIdentity(identity: ServerIdentity): {
  version: 1;
  dh: { publicKey: string; privateKey: string };
  signing: { publicKey: string; privateKey: string };
} {
  validateIdentity(identity);
  return {
    version: 1,
    dh: { publicKey: toBase64Url(identity.dh.publicKey), privateKey: toBase64Url(identity.dh.privateKey) },
    signing: { publicKey: toBase64Url(identity.signing.publicKey), privateKey: toBase64Url(identity.signing.privateKey) },
  };
}

function object(value: unknown, allowedKeys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed server identity');
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new Error('Malformed server identity');
  return value as Record<string, unknown>;
}

function parsePair(value: unknown): KeyPair {
  const pair = object(value, ['publicKey', 'privateKey']);
  if (typeof pair.publicKey !== 'string' || typeof pair.privateKey !== 'string') throw new Error('Malformed server identity');
  const publicKey = fromBase64Url(pair.publicKey);
  const privateKey = fromBase64Url(pair.privateKey);
  requireLength(publicKey, 32);
  requireLength(privateKey, 32);
  return { publicKey, privateKey };
}

export function parseServerIdentity(value: unknown): ServerIdentity {
  const stored = object(value, ['version', 'serverId', 'dh', 'signing']);
  if (stored.version !== 1) throw new Error('Unsupported server identity version');
  const dh = parsePair(stored.dh);
  const signing = parsePair(stored.signing);
  const serverId = deriveServerId(signing.publicKey);
  // The v1 persisted shape derives its id; accept an explicit id only if it agrees.
  if ('serverId' in stored && stored.serverId !== serverId) throw new Error('Mismatched server identity');
  const identity = { serverId, dh, signing };
  validateIdentity(identity);
  return identity;
}

export function signRelayChallenge(identity: ServerIdentity, nonce: Uint8Array): Uint8Array {
  validateIdentity(identity);
  requireLength(nonce, 32);
  return ed25519.sign(concatBytes(utf8(RELAY_REGISTER_CONTEXT), nonce), identity.signing.privateKey);
}

export function verifyRelayRegistration(input: { serverId: string; key: string; signature: string; nonce: Uint8Array }): boolean {
  try {
    if (typeof input.serverId !== 'string' || typeof input.key !== 'string' || typeof input.signature !== 'string') return false;
    const key = fromBase64Url(input.key);
    const signature = fromBase64Url(input.signature);
    requireLength(key, 32);
    requireLength(signature, 64);
    requireLength(input.nonce, 32);
    return deriveServerId(key) === input.serverId
      && ed25519.verify(signature, concatBytes(utf8(RELAY_REGISTER_CONTEXT), input.nonce), key, { zip215: false });
  } catch {
    return false;
  }
}
