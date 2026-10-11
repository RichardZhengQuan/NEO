import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { MAX_PAIRING_LAN_ADDRESSES, NeoConfigSchema } from '@neo/protocol';
import { lanAddresses } from './addresses.js';

function address(ip: string, internal = false, family = 'IPv4'): NetworkInterfaceInfo {
  return { address: ip, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null } as NetworkInterfaceInfo;
}

describe('LAN addresses', () => {
  it('prefers explicit addresses, deduplicates and caps their count', () => {
    const advertise = ['neo.local:7778', 'neo.local:7778', ...Array.from({ length: 12 }, (_, index) => `192.168.1.${index + 1}:7778`)];
    const config = NeoConfigSchema.parse({ tunnel: { advertise } });
    expect(lanAddresses(9000, config, { networkInterfaces: () => { throw new Error('Must not enumerate'); } })).toEqual([...new Set(advertise)].slice(0, MAX_PAIRING_LAN_ADDRESSES));
  });

  it('omits loopback, IPv6, link-local and virtual interfaces while adding a local hostname', () => {
    const interfaces = {
      lo0: [address('127.0.0.1', true)],
      en0: [address('192.168.1.20'), address('169.254.1.2'), address('fe80::1', false, 'IPv6')],
      en1: [address('192.168.1.20'), address('10.0.0.2')],
      docker0: [address('172.17.0.1')], 'br-test': [address('172.18.0.1')],
      veth123: [address('172.19.0.1')], vboxnet0: [address('172.20.0.1')],
      vmnet1: [address('172.21.0.1')], utun0: [address('10.1.0.1')], bridge0: [address('172.22.0.1')],
    };
    expect(lanAddresses(7778, NeoConfigSchema.parse({}), { networkInterfaces: () => interfaces, hostname: () => 'computer.local' })).toEqual(['192.168.1.20:7778', '10.0.0.2:7778', 'computer.local:7778']);
  });

  it('never advertises an ordinary hostname and limits detected addresses', () => {
    const interfaces = { en0: Array.from({ length: 12 }, (_, index) => address(`10.0.0.${index + 1}`)) };
    expect(lanAddresses(1234, NeoConfigSchema.parse({}), { networkInterfaces: () => interfaces, hostname: () => 'computer' })).toHaveLength(MAX_PAIRING_LAN_ADDRESSES);
    expect(lanAddresses(1234, NeoConfigSchema.parse({}), { networkInterfaces: () => ({}), hostname: () => 'computer' })).toEqual([]);
  });
});
