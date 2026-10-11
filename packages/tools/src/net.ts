/**
 * Outbound HTTP for web_fetch with an SSRF guard.
 *
 * Address policy: loopback, private (RFC 1918, ULA), link-local (incl. cloud
 * metadata at 169.254.169.254 / fd00:ec2::254), CGNAT (incl. 100.100.100.200),
 * unspecified, multicast, broadcast and other reserved/documentation ranges
 * are refused, including IPv4 embedded in IPv6 (mapped, compatible, NAT64,
 * 6to4). 198.18.0.0/15 (benchmarking) is deliberately allowed: "fake-IP"
 * proxies (Clash, V2Box…) answer every DNS query from that range, and blocking
 * it would make web_fetch unusable on such machines.
 *
 * DNS rebinding: the hostname is resolved once per hop, every answer is
 * checked, and the default transport (node:http/https) connects through a
 * `lookup` hook that only returns those vetted addresses. There is no second
 * resolution between check and connect. TLS still verifies the certificate for
 * the hostname (SNI and Host stay the hostname). An injected `fetch` (tests,
 * custom deployments) can't be pinned; it gets the same checks per hop but
 * resolves names itself.
 */
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import zlib from 'node:zlib';
import { NeoError } from '@neo/protocol';

/** Resolve a hostname to IP address strings. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/** The system resolver (getaddrinfo, so /etc/hosts is honored, like the connection itself). */
export const systemResolver: DnsResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

// ───────────────────────────── address classification ─────────────────────────────

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network" / unspecified (0.0.0.0 reaches localhost)
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (also Alibaba Cloud metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];
const BLOCKED_V4_RANGES = BLOCKED_V4.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = Math.floor(ipv4ToInt(base) / size) * size;
  return [start, start + size - 1] as const;
});

function isBlockedV4(n: number): boolean {
  return BLOCKED_V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/** Expand a valid IPv6 literal into its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] {
  let s = ip.toLowerCase();
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.', lastColon)) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : new Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...zeros, ...t].map((g) => parseInt(g, 16));
}

function isBlockedV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = g6 * 65536 + g7;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0) return true; // ::, ::1 and deprecated IPv4-compatible ::a.b.c.d
  if (zeroPrefix && g5 === 0xffff) return isBlockedV4(embedded); // IPv4-mapped ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return isBlockedV4(embedded); // IPv4-translated
  if (g0 === 0x64 && g1 === 0xff9b) return g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0 || isBlockedV4(embedded); // NAT64
  if (g0 === 0x2002) return isBlockedV4(g1 * 65536 + g2); // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo, documentation
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for addresses web_fetch must not reach (anything that isn't a valid, public IP). */
export function isBlockedAddress(address: string): boolean {
  let ip = address.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const version = isIP(ip);
  if (version === 4) return isBlockedV4(ipv4ToInt(ip));
  if (version === 6) return isBlockedV6(ipv6Groups(ip));
  return true;
}

// ───────────────────────────── URL vetting ─────────────────────────────

export interface GuardOptions {
  resolver: DnsResolver;
  /** Skip the address checks (local mode). Scheme and credential checks still apply. */
  allowPrivateNetwork: boolean;
  isBlockedAddress: (ip: string) => boolean;
}

export interface VettedUrl {
  url: URL;
  /** Addresses the connection may use; empty when private networks are allowed (normal resolution). */
  addresses: string[];
}

/** Validate a URL for fetching and resolve its host; throws NeoError with a readable reason. */
export async function vetUrl(input: string | URL, opts: GuardOptions): Promise<VettedUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new NeoError('bad_request', `Invalid URL: ${String(input).slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NeoError('bad_request', `Only http:// and https:// URLs can be fetched (got ${url.protocol}).`);
  }
  if (url.username || url.password) throw new NeoError('bad_request', 'URLs with embedded credentials are not allowed.');
  if (opts.allowPrivateNetwork) return { url, addresses: [] };

  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '').toLowerCase();
  const refuse = (detail: string) =>
    new NeoError('forbidden', `Fetching ${url.host} is not allowed: ${detail}. Only public internet addresses can be fetched.`);

  if (isIP(host)) {
    if (opts.isBlockedAddress(host)) throw refuse('it is a private or reserved address');
    return { url, addresses: [host] };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) throw refuse('it is a local name');

  let addresses: string[];
  try {
    addresses = await opts.resolver(host);
  } catch (err) {
    throw new NeoError('bad_request', `Could not resolve ${host} (${(err as { code?: string }).code ?? (err as Error).message}).`);
  }
  if (!addresses.length) throw new NeoError('bad_request', `Could not resolve ${host}.`);
  const blocked = addresses.find((a) => opts.isBlockedAddress(a));
  if (blocked) throw refuse(`it resolves to a private or reserved address (${blocked})`);
  return { url, addresses };
}

