import { describe, expect, it } from 'vitest';
import { buildPairingLink, isLanAddress } from './pairing.js';

describe('isLanAddress', () => {
  it.each([
    '[fd12:3456:0:0:0:0:0:1]:7778',
    '[2001:0db8::1]:7778',
    '[FD12:3456:0000:0000:0000:0000:0000:0001]:7778',
    '[::ffff:192.168.1.20]:7778',
  ])('accepts non-canonical IPv6 address %s', (address) => {
    expect(isLanAddress(address)).toBe(true);
  });

  it.each([
    '[fd12:3456::1]:7778',
    '[2001:db8::1]:7778',
    '[FD12:3456::1]:7778',
    '[::1]:1',
    '[::1]:65535',
  ])('still accepts valid IPv6 address %s', (address) => {
    expect(isLanAddress(address)).toBe(true);
  });

  it.each([
    '[not-ipv6]:7778',
    '[fd12:::1]:7778',
    '[12345::1]:7778',
    '[1:2:3:4:5:6:7:8:9]:7778',
    '[192.168.1.20]:7778',
    '[fd12::1]:0',
    '[fd12::1]:65536',
    '[fd12::1]:100000',
    '[fd12::1]',
    'fd12::1:7778',
    'http://[fd12::1]:7778',
    '[fd12::1]:7778/path',
    '[fe80::1%eth0]:7778',
    '',
  ])('still rejects invalid LAN address %s', (address) => {
    expect(isLanAddress(address)).toBe(false);
  });
});

describe('buildPairingLink', () => {
  it('preserves a non-canonical IPv6 LAN route in the pairing link', () => {
    const link = buildPairingLink({
      code: 'c'.repeat(32),
      tunnel: {
        serverId: 'a'.repeat(32),
        publicKey: 'b'.repeat(43),
        lan: ['[fd12:3456:0:0:0:0:0:1]:7778'],
        relay: null,
      },
    });
    expect(new URL(link).searchParams.get('lan')).toBe('[fd12:3456:0:0:0:0:0:1]:7778');
  });
});
