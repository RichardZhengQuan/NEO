import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

describe('icon artefacts', () => {
  it('has a valid ICNS header and declared file length', () => {
    const icon = readFileSync(path.resolve(fileURLToPath(import.meta.url), '../../build/icon.icns'));
    expect(icon.subarray(0, 4)).toEqual(Buffer.from([0x69, 0x63, 0x6e, 0x73]));
    expect(icon.readUInt32BE(4)).toBe(icon.length);
  });

  it('has the Windows ICO signature', () => {
    const icon = readFileSync(path.resolve(fileURLToPath(import.meta.url), '../../build/icon.ico'));
    expect(icon.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
  });

  it('has the Linux PNG signature', () => {
    const icon = readFileSync(path.resolve(fileURLToPath(import.meta.url), '../../build/icons/256x256.png'));
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
