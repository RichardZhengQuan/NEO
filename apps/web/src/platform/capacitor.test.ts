import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, readJson } from '../lib/storage.js';
import { createCapacitorBridge } from './capacitor.js';

const plugins = vi.hoisted(() => ({
  getLaunchUrl: vi.fn(),
  addListener: vi.fn(),
  remove: vi.fn(async () => undefined),
  scanBarcode: vi.fn(),
  registerActionTypes: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/app', () => ({ App: { getLaunchUrl: plugins.getLaunchUrl, addListener: plugins.addListener } }));
vi.mock('@capacitor/barcode-scanner', () => ({ CapacitorBarcodeScanner: { scanBarcode: plugins.scanBarcode }, CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 } }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: { registerActionTypes: plugins.registerActionTypes } }));

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  plugins.addListener.mockResolvedValue({ remove: plugins.remove });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mobile QR scanner', () => {
  it('requests QR-only scanning with localized instructions and returns the link', async () => {
    plugins.scanBarcode.mockResolvedValue({ ScanResult: 'neo://pair?v=2&code=test', format: 0 });
    const bridge = createCapacitorBridge('ios');
    bridge.setLocale('zh-CN');
    expect(await bridge.scanQrCode?.()).toBe('neo://pair?v=2&code=test');
    expect(plugins.scanBarcode).toHaveBeenCalledWith({ hint: 0, scanInstructions: '将相机对准电脑上的二维码', scanButton: false });
  });

  it('returns null on cancellation, empty scans and camera errors', async () => {
    const bridge = createCapacitorBridge('android');
    plugins.scanBarcode.mockRejectedValueOnce(new Error('cancelled'));
    expect(await bridge.scanQrCode?.()).toBeNull();
    plugins.scanBarcode.mockResolvedValueOnce({ ScanResult: '' });
    expect(await bridge.scanQrCode?.()).toBeNull();
    plugins.scanBarcode.mockRejectedValueOnce(new Error('camera denied'));
    expect(await bridge.scanQrCode?.()).toBeNull();
  });
});

describe('mobile launch pairing links', () => {
  it('consumes only pairing launch URLs', async () => {
    const bridge = createCapacitorBridge('ios');
    plugins.getLaunchUrl.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ url: 'neo://notes/note_1' }).mockResolvedValueOnce({ url: 'https://example.com' });
    expect(await bridge.launchLink?.()).toBeNull();
    expect(await bridge.launchLink?.()).toBeNull();
    expect(await bridge.launchLink?.()).toBeNull();
  });

  it('never returns the same launch URL again, including A → B → A and a WebView reload', async () => {
    const a = 'neo://pair?v=2&code=launch_url_a_1234567890123&server=https://home.example';
    const b = 'neo://pair?v=2&code=launch_url_b_1234567890123&server=https://home.example';
    plugins.getLaunchUrl.mockResolvedValue({ url: a });
    const bridge = createCapacitorBridge('ios');
    expect(await bridge.launchLink?.()).toBe(a);
    expect(await bridge.launchLink?.()).toBeNull();
    plugins.getLaunchUrl.mockResolvedValue({ url: b });
    expect(await bridge.launchLink?.()).toBe(b);
    plugins.getLaunchUrl.mockResolvedValue({ url: a });
    expect(await bridge.launchLink?.()).toBeNull();
    expect(readJson(STORAGE_KEYS.pairingLaunchLink)).toEqual({ last: b, handled: [a, b] });
    vi.resetModules();
    const reloaded = await import('./capacitor.js');
    expect(await reloaded.createCapacitorBridge('ios').launchLink?.()).toBeNull();
  });

  it('returns null when the native launch API is unavailable', async () => {
    plugins.getLaunchUrl.mockRejectedValueOnce(new Error('unavailable'));
    expect(await createCapacitorBridge('ios').launchLink?.()).toBeNull();
  });
});

describe('mobile pairing link listener', () => {
  it('forwards only pairing links and disposes the native listener', async () => {
    const onLink = vi.fn();
    const cleanup = createCapacitorBridge('ios').watchPairLinks?.(onLink);
    await vi.waitFor(() => expect(plugins.addListener).toHaveBeenCalledOnce());
    const [, callback] = plugins.addListener.mock.calls[0] as [string, (event: { url: string }) => void];
    callback({ url: 'neo://notes/note_1' });
    callback({ url: 'neo://pairing?token=bad' });
    callback({ url: 'neo://pair?v=2&code=phone' });
    expect(onLink).toHaveBeenCalledOnce();
    expect(onLink).toHaveBeenCalledWith('neo://pair?v=2&code=phone');
    cleanup?.();
    callback({ url: 'neo://pair?token=late' });
    expect(onLink).toHaveBeenCalledOnce();
    expect(plugins.remove).toHaveBeenCalledOnce();
  });

  it('removes a listener whose registration finishes after cleanup', async () => {
    let resolve!: (handle: { remove: typeof plugins.remove }) => void;
    plugins.addListener.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const cleanup = createCapacitorBridge('ios').watchPairLinks?.(vi.fn());
    await vi.waitFor(() => expect(plugins.addListener).toHaveBeenCalledOnce());
    cleanup?.();
    resolve({ remove: plugins.remove });
    await vi.waitFor(() => expect(plugins.remove).toHaveBeenCalledOnce());
  });
});
