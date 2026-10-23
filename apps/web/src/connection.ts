/**
 * Connection bootstrap: find the NEO server and a token.
 *
 * Order:
 *  1. Desktop app — `window.neoDesktop.getConfig()` (the embedded server).
 *  2. A pairing hash `#/pair?token=…` (v1) or `#/pair?v=2&code=…` —
 *     verified or claimed, saved, and removed from the address bar.
 *  3. A launch pairing link (mobile deep link), consumed once across reloads.
 *  4. Saved credentials (localStorage). 401 → Connect screen with the URL kept;
 *     unreachable → an "offline" screen that keeps them and retries.
 *  5. Same-origin `/api/health` — the app is served by a NEO server, so the
 *     Connect screen only needs the token.
 *  6. Otherwise the Connect screen.
 *
 * Everything external is injected so the order is unit-tested.
 */
import { MAX_PAIRING_LAN_ADDRESSES, ServerIdSchema, TunnelPublicKeySchema, isLanAddress, isLocalUrl, parsePairingLink, parsePairingUrl, type Device, type HealthResponse, type PairingLink, type TunnelRoute } from '@neo/protocol';
import { NeoClient, type NeoClientOptions } from '@neo/client';
import { createTunnelTransport, tunnelBaseUrl, type TunnelTransport } from '@neo/tunnel';
import { STORAGE_KEYS, readJson, writeJson } from './lib/storage.js';
import { httpStatus, isNetworkError } from './lib/errors.js';
import { parseRoute } from './router.js';
import { getPlatform } from './platform/index.js';

export type ConnectionSource = 'desktop' | 'pair' | 'saved' | 'manual';

export interface Credentials {
  serverUrl: string;
  token: string;
  tunnel?: TunnelRoute | null;
}

export type VerifyResult = 'ok' | 'unauthorized' | 'unreachable';

export type ClaimResult =
  | { kind: 'ok'; token: string }
  | { kind: 'invalid' }
  | { kind: 'rate-limited' }
  | { kind: 'unreachable' };

export type BootstrapResult =
  | ({ kind: 'ready'; source: ConnectionSource } & Credentials)
  | ({ kind: 'offline'; source: ConnectionSource } & Credentials)
  | { kind: 'connect'; reason: 'none' | 'unauthorized' | 'pair-failed' | 'same-origin'; serverUrl?: string; token?: string; tunnel?: TunnelRoute | null };

export interface DesktopConfigSource {
  getConfig(): Promise<{ serverUrl: string; token: string }>;
}

export interface BootstrapDeps {
  desktop: DesktopConfigSource | null;
  /** window.location.hash */
  hash: string;
  /** window.location.origin ('null' / capacitor:// when not served over http) */
  origin: string;
  load(): Credentials | null;
  save(credentials: Credentials): void;
  /** Forget the token but keep the server URL. */
  forgetToken(): void;
  verify(serverUrl: string, token: string, tunnel?: TunnelRoute | null): Promise<VerifyResult>;
  claim(serverUrl: string, code: string, tunnel?: TunnelRoute | null): Promise<ClaimResult>;
  launchLink(): Promise<string | null>;
  /** Share page-lifetime deduplication with pairing actions. */
  consumePairLink?(link: PairingLink): boolean;
  health(serverUrl: string): Promise<boolean>;
  /** Remove the pairing credentials from the address bar. */
  clearPairHash(): void;
}

