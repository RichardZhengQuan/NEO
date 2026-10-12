import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NOISE_MAX_MESSAGE, TUNNEL_NOISE_PROTOCOL, TUNNEL_PROLOGUE_PREFIX } from '@neo/protocol';
import { concatBytes, equalBytes, utf8 } from './bytes.js';

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export class NoiseError extends Error {
  constructor(message = 'Noise operation failed', options?: ErrorOptions) {
    super(message, options);
    this.name = 'NoiseError';
  }
}

function noiseError(error: unknown): NoiseError {
  return error instanceof NoiseError ? error : new NoiseError('Noise operation failed', { cause: error });
}

function keyBytes(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new NoiseError('Noise keys must be 32 bytes');
  return key.slice();
}

function keyPairBytes(key: KeyPair): KeyPair {
  return { privateKey: keyBytes(key.privateKey), publicKey: keyBytes(key.publicKey) };
}

function checkKeyPair(key: KeyPair): KeyPair {
  if (!equalBytes(publicKeyFromPrivate(key.privateKey), key.publicKey)) throw new NoiseError('Mismatched Noise keypair');
  return key;
}

function copyKeyPair(key: KeyPair): KeyPair {
  return checkKeyPair(keyPairBytes(key));
}

/**
 * Servers build a responder per session from one long-lived static pair, so its curve check runs once per
 * pair object rather than per session. A digest of the checked bytes catches later in-place changes
 * without keeping another copy of the private key.
 */
const checkedStaticKeys = new WeakMap<KeyPair, Uint8Array>();

function copyStaticKeyPair(key: KeyPair): KeyPair {
  const copy = keyPairBytes(key);
  const digest = sha256(concatBytes(copy.privateKey, copy.publicKey));
  const checked = checkedStaticKeys.get(key);
  if (!checked || !equalBytes(checked, digest)) {
    checkKeyPair(copy);
    checkedStaticKeys.set(key, digest);
  }
  return copy;
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  try {
    return x25519.getPublicKey(keyBytes(privateKey));
  } catch (error) {
    throw noiseError(error);
  }
}

const EMPTY = new Uint8Array();
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

function checkMessage(message: Uint8Array, minimum = 0): void {
  if (!(message instanceof Uint8Array) || message.length < minimum || message.length > NOISE_MAX_MESSAGE) {
    throw new NoiseError('Invalid Noise message length');
  }
}

class CipherState {
  private key: Uint8Array | null = null;
  private nonce = 0;

  initializeKey(key: Uint8Array): void {
    this.key = key.slice();
    this.nonce = 0;
  }

  private nextNonce(): Uint8Array {
    if (this.nonce >= MAX_NONCE) throw new NoiseError('Noise nonce exhausted');
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setBigUint64(4, BigInt(this.nonce), true);
    return bytes;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext.slice();
    const ciphertext = chacha20poly1305(this.key, this.nextNonce(), ad).encrypt(plaintext);
    this.nonce++;
    return ciphertext;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext.slice();
    const plaintext = chacha20poly1305(this.key, this.nextNonce(), ad).decrypt(ciphertext);
    this.nonce++;
    return plaintext;
  }
}

/** Noise section 4.3 uses HMAC directly, including the one-byte output counters. */
function hkdf(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temporaryKey = hmac(sha256, chainingKey, input);
  const first = hmac(sha256, temporaryKey, new Uint8Array([1]));
  const second = hmac(sha256, temporaryKey, concatBytes(first, new Uint8Array([2])));
  temporaryKey.fill(0);
  return [first, second];
}

class SymmetricState {
  hash: Uint8Array;
  private chainingKey: Uint8Array;
  private readonly cipher = new CipherState();

