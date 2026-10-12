const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const first = bytes[i]!;
    const second = bytes[i + 1];
    const third = bytes[i + 2];
    result += BASE64URL[first >>> 2]!;
    result += BASE64URL[((first & 3) << 4) | ((second ?? 0) >>> 4)]!;
    if (second !== undefined) result += BASE64URL[((second & 15) << 2) | ((third ?? 0) >>> 6)]!;
    if (third !== undefined) result += BASE64URL[third & 63]!;
  }
  return result;
}

/** Reject noncanonical encodings so keys have one unambiguous persisted form. */
export function fromBase64Url(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('Invalid base64url');
  }
  const result = new Uint8Array(Math.floor(text.length * 6 / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of text) {
    accumulator = (accumulator << 6) | BASE64URL.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result[offset++] = (accumulator >>> bits) & 255;
    }
  }
  if (bits && (accumulator & ((1 << bits) - 1))) throw new Error('Invalid base64url');
  return result;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length % 2 || !/^[0-9a-f]*$/i.test(text)) throw new Error('Invalid hex');
  const result = new Uint8Array(text.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return result;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