// ───────────────────────────── transports ─────────────────────────────

export interface HopResponse {
  status: number;
  header(name: string): string | null;
  body: AsyncIterable<Uint8Array> | null;
  /** Stop downloading and release the connection. */
  close(): void;
}

export type Transport = (target: VettedUrl, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<HopResponse>;

/** Reject when `signal` aborts (for awaits that don't take a signal themselves). */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** A transport over an injected fetch: manual redirects, no address pinning. */
export function fetchTransport(fetchFn: typeof fetch): Transport {
  return async ({ url }, { signal, headers }) => {
    const res = await abortable(fetchFn(url.href, { method: 'GET', redirect: 'manual', signal, headers }), signal);
    const stream = res.body;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const close = () => {
      if (reader) reader.cancel().catch(() => {});
      else stream?.cancel().catch(() => {});
    };
    async function* chunks(): AsyncGenerator<Uint8Array> {
      if (!stream) return;
      reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await abortable(reader.read(), signal);
          if (done) return;
          if (value) yield value;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    return { status: res.status, header: (n) => res.headers.get(n), body: stream ? chunks() : null, close };
  };
}

/** `lookup` hook that only ever answers with the vetted addresses. */
function pinnedLookup(addresses: string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((hostname: string, options: { family?: number | string; all?: boolean } | number, callback: (...args: unknown[]) => void) => {
    const opts = typeof options === 'object' && options !== null ? options : {};
    const wanted = typeof options === 'number' ? options : opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : opts.family;
    const list = wanted === 4 || wanted === 6 ? entries.filter((e) => e.family === wanted) : entries;
    if (!list.length) {
      callback(Object.assign(new Error(`No vetted IPv${String(wanted)} address for ${hostname}`), { code: 'ENOTFOUND' }));
      return;
    }
    if (opts.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  }) as unknown as LookupFunction;
}

/** The default transport: node:http(s) connected to the vetted addresses only. */
export const nodeTransport: Transport = ({ url, addresses }, { signal, headers }) =>
  new Promise<HopResponse>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' },
        signal,
        agent: false,
        ...(addresses.length ? { lookup: pinnedLookup(addresses) } : {}),
      },
      (res) => {
        const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
        const decoder =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? zlib.createGunzip()
            : encoding === 'deflate'
              ? zlib.createInflate()
              : encoding === 'br'
                ? zlib.createBrotliDecompress()
                : null;
        const body: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
        resolve({
          status: res.statusCode ?? 0,
          header: (name) => {
            const v = res.headers[name.toLowerCase()];
            return Array.isArray(v) ? v.join(', ') : (v ?? null);
          },
          body: body as AsyncIterable<Uint8Array>,
          close: () => {
            body.destroy();
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

// ───────────────────────────── guarded fetch ─────────────────────────────

export interface GuardedFetchOptions extends GuardOptions {
  transport: Transport;
  maxRedirects: number;
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** GET `url`, following up to `maxRedirects` redirects manually and vetting every hop. */
export async function guardedFetch(url: string, opts: GuardedFetchOptions): Promise<{ url: URL; response: HopResponse }> {
  let current: string | URL = url;
  for (let hop = 0; ; hop++) {
    const target = await vetUrl(current, opts);
    const response = await opts.transport(target, { signal: opts.signal, headers: opts.headers });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.header('location');
      response.close();
      if (!location) throw new NeoError('tool_error', `HTTP ${response.status} redirect without a Location header.`);
      if (hop >= opts.maxRedirects) throw new NeoError('tool_error', `Too many redirects (more than ${opts.maxRedirects}).`);
      current = new URL(location, target.url);
      continue;
    }
    return { url: target.url, response };
  }
}

/** Read at most `maxBytes` from `body`, stopping (and cancelling) the download at the cap. */
export async function readCapped(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  if (body) {
    for await (const chunk of body) {
      const room = maxBytes - total;
      if (chunk.byteLength >= room) {
        chunks.push(chunk.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}