  constructor(prologue: Uint8Array, responderStatic: Uint8Array) {
    const name = utf8(TUNNEL_NOISE_PROTOCOL);
    this.hash = name.length <= 32 ? concatBytes(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.chainingKey = this.hash.slice();
    this.mixHash(prologue);
    this.mixHash(responderStatic);
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(concatBytes(this.hash, data));
  }

  mixKey(input: Uint8Array): void {
    const [chainingKey, key] = hkdf(this.chainingKey, input);
    this.chainingKey.fill(0);
    this.chainingKey = chainingKey;
    this.cipher.initializeKey(key);
    key.fill(0);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(initiator: boolean): NoiseTransport {
    const [first, second] = hkdf(this.chainingKey, EMPTY);
    const sending = new CipherState();
    const receiving = new CipherState();
    sending.initializeKey(initiator ? first : second);
    receiving.initializeKey(initiator ? second : first);
    first.fill(0);
    second.fill(0);
    this.chainingKey.fill(0);
    return new Transport(sending, receiving, this.hash);
  }
}

export interface NoiseTransport {
  encrypt(plaintext: Uint8Array): Uint8Array;
  /** An authentication failure permanently kills both directions of the session. */
  decrypt(message: Uint8Array): Uint8Array;
  readonly handshakeHash: Uint8Array;
}

class Transport implements NoiseTransport {
  private dead = false;
  private readonly hash: Uint8Array;

  constructor(private readonly sending: CipherState, private readonly receiving: CipherState, hash: Uint8Array) {
    this.hash = hash.slice();
  }

  get handshakeHash(): Uint8Array {
    return this.hash.slice();
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    try {
      if (this.dead) throw new NoiseError('Noise session is dead');
      checkMessage(plaintext);
      if (plaintext.length > NOISE_MAX_MESSAGE - 16) throw new NoiseError('Invalid Noise message length');
      return this.sending.encryptWithAd(EMPTY, plaintext);
    } catch (error) {
      this.dead = true;
      throw noiseError(error);
    }
  }

  decrypt(message: Uint8Array): Uint8Array {
    try {
      if (this.dead) throw new NoiseError('Noise session is dead');
      checkMessage(message, 16);
      return this.receiving.decryptWithAd(EMPTY, message);
    } catch (error) {
      this.dead = true;
      throw noiseError(error);
    }
  }
}

export class NkInitiator {
  private state: 'write' | 'read' | 'done' | 'failed' = 'write';
  private readonly remoteStatic: Uint8Array;
  private readonly ephemeral: KeyPair;
  private readonly symmetric: SymmetricState;

  constructor(options: { remoteStaticKey: Uint8Array; prologue: Uint8Array; ephemeral?: KeyPair }) {
    try {
      this.remoteStatic = keyBytes(options.remoteStaticKey);
      this.ephemeral = options.ephemeral ? copyKeyPair(options.ephemeral) : generateKeyPair();
      this.symmetric = new SymmetricState(options.prologue, this.remoteStatic);
    } catch (error) {
      throw noiseError(error);
    }
  }

  writeMessage1(payload: Uint8Array = EMPTY): Uint8Array {
    try {
      if (this.state !== 'write') throw new NoiseError('Unexpected Noise handshake operation');
      this.state = 'failed';
      checkMessage(payload);
      if (payload.length > NOISE_MAX_MESSAGE - 48) throw new NoiseError('Invalid Noise message length');
      this.symmetric.mixHash(this.ephemeral.publicKey);
      this.symmetric.mixKey(x25519.getSharedSecret(this.ephemeral.privateKey, this.remoteStatic));
      const message = concatBytes(this.ephemeral.publicKey, this.symmetric.encryptAndHash(payload));
      this.state = 'read';
      return message;
    } catch (error) {
      this.state = 'failed';
      throw noiseError(error);
    }
  }

  readMessage2(message: Uint8Array): { payload: Uint8Array; transport: NoiseTransport } {
    try {
      if (this.state !== 'read') throw new NoiseError('Unexpected Noise handshake operation');
      this.state = 'failed';
      checkMessage(message, 48);
      const remoteEphemeral = message.subarray(0, 32);
      this.symmetric.mixHash(remoteEphemeral);
      this.symmetric.mixKey(x25519.getSharedSecret(this.ephemeral.privateKey, remoteEphemeral));
      const payload = this.symmetric.decryptAndHash(message.subarray(32));
      const transport = this.symmetric.split(true);
      this.state = 'done';
      return { payload, transport };
    } catch (error) {
      this.state = 'failed';
      throw noiseError(error);
    }
  }
}

/**
 * Construction does no curve work once the static pair has been checked: a session whose peer never sends
 * message 1 (a relay Open or LAN connection left idle until the handshake timeout) costs only hashing.
 */
export class NkResponder {
  private state: 'read' | 'write' | 'done' | 'failed' = 'read';
  private readonly staticKey: KeyPair;
  /** An injected ephemeral is checked, and a missing one generated, only by writeMessage2. */
  private readonly ephemeral: KeyPair | null;
  private readonly symmetric: SymmetricState;
  private remoteEphemeral: Uint8Array | null = null;

  constructor(options: { staticKey: KeyPair; prologue: Uint8Array; ephemeral?: KeyPair }) {
    try {
      this.staticKey = copyStaticKeyPair(options.staticKey);
      this.ephemeral = options.ephemeral ? keyPairBytes(options.ephemeral) : null;
      this.symmetric = new SymmetricState(options.prologue, this.staticKey.publicKey);
    } catch (error) {
      throw noiseError(error);
    }
  }

  readMessage1(message: Uint8Array): Uint8Array {
    try {
      if (this.state !== 'read') throw new NoiseError('Unexpected Noise handshake operation');
      this.state = 'failed';
      checkMessage(message, 48);
      this.remoteEphemeral = message.slice(0, 32);
      this.symmetric.mixHash(this.remoteEphemeral);
      this.symmetric.mixKey(x25519.getSharedSecret(this.staticKey.privateKey, this.remoteEphemeral));
      const payload = this.symmetric.decryptAndHash(message.subarray(32));
      this.state = 'write';
      return payload;
    } catch (error) {
      this.state = 'failed';
      throw noiseError(error);
    }
  }

  writeMessage2(payload: Uint8Array = EMPTY): { message: Uint8Array; transport: NoiseTransport } {
    try {
      if (this.state !== 'write' || !this.remoteEphemeral) throw new NoiseError('Unexpected Noise handshake operation');
      this.state = 'failed';
      checkMessage(payload);
      if (payload.length > NOISE_MAX_MESSAGE - 48) throw new NoiseError('Invalid Noise message length');
      const ephemeral = this.ephemeral ? checkKeyPair(this.ephemeral) : generateKeyPair();
      this.symmetric.mixHash(ephemeral.publicKey);
      this.symmetric.mixKey(x25519.getSharedSecret(ephemeral.privateKey, this.remoteEphemeral));
      const message = concatBytes(ephemeral.publicKey, this.symmetric.encryptAndHash(payload));
      const transport = this.symmetric.split(false);
      this.state = 'done';
      return { message, transport };
    } catch (error) {
      this.state = 'failed';
      throw noiseError(error);
    }
  }
}

export function tunnelPrologue(serverId: string): Uint8Array {
  return utf8(TUNNEL_PROLOGUE_PREFIX + serverId);
}
