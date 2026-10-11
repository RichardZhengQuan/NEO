import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type TunnelRoute } from '@neo/protocol';
import { createTunnelTransport, tunnelBaseUrl } from '@neo/tunnel';
import { bootstrapConnection, consumePairingLink, loadCredentials, saveCredentials } from '../connection.js';
import { useData } from '../state/data.js';
import { startSession, useSession } from '../state/session.js';
import { pairWithLink, pairingOutcomeKey } from './pairing.js';

vi.mock('@neo/tunnel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neo/tunnel')>();
  return { ...actual, createTunnelTransport: vi.fn(({ route }: { route: TunnelRoute }) => ({
    baseUrl: actual.tunnelBaseUrl(route.serverId),
    fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
    WebSocket: class {} as unknown as typeof WebSocket,
  })) };
});

let sequence = 0;
const link = () => `neo://pair?v=2&code=pairing_action_test_code_${++sequence}&server=https://new.example`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fetchSuccess(url: string | URL | Request): Promise<Response> {
  const path = String(url);
  if (path.endsWith('/pairing/claim')) return Promise.resolve(json({ token: 'phone-token', device: {} }, 201));
  if (path.endsWith('/settings')) return Promise.resolve(json(DEFAULT_SETTINGS));
  if (path.endsWith('/health')) return Promise.resolve(json({ ok: true, name: 'neo' }));
  return Promise.resolve(json({ items: [], defaultModel: null }));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(fetchSuccess));
  startSession({ serverUrl: 'https://current.example', token: 'current-token' }, 'saved');
  useSession.setState({ phase: 'ready', settings: DEFAULT_SETTINGS });
  saveCredentials({ serverUrl: 'https://current.example', token: 'current-token' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pairWithLink', () => {
  it('claims a v2 code, connects and saves only the new device token', async () => {
    expect(await pairWithLink(link())).toBe('ok');
    expect(useSession.getState()).toMatchObject({ phase: 'ready', serverUrl: 'https://new.example', source: 'pair' });
    expect(loadCredentials()).toEqual({ serverUrl: 'https://new.example', token: 'phone-token' });
  });

  it('verifies a v1 link before switching', async () => {
    const url = `neo://pair?server=https://new.example&token=legacy_token_${++sequence}`;
    const fetch = vi.mocked(globalThis.fetch);
    expect(await pairWithLink(url)).toBe('ok');
    expect(fetch.mock.calls.filter(([request]) => String(request).endsWith('/settings'))).toHaveLength(2);
    expect(fetch.mock.calls.some(([request]) => String(request).endsWith('/pairing/claim'))).toBe(false);
  });

  it.each([[401, 'invalid'], [429, 'rate-limited'], [503, 'unreachable']] as const)('keeps the current session after claim status %i', async (status, outcome) => {
    const original = useSession.getState();
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'unauthorized', message: 'Rejected' }, status)));
    expect(await pairWithLink(link())).toBe(outcome);
    expect(useSession.getState()).toBe(original);
    expect(loadCredentials()?.token).toBe('current-token');
  });

  it('retains the session and its data when the claimed token cannot load settings', async () => {
    const original = useSession.getState();
    useData.setState({ notesLoaded: true });
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/settings') ? json({ code: 'internal', message: 'Offline' }, 503) : fetchSuccess(url)));
    expect(await pairWithLink(link())).toBe('unreachable');
    expect(useSession.getState()).toBe(original);
    expect(useData.getState().notesLoaded).toBe(true);
    expect(loadCredentials()?.token).toBe('current-token');
  });

  it('retains the session when a v1 preflight fails after verification', async () => {
    const original = useSession.getState();
    let settingsCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('/settings') && ++settingsCalls === 2) return json({ code: 'unauthorized', message: 'Revoked' }, 401);
      return fetchSuccess(url);
    }));
    expect(await pairWithLink(`neo://pair?server=https://new.example&token=preflight_legacy_${++sequence}`)).toBe('invalid');
    expect(useSession.getState()).toBe(original);
  });

  it('reserves a code before the request so concurrent deliveries claim only once', async () => {
    let resolve!: (response: Response) => void;
    const claim = new Promise<Response>((done) => { resolve = done; });
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/pairing/claim') ? claim : fetchSuccess(url));
    vi.stubGlobal('fetch', fetch);
    const url = link();
    const first = pairWithLink(url);
    expect(await pairWithLink(url)).toBe('duplicate');
    resolve(json({ token: 'phone-token', device: {} }, 201));
    expect(await first).toBe('ok');
    expect(fetch.mock.calls.filter(([request]) => String(request).endsWith('/pairing/claim'))).toHaveLength(1);
  });

  it('does not reclaim a bootstrap code from a retained deep link', async () => {
    const url = link();
    await bootstrapConnection({
      desktop: null, hash: '', origin: 'capacitor://localhost', launchLink: async () => url,
      load: () => null, save: () => undefined, forgetToken: () => undefined,
      verify: async () => 'ok', claim: async () => ({ kind: 'ok', token: 'bootstrap-token' }),
      consumePairLink: consumePairingLink, health: async () => false, clearPairHash: () => undefined,
    });
    expect(await pairWithLink(url)).toBe('duplicate');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not switch after the user changes session while a claim is pending', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const pending = pairWithLink(link());
    const newer = startSession({ serverUrl: 'https://other.example', token: 'other-token' }, 'manual');
    resolve(json({ token: 'late-token', device: {} }, 201));
    expect(await pending).toBe('unreachable');
    expect(useSession.getState().client).toBe(newer);
  });

  it('rejects malformed links without making a request', async () => {
    expect(await pairWithLink('not a link')).toBe('bad-link');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('claims tunnel-only links and saves their pinned route', async () => {
    const tunnel = { serverId: 'a'.repeat(32), publicKey: 'b'.repeat(43), lan: ['mac.local:7778'], relay: null };
    expect(await pairWithLink(`neo://pair?v=2&code=tunnel_only_test_code_123&id=${tunnel.serverId}&pk=${tunnel.publicKey}&lan=mac.local:7778`)).toBe('ok');
    expect(loadCredentials()).toEqual({ serverUrl: tunnelBaseUrl(tunnel.serverId), token: 'phone-token', tunnel });
    expect(useSession.getState().credentials?.tunnel).toEqual(tunnel);
    expect(createTunnelTransport).toHaveBeenCalledOnce();
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const claim = calls.find(([url]) => String(url).endsWith('/pairing/claim'));
    expect(new Headers(claim?.[1]?.headers).has('Authorization')).toBe(false);
    expect(calls.some(([url]) => String(url).endsWith('/phone-access'))).toBe(true);
  });

  it.each([
    ['ok', 'pairing.ok'], ['bad-link', 'pairing.bad_link'], ['invalid', 'pairing.invalid'],
    ['rate-limited', 'pairing.rate_limited'], ['unreachable', 'pairing.unreachable'], ['duplicate', 'pairing.duplicate'],
  ] as const)('maps %s to its UI message', (outcome, key) => {
    expect(pairingOutcomeKey(outcome)).toBe(key);
  });
});
