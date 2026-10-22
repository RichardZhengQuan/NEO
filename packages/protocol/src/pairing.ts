/**
 * Pairing a phone with a NEO server.
 *
 * The computer shows a QR code holding a single-use pairing code (valid for
 * five minutes). The phone scans it and exchanges the code for its own device
 * token with `POST /api/pairing/claim`. The QR also says how to reach the
 * server: a direct http(s) address (a self-hosted server with a public URL)
 * and/or the end-to-end-encrypted tunnel (LAN addresses and a relay), pinned
 * to the server's public key.
 *
 *   v2  neo://pair?v=2&code=…[&server=https://…][&id=<serverId>&pk=<key>[&lan=host:port,…][&relay=wss://…]]
 *   v1  neo://pair?server=…&token=…  and  https://host/#/pair?token=…
 *       (a long-lived device token; still accepted, no longer generated for phones)
 */
import { z } from 'zod';
import type { Device } from './productivity.js';

/** How long a pairing code can be claimed. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** Unclaimed codes kept per server; creating another one drops the oldest. */
export const MAX_ACTIVE_PAIRING_CODES = 5;
/** At most this many LAN addresses go into a pairing link. */
export const MAX_PAIRING_LAN_ADDRESSES = 8;

export const DevicePlatformSchema = z.enum(['web', 'desktop', 'ios', 'android', 'cli', 'other']);

/** base64url, at least 128 bits. */
export const PairingCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
/** Lowercase hex, 128 bits (derived from the server's relay signing key). */
export const ServerIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
/** The server's static X25519 public key, base64url without padding (32 bytes). */
export const TunnelPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `POST /api/pairing` (owner only) response. */
export interface PairingSession {
  /** `pair_…`. Cancels the code (`DELETE /api/pairing/:id`) and matches the `device.paired` event. */
  id: string;
  /** Returned once, inside `pairingUrl`. The server keeps only its hash. */
  code: string;
  expiresAt: number;
  /** neo://pair?v=2&… — render it as a QR code. */
  pairingUrl: string;
}

/** `POST /api/pairing/claim` (public, rate-limited). */
export const ClaimPairingRequestSchema = z.object({
  code: PairingCodeSchema,
  deviceName: z.string().trim().min(1).max(100),
  platform: DevicePlatformSchema.default('other'),
});
export type ClaimPairingRequest = z.input<typeof ClaimPairingRequestSchema>;

export interface ClaimPairingResponse {
  device: Device;
  /** The device's own bearer token. Shown once. */
  token: string;
}

/** How a phone reaches the server through the encrypted tunnel. */
export interface TunnelRoute {
  serverId: string;
  /** Pinned: the tunnel handshake fails unless the server holds the matching private key. */
  publicKey: string;
  /** `host:port` addresses on the server's local network, tried first. */
  lan: string[];
  /** ws(s):// relay used when the LAN addresses are unreachable. */
  relay: string | null;
}

export type PairingLink =
  | { version: 1; serverUrl: string; token: string }
  | { version: 2; code: string; serverUrl: string | null; tunnel: TunnelRoute | null };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** `192.168.1.20:7778`, `[fe80::1]:7778`, `mac.local:7778`. */
export function isLanAddress(value: string): boolean {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(value);
  if (!match) return false;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return false;
  const host = match[1]!;
  if (host.startsWith('[')) {
    try {
      const parsed = new URL(`http://${host}/`).hostname;
      // Accept any valid IPv6 regardless of canonical spelling difference.
      return parsed.startsWith('[') && parsed.endsWith(']');
    } catch {
      return false;
    }
  }
  // A purely-numeric dotted string (e.g. 256.256.256.256) is only valid if it
  // also passes the IPV4 byte-range check. HOSTNAME allows such strings because
  // [A-Za-z0-9] is a superset of the IPv4 alphabet, so guard the HOSTNAME path.
  return IPV4.test(host) || (HOSTNAME.test(host) && !/^[\d.]+$/.test(host));
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function relayUrl(value: string | null): string | null {
  if (!value || value.length > 500) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'wss:' && url.protocol !== 'ws:') || url.username || url.password || url.search || url.hash) return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Build a v2 pairing link. Throws if a field is malformed. */
