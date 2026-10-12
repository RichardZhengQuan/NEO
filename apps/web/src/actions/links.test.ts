import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@neo/protocol';
import { appDictionaries } from '../i18n.js';
import { loadCredentials, saveCredentials } from '../connection.js';
import type { PlatformKind } from '../platform/types.js';
import { useToasts } from '../state/notifications.js';
import { startSession, useSession } from '../state/session.js';
import { openLink, openPairLink } from './links.js';

const platform = vi.hoisted(() => ({
  kind: 'browser' as PlatformKind,
  deviceName: () => 'Test phone',
  devicePlatform: 'ios',
  openExternal: vi.fn(),
}));

vi.mock('../platform/index.js', () => ({ getPlatform: () => platform }));

let sequence = 0;
const pairingLink = () => `neo://pair?v=2&code=background_link_test_code_${++sequence}&server=https://paired.example`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fetchSuccess(url: string | URL | Request): Promise<Response> {
  const path = String(url);
  if (path.endsWith('/pairing/claim')) return Promise.resolve(json({ token: 'phone-token', device: {} }, 201));
  if (path.endsWith('/settings')) return Promise.resolve(json({ ...DEFAULT_SETTINGS, locale: 'zh-CN' }));
  if (path.endsWith('/health')) return Promise.resolve(json({ ok: true, name: 'neo' }));
  return Promise.resolve(json({ items: [], defaultModel: null }));
}

beforeEach(() => {
  window.localStorage.clear();
  platform.kind = 'browser';
  vi.stubGlobal('fetch', vi.fn(fetchSuccess));
  startSession({ serverUrl: 'https://current.example', token: 'current-token' }, 'saved');
  useSession.setState({ phase: 'ready', settings: { ...DEFAULT_SETTINGS, locale: 'zh-CN' } });
  saveCredentials({ serverUrl: 'https://current.example', token: 'current-token' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openPairLink', () => {
  it('ignores pairing links in Electron without a request or toast', () => {
    platform.kind = 'electron';
    const original = useSession.getState();
    openPairLink(pairingLink());
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useSession.getState()).toBe(original);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it('retains the connected session after a failed background claim and shows a localized toast', async () => {
    const original = useSession.getState();
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'unauthorized', message: 'Expired' }, 401)));
    openPairLink(pairingLink());
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(useSession.getState()).toBe(original);
    expect(loadCredentials()).toEqual({ serverUrl: 'https://current.example', token: 'current-token' });
    expect(useToasts.getState().toasts[0]).toMatchObject({ tone: 'error', title: appDictionaries['zh-CN']['pairing.invalid'] });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('shows the localized success toast after switching to the paired session', async () => {
    const sessionAtToast: { phase: string; serverUrl: string | null }[] = [];
    const stop = useToasts.subscribe((state) => {
      if (state.toasts.length) {
        const { phase, serverUrl } = useSession.getState();
        sessionAtToast.push({ phase, serverUrl });
      }
    });
    try {
      openPairLink(pairingLink());
      await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
      expect(sessionAtToast).toEqual([{ phase: 'ready', serverUrl: 'https://paired.example' }]);
      expect(loadCredentials()).toEqual({ serverUrl: 'https://paired.example', token: 'phone-token' });
      expect(useToasts.getState().toasts[0]).toMatchObject({ tone: 'success', title: appDictionaries['zh-CN']['pairing.ok'] });
    } finally {
      stop();
    }
  });

  it('claims a clicked v2 pairing hash through the same pairing action', async () => {
    const code = `clicked_hash_test_code_${++sequence}`;
    expect(openLink(`#/pair?v=2&code=${code}&server=https%3A%2F%2Fpaired.example`)).toBe(true);
    await vi.waitFor(() => expect(useToasts.getState().toasts[0]?.tone).toBe('success'));
    expect(useSession.getState()).toMatchObject({ phase: 'ready', source: 'pair', serverUrl: 'https://paired.example' });
    const claim = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).endsWith('/pairing/claim'));
    expect(JSON.parse(claim?.[1]?.body as string)).toMatchObject({ code, deviceName: 'Test phone', platform: 'ios' });
  });
});
