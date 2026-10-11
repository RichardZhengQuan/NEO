import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, equalBytes, fromBase64Url, fromUtf8, hexToBytes, toBase64Url, utf8 } from './bytes.js';

describe('byte helpers', () => {
  it('round trips every byte through canonical base64url and hex', () => {
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    for (let length = 0; length <= bytes.length; length++) {
      const part = bytes.slice(0, length);
      expect(fromBase64Url(toBase64Url(part))).toEqual(part);
      expect(hexToBytes(bytesToHex(part))).toEqual(part);
    }
    expect(toBase64Url(new Uint8Array([255, 255, 255]))).toBe('____');
    expect(hexToBytes('aAFF00')).toEqual(new Uint8Array([170, 255, 0]));
  });

  it('rejects malformed and noncanonical encodings', () => {
    for (const value of ['a', 'a=', 'a+', 'a/', ' aA', 'aA\n', 'AB', 'AAB', '%%%%']) {
      expect(() => fromBase64Url(value)).toThrow();
    }
    for (const value of ['a', '0g', '00 ', '-1']) expect(() => hexToBytes(value)).toThrow();
  });

  it('concatenates without sharing storage and compares bytes', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    const joined = concatBytes(a, b, new Uint8Array());
    a[0] = 9;
    expect(joined).toEqual(new Uint8Array([1, 2, 3]));
    expect(equalBytes(joined, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(equalBytes(joined, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(equalBytes(joined, new Uint8Array([1, 2]))).toBe(false);
    expect(equalBytes(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  it('encodes Unicode and rejects invalid UTF-8', () => {
    expect(fromUtf8(utf8('NEO 你好 🌏'))).toBe('NEO 你好 🌏');
    expect(() => fromUtf8(new Uint8Array([255]))).toThrow();
  });
});
