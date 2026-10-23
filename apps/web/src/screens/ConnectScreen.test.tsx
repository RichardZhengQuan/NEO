import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider, buildMessages } from '@neo/ui';
import { pairWithLink, pairingOutcomeKey, type PairOutcome } from '../actions/pairing.js';
import { appDictionaries } from '../i18n.js';
import { useSession } from '../state/session.js';
import { ConnectScreen, OfflineScreen } from './ConnectScreen.js';

const mocks = vi.hoisted(() => ({
  pair: vi.fn(),
  verify: vi.fn(),
  connect: vi.fn(),
  cleanup: vi.fn(),
  onLink: null as ((url: string) => void) | null,
  platform: { kind: 'browser' as 'browser' | 'capacitor' | 'electron', scanQrCode: vi.fn(), watchPairLinks: vi.fn(), setLocale: vi.fn() },
}));
vi.mock('../platform/index.js', () => ({ getPlatform: () => mocks.platform }));
vi.mock('../actions/session.js', () => ({ connectWith: mocks.connect }));
vi.mock('../actions/pairing.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../actions/pairing.js')>(),
  pairWithLink: mocks.pair,
}));
vi.mock('../connection.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../connection.js')>(),
  verifyCredentials: mocks.verify,
}));

function show(locale = 'en') {
  return render(<I18nProvider locale={locale} messages={appDictionaries}><ConnectScreen /></I18nProvider>);
}

function showOffline() {
  useSession.setState({ phase: 'offline', connectHint: { reason: 'none', serverUrl: 'https://a.example.com', token: 'tok' } });
  return render(<I18nProvider locale="en" messages={appDictionaries}><OfflineScreen /></I18nProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.kind = 'browser';
  mocks.pair.mockResolvedValue('ok');
  mocks.platform.scanQrCode.mockResolvedValue(null);
  mocks.platform.watchPairLinks.mockImplementation((onLink: (url: string) => void) => {
    mocks.onLink = onLink;
    return mocks.cleanup;
  });
  mocks.verify.mockResolvedValue('ok');
  mocks.connect.mockResolvedValue(undefined);
  useSession.setState({ connectHint: null });
});
afterEach(() => {
  cleanup();
  delete window.neoDesktop;
  vi.restoreAllMocks();
});