/** "neo.example.com" → "https://neo.example.com"; strips trailing "/" and "/api". */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split('/')[0]!.split(':')[0]!;
    const local = isLocalUrl(`http://${host}`);
    s = `${local ? 'http' : 'https'}://${s}`;
  }
  try {
    const url = new URL(s);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

/** Parse what the user typed on the Connect screen: either a pairing link or URL + token. */
export function credentialsFromInput(input: { link?: string; serverUrl?: string; token?: string }): Credentials | null {
  if (input.link?.trim()) {
    const parsed = parsePairingUrl(input.link);
    if (!parsed) return null;
    const serverUrl = normalizeServerUrl(parsed.serverUrl);
    return serverUrl ? { serverUrl, token: parsed.token } : null;
  }
  const serverUrl = normalizeServerUrl(input.serverUrl ?? '');
  const token = input.token?.trim();
  return serverUrl && token ? { serverUrl, token } : null;
}

function httpOrigin(origin: string): string | null {
  return /^https?:\/\//i.test(origin) ? origin : null;
}

/** Public HTTPS first, then the pinned tunnel, then a plain HTTP server. */
export function pairingConnection(link: PairingLink): Omit<Credentials, 'token'> | null {
  const serverUrl = link.serverUrl ? normalizeServerUrl(link.serverUrl) : null;
  if (serverUrl?.startsWith('https://')) return { serverUrl };
  if (link.version === 2 && link.tunnel) return { serverUrl: tunnelBaseUrl(link.tunnel.serverId), tunnel: link.tunnel };
  return serverUrl ? { serverUrl } : null;
}

function validatedTunnel(value: unknown): TunnelRoute | null {
  if (!value || typeof value !== 'object') return null;
  const route = value as Partial<TunnelRoute>;
  if (!ServerIdSchema.safeParse(route.serverId).success || !TunnelPublicKeySchema.safeParse(route.publicKey).success ||
      !Array.isArray(route.lan) || route.lan.length > MAX_PAIRING_LAN_ADDRESSES ||
      !route.lan.every(address => typeof address === 'string' && isLanAddress(address))) return null;
  if (route.relay !== null) {
    if (typeof route.relay !== 'string' || !route.relay || route.relay.length > 500) return null;
    try {
      const url = new URL(route.relay);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || route.relay.includes('?') || route.relay.includes('#')) return null;
    } catch { return null; }
  }
  return { serverId: route.serverId!, publicKey: route.publicKey!, lan: [...route.lan], relay: route.relay! };
}

const tunnelTransports = new Map<string, { route: TunnelRoute; transport: TunnelTransport }>();

/** Every server client shares the same pinned transport, including a token-less claim. */
export function createServerClient(credentials: Credentials, options: Omit<NeoClientOptions, 'baseUrl' | 'token' | 'fetch' | 'WebSocket'> = {}): NeoClient {
  const tunnel = credentials.tunnel;
  if (!tunnel) return new NeoClient({ ...options, baseUrl: credentials.serverUrl, token: credentials.token });
  const key = `${tunnel.serverId}:${tunnel.publicKey}`;
  let cached = tunnelTransports.get(key);
  if (!cached) {
    const route = { ...tunnel, lan: [...tunnel.lan] };
    cached = { route, transport: createTunnelTransport({ route }) };
    tunnelTransports.set(key, cached);
  } else {
    cached.route.lan = [...tunnel.lan];
    cached.route.relay = tunnel.relay;
  }
  const { baseUrl, fetch, WebSocket } = cached.transport;
  return new NeoClient({ ...options, baseUrl, token: credentials.token, fetch, WebSocket });
}

/** Refresh addresses without ever accepting a new identity from the server. */
export async function refreshTunnelRoute(credentials: Credentials, client: NeoClient, active: () => boolean): Promise<Credentials> {
  const pinned = credentials.tunnel;
  if (!pinned) return credentials;
  try {
    const status = await client.phoneAccess.status();
    if (!active() || status.serverId !== pinned.serverId || status.publicKey !== pinned.publicKey) return credentials;
    // A relay that is only reconnecting is still the way home; a route with no way in at all is never saved.
    const route = validatedTunnel({ ...pinned, lan: status.lan.addresses, relay: status.relay.url });
    if (!route || (!route.lan.length && !route.relay)) return credentials;
    const next = { ...credentials, tunnel: route };
    const cached = tunnelTransports.get(`${pinned.serverId}:${pinned.publicKey}`);
    if (cached) { cached.route.lan = [...route.lan]; cached.route.relay = route.relay; }
    const saved = loadCredentials();
    if (saved?.serverUrl === credentials.serverUrl && saved.token === credentials.token &&
        saved.tunnel?.serverId === pinned.serverId && saved.tunnel.publicKey === pinned.publicKey) saveCredentials(next);
    return next;
  } catch { return credentials; }
}

const handledPairingLinks = new Set<string>();

/** Reserve a code/token synchronously before any request, including bootstrap. */
export function consumePairingLink(link: PairingLink): boolean {
  const key = link.version === 2 ? `code:${link.code}` : `token:${link.token}`;
  if (handledPairingLinks.has(key)) return false;
  handledPairingLinks.add(key);
  return true;
}

