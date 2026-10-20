import { afterEach, describe, it, expect, vi } from 'vitest';
import { startServer } from '@neo/server';

const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');

  class FakeBrowserWindow extends EventEmitter {
    loadURL = vi.fn().mockResolvedValue(undefined);
    show = vi.fn();
    focus = vi.fn();
    isMinimized = vi.fn(() => false);
    restore = vi.fn();
    hide = vi.fn();
    isVisible = vi.fn(() => true);
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(),
      executeJavaScript: vi.fn(),
    };

    constructor() {
      super();
      this.on('newListener', (event) => {
        if (event === 'ready-to-show') resolveWindow(this);
      });
    }
  }

  let resolveWindow!: (win: FakeBrowserWindow) => void;
  const windowReady = new Promise<FakeBrowserWindow>((resolve) => {
    resolveWindow = resolve;
  });

  return {
    app: Object.assign(new EventEmitter(), {
      whenReady: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      getPath: vi.fn(() => '/neo-test'),
      getAppPath: vi.fn(() => '/neo-test/apps/desktop'),
      setName: vi.fn(),
      isPackaged: false,
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    }),
    BrowserWindow: vi.fn(function () { return new FakeBrowserWindow(); }),
    Tray: vi.fn(function () {
      return Object.assign(new EventEmitter(), {
        setToolTip: vi.fn(),
        setContextMenu: vi.fn(),
      });
    }),
    windowReady,
  };
});

const server = vi.hoisted(() => ({
  startServer: vi.fn(),
  stopServer: vi.fn<() => Promise<void>>(),
}));

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  dialog: {},
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  MenuItem: vi.fn(),
  Notification: vi.fn(),
  nativeImage: { createFromBuffer: vi.fn(() => ({ setTemplateImage: vi.fn() })) },
  shell: {},
  Tray: electron.Tray,
}));

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: vi.fn(),
      checkForUpdatesAndNotify: vi.fn(),
    },
  },
}));

vi.mock('@neo/server', () => ({
  startServer: server.startServer,
  loadConfig: vi.fn(() => ({})),
}));

vi.mock('@neo/client', () => ({
  NeoClient: vi.fn(function () {
    return { connect: vi.fn(() => ({ close: vi.fn() })) };
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  electron.app.removeAllListeners();
});

describe('desktop startup failure', () => {
  it('quits when the startup-error window closes on macOS, even after activation', async () => {
    server.startServer.mockRejectedValueOnce(new Error('no build'));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await electron.app.whenReady();
    // Awaiting this event registration resumes after the helper's synchronous
    // setup, including the close handler. Old code still reaches the quit assertion.
    const win = await electron.windowReady;

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      '[NEO desktop] Failed to start embedded server:',
      expect.objectContaining({ message: 'no build' }),
    );
    expect(electron.app.quit).not.toHaveBeenCalled();

    win.emit('close');
    electron.app.emit('window-all-closed');
    electron.app.emit('activate');

    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });
});

describe('before-quit graceful shutdown', () => {
  it('prevents quitting until the server stops once and then allows quitting', async () => {
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    server.stopServer.mockReturnValueOnce(stopped);
    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7777',
      ownerToken: 'test-owner-token',
      stop: server.stopServer,
    });

    const shutdownReady = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event) => {
        // The earlier before-quit handlers set isQuitting and close notifications.
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await shutdownReady;

    const quit = new Promise<void>((resolve) => {
      electron.app.quit.mockImplementationOnce(resolve);
    });
    function createQuitEvent() {
      const event = {
        defaultPrevented: false,
        preventDefault: vi.fn(() => { event.defaultPrevented = true; }),
      };
      return event;
    }

    const firstEvent = createQuitEvent();
    electron.app.emit('before-quit', firstEvent);
    expect(firstEvent.defaultPrevented).toBe(true);
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(server.stopServer).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).not.toHaveBeenCalled();

    const pendingEvent = createQuitEvent();
    electron.app.emit('before-quit', pendingEvent);
    expect(pendingEvent.defaultPrevented).toBe(true);
    expect(server.stopServer).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).not.toHaveBeenCalled();

    resolveStop();
    await quit;
    expect(electron.app.quit).toHaveBeenCalledTimes(1);

    const completedEvent = createQuitEvent();
    electron.app.emit('before-quit', completedEvent);
    expect(completedEvent.preventDefault).not.toHaveBeenCalled();
    expect(completedEvent.defaultPrevented).toBe(false);
    expect(server.stopServer).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });
});
