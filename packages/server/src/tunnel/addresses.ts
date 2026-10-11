import * as os from 'node:os';
import { isLanAddress, MAX_PAIRING_LAN_ADDRESSES } from '@neo/protocol';
import type { NeoConfig } from '@neo/protocol';

/** Prefer explicit addresses; omit loopback, link-local and virtual interfaces. */
export function lanAddresses(port: number, config: Pick<NeoConfig, 'tunnel'>, options: {
  networkInterfaces?: typeof os.networkInterfaces;
  hostname?: typeof os.hostname;
} = {}): string[] {
  if (config.tunnel.advertise.length) return [...new Set(config.tunnel.advertise)].slice(0, MAX_PAIRING_LAN_ADDRESSES);
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries((options.networkInterfaces ?? os.networkInterfaces)())) {
    if (/^(docker|br-|veth|vboxnet|vmnet|utun|bridge)/i.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || entry.address.startsWith('169.254.')) continue;
      const address = `${entry.address}:${port}`;
      if (isLanAddress(address)) addresses.push(address);
    }
  }
  const hostname = (options.hostname ?? os.hostname)();
  if (hostname.toLowerCase().endsWith('.local') && isLanAddress(`${hostname}:${port}`)) addresses.push(`${hostname}:${port}`);
  return [...new Set(addresses)].slice(0, MAX_PAIRING_LAN_ADDRESSES);
}