describe('ConnectScreen pairing', () => {
  it('makes a pasted link primary in browsers and keeps credentials collapsed', async () => {
    show();
    expect(screen.getByRole('heading', { name: 'Paste the pairing link' })).toBeTruthy();
    const disclosure = screen.getByText('Connect manually (advanced)').closest('details');
    expect(disclosure?.open).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: /Pairing link/ }), { target: { value: 'neo://pair?v=2&code=example' } });
    fireEvent.submit(screen.getByRole('textbox', { name: /Pairing link/ }).closest('form')!);
    await act(async () => undefined);
    expect(pairWithLink).toHaveBeenCalledExactlyOnceWith('neo://pair?v=2&code=example');
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it.each(['bad-link', 'invalid', 'rate-limited', 'unreachable', 'duplicate'] as const)('shows the %s pairing message', async (outcome) => {
    mocks.pair.mockResolvedValue(outcome);
    show();
    fireEvent.change(screen.getByRole('textbox', { name: /Pairing link/ }), { target: { value: 'neo://pair?example' } });
    fireEvent.submit(screen.getByRole('textbox', { name: /Pairing link/ }).closest('form')!);
    await act(async () => undefined);
    expect(screen.getByRole('alert').textContent).toBe(appDictionaries.en[pairingOutcomeKey(outcome)]);
  });

  it('starts with Scan on phones, scans a link, and cleans up deep-link watching', async () => {
    mocks.platform.kind = 'capacitor';
    mocks.platform.scanQrCode.mockResolvedValue('neo://pair?v=2&code=scanned');
    const { unmount } = show();
    expect(screen.getByRole('heading', { name: 'Scan the code on your computer' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Pairing link/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await act(async () => undefined);
    expect(pairWithLink).toHaveBeenCalledExactlyOnceWith('neo://pair?v=2&code=scanned');
    unmount();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('pairs a watched link without scanning and does not show an error for scan cancellation', async () => {
    mocks.platform.kind = 'capacitor';
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await act(async () => undefined);
    expect(pairWithLink).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { mocks.onLink?.('neo://pair?v=2&code=opened'); });
    expect(pairWithLink).toHaveBeenCalledExactlyOnceWith('neo://pair?v=2&code=opened');
  });

  it('sets the phone bridge language before the first Chinese scan', async () => {
    mocks.platform.kind = 'capacitor';
    show('zh-CN');
    expect(mocks.platform.setLocale).toHaveBeenCalledExactlyOnceWith('zh-CN');
    fireEvent.click(screen.getByRole('button', { name: '扫描' }));
    await act(async () => undefined);
    expect(mocks.platform.setLocale.mock.invocationCallOrder[0]).toBeLessThan(mocks.platform.scanQrCode.mock.invocationCallOrder[0]!);
  });

  it('translates every outcome helper key in both languages', () => {
    const outcomes: PairOutcome[] = ['ok', 'bad-link', 'invalid', 'rate-limited', 'unreachable', 'duplicate'];
    for (const locale of ['en', 'zh-CN']) {
      const messages = buildMessages(locale, appDictionaries);
      for (const outcome of outcomes) expect(messages[pairingOutcomeKey(outcome)]).toBeTruthy();
    }
  });
});

describe('electron local-mode escape hatch', () => {
  beforeEach(() => {
    window.neoDesktop = {
      platform: 'darwin',
      getConfig: vi.fn().mockResolvedValue({ serverUrl: 'https://remote.example.com', token: 'tok' }),
      openExternal: vi.fn(),
      switchMode: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('switches from ConnectScreen to local mode without confirmation on electron', async () => {
    mocks.platform.kind = 'electron';
    const confirm = vi.spyOn(window, 'confirm');
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Run NEO on this Mac' }));
    await act(async () => undefined);
    expect(window.neoDesktop!.switchMode).toHaveBeenCalledExactlyOnceWith('local');
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides the ConnectScreen action on electron when the desktop bridge is missing', () => {
    mocks.platform.kind = 'electron';
    const { rerender } = show();
    expect(screen.getByRole('button', { name: 'Run NEO on this Mac' })).toBeTruthy();
    delete window.neoDesktop;
    rerender(<I18nProvider locale="en" messages={appDictionaries}><ConnectScreen /></I18nProvider>);
    expect(screen.queryByRole('button', { name: 'Run NEO on this Mac' })).toBeNull();
  });

  it('hides the ConnectScreen action in browsers even when the desktop bridge is present', () => {
    mocks.platform.kind = 'electron';
    const { rerender } = show();
    expect(screen.getByRole('button', { name: 'Run NEO on this Mac' })).toBeTruthy();
    mocks.platform.kind = 'browser';
    rerender(<I18nProvider locale="en" messages={appDictionaries}><ConnectScreen /></I18nProvider>);
    expect(screen.queryByRole('button', { name: 'Run NEO on this Mac' })).toBeNull();
    expect(window.neoDesktop!.switchMode).not.toHaveBeenCalled();
  });

  it('switches from OfflineScreen to local mode on electron', async () => {
    mocks.platform.kind = 'electron';
    showOffline();
    fireEvent.click(screen.getByRole('button', { name: 'Run NEO on this Mac' }));
    await act(async () => undefined);
    expect(window.neoDesktop!.switchMode).toHaveBeenCalledExactlyOnceWith('local');
  });

  it('shows a rejected ConnectScreen mode switch inline', async () => {
    mocks.platform.kind = 'electron';
    vi.mocked(window.neoDesktop!.switchMode!).mockRejectedValue(new Error('Could not save startup mode'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Run NEO on this Mac' }));
    await act(async () => undefined);
    expect(window.neoDesktop!.switchMode).toHaveBeenCalledExactlyOnceWith('local');
    expect(screen.getByRole('alert').textContent).toBe('Could not save startup mode');
  });
});

describe('OfflineScreen retry', () => {
  it('does not reconnect after choosing a different server', async () => {
    let resolve!: (value: 'ok' | 'unauthorized' | 'unreachable') => void;
    mocks.verify.mockReturnValue(new Promise((r) => { resolve = r; }));
    showOffline();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith('https://a.example.com', 'tok', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Use a different server' }));
    await act(async () => { resolve('ok'); });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(useSession.getState().phase).toBe('connect');
  });

  it('does not replace the manual connection hint after a stale unauthorized reply', async () => {
    let resolve!: (value: 'ok' | 'unauthorized' | 'unreachable') => void;
    mocks.verify.mockReturnValue(new Promise((r) => { resolve = r; }));
    showOffline();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith('https://a.example.com', 'tok', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Use a different server' }));
    await act(async () => { resolve('unauthorized'); });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(useSession.getState().phase).toBe('connect');
    expect(useSession.getState().connectHint).toEqual({ reason: 'manual', serverUrl: 'https://a.example.com', tunnel: undefined });
  });
});