async function bootstrapPairLink(url: string, deps: BootstrapDeps, fallback?: { serverUrl?: string; token?: string }): Promise<BootstrapResult> {
  const link = parsePairingLink(url);
  if (!link) return { kind: 'connect', reason: 'pair-failed', ...fallback };
  const connection = pairingConnection(link);
  if (!connection || (deps.consumePairLink && !deps.consumePairLink(link))) {
    return { kind: 'connect', reason: 'pair-failed', ...connection };
  }
  const { serverUrl, tunnel } = connection;
  if (link.version === 1) {
    const result = await deps.verify(serverUrl, link.token);
    if (result === 'ok') {
      deps.save({ serverUrl, token: link.token });
      return { kind: 'ready', serverUrl, token: link.token, source: 'pair' };
    }
    return { kind: 'connect', reason: 'pair-failed', serverUrl, token: link.token };
  }
  const result = tunnel ? await deps.claim(serverUrl, link.code, tunnel) : await deps.claim(serverUrl, link.code);
  if (result.kind === 'ok') {
    const credentials = { ...connection, token: result.token };
    deps.save(credentials);
    return { kind: 'ready', ...credentials, source: 'pair' };
  }
  return { kind: 'connect', reason: 'pair-failed', serverUrl };
}

export async function bootstrapConnection(deps: BootstrapDeps): Promise<BootstrapResult> {
  // 1. Desktop app
  if (deps.desktop) {
    try {
      const cfg = await deps.desktop.getConfig();
      if (cfg.serverUrl && cfg.token) return { kind: 'ready', serverUrl: cfg.serverUrl.replace(/\/+$/, ''), token: cfg.token, source: 'desktop' };
    } catch {
      // Fall through: the desktop server may not be reachable; try the rest.
    }
  }

  // 2. Pairing hash
  const route = parseRoute(deps.hash);
  if (route.name === 'pair') {
    deps.clearPairHash();
    const origin = httpOrigin(deps.origin);
    const q = deps.hash.indexOf('?');
    const query = new URLSearchParams(q >= 0 ? deps.hash.slice(q + 1) : '');
    if (!query.has('server') && route.serverUrl) query.set('server', route.serverUrl);
    const url = origin ? `${origin}/#/pair?${query.toString()}` : `neo://pair?${query.toString()}`;
    return bootstrapPairLink(url, deps, { ...(route.serverUrl ? { serverUrl: route.serverUrl } : {}), ...(route.token ? { token: route.token } : {}) });
  }

  // 3. Launch pairing link
  const launch = await deps.launchLink();
  if (launch) return bootstrapPairLink(launch, deps);

  // 4. Saved credentials
  const saved = deps.load();
  if (saved?.serverUrl && saved.token) {
    const result = saved.tunnel ? await deps.verify(saved.serverUrl, saved.token, saved.tunnel) : await deps.verify(saved.serverUrl, saved.token);
    if (result === 'ok') return { kind: 'ready', ...saved, source: 'saved' };
    if (result === 'unauthorized') {
      deps.forgetToken();
      return { kind: 'connect', reason: 'unauthorized', serverUrl: saved.serverUrl, ...(saved.tunnel ? { tunnel: saved.tunnel } : {}) };
    }
    return { kind: 'offline', ...saved, source: 'saved' };
  }

  // 5. Same origin
  const origin = httpOrigin(deps.origin);
  if (origin && (await deps.health(origin))) return { kind: 'connect', reason: 'same-origin', serverUrl: origin };

  // 6. Nothing found
  return { kind: 'connect', reason: 'none', serverUrl: saved?.serverUrl };
}

// ───────────────────────────── real dependencies ─────────────────────────────

/** Check credentials with an authenticated call (health is public, so it can't verify a token). */
export async function verifyCredentials(serverUrl: string, token: string, tunnel?: TunnelRoute | null): Promise<VerifyResult> {
  try {
    const client = createServerClient({ serverUrl, token, tunnel }, { timeoutMs: 8000 });
    await client.settings.get();
    return 'ok';
  } catch (err) {
    const status = httpStatus(err);
    if (status === 401 || status === 403) return 'unauthorized';
    if (isNetworkError(err) || status === null || status >= 500 || status === 404) return 'unreachable';
    return 'unauthorized';
  }
}

