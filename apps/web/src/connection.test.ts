import { describe, expect, it, vi } from 'vitest';
import { bootstrapConnection, browserBootstrapDeps, credentialsFromInput, normalizeServerUrl, type BootstrapDeps, type Credentials } from './connection.js';

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
    const result = await bootstrapConnection(deps({ desktop: { getConfig: async () => ({ serverUrl: 'http://127.0.0.1:5123/', token: 'owner' }) }, verify }));
    expect(result).toEqual({ kind: 'ready', serverUrl: 'http://127.0.0.1:5123', token: 'owner', source: 'desktop' });
    expect(verify).not.toHaveBeenCalled();
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
});