export function buildPairingLink(input: { code: string; serverUrl?: string | null; tunnel?: TunnelRoute | null }): string {
  const q = new URLSearchParams({ v: '2', code: PairingCodeSchema.parse(input.code) });
  if (input.serverUrl) {
    const server = httpUrl(input.serverUrl);
    if (!server) throw new Error('Invalid server URL for a pairing link');
    q.set('server', server);
  }
  const tunnel = input.tunnel;
  if (tunnel) {
    q.set('id', ServerIdSchema.parse(tunnel.serverId));
    q.set('pk', TunnelPublicKeySchema.parse(tunnel.publicKey));
    const lan = tunnel.lan.filter(isLanAddress).slice(0, MAX_PAIRING_LAN_ADDRESSES);
    if (lan.length) q.set('lan', lan.join(','));
    if (tunnel.relay) {
      const relay = relayUrl(tunnel.relay);
      if (!relay) throw new Error('Invalid relay URL for a pairing link');
      q.set('relay', relay);
    }
  }
  return `neo://pair?${q.toString()}`;
}

function parseV2(q: URLSearchParams, origin: string | null): PairingLink | null {
  const code = PairingCodeSchema.safeParse(q.get('code'));
  if (!code.success) return null;
  const rawServer = q.get('server') ?? origin;
  const serverUrl = httpUrl(rawServer);
  if (rawServer && !serverUrl) return null;
  let tunnel: TunnelRoute | null = null;
  const id = q.get('id');
  const pk = q.get('pk');
  if (id || pk) {
    if (!ServerIdSchema.safeParse(id).success || !TunnelPublicKeySchema.safeParse(pk).success) return null;
    const lan = (q.get('lan') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (lan.length > MAX_PAIRING_LAN_ADDRESSES || !lan.every(isLanAddress)) return null;
    const rawRelay = q.get('relay');
    const relay = relayUrl(rawRelay);
    if (rawRelay && !relay) return null;
    if (!lan.length && !relay) return null;
    tunnel = { serverId: id!, publicKey: pk!, lan, relay };
  }
  // A code is useless without a way to reach the server.
  if (!serverUrl && !tunnel) return null;
  return { version: 2, code: code.data, serverUrl, tunnel };
}

/**
 * Parse any pairing link: v2 (`neo://pair?v=2&code=…`, or the same query in an
 * http(s) `#/pair?…` hash) and v1 (`neo://pair?server=…&token=…`,
 * `https://host/#/pair?token=…`). Returns null for anything malformed.
 */
export function parsePairingLink(input: string): PairingLink | null {
  try {
    const url = new URL(input.trim());
    let q: URLSearchParams;
    let origin: string | null = null;
    if (url.protocol === 'neo:') {
      if (url.hostname !== 'pair' && !url.pathname.replace(/^\/+/, '').startsWith('pair')) return null;
      q = url.searchParams;
    } else if (url.protocol === 'https:' || url.protocol === 'http:') {
      const hash = url.hash.replace(/^#\/?/, '');
      q = hash.startsWith('pair?') ? new URLSearchParams(hash.slice(5)) : url.searchParams;
      origin = url.origin;
    } else {
      return null;
    }
    const version = q.get('v');
    if (version === '2') return parseV2(q, origin);
    if (version !== null) return null;
    const token = q.get('token');
    if (!token) return null;
    const serverUrl = httpUrl(q.get('server') ?? origin);
    return serverUrl ? { version: 1, serverUrl, token } : null;
  } catch {
    return null;
  }
}

/** A v1 link carrying a long-lived device token (`neo pair`, `neo serve`). */
export function buildPairingUrl(serverUrl: string, token: string): string {
  return `neo://pair?server=${encodeURIComponent(serverUrl)}&token=${encodeURIComponent(token)}`;
}

/** v1 links only: neo://pair?server=…&token=… and https://host/#/pair?token=… */
export function parsePairingUrl(input: string): { serverUrl: string; token: string } | null {
  const link = parsePairingLink(input);
  return link?.version === 1 ? { serverUrl: link.serverUrl, token: link.token } : null;
}
