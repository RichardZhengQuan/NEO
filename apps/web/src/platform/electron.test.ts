import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { NeoDesktopBridge } from '../connection.js';
import { createElectronBridge } from './electron.js';
import type { PlatformContext } from './types.js';

function preloadBridge() {
  const ipcRenderer = new EventEmitter();
  const exposeInMainWorld = vi.fn();
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../desktop/src/preload.cts'), 'utf8');
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, {
    exports: {},
    process: { platform: 'darwin' },
    require(name: string) {
      expect(name).toBe('electron');
      return { contextBridge: { exposeInMainWorld }, ipcRenderer };
    },
  });
  expect(exposeInMainWorld).toHaveBeenCalledExactlyOnceWith('neoDesktop', expect.any(Object));
  const desktop = exposeInMainWorld.mock.calls[0]![1] as NeoDesktopBridge;
  return { desktop, ipcRenderer };
}

function context() {
  return {
    openLink: vi.fn(),
    onPairLink: vi.fn(),
    onReminderAction: vi.fn(),
    onResume: vi.fn(),
  } satisfies PlatformContext;
}

describe('electron active-session pair links', () => {
  it('forwards preload IPC pairing links after init, then unsubscribes on cleanup', () => {
    const { desktop, ipcRenderer } = preloadBridge();
    const ctx = context();
    const cleanup = createElectronBridge(desktop).init(ctx);
    const url = 'neo://pair?v=2&code=test';
    try {
      ipcRenderer.emit('neo:pairLink', {}, url);
      expect(ctx.onPairLink).toHaveBeenCalledExactlyOnceWith(url);
      window.dispatchEvent(new Event('focus'));
      expect(ctx.onResume).toHaveBeenCalledOnce();
    } finally {
      cleanup();
    }

    expect(ipcRenderer.listenerCount('neo:pairLink')).toBe(0);
    ipcRenderer.emit('neo:pairLink', {}, 'neo://pair?v=2&code=after-cleanup');
    window.dispatchEvent(new Event('focus'));
    expect(ctx.onPairLink).toHaveBeenCalledExactlyOnceWith(url);
    expect(ctx.onResume).toHaveBeenCalledOnce();
  });

  it('initializes and cleans up when the desktop has no pairing-link subscription API', () => {
    const desktop: NeoDesktopBridge = {
      getConfig: async () => ({ serverUrl: 'http://127.0.0.1:1', token: 't' }),
      platform: 'darwin',
      openExternal: () => undefined,
    };
    const ctx = context();
    const cleanup = createElectronBridge(desktop).init(ctx);
    try {
      window.dispatchEvent(new Event('focus'));
      expect(ctx.onResume).toHaveBeenCalledOnce();
      expect(ctx.onPairLink).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }

    window.dispatchEvent(new Event('focus'));
    expect(ctx.onResume).toHaveBeenCalledOnce();
  });
});
