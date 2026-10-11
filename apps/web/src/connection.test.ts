import { describe, expect, it, vi } from 'vitest';
import { bootstrapConnection, claimPairingCode, consumePairingLink, credentialsFromInput, normalizeServerUrl, type BootstrapDeps, type Credentials } from './connection.js';

const code = 'bootstrap_pairing_code_123456';

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

  it('cannot claim a tunnel-only link yet', async () => {
    const launchLink = async () => `neo://pair?v=2&code=${code}&id=${'a'.repeat(32)}&pk=${'b'.repeat(43)}&lan=mac.local:7778`;
    const claim = vi.fn(async () => ({ kind: 'ok' as const, token: 't' }));
    expect(await bootstrapConnection(deps({ launchLink, claim }))).toEqual({ kind: 'connect', reason: 'pair-failed' });
    expect(claim).not.toHaveBeenCalled();
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