/** Exchange a single-use code without sending an existing device token. */
export async function claimPairingCode(serverUrl: string, code: string, device?: { deviceName: string; platform: Device['platform'] }, tunnel?: TunnelRoute | null): Promise<ClaimResult> {
  try {
    const info = device ?? { deviceName: getPlatform().deviceName(), platform: getPlatform().devicePlatform };
    const client = createServerClient({ serverUrl, token: '', tunnel }, { timeoutMs: 8000 });
    const result = await client.pairing.claim({ code, ...info });
    return { kind: 'ok', token: result.token };
  } catch (err) {
    const status = httpStatus(err);
    if (status === 429) return { kind: 'rate-limited' };
    if (status === 400 || status === 401 || status === 404) return { kind: 'invalid' };
    return { kind: 'unreachable' };
  }
}

export async function checkHealth(serverUrl: string, tunnel?: TunnelRoute | null): Promise<HealthResponse | null> {
  try {
    const client = createServerClient({ serverUrl, token: '', tunnel }, { timeoutMs: 4000 });
    const health = await client.health();
    return health.ok && health.name === 'neo' ? health : null;
  } catch {
    return null;
  }
}

export function loadCredentials(): Credentials | null {
  const c = readJson<Partial<Credentials>>(STORAGE_KEYS.connection);
  if (!c || typeof c.serverUrl !== 'string') return null;
  const tunnel = validatedTunnel(c.tunnel);
  return { serverUrl: tunnel ? tunnelBaseUrl(tunnel.serverId) : c.serverUrl, token: typeof c.token === 'string' ? c.token : '', ...(tunnel ? { tunnel } : {}) };
}

export function saveCredentials(c: Credentials): void {
  writeJson(STORAGE_KEYS.connection, c);
}

export function forgetToken(): void {
  const c = loadCredentials();
  writeJson(STORAGE_KEYS.connection, c ? { ...c, token: '' } : null);
}

export function clearCredentials(): void {
  writeJson(STORAGE_KEYS.connection, null);
}

/** Typed `window.neoDesktop` bridge exposed by the Electron preload. */
export interface NeoDesktopBridge {
  getConfig(): Promise<{ serverUrl: string; token: string }>;
  getMode?(): Promise<{ kind: 'local' } | { kind: 'remote'; serverUrl?: string }>;
  switchMode?(target: 'local' | 'remote'): Promise<void>;
  platform: string;
  openExternal(url: string): Promise<void> | void;
  /**
   * Persist the chosen remote mode so subsequent launches skip the dialog.
   * Only present in connect mode.
   */
  saveMode?(mode: { kind: 'remote'; serverUrl: string; token: string; tunnel?: TunnelRoute | null }): Promise<void>;
  /**
   * Subscribe to incoming neo://pair?... deep links forwarded from the main
   * process. Returns an unsubscribe function.
   */
  watchPairLinks?(onLink: (url: string) => void): () => void;
}

declare global {
  interface Window {
    neoDesktop?: NeoDesktopBridge;
  }
}

/**
 * Persist the desktop remote-mode credentials so the next launch skips the
 * "Run on this Mac / Connect" dialog. No-op when not running in Electron
 * connect mode (local desktop or browser).
 */
export async function saveDesktopMode(credentials: Credentials): Promise<void> {
  const desktop = typeof window !== 'undefined' ? window.neoDesktop : undefined;
  if (!desktop?.saveMode) return;
  await desktop.saveMode({
    kind: 'remote',
    serverUrl: credentials.serverUrl,
    token: credentials.token,
    tunnel: credentials.tunnel ?? null,
  });
}

export function browserBootstrapDeps(): BootstrapDeps {
  return {
    desktop: typeof window !== 'undefined' && window.neoDesktop ? window.neoDesktop : null,
    hash: window.location.hash,
    origin: window.location.origin,
    load: loadCredentials,
    save: saveCredentials,
    forgetToken,
    verify: verifyCredentials,
    claim: (serverUrl, code, tunnel) => claimPairingCode(serverUrl, code, undefined, tunnel),
    launchLink: () => getPlatform().launchLink?.() ?? Promise.resolve(null),
    consumePairLink: consumePairingLink,
    health: async (url) => (await checkHealth(url)) !== null,
    clearPairHash: () => {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/`);
    },
  };
}
