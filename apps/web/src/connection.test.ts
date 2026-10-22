import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPairingLink, type PhoneAccessStatus, type TunnelRoute } from '@neo/protocol';
import { NeoClient } from '@neo/client';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@neo/ui';
import { createTunnelTransport, tunnelBaseUrl } from '@neo/tunnel';
import { appDictionaries } from './i18n.js';
import { PhoneAccessCard } from './screens/settings/PhoneAccessCard.js';
import { useSession } from './state/session.js';
import { bootstrapConnection, browserBootstrapDeps, checkHealth, claimPairingCode, consumePairingLink, createServerClient, credentialsFromInput, forgetToken, loadCredentials, normalizeServerUrl, refreshTunnelRoute, saveCredentials, verifyCredentials, type BootstrapDeps, type Credentials } from './connection.js';

vi.mock('@neo/tunnel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neo/tunnel')>();
  return { ...actual, createTunnelTransport: vi.fn(({ route }: { route: TunnelRoute }) => ({
    baseUrl: actual.tunnelBaseUrl(route.serverId),
    fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
    WebSocket: class {} as unknown as typeof WebSocket,
  })) };
});

const tunnel: TunnelRoute = { serverId: 'a'.repeat(32), publicKey: 'b'.repeat(43), lan: ['mac.local:7778'], relay: null };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

const code = 'bootstrap_pairing_code_123456';

it('clears a consumed pairing link into the home timeline without adding history', () => {
  const oldHash = window.location.hash;
  window.history.replaceState(null, '', '#/pair?token=paired-token');
  const historyLength = window.history.length;
  try {
    browserBootstrapDeps().clearPairHash();
    expect(window.location.hash).toBe('#/');
    expect(window.history.length).toBe(historyLength);
  } finally {
    window.history.replaceState(null, '', oldHash || '#/');
  }
});

function deps(over: Partial<BootstrapDeps> = {}): BootstrapDeps & { saved: Credentials | null } {
  const state = { saved: null as Credentials | null };
  const d: BootstrapDeps & { saved: Credentials | null } = {
    desktop: null,
    hash: '',
    origin: 'capacitor://localhost',
    load: () => state.saved,
    save: (c) => {
      state.saved = c;
    },
    forgetToken: () => {
      if (state.saved) state.saved = { ...state.saved, token: '' };
    },
    verify: async () => 'ok',
    claim: async () => ({ kind: 'ok', token: 'phone-token' }),
    launchLink: async () => null,
    health: async () => false,
    clearPairHash: () => undefined,
    get saved() {
      return state.saved;
    },
    set saved(v) {
      state.saved = v;
    },
    ...over,
  };
  return d;
}

