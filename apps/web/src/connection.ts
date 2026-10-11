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
import { parsePairingLink, parsePairingUrl, type Device, type HealthResponse, type PairingLink } from '@neo/protocol';
import { NeoClient } from '@neo/client';
import { STORAGE_KEYS, readJson, writeJson } from './lib/storage.js';
import { httpStatus, isNetworkError } from './lib/errors.js';
import { parseRoute } from './router.js';
import { getPlatform } from './platform/index.js';

export type ConnectionSource = 'desktop' | 'pair' | 'saved' | 'manual';

export interface Credentials {
  serverUrl: string;
  token: string;
}

export type VerifyResult = 'ok' | 'unauthorized' | 'unreachable';

export type ClaimResult =
  | { kind: 'ok'; token: string }
  | { kind: 'invalid' }
  | { kind: 'rate-limited' }
  | { kind: 'unreachable' };

export type BootstrapResult =
  | { kind: 'ready'; serverUrl: string; token: string; source: ConnectionSource }
  | { kind: 'offline'; serverUrl: string; token: string; source: ConnectionSource }
  | { kind: 'connect'; reason: 'none' | 'unauthorized' | 'pair-failed' | 'same-origin'; serverUrl?: string; token?: string };

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
  verify(serverUrl: string, token: string): Promise<VerifyResult>;
  claim(serverUrl: string, code: string): Promise<ClaimResult>;
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
    const local = host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local');
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
  const serverUrl = link.serverUrl ? normalizeServerUrl(link.serverUrl) : null;
  if (!serverUrl || (deps.consumePairLink && !deps.consumePairLink(link))) {
    return { kind: 'connect', reason: 'pair-failed', ...(serverUrl ? { serverUrl } : {}) };
  }
  if (link.version === 1) {
    const result = await deps.verify(serverUrl, link.token);
    if (result === 'ok') {
      deps.save({ serverUrl, token: link.token });
      return { kind: 'ready', serverUrl, token: link.token, source: 'pair' };
    }
    return { kind: 'connect', reason: 'pair-failed', serverUrl, token: link.token };
  }
  const result = await deps.claim(serverUrl, link.code);
  if (result.kind === 'ok') {
    deps.save({ serverUrl, token: result.token });
    return { kind: 'ready', serverUrl, token: result.token, source: 'pair' };
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
    const result = await deps.verify(saved.serverUrl, saved.token);
    if (result === 'ok') return { kind: 'ready', serverUrl: saved.serverUrl, token: saved.token, source: 'saved' };
    if (result === 'unauthorized') {
      deps.forgetToken();
      return { kind: 'connect', reason: 'unauthorized', serverUrl: saved.serverUrl };
    }
    return { kind: 'offline', serverUrl: saved.serverUrl, token: saved.token, source: 'saved' };
  }

  // 5. Same origin
  const origin = httpOrigin(deps.origin);
  if (origin && (await deps.health(origin))) return { kind: 'connect', reason: 'same-origin', serverUrl: origin };

  // 6. Nothing found
  return { kind: 'connect', reason: 'none', serverUrl: saved?.serverUrl };
}

// ───────────────────────────── real dependencies ─────────────────────────────

/** Check credentials with an authenticated call (health is public, so it can't verify a token). */
export async function verifyCredentials(serverUrl: string, token: string): Promise<VerifyResult> {
  try {
    const client = new NeoClient({ baseUrl: serverUrl, token, timeoutMs: 8000 });
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
export async function claimPairingCode(serverUrl: string, code: string, device?: { deviceName: string; platform: Device['platform'] }): Promise<ClaimResult> {
  try {
    const info = device ?? { deviceName: getPlatform().deviceName(), platform: getPlatform().devicePlatform };
    const client = new NeoClient({ baseUrl: serverUrl, timeoutMs: 8000 });
    const result = await client.pairing.claim({ code, ...info });
    return { kind: 'ok', token: result.token };
  } catch (err) {
    const status = httpStatus(err);
    if (status === 429) return { kind: 'rate-limited' };
    if (status === 400 || status === 401 || status === 404) return { kind: 'invalid' };
    return { kind: 'unreachable' };
  }
}

export async function checkHealth(serverUrl: string): Promise<HealthResponse | null> {
  try {
    const client = new NeoClient({ baseUrl: serverUrl, timeoutMs: 4000 });
    const health = await client.health();
    return health.ok && health.name === 'neo' ? health : null;
  } catch {
    return null;
  }
}

export function loadCredentials(): Credentials | null {
  const c = readJson<Partial<Credentials>>(STORAGE_KEYS.connection);
  if (!c || typeof c.serverUrl !== 'string') return null;
  return { serverUrl: c.serverUrl, token: typeof c.token === 'string' ? c.token : '' };
}

export function saveCredentials(c: Credentials): void {
  writeJson(STORAGE_KEYS.connection, c);
}

export function forgetToken(): void {
  const c = loadCredentials();
  writeJson(STORAGE_KEYS.connection, c ? { serverUrl: c.serverUrl, token: '' } : null);
}

export function clearCredentials(): void {
  writeJson(STORAGE_KEYS.connection, null);
}

/** Typed `window.neoDesktop` bridge exposed by the Electron preload. */
export interface NeoDesktopBridge {
  getConfig(): Promise<{ serverUrl: string; token: string }>;
  platform: string;
  openExternal(url: string): Promise<void> | void;
}

declare global {
  interface Window {
    neoDesktop?: NeoDesktopBridge;
  }
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
    claim: claimPairingCode,
    launchLink: () => getPlatform().launchLink?.() ?? Promise.resolve(null),
    consumePairLink: consumePairingLink,
    health: async (url) => (await checkHealth(url)) !== null,
    clearPairHash: () => {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/chat`);
    },
  };
}
