/**
 * Electron preload (CommonJS — sandboxed renderers cannot load ESM preloads).
 *
 * Compiled by tsc from .cts → .cjs.
 *
 * Exposes `window.neoDesktop` via contextBridge so the web app can call it
 * without nodeIntegration enabled in the renderer.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
// Under verbatimModuleSyntax, .cts files must use require() for CJS modules.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

/** Shape exposed on window.neoDesktop */
export interface NeoDesktopApi {
  /** Fetch the running server URL and auth token from the main process. */
  getConfig(): Promise<{ serverUrl: string; token: string }>;
  /** The current platform string (darwin | win32 | linux). */
  platform: string;
  /**
   * Ask the main process to open a URL in the default external browser.
   * Only http/https URLs are accepted; others are silently ignored.
   */
  openExternal(url: string): Promise<void>;
  /**
   * Persist the chosen remote mode so subsequent launches skip the dialog.
   * Only available in connect mode.
   */
  saveMode?(mode: { kind: 'remote'; serverUrl: string; token: string; tunnel?: unknown }): Promise<void>;
  /**
   * Subscribe to incoming neo://pair?... deep links forwarded from the main
   * process (macOS open-url / protocol handler). Returns an unsubscribe fn.
   */
  watchPairLinks?(callback: (url: string) => void): () => void;
}

const api: NeoDesktopApi = {
  getConfig(): Promise<{ serverUrl: string; token: string }> {
    return ipcRenderer.invoke('neo:getConfig') as Promise<{ serverUrl: string; token: string }>;
  },

  platform: process.platform,

  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('neo:openExternal', url) as Promise<void>;
  },

  saveMode(mode: { kind: 'remote'; serverUrl: string; token: string; tunnel?: unknown }): Promise<void> {
    return ipcRenderer.invoke('neo:saveMode', mode) as Promise<void>;
  },

  watchPairLinks(callback: (url: string) => void): () => void {
    const listener = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on('neo:pairLink', listener as Parameters<typeof ipcRenderer.on>[1]);
    return () => ipcRenderer.removeListener('neo:pairLink', listener as Parameters<typeof ipcRenderer.on>[1]);
  },
};

contextBridge.exposeInMainWorld('neoDesktop', api);

// Type augmentation consumed by the web app / TypeScript code in the renderer.
declare global {
  interface Window {
    neoDesktop: NeoDesktopApi;
  }
}