describe('bootstrapConnection', () => {
  it('prefers the desktop bridge', async () => {
    const verify = vi.fn(async () => 'ok' as const);
    const claim = vi.fn(async () => ({ kind: 'ok' as const, token: 'phone-token' }));
    const launchLink = vi.fn(async () => `neo://pair?v=2&code=${code}&server=https://phone.example`);
    const result = await bootstrapConnection(deps({ desktop: { getConfig: async () => ({ serverUrl: 'http://127.0.0.1:5123/', token: 'owner' }) }, hash: `#/pair?v=2&code=${code}`, origin: 'https://hash.example', verify, claim, launchLink }));
    expect(result).toEqual({ kind: 'ready', serverUrl: 'http://127.0.0.1:5123', token: 'owner', source: 'desktop' });
    expect(verify).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(launchLink).not.toHaveBeenCalled();
  });

  it('accepts a pairing hash, verifies, saves and clears it', async () => {
    const clearPairHash = vi.fn();
    const d = deps({ hash: '#/pair?token=tok123', origin: 'https://neo.example.com', clearPairHash });
    const result = await bootstrapConnection(d);
    expect(result).toEqual({ kind: 'ready', serverUrl: 'https://neo.example.com', token: 'tok123', source: 'pair' });
    expect(d.saved).toEqual({ serverUrl: 'https://neo.example.com', token: 'tok123' });
    expect(clearPairHash).toHaveBeenCalled();
  });

  it('uses the server from the pairing hash when given', async () => {
    const verify = vi.fn(async () => 'ok' as const);
    await bootstrapConnection(deps({ hash: '#/pair?token=t&server=https%3A%2F%2Fhome.example', verify }));
    expect(verify).toHaveBeenCalledWith('https://home.example', 't');
  });

  it('a rejected pairing token goes to Connect with the details prefilled', async () => {
    const result = await bootstrapConnection(deps({ hash: '#/pair?token=bad', origin: 'https://neo.example.com', verify: async () => 'unauthorized' }));
    expect(result).toEqual({ kind: 'connect', reason: 'pair-failed', serverUrl: 'https://neo.example.com', token: 'bad' });
  });

  it('claims a v2 hash on its http origin before launch and saved credentials', async () => {
    const claim = vi.fn(async () => ({ kind: 'ok' as const, token: 'claimed-token' }));
    const verify = vi.fn(async () => 'ok' as const);
    const launchLink = vi.fn(async () => `neo://pair?v=2&code=${code}&server=https://launch.example`);
    const clearPairHash = vi.fn();
    const d = deps({ hash: `#/pair?v=2&code=${code}`, origin: 'https://hash.example', claim, verify, launchLink, clearPairHash });
    d.saved = { serverUrl: 'https://saved.example', token: 'saved-token' };
    expect(await bootstrapConnection(d)).toEqual({ kind: 'ready', source: 'pair', serverUrl: 'https://hash.example', token: 'claimed-token' });
    expect(claim).toHaveBeenCalledWith('https://hash.example', code);
    expect(d.saved).toEqual({ serverUrl: 'https://hash.example', token: 'claimed-token' });
    expect(clearPairHash).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
    expect(launchLink).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'rate-limited', 'unreachable'] as const)('a %s v2 hash claim goes to Connect and clears the hash', async (kind) => {
    const clearPairHash = vi.fn();
    const d = deps({ hash: `#/pair?v=2&code=${code}&server=https://home.example`, claim: async () => ({ kind }), clearPairHash });
    expect(await bootstrapConnection(d)).toEqual({ kind: 'connect', reason: 'pair-failed', serverUrl: 'https://home.example' });
    expect(d.saved).toBeNull();
    expect(clearPairHash).toHaveBeenCalledOnce();
  });

  it('cannot claim a hash without a server on a non-http origin', async () => {
    const claim = vi.fn(async () => ({ kind: 'ok' as const, token: 't' }));
    expect(await bootstrapConnection(deps({ hash: `#/pair?v=2&code=${code}`, claim }))).toEqual({ kind: 'connect', reason: 'pair-failed' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('claims and saves a tunnel-only link with its pinned route', async () => {
    const launchLink = async () => `neo://pair?v=2&code=${code}&id=${'a'.repeat(32)}&pk=${'b'.repeat(43)}&lan=mac.local:7778`;
    const claim = vi.fn(async () => ({ kind: 'ok' as const, token: 't' }));
    const d = deps({ launchLink, claim });
    expect(await bootstrapConnection(d)).toEqual({ kind: 'ready', source: 'pair', serverUrl: tunnelBaseUrl(tunnel.serverId), token: 't', tunnel });
    expect(claim).toHaveBeenCalledWith(tunnelBaseUrl(tunnel.serverId), code, tunnel);
    expect(d.saved?.tunnel).toEqual(tunnel);
  });

  it.each([
    ['https://public.example', false], ['http://192.168.1.20:7777', true],
  ] as const)('prefers the expected route for %s', async (serverUrl, encrypted) => {
    const claim = vi.fn(async () => ({ kind: 'ok' as const, token: 't' }));
    const d = deps({ launchLink: async () => buildPairingLink({ code, serverUrl, tunnel }), claim });
    await bootstrapConnection(d);
    expect(d.saved?.serverUrl).toBe(encrypted ? tunnelBaseUrl(tunnel.serverId) : serverUrl);
    expect(d.saved?.tunnel).toEqual(encrypted ? tunnel : undefined);
  });

  it('retains and verifies the full saved tunnel credentials when offline', async () => {
    const verify = vi.fn(async () => 'unreachable' as const);
    const d = deps({ verify });
    d.saved = { serverUrl: tunnelBaseUrl(tunnel.serverId), token: 'device', tunnel };
    expect(await bootstrapConnection(d)).toEqual({ kind: 'offline', source: 'saved', ...d.saved });
    expect(verify).toHaveBeenCalledWith(d.saved.serverUrl, 'device', tunnel);
  });

  it('launch pairing claims before saved credentials', async () => {
    const verify = vi.fn(async () => 'ok' as const);
    const claim = vi.fn(async () => ({ kind: 'ok' as const, token: 'launch-token' }));
    const d = deps({ launchLink: async () => `neo://pair?v=2&code=${code}&server=https://launch.example`, verify, claim });
    d.saved = { serverUrl: 'https://saved.example', token: 'saved-token' };
    expect(await bootstrapConnection(d)).toEqual({ kind: 'ready', source: 'pair', serverUrl: 'https://launch.example', token: 'launch-token' });
    expect(verify).not.toHaveBeenCalled();
    expect(d.saved?.token).toBe('launch-token');
  });

  it('a failed launch pairing preserves saved credentials and opens Connect', async () => {
    const d = deps({ launchLink: async () => `neo://pair?v=2&code=${code}&server=https://launch.example`, claim: async () => ({ kind: 'invalid' }) });
    d.saved = { serverUrl: 'https://saved.example', token: 'saved-token' };
    expect(await bootstrapConnection(d)).toEqual({ kind: 'connect', reason: 'pair-failed', serverUrl: 'https://launch.example' });
    expect(d.saved).toEqual({ serverUrl: 'https://saved.example', token: 'saved-token' });
  });

  it('supports a v1 launch link', async () => {
    expect(await bootstrapConnection(deps({ launchLink: async () => 'neo://pair?server=https://launch.example&token=old-link' }))).toEqual({ kind: 'ready', source: 'pair', serverUrl: 'https://launch.example', token: 'old-link' });
  });

  it('a null launch link proceeds to saved credentials', async () => {
    const launchLink = vi.fn(async () => null);
    const d = deps({ launchLink });
    d.saved = { serverUrl: 'https://saved.example', token: 'saved-token' };
    expect((await bootstrapConnection(d))).toMatchObject({ kind: 'ready', source: 'saved' });
    expect(launchLink).toHaveBeenCalledOnce();
  });

  it('reserves bootstrap codes for the page-lifetime pairing actions', async () => {
    const bootstrapCode = 'deduplicate_bootstrap_code_123';
    const d = deps({ launchLink: async () => `neo://pair?v=2&code=${bootstrapCode}&server=https://launch.example`, consumePairLink: consumePairingLink });
    expect((await bootstrapConnection(d)).kind).toBe('ready');
    expect(consumePairingLink({ version: 2, code: bootstrapCode, serverUrl: 'https://launch.example', tunnel: null })).toBe(false);
  });

  it('uses saved credentials', async () => {
    const d = deps();
    d.saved = { serverUrl: 'https://a.example', token: 'x' };
    expect(await bootstrapConnection(d)).toEqual({ kind: 'ready', serverUrl: 'https://a.example', token: 'x', source: 'saved' });
  });

  it('a revoked saved token keeps the URL and asks for a new token', async () => {
    const d = deps({ verify: async () => 'unauthorized' });
    d.saved = { serverUrl: 'https://a.example', token: 'old' };
    expect(await bootstrapConnection(d)).toEqual({ kind: 'connect', reason: 'unauthorized', serverUrl: 'https://a.example' });
    expect(d.saved).toEqual({ serverUrl: 'https://a.example', token: '' });
  });

  it('an unreachable server keeps the credentials (offline)', async () => {
    const d = deps({ verify: async () => 'unreachable' });
    d.saved = { serverUrl: 'https://a.example', token: 'x' };
    expect(await bootstrapConnection(d)).toEqual({ kind: 'offline', serverUrl: 'https://a.example', token: 'x', source: 'saved' });
    expect(d.saved?.token).toBe('x');
  });

  it('detects a same-origin server', async () => {
    const health = vi.fn(async () => true);
    expect(await bootstrapConnection(deps({ origin: 'https://neo.example.com', health }))).toEqual({ kind: 'connect', reason: 'same-origin', serverUrl: 'https://neo.example.com' });
    expect(health).toHaveBeenCalledWith('https://neo.example.com');
  });

  it('does not probe non-http origins', async () => {
    const health = vi.fn(async () => true);
    expect(await bootstrapConnection(deps({ origin: 'capacitor://localhost', health }))).toEqual({ kind: 'connect', reason: 'none', serverUrl: undefined });
    expect(health).not.toHaveBeenCalled();
  });

  it('falls through when the desktop bridge fails', async () => {
    const d = deps({ desktop: { getConfig: async () => Promise.reject(new Error('no')) } });
    d.saved = { serverUrl: 'https://a.example', token: 'x' };
    expect((await bootstrapConnection(d)).kind).toBe('ready');
  });
});

describe('normalizeServerUrl', () => {
  it.each([
    ['neo.example.com', 'https://neo.example.com'],
    ['https://neo.example.com/', 'https://neo.example.com'],
    ['https://neo.example.com/api', 'https://neo.example.com'],
    ['192.168.1.20:7777', 'http://192.168.1.20:7777'],
    ['localhost:7777', 'http://localhost:7777'],
    ['nas.local.', 'http://nas.local.'],
    ['nas.local./api', 'http://nas.local.'],
    ['localhost.', 'http://localhost.'],
    ['api.localhost.', 'http://api.localhost.'],
    ['nas.lan', 'http://nas.lan'],
    ['nas.lan.', 'http://nas.lan.'],
    ['nas.lan./api', 'http://nas.lan.'],
    ['http://127.0.0.1:7777/api/', 'http://127.0.0.1:7777'],
    ['https://host/neo/', 'https://host/neo'],
  ])('%s → %s', (input, out) => {
    expect(normalizeServerUrl(input)).toBe(out);
  });

  it('rejects junk', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('ftp://x')).toBeNull();
  });
});

describe('credentialsFromInput', () => {
  it('reads neo://pair links', () => {
    expect(credentialsFromInput({ link: 'neo://pair?server=https%3A%2F%2Fhome.example&token=abc' })).toEqual({ serverUrl: 'https://home.example', token: 'abc' });
  });

  it('reads https pairing links', () => {
    expect(credentialsFromInput({ link: 'https://home.example/#/pair?token=abc' })).toEqual({ serverUrl: 'https://home.example', token: 'abc' });
  });

  it('reads URL + token', () => {
    expect(credentialsFromInput({ serverUrl: 'home.example', token: ' t ' })).toEqual({ serverUrl: 'https://home.example', token: 't' });
    expect(credentialsFromInput({ serverUrl: 'home.example', token: '' })).toBeNull();
  });

  it('leaves v2 links for the pairing action', () => {
    expect(credentialsFromInput({ link: `neo://pair?v=2&code=${code}&server=https://home.example` })).toBeNull();
  });
});

describe('claimPairingCode', () => {
  it('claims without a bearer token and sends the supplied device information', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ token: 'device-token', device: {} }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await claimPairingCode('https://home.example', code, { deviceName: 'Test phone', platform: 'ios' })).toEqual({ kind: 'ok', token: 'device-token' });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://home.example/api/pairing/claim');
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      expect(JSON.parse(init.body as string)).toEqual({ code, deviceName: 'Test phone', platform: 'ios' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([[400, 'invalid'], [401, 'invalid'], [404, 'invalid'], [429, 'rate-limited'], [500, 'unreachable'], [503, 'unreachable']] as const)('maps status %i to %s', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'unauthorized', message: 'Rejected' }), { status, headers: { 'Content-Type': 'application/json' } })));
    try {
      expect(await claimPairingCode('https://home.example', code, { deviceName: 'Phone', platform: 'android' })).toEqual({ kind });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a network failure to unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    try {
      expect(await claimPairingCode('https://home.example', code, { deviceName: 'Phone', platform: 'ios' })).toEqual({ kind: 'unreachable' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('tunnel credentials and clients', () => {
  it('stores a validated route, normalizes its base URL and retains it when forgetting a token', () => {
    saveCredentials({ serverUrl: 'http://old.example', token: 'device', tunnel });
    expect(loadCredentials()).toEqual({ serverUrl: tunnelBaseUrl(tunnel.serverId), token: 'device', tunnel });
    forgetToken();
    expect(loadCredentials()).toEqual({ serverUrl: tunnelBaseUrl(tunnel.serverId), token: '', tunnel });
  });

  it.each([
    { ...tunnel, serverId: 'wrong' }, { ...tunnel, publicKey: 'wrong' },
    { ...tunnel, lan: ['mac.local/no-port'] }, { ...tunnel, lan: Array(9).fill('mac.local:7778') },
    { ...tunnel, relay: 'https://relay.example' }, { ...tunnel, relay: 'wss://user@relay.example' },
    { ...tunnel, relay: 'wss://relay.example?secret=yes' }, { ...tunnel, relay: 'wss://relay.example#fragment' },
    { ...tunnel, relay: 'wss://relay.example?' }, { ...tunnel, relay: 'wss://relay.example#' },
  ])('drops a malformed saved route without trusting it', (badRoute) => {
    window.localStorage.setItem('neo.connection', JSON.stringify({ serverUrl: 'https://plain.example', token: 'device', tunnel: badRoute }));
    expect(loadCredentials()).toEqual({ serverUrl: 'https://plain.example', token: 'device' });
  });

  it('reuses one transport per pinned identity for health, verification, claim and session clients', async () => {
    const route = { ...tunnel, serverId: 'c'.repeat(32) };
    vi.mocked(createTunnelTransport).mockClear();
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith('/health') ? { ok: true, name: 'neo' } : { token: 'phone' }), { headers: { 'Content-Type': 'application/json' } })));
    const baseUrl = tunnelBaseUrl(route.serverId);
    expect(await checkHealth(baseUrl, route)).toMatchObject({ ok: true });
    expect(await verifyCredentials(baseUrl, 'owner', route)).toBe('ok');
    expect(await claimPairingCode(baseUrl, code, { deviceName: 'Phone', platform: 'ios' }, route)).toEqual({ kind: 'ok', token: 'phone' });
    const first = createServerClient({ serverUrl: baseUrl, token: 'phone', tunnel: route });
    const next = createServerClient({ serverUrl: baseUrl, token: 'phone', tunnel: { ...route, lan: ['new.local:7778'] } });
    expect(first.options.fetch).toBe(next.options.fetch);
    expect(first.options.WebSocket).toBe(next.options.WebSocket);
    expect(createTunnelTransport).toHaveBeenCalledOnce();
    expect(vi.mocked(createTunnelTransport).mock.calls[0]?.[0].route.lan).toEqual(['new.local:7778']);
    const claim = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).endsWith('/pairing/claim'));
    expect(new Headers(claim?.[1]?.headers).has('Authorization')).toBe(false);
    createServerClient({ serverUrl: baseUrl, token: 'phone', tunnel: { ...route, publicKey: 'd'.repeat(43) } });
    expect(createTunnelTransport).toHaveBeenCalledTimes(2);
  });
});

describe('refreshTunnelRoute', () => {
  const credentials: Credentials = { serverUrl: tunnelBaseUrl(tunnel.serverId), token: 'device', tunnel };
  const status: PhoneAccessStatus = {
    enabled: true, serverId: tunnel.serverId, publicKey: tunnel.publicKey,
    lan: { listening: true, port: 8000, addresses: ['new.local:8000'], error: null },
    relay: { url: null, status: 'off', error: null }, defaultRelayUrl: '',
  };
  const client = (response: PhoneAccessStatus) => ({ phoneAccess: { status: vi.fn(async () => response) } }) as unknown as NeoClient;

  it('updates only addresses under the existing pinned identity', async () => {
    saveCredentials(credentials);
    const next = await refreshTunnelRoute(credentials, client(status), () => true);
    expect(next.tunnel).toEqual({ ...tunnel, lan: ['new.local:8000'] });
    expect(loadCredentials()).toEqual(next);
  });

  it.each([{ serverId: 'e'.repeat(32) }, { publicKey: 'f'.repeat(43) }])('ignores a server reporting a different identity', async (identity) => {
    saveCredentials(credentials);
    expect(await refreshTunnelRoute(credentials, client({ ...status, ...identity }), () => true)).toBe(credentials);
    expect(loadCredentials()).toEqual(credentials);
  });

  it('keeps a reconnecting relay and never saves a route with no way in', async () => {
    saveCredentials(credentials);
    const reconnecting = await refreshTunnelRoute(credentials, client({ ...status, relay: { url: 'wss://relay.example', status: 'connecting', error: null } }), () => true);
    expect(reconnecting.tunnel).toEqual({ ...tunnel, lan: ['new.local:8000'], relay: 'wss://relay.example' });
    const unreachable = { ...status, lan: { listening: false, port: null, addresses: [], error: null } };
    expect(await refreshTunnelRoute(reconnecting, client(unreachable), () => true)).toBe(reconnecting);
    expect(loadCredentials()).toEqual(reconnecting);
  });

  it('ignores a late response after a session switch', async () => {
    saveCredentials(credentials);
    expect(await refreshTunnelRoute(credentials, client(status), () => false)).toBe(credentials);
    expect(loadCredentials()).toEqual(credentials);
  });

  it('keeps a newer saved connection when a route refresh completes', async () => {
    saveCredentials({ serverUrl: 'https://new.example', token: 'new-token' });
    await refreshTunnelRoute(credentials, client(status), () => true);
    expect(loadCredentials()).toEqual({ serverUrl: 'https://new.example', token: 'new-token' });
  });
});

describe('PhoneAccessCard', () => {
  const status = (enabled: boolean): PhoneAccessStatus => ({
    enabled, serverId: tunnel.serverId, publicKey: tunnel.publicKey,
    lan: { listening: enabled, port: enabled ? 7778 : null, addresses: enabled ? tunnel.lan : [], error: null },
    relay: { url: null, status: 'off', error: null }, defaultRelayUrl: '',
  });
  const card = (refresh = 0, locale = 'en') => createElement(I18nProvider, { locale, messages: appDictionaries, children: createElement(PhoneAccessCard, { refresh }) });

  it('toggles phone access and reloads honest listener status', async () => {
    const phoneAccess = { status: vi.fn().mockResolvedValueOnce(status(false)).mockResolvedValue(status(true)), update: vi.fn().mockResolvedValue(status(true)) };
    useSession.setState({ client: { phoneAccess } as unknown as NeoClient, settings: null });
    render(card());
    await act(async () => undefined);
    expect(screen.getByRole('status').textContent).toBe('Off');
    fireEvent.click(screen.getByRole('switch', { name: 'Phone access' }));
    await act(async () => undefined);
    expect(phoneAccess.update).toHaveBeenCalledWith({ enabled: true });
    expect(phoneAccess.status).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toBe('On this network: mac.local:7778');
    expect(screen.getByText(/Keep NEO running in the background/)).toBeTruthy();
  });

  it('shows owner-only feedback on 403 without changing the switch', async () => {
    const phoneAccess = { status: vi.fn().mockResolvedValue(status(false)), update: vi.fn().mockRejectedValue({ httpStatus: 403 }) };
    useSession.setState({ client: { phoneAccess } as unknown as NeoClient });
    render(card());
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('switch', { name: 'Phone access' }));
    await act(async () => undefined);
    expect(screen.getByRole('alert').textContent).toBe(appDictionaries.en['devices.owner_only']);
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
  });

  it('refreshes after pairing closes and displays a listener failure in Chinese', async () => {
    const phoneAccess = { status: vi.fn().mockResolvedValueOnce(status(false)).mockResolvedValue({ ...status(true), lan: { ...status(false).lan, error: 'Port unavailable' } }), update: vi.fn() };
    useSession.setState({ client: { phoneAccess } as unknown as NeoClient });
    const view = render(card(0, 'zh-CN'));
    await act(async () => undefined);
    expect(screen.getByRole('status').textContent).toBe('已关闭');
    view.rerender(card(1, 'zh-CN'));
    await act(async () => undefined);
    expect(phoneAccess.status).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toBe('Port unavailable');
    expect(screen.getByRole('switch', { name: '手机访问' })).toBeTruthy();
  });
});
