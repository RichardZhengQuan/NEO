import { afterEach, describe, it, expect, vi } from 'vitest';
import { ipcMain, shell } from 'electron';
import { startServer } from '@neo/server';
import { NeoClient } from '@neo/client';

// Mock node:fs/promises so catch-up state persistence doesn't touch disk.
// Default: startup-mode.json → 'local' (so existing tests don't trigger the dialog).
const ENOENT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const fsMock = vi.hoisted(() => ({
  readFile: vi.fn<(p: string, enc?: string) => Promise<string | Buffer>>().mockImplementation((p: string) => {
    if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify('local'));
    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  }),
  writeFile: vi.fn<(p: string, d: string, enc: string) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock('node:fs/promises', () => fsMock);

const dialogMock = vi.hoisted(() => ({
  showMessageBox: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false }),
}));

const protocolMock = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn<(scheme: string, handler: (req: Request) => Promise<Response>) => void>(),
}));

const tunnelMock = vi.hoisted(() => ({
  createTunnelTransport: vi.fn(function (_options: unknown) {
    return {
      baseUrl: 'https://fake.tunnel.invalid',
      fetch: vi.fn(),
      WebSocket: vi.fn(),
      close: vi.fn(),
    };
  }),
}));
vi.mock('@neo/tunnel', () => tunnelMock);

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
      this.on('closed', () => {
        for (const method of [
          this.loadURL,
          this.show,
          this.focus,
          this.isMinimized,
          this.restore,
          this.hide,
          this.isVisible,
          ...Object.values(this.webContents),
        ]) {
          method.mockImplementation(() => { throw new Error('Object has been destroyed'); });
        }
      });
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
      relaunch: vi.fn(),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      setAsDefaultProtocolClient: vi.fn(() => true),
      getPath: vi.fn(() => '/neo-test'),
      getAppPath: vi.fn(() => '/neo-test/apps/desktop'),
      getLocale: vi.fn(() => 'en-US'),
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

const clientMock = vi.hoisted(() => ({
  onStatus: null as ((status: string) => void) | null,
  onEvent: null as ((e: unknown) => void) | null,
  connectionCloses: [] as ReturnType<typeof vi.fn>[],
  remindersList: vi.fn<(q?: { status?: string[]; lastFiredAtFrom?: number }) => Promise<{ items: unknown[] }>>()
    .mockResolvedValue({ items: [] }),
}));

vi.mock('electron', () => {
  // Each new Notification() must have on() and show() so that callers outside
  // the catch-up try/catch (e.g. the onEvent WS handler) do not throw.
  const Notification = Object.assign(
    vi.fn(function () { return { on: vi.fn(), show: vi.fn() }; }),
    { isSupported: vi.fn(() => false) },
  );
  return {
    app: electron.app,
    BrowserWindow: electron.BrowserWindow,
    dialog: { showMessageBox: dialogMock.showMessageBox },
    ipcMain: { handle: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    MenuItem: vi.fn(),
    Notification,
    nativeImage: { createFromBuffer: vi.fn(() => ({ setTemplateImage: vi.fn() })) },
    protocol: protocolMock,
    shell: { openExternal: vi.fn() },
    Tray: electron.Tray,
  };
});

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
    return {
      connect: vi.fn((opts: { onStatus?: (s: string) => void; onEvent?: (e: unknown) => void; reconnect?: boolean }) => {
        clientMock.onStatus = opts.onStatus ?? null;
        clientMock.onEvent = opts.onEvent ?? null;
        const close = vi.fn();
        clientMock.connectionCloses.push(close);
        return { close };
      }),
      reminders: {
        list: clientMock.remindersList,
      },
    };
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  electron.app.removeAllListeners();
  electron.app.isPackaged = false;
  clientMock.onStatus = null;
  clientMock.onEvent = null;
  clientMock.connectionCloses = [];
  // Reset fsMock: startup-mode.json → 'local', everything else → ENOENT.
  fsMock.readFile.mockImplementation((p: string) => {
    if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify('local'));
    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });
  fsMock.writeFile.mockResolvedValue(undefined);
  dialogMock.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
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

describe('neo:// URL scheme registration', () => {
  it('calls setAsDefaultProtocolClient("neo") on startup', async () => {
    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7777',
      ownerToken: 'test-token',
      stop: server.stopServer,
    });
    const ready = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await ready;

    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);
    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('neo');
  });
});

describe('desktop window lifecycle', () => {
  it('second-instance after window close does not access a destroyed window', async () => {
    const serverUrl = 'http://127.0.0.1:7777';
    server.startServer.mockResolvedValueOnce({
      url: serverUrl,
      ownerToken: 'test-owner-token',
      stop: server.stopServer,
    });

    const startupReady = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await startupReady;

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(1);
    const win = electron.BrowserWindow.mock.results[0]!.value;
    expect(win.loadURL).toHaveBeenCalledWith(serverUrl);

    win.emit('closed');
    expect(() => win.isMinimized()).toThrow('Object has been destroyed');
    expect(() => win.show()).toThrow('Object has been destroyed');

    expect.soft(() => electron.app.emit('second-instance')).not.toThrow();
    expect.soft(() => electron.app.emit('activate')).not.toThrow();
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(2);
    const reopenedWindow = electron.BrowserWindow.mock.results[1]!.value;
    expect(reopenedWindow.loadURL).toHaveBeenCalledWith(serverUrl);
  });
});

describe('desktop local mode IPC', () => {
  const serverUrl = 'http://127.0.0.1:7777';
  const localEvent = { senderFrame: { url: `${serverUrl}/#/settings/desktop` } } as Electron.IpcMainInvokeEvent;

  async function enterLocalMode(): Promise<void> {
    server.startServer.mockResolvedValueOnce({
      url: serverUrl,
      ownerToken: 'local-token',
      stop: server.stopServer,
    });
    const ready = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await ready;
  }

  function ipcHandler(channel: string) {
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
    expect(handler, `${channel} must be registered`).toBeTypeOf('function');
    return handler!;
  }

  it('neo:getMode reports this Mac in local mode', async () => {
    await enterLocalMode();
    await expect(ipcHandler('neo:getMode')(localEvent)).resolves.toStrictEqual({ kind: 'local' });
  });

  it('neo:switchMode persists a credential-free remote mode before relaunching and quitting', async () => {
    await enterLocalMode();
    let finishSave!: () => void;
    fsMock.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const switching = ipcHandler('neo:switchMode')(localEvent, 'remote');
    expect(fsMock.writeFile).toHaveBeenCalledExactlyOnceWith(
      '/neo-test/startup-mode.json', JSON.stringify({ kind: 'remote' }), 'utf8',
    );
    expect(electron.app.relaunch).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
    finishSave();
    await switching;
    expect(electron.app.relaunch).toHaveBeenCalledExactlyOnceWith();
    expect(electron.app.quit).toHaveBeenCalledExactlyOnceWith();
    expect(electron.app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(electron.app.quit.mock.invocationCallOrder[0]!);
  });

  it.each(['neo:getMode', 'neo:switchMode'])('%s rejects unauthorized senders in local mode', async (channel) => {
    await enterLocalMode();
    const handler = ipcHandler(channel);
    for (const url of ['file:///evil', 'https://evil.example', 'http://127.0.0.1:9999']) {
      await expect(handler({ senderFrame: { url } } as Electron.IpcMainInvokeEvent, 'remote')).rejects.toThrow('Unauthorized sender');
    }
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(electron.app.relaunch).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
  });
});

describe('neo:openExternal IPC handler', () => {
  it('opens mailto: URLs from a same-origin sender', async () => {
    const serverUrl = 'http://127.0.0.1:7777';
    server.startServer.mockResolvedValueOnce({
      url: serverUrl,
      ownerToken: 'test-owner-token',
      stop: server.stopServer,
    });

    const startupReady = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await startupReady;

    const handler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([channel]) => channel === 'neo:openExternal',
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const event = { senderFrame: { url: serverUrl } } as Electron.IpcMainInvokeEvent;
    await handler!(event, 'mailto:alice@example.com');

    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('mailto:alice@example.com');
  });

  it('opens tel: URLs from a same-origin sender', async () => {
    const serverUrl = 'http://127.0.0.1:7777';
    server.startServer.mockResolvedValueOnce({
      url: serverUrl,
      ownerToken: 'test-owner-token',
      stop: server.stopServer,
    });

    const startupReady = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await startupReady;

    const handler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([channel]) => channel === 'neo:openExternal',
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const event = { senderFrame: { url: serverUrl } } as Electron.IpcMainInvokeEvent;
    await handler!(event, 'tel:+15551234567');

    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('tel:+15551234567');
  });

  it('rejects javascript: URLs from a same-origin sender', async () => {
    const serverUrl = 'http://127.0.0.1:7777';
    server.startServer.mockResolvedValueOnce({
      url: serverUrl,
      ownerToken: 'test-owner-token',
      stop: server.stopServer,
    });

    const startupReady = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await startupReady;

    const handler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([channel]) => channel === 'neo:openExternal',
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const event = { senderFrame: { url: serverUrl } } as Electron.IpcMainInvokeEvent;
    await handler!(event, 'javascript:alert(1)');

    expect(shell.openExternal).not.toHaveBeenCalled();
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

  it('still quits and logs when server stop rejects', async () => {
    const stopError = new Error('stop failed');
    server.stopServer.mockRejectedValueOnce(stopError);
    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7777',
      ownerToken: 'test-owner-token',
      stop: server.stopServer,
    });

    const shutdownReady = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await shutdownReady;

    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    expect(server.stopServer).toHaveBeenCalledTimes(1);

    await quit;
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      '[NEO desktop] Error stopping server during quit:',
      stopError,
    );

    // After rejection + quit, shutdownDone is true so subsequent events pass through.
    const completedEvent = createQuitEvent();
    electron.app.emit('before-quit', completedEvent);
    expect(completedEvent.preventDefault).not.toHaveBeenCalled();
    expect(server.stopServer).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });
});

/** Flush enough microtask ticks for the catch-up async block to complete:
 *  1. void IIFE starts
 *  2. loadPersistedState / readFile resolves
 *  3. client.reminders.list resolves
 *  4. notification loop iterates
 *  5. savePersistedState writeFile resolves
 */
async function flushCatchup(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('startup reminder catch-up', () => {
  it('notifies overdue reminders when desktop starts', async () => {
    // Seed a one-shot reminder whose dueAt is in the past so the scheduler fires
    // it synchronously inside startServer(), before the WS subscriber connects.
    const overdueReminder = {
      id: 'r-overdue-1',
      title: 'Buy milk',
      notes: null,
      dueAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
      status: 'fired',
      firedCount: 1,
      lastFiredAt: Date.now(), // fired recently (startup gap simulation)
      messageId: null,
    };
    clientMock.remindersList.mockResolvedValueOnce({ items: [overdueReminder] });

    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7778',
      ownerToken: 'owner-tok-catchup',
      stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    // Wait until main() has registered its before-quit listener (signals full startup).
    const startupDone = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });

    await import('./main.js');
    await startupDone;

    // Obtain the Notification constructor from the current mock cycle.
    const { Notification } = await import('electron');
    // Allow ElectronNotification.isSupported() to return true for this test.
    vi.spyOn(Notification as { isSupported: () => boolean }, 'isSupported').mockReturnValue(true);

    // Simulate the WS becoming 'open' for the first time — triggers catch-up.
    clientMock.onStatus?.('open');

    await flushCatchup();

    // Exactly one 'Missed reminder' notification must have been shown.
    expect(Notification).toHaveBeenCalledTimes(1);
    expect(Notification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Missed reminder' }),
    );
    // Catch-up must query by lastFiredAtFrom (not status:'fired') so recurring
    // reminders (status='scheduled') are included and the 100-item page limit is
    // not a filter boundary.
    expect(clientMock.remindersList).toHaveBeenCalledWith(
      expect.objectContaining({ lastFiredAtFrom: expect.any(Number) }),
    );
    expect(clientMock.remindersList.mock.calls[0]![0]).not.toHaveProperty('status');
  });

  it('persists catch-up window floor even when ElectronNotification.isSupported() is false', async () => {
    const firedAt = Date.now() - 5_000;
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify({ lastRunAt: firedAt - 1_000 }));
    const overdueReminder = {
      id: 'r-unsupported-1',
      title: 'Call dentist',
      notes: null,
      dueAt: firedAt - 1_000,
      status: 'fired',
      firedCount: 1,
      lastFiredAt: firedAt,
      messageId: null,
    };
    clientMock.remindersList.mockResolvedValueOnce({ items: [overdueReminder] });

    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7782',
      ownerToken: 'owner-tok-unsupported',
      stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const startupDone = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });

    await import('./main.js');
    await startupDone;

    const { Notification } = await import('electron');
    vi.spyOn(Notification as { isSupported: () => boolean }, 'isSupported').mockReturnValue(false);
    const beforeCatchup = Date.now();
    clientMock.onStatus?.('open');
    await flushCatchup();

    expect(Notification).not.toHaveBeenCalled();
    expect(fsMock.writeFile).toHaveBeenCalled();
    const written = JSON.parse(fsMock.writeFile.mock.calls.at(-1)![1] as string) as { lastRunAt: number };
    expect(written.lastRunAt).toBeGreaterThanOrEqual(beforeCatchup);
  });

  it('uses lastFiredAtFrom from persisted state to avoid duplicate on rapid restart', async () => {
    const firedAt = Date.now() - 5_000; // fired 5 s ago
    const lastRunAt = firedAt + 1_000;  // previous process completed catch-up 1 s after firing
    // Simulate persisted state from the previous process run.
    // Override the default to serve both startup-mode and persisted catch-up state.
    fsMock.readFile.mockImplementation((p: string) => {
      if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify('local'));
      if (p.endsWith('reminder-catchup.json')) return Promise.resolve(JSON.stringify({ lastRunAt }));
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const overdueReminder = {
      id: 'r-restart-dup',
      title: 'Call dentist',
      notes: null,
      dueAt: firedAt - 1_000,
      status: 'fired',
      firedCount: 1,
      // lastFiredAt is BEFORE lastRunAt, so it should not be shown again.
      lastFiredAt: firedAt,
      messageId: null,
    };
    // The server returns the reminder; the catch-up must not show it because
    // lastFiredAtFrom will be lastRunAt (> firedAt), so the server would filter
    // it out.  We verify by checking that the query carries lastFiredAtFrom >= lastRunAt.
    clientMock.remindersList.mockResolvedValueOnce({ items: [] });

    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7779',
      ownerToken: 'owner-tok-restart',
      stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const startupDone = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });

    await import('./main.js');
    await startupDone;

    const { Notification } = await import('electron');
    vi.spyOn(Notification as { isSupported: () => boolean }, 'isSupported').mockReturnValue(true);
    clientMock.onStatus?.('open');
    await flushCatchup();

    // No notification: the persisted lastRunAt floors the window above firedAt.
    expect(Notification).not.toHaveBeenCalled();
    // The query's lastFiredAtFrom must be >= lastRunAt.
    const callArg = clientMock.remindersList.mock.calls[0]?.[0];
    expect(callArg?.lastFiredAtFrom).toBeGreaterThanOrEqual(lastRunAt);
    // Ignore unused variable — only needed to illustrate the scenario.
    void overdueReminder;
  });

  it('includes recurring reminders (status=scheduled) in catch-up', async () => {
    // A recurring reminder that fired during the gap gets status='scheduled'
    // (not 'fired') because markFired advances it.  The old status:['fired']
    // query would miss it; the new lastFiredAtFrom query catches it.
    const recurringReminder = {
      id: 'r-recurring-1',
      title: 'Daily standup',
      notes: null,
      dueAt: Date.now() + 24 * 60 * 60 * 1000, // next occurrence tomorrow
      status: 'scheduled',     // <-- NOT 'fired'
      firedCount: 3,
      lastFiredAt: Date.now(), // fired recently during the startup gap
      messageId: null,
    };
    clientMock.remindersList.mockResolvedValueOnce({ items: [recurringReminder] });

    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7780',
      ownerToken: 'owner-tok-recurring',
      stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const startupDone = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });

    await import('./main.js');
    await startupDone;

    const { Notification } = await import('electron');
    vi.spyOn(Notification as { isSupported: () => boolean }, 'isSupported').mockReturnValue(true);
    clientMock.onStatus?.('open');
    await flushCatchup();

    // The recurring reminder must be shown — it was returned by the server.
    expect(Notification).toHaveBeenCalledTimes(1);
    expect(Notification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Missed reminder' }),
    );
  });

  it('persists state on live WS delivery so restart within catch-up window does not re-fire', async () => {
    // A reminder delivered live via WS (not through catch-up) must advance the
    // persisted lastRunAt floor.  Without this fix a restart within the 60-second
    // catch-up window would include the reminder in the next catch-up sweep and
    // show it again as "Missed reminder".
    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7781',
      ownerToken: 'owner-tok-ws-persist',
      stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const startupDone = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });

    await import('./main.js');
    await startupDone;

    const { Notification } = await import('electron');
    vi.spyOn(Notification as { isSupported: () => boolean }, 'isSupported').mockReturnValue(true);

    // Deliver a reminder via the live WS stream (not the catch-up path).
    const wsReminder = {
      id: 'r-ws-live-1',
      title: 'Take medicine',
      notes: null,
      dueAt: Date.now() + 60_000,
      status: 'fired',
      firedCount: 1,
      lastFiredAt: Date.now(),
      messageId: null,
    };
    const beforeFire = Date.now();
    clientMock.onEvent?.({
      event: {
        type: 'reminder.fired',
        firing: {
          reminder: wsReminder,
          occurrenceAt: wsReminder.lastFiredAt,
          firedAt: wsReminder.lastFiredAt,
          missed: false,
          nextDueAt: null,
        },
      },
    });

    // Flush the micro-task queue so the async writeFile inside savePersistedState
    // has a chance to be called.
    await Promise.resolve();
    await Promise.resolve();

    // The notification must have been shown.
    expect(Notification).toHaveBeenCalledTimes(1);

    // savePersistedState must have been called with a timestamp >= beforeFire,
    // writing the delivery time to disk so the next startup's catch-up window
    // starts no earlier than this delivery.
    expect(fsMock.writeFile).toHaveBeenCalled();
    const writeArgs = fsMock.writeFile.mock.calls[fsMock.writeFile.mock.calls.length - 1]!;
    const written = JSON.parse(writeArgs[1] as string) as { lastRunAt: number };
    expect(written.lastRunAt).toBeGreaterThanOrEqual(beforeFire);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Helper: wait until the 2nd before-quit listener is registered (connect mode
// startup is complete — no embedded server, so only 2 handlers are added).
// ──────────────────────────────────────────────────────────────────────────────
function connectModeReady(): Promise<void> {
  return new Promise<void>((resolve) => {
    electron.app.on('newListener', (event: string) => {
      if (event === 'before-quit' && electron.app.listenerCount(event) === 1) resolve();
    });
  });
}

describe('desktop connect mode', () => {
  async function enterConnectMode(mode: Record<string, unknown> = { kind: 'remote' }): Promise<void> {
    fsMock.readFile.mockImplementation((p: string) => {
      if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify(mode));
      return Promise.reject(ENOENT);
    });
    const ready = connectModeReady();
    await import('./main.js');
    await ready;
  }

  function ipcHandler(channel: string) {
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
    expect(handler, `${channel} must be registered`).toBeTypeOf('function');
    return handler!;
  }

  function savedMode() {
    const write = fsMock.writeFile.mock.calls.find(([p]) => p.endsWith('startup-mode.json'));
    expect(write, 'startup-mode.json must be written').toBeDefined();
    return JSON.parse(write![1]);
  }

  const appEvent = { senderFrame: { url: 'app://neo/index.html' } } as Electron.IpcMainInvokeEvent;
  const route = {
    serverId: 's1', publicKey: 'p1', lan: ['192.168.1.10:7777'], relay: 'wss://relay.example',
  };

  it('neo:getMode reports only the remote address after saveMode pairs a NEO', async () => {
    await enterConnectMode();
    await ipcHandler('neo:saveMode')(appEvent, {
      kind: 'remote', serverUrl: 'https://neo.example', token: 'private-token', tunnel: route,
    });
    await expect(ipcHandler('neo:getMode')(appEvent)).resolves.toStrictEqual({
      kind: 'remote', serverUrl: 'https://neo.example',
    });
  });

  it('neo:getMode reports an unpaired remote mode without a serverUrl', async () => {
    await enterConnectMode({ kind: 'remote' });
    await expect(ipcHandler('neo:getMode')(appEvent)).resolves.toStrictEqual({ kind: 'remote' });
  });

  it('neo:getMode reports the saved remote address on startup without exposing credentials', async () => {
    await enterConnectMode({ kind: 'remote', serverUrl: 'https://saved.example', token: 'private-token', tunnel: route });
    await expect(ipcHandler('neo:getMode')(appEvent)).resolves.toStrictEqual({
      kind: 'remote', serverUrl: 'https://saved.example',
    });
  });

  it('checks for updates exactly once on packaged connect-mode startup with saved credentials', async () => {
    const { default: { autoUpdater } } = await import('electron-updater');
    electron.app.isPackaged = true;
    vi.mocked(autoUpdater.checkForUpdatesAndNotify).mockResolvedValueOnce(null);

    await enterConnectMode({ kind: 'remote', serverUrl: 'https://saved.example', token: 'private-token' });

    expect(autoUpdater.on).toHaveBeenCalledTimes(1);
    expect(autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
  });

  it('neo:switchMode persists local mode then relaunches and quits from connect mode', async () => {
    await enterConnectMode({ kind: 'remote', serverUrl: 'https://neo.example', token: 'private-token' });
    await ipcHandler('neo:switchMode')(appEvent, 'local');
    expect(fsMock.writeFile).toHaveBeenCalledExactlyOnceWith(
      '/neo-test/startup-mode.json', JSON.stringify('local'), 'utf8',
    );
    expect(electron.app.relaunch).toHaveBeenCalledExactlyOnceWith();
    expect(electron.app.quit).toHaveBeenCalledExactlyOnceWith();
    expect(fsMock.writeFile.mock.invocationCallOrder[0]).toBeLessThan(electron.app.relaunch.mock.invocationCallOrder[0]!);
    expect(electron.app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(electron.app.quit.mock.invocationCallOrder[0]!);
  });

  it('neo:switchMode clears saved remote credentials when connecting to a different NEO', async () => {
    await enterConnectMode({ kind: 'remote', serverUrl: 'https://old.example', token: 'old-token', tunnel: route });
    await ipcHandler('neo:switchMode')(appEvent, 'remote');
    expect(fsMock.writeFile).toHaveBeenCalledExactlyOnceWith(
      '/neo-test/startup-mode.json', JSON.stringify({ kind: 'remote' }), 'utf8',
    );
    expect(electron.app.relaunch).toHaveBeenCalledExactlyOnceWith();
    expect(electron.app.quit).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['neo:getMode', 'neo:switchMode'])('%s rejects unauthorized senders in connect mode', async (channel) => {
    await enterConnectMode();
    const handler = ipcHandler(channel);
    for (const url of ['file:///evil', 'https://evil.example', 'app://evil/index.html']) {
      await expect(handler({ senderFrame: { url } } as Electron.IpcMainInvokeEvent, 'local')).rejects.toThrow('Unauthorized sender');
    }
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(electron.app.relaunch).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it('registers the privileged app scheme before readiness and serves the bundled renderer at app://neo', async () => {
    const index = Buffer.from('<!doctype html><title>NEO</title>');
    const asset = Buffer.from('console.log("NEO");');
    fsMock.readFile.mockImplementation((p: string) => {
      if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify({ kind: 'remote' }));
      if (p === '/neo-test/apps/web/dist/index.html') return Promise.resolve(index);
      if (p === '/neo-test/apps/web/dist/assets/foo.js') return Promise.resolve(asset);
      if (p === '/neo-test/apps/web/dist/assets/data.unknown') return Promise.resolve(Buffer.from([0, 255]));
      return Promise.reject(ENOENT);
    });
    // Hold readiness unresolved: scheme privileges must already be registered.
    let releaseReady!: () => void;
    electron.app.whenReady.mockReturnValueOnce(new Promise<void>((resolve) => { releaseReady = resolve; }));
    const ready = connectModeReady();
    await import('./main.js');
    try {
      expect.soft(protocolMock.registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([
        { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
      ]);
      expect.soft(protocolMock.handle).not.toHaveBeenCalled();
    } finally {
      releaseReady();
      await ready;
    }
    expect(protocolMock.registerSchemesAsPrivileged.mock.invocationCallOrder[0]).toBeLessThan(
      electron.app.whenReady.mock.invocationCallOrder[0]!,
    );
    expect(protocolMock.handle).toHaveBeenCalledExactlyOnceWith('app', expect.any(Function));
    const handler = protocolMock.handle.mock.calls[0]![1];
    const win = electron.BrowserWindow.mock.results[0]!.value;
    expect(win.loadURL).toHaveBeenCalledWith('app://neo/index.html');
    for (const url of ['app://neo/', 'app://neo/index.html']) {
      const response = await handler(new Request(url));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(index);
      expect(response.headers.get('Content-Type')).toBe('text/html');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
    }
    const response = await handler(new Request('app://neo/assets/foo.js'));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(asset);
    expect(response.headers.get('Content-Type')).toBe('text/javascript');
    const unknown = await handler(new Request('app://neo/assets/data.unknown'));
    expect(unknown.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(Buffer.from(await unknown.arrayBuffer())).toEqual(Buffer.from([0, 255]));

    // Invalid requests must not read arbitrary files, even a sibling with the same prefix.
    fsMock.readFile.mockClear();
    for (const url of [
      'app://evil/index.html', 'app://neo:123/index.html',
      'app://neo/..%2fetc%2fpasswd', 'app://neo/..%2fdist-private%2fsecret',
      'app://neo/%E0%A4%A',
    ]) {
      const invalid = await handler(new Request(url));
      expect(invalid.status, url).not.toBe(200);
    }
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect((await handler(new Request('app://neo/assets/missing.js'))).status).toBe(404);
    // Reopening a closed window reuses the URL without registering the protocol again.
    win.emit('closed');
    electron.app.emit('activate');
    expect(electron.BrowserWindow.mock.results[1]!.value.loadURL).toHaveBeenCalledWith('app://neo/index.html');
    expect(protocolMock.handle).toHaveBeenCalledTimes(1);
  });

  it('persists the tunnel route and uses its transport for notification requests', async () => {
    await enterConnectMode();
    await ipcHandler('neo:saveMode')(appEvent, {
      kind: 'remote', serverUrl: 'https://relay.example', token: 'tok', tunnel: route,
    });
    expect(savedMode()).toEqual({
      kind: 'remote', serverUrl: 'https://relay.example', token: 'tok', tunnel: route,
    });
    expect(tunnelMock.createTunnelTransport).toHaveBeenCalledExactlyOnceWith({ route });
    const transport = tunnelMock.createTunnelTransport.mock.results[0]!.value;
    expect(NeoClient).toHaveBeenCalledExactlyOnceWith({
      baseUrl: transport.baseUrl, token: 'tok', fetch: transport.fetch, WebSocket: transport.WebSocket,
    });
    expect(tunnelMock.createTunnelTransport.mock.calls[0]![0]).toEqual({ route });
    const passedRoute = (tunnelMock.createTunnelTransport.mock.calls[0]![0] as { route: typeof route }).route;
    expect(passedRoute).not.toBe(route);
    expect(passedRoute.lan).not.toBe(route.lan);
  });

  it('restarts notification delivery through the persisted tunnel route', async () => {
    await enterConnectMode({
      kind: 'remote', serverUrl: 'https://relay.example', token: 'tok', tunnel: route,
    });
    expect(tunnelMock.createTunnelTransport).toHaveBeenCalledExactlyOnceWith({ route });
    const transport = tunnelMock.createTunnelTransport.mock.results[0]!.value;
    expect(NeoClient).toHaveBeenCalledExactlyOnceWith({
      baseUrl: transport.baseUrl, token: 'tok', fetch: transport.fetch, WebSocket: transport.WebSocket,
    });
    electron.app.emit('before-quit');
    expect(clientMock.connectionCloses[0]).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it.each(['null', 'missing'] as const)('persists tunnel: null and uses a plain client when tunnel is %s', async (value) => {
    await enterConnectMode();
    await ipcHandler('neo:saveMode')(appEvent, {
      kind: 'remote', serverUrl: 'https://neo.example', token: 'tok',
      ...(value === 'null' ? { tunnel: null } : {}),
    });
    expect(savedMode()).toEqual({ kind: 'remote', serverUrl: 'https://neo.example', token: 'tok', tunnel: null });
    expect(NeoClient).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'https://neo.example', token: 'tok' });
    expect(tunnelMock.createTunnelTransport).not.toHaveBeenCalled();
  });

  it('normalizes a missing tunnel relay to null before saving and creating the transport', async () => {
    await enterConnectMode();
    const { relay: _relay, ...withoutRelay } = route;
    await ipcHandler('neo:saveMode')(appEvent, {
      kind: 'remote', serverUrl: 'https://relay.example', token: 'tok', tunnel: withoutRelay,
    });
    expect(savedMode().tunnel).toEqual({ ...withoutRelay, relay: null });
    expect(tunnelMock.createTunnelTransport).toHaveBeenCalledExactlyOnceWith({ route: { ...withoutRelay, relay: null } });
  });

  it.each([
    ['missing publicKey', { serverId: 's1' }],
    ['non-string serverId', { ...route, serverId: 1 }],
    ['non-string publicKey', { ...route, publicKey: 1 }],
    ['non-array lan', { ...route, lan: '192.168.1.10:7777' }],
    ['non-string lan entry', { ...route, lan: [1] }],
    ['invalid relay', { ...route, relay: 1 }],
    ['primitive tunnel', 'relay'],
    ['array tunnel', []],
  ])('rejects the entire save for a tunnel with %s', async (_name, tunnel) => {
    await enterConnectMode();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await ipcHandler('neo:saveMode')(appEvent, {
      kind: 'remote', serverUrl: 'https://neo.example', token: 'tok', tunnel,
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(NeoClient).not.toHaveBeenCalled();
    expect(tunnelMock.createTunnelTransport).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it.each(['token', 'serverUrl', 'tunnel'] as const)('re-pairing with a changed %s closes the old listener before replacement and is idempotent', async (field) => {
    await enterConnectMode();
    const save = ipcHandler('neo:saveMode');
    const initial = { kind: 'remote', serverUrl: 'https://relay.example', token: 'old', tunnel: route };
    await save(appEvent, initial);
    const firstClose = clientMock.connectionCloses[0]!;
    const firstTransport = tunnelMock.createTunnelTransport.mock.results[0]?.value;
    const changed = {
      ...initial,
      ...(field === 'token' ? { token: 'rotated' } : {}),
      ...(field === 'serverUrl' ? { serverUrl: 'https://other.example' } : {}),
      ...(field === 'tunnel' ? { tunnel: { ...route, publicKey: 'rotated-key' } } : {}),
    };
    await save(appEvent, changed);
    expect(NeoClient).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(firstTransport!.close).toHaveBeenCalledTimes(1);
    expect(firstClose.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(NeoClient).mock.invocationCallOrder[1]!);
    expect(firstTransport!.close.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(NeoClient).mock.invocationCallOrder[1]!);
    // Equivalent values with different object identity and property order are unchanged.
    await save(appEvent, {
      ...changed, tunnel: { relay: changed.tunnel.relay, lan: [...changed.tunnel.lan], publicKey: changed.tunnel.publicKey, serverId: changed.tunnel.serverId },
    });
    expect(NeoClient).toHaveBeenCalledTimes(2);
    expect(tunnelMock.createTunnelTransport).toHaveBeenCalledTimes(2);
    expect(clientMock.connectionCloses[1]).not.toHaveBeenCalled();
    electron.app.emit('before-quit');
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(clientMock.connectionCloses[1]).toHaveBeenCalledTimes(1);
    expect(tunnelMock.createTunnelTransport.mock.results[1]!.value.close).toHaveBeenCalledTimes(1);
  });

  it('re-pairing plain credentials closes the old stream and replaces its token', async () => {
    await enterConnectMode();
    const save = ipcHandler('neo:saveMode');
    await save(appEvent, { kind: 'remote', serverUrl: 'https://neo.example', token: 'old' });
    const firstClose = clientMock.connectionCloses[0]!;
    await save(appEvent, { kind: 'remote', serverUrl: 'https://neo.example', token: 'new', tunnel: null });
    expect(NeoClient).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(firstClose.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(NeoClient).mock.invocationCallOrder[1]!);
    expect(NeoClient).toHaveBeenLastCalledWith({ baseUrl: 'https://neo.example', token: 'new' });
    expect(tunnelMock.createTunnelTransport).not.toHaveBeenCalled();
    await save(appEvent, { kind: 'remote', serverUrl: 'https://neo.example', token: 'new' });
    expect(NeoClient).toHaveBeenCalledTimes(2);
  });

  it('accepts app://neo senders and rejects file and foreign HTTP senders for connect IPC', async () => {
    await enterConnectMode({ kind: 'remote', serverUrl: 'https://neo.example', token: 'tok' });
    const getConfig = ipcHandler('neo:getConfig');
    await expect(getConfig(appEvent)).resolves.toEqual({ serverUrl: 'https://neo.example', token: 'tok' });
    for (const url of ['file:///tmp/evil.html', 'http://evil.example/']) {
      const event = { senderFrame: { url } } as Electron.IpcMainInvokeEvent;
      await expect(getConfig(event)).rejects.toThrow('Unauthorized sender');
    }
    const openExternal = ipcHandler('neo:openExternal');
    openExternal(appEvent, 'https://neo.example/help');
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('https://neo.example/help');
    for (const url of ['file:///tmp/evil.html', 'http://evil.example/']) {
      const event = { senderFrame: { url } } as Electron.IpcMainInvokeEvent;
      expect(() => openExternal(event, 'https://neo.example/help')).toThrow('Unauthorized sender');
    }
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it('shows a dialog on first launch and enters connect mode when the user chooses "Connect to a NEO"', async () => {
    // First launch: no startup-mode.json on disk.
    fsMock.readFile.mockRejectedValue(ENOENT);
    // User picks "Connect to a NEO" (response === 1).
    dialogMock.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });

    const ready = connectModeReady();
    await import('./main.js');
    await ready;

    // Must not have started the embedded server.
    expect(startServer).not.toHaveBeenCalled();
    // Dialog must have appeared once.
    expect(dialogMock.showMessageBox).toHaveBeenCalledTimes(1);
    // The bundled renderer uses the server's allowed app://neo origin.
    const win = electron.BrowserWindow.mock.results[0]?.value;
    expect(win?.loadURL).toHaveBeenCalledWith('app://neo/index.html');
    // The chosen mode must be persisted.
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('startup-mode.json'),
      JSON.stringify({ kind: 'remote' }),
      'utf8',
    );
  });

  it('shows no dialog and enters connect mode when startup-mode.json holds remote credentials', async () => {
    const remoteMode = { kind: 'remote', serverUrl: 'https://neo.example.com', token: 'tok123' };
    fsMock.readFile.mockImplementation((p: string) => {
      if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify(remoteMode));
      return Promise.reject(ENOENT);
    });

    const ready = connectModeReady();
    await import('./main.js');
    await ready;

    expect(startServer).not.toHaveBeenCalled();
    expect(dialogMock.showMessageBox).not.toHaveBeenCalled();
    const win = electron.BrowserWindow.mock.results[0]?.value;
    expect(win?.loadURL).toHaveBeenCalledWith('app://neo/index.html');
    // Notification listener started with stored credentials (NeoClient.connect was called).
    expect(clientMock.onStatus).not.toBeNull();
  });

  it('neo:getConfig throws in connect mode before saveMode is called', async () => {
    fsMock.readFile.mockImplementation((p: string) => {
      if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify({ kind: 'remote' }));
      return Promise.reject(ENOENT);
    });

    const ready = connectModeReady();
    await import('./main.js');
    await ready;

    const handler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([ch]) => ch === 'neo:getConfig',
    )?.[1];
    expect(handler).toBeTypeOf('function');
    // Should reject — no credentials yet.
    await expect(handler!({} as Electron.IpcMainInvokeEvent)).rejects.toThrow();
  });

  it('neo:saveMode persists credentials and starts the notification listener', async () => {
    fsMock.readFile.mockImplementation((p: string) => {
      if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify({ kind: 'remote' }));
      return Promise.reject(ENOENT);
    });

    const ready = connectModeReady();
    await import('./main.js');
    await ready;

    // Before saveMode: notification listener not active.
    expect(clientMock.onStatus).toBeNull();

    const saveModeHandler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([ch]) => ch === 'neo:saveMode',
    )?.[1];
    expect(saveModeHandler).toBeTypeOf('function');
    await saveModeHandler!({} as Electron.IpcMainInvokeEvent, {
      kind: 'remote',
      serverUrl: 'https://neo.example.com',
      token: 'tok456',
    });

    // Credentials must have been written to disk.
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('startup-mode.json'),
      JSON.stringify({ kind: 'remote', serverUrl: 'https://neo.example.com', token: 'tok456', tunnel: null }),
      'utf8',
    );
    // Notification listener must have been started.
    expect(clientMock.onStatus).not.toBeNull();
  });

  it('neo:getConfig returns credentials after saveMode is called', async () => {
    fsMock.readFile.mockImplementation((p: string) => {
      if (p.endsWith('startup-mode.json')) return Promise.resolve(JSON.stringify({ kind: 'remote' }));
      return Promise.reject(ENOENT);
    });

    const ready = connectModeReady();
    await import('./main.js');
    await ready;

    const saveModeHandler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([ch]) => ch === 'neo:saveMode',
    )?.[1];
    await saveModeHandler!({} as Electron.IpcMainInvokeEvent, {
      kind: 'remote',
      serverUrl: 'https://neo.example.com',
      token: 'tok789',
    });

    const getConfigHandler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([ch]) => ch === 'neo:getConfig',
    )?.[1];
    const result = await getConfigHandler!(appEvent);
    expect(result).toEqual({ serverUrl: 'https://neo.example.com', token: 'tok789' });
  });

  it('first launch: choosing "Run NEO on this Mac" uses local mode (existing behaviour)', async () => {
    // First launch: no startup-mode.json on disk.
    fsMock.readFile.mockRejectedValue(ENOENT);
    // User picks "Run NEO on this Mac" (response === 0).
    dialogMock.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    server.startServer.mockResolvedValueOnce({
      url: 'http://127.0.0.1:7790',
      ownerToken: 'local-tok',
      stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const localReady = new Promise<void>((resolve) => {
      electron.app.on('newListener', (event: string) => {
        if (event === 'before-quit' && electron.app.listenerCount(event) === 2) resolve();
      });
    });
    await import('./main.js');
    await localReady;

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(dialogMock.showMessageBox).toHaveBeenCalledTimes(1);
    // Saved 'local' to disk.
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('startup-mode.json'),
      JSON.stringify('local'),
      'utf8',
    );
    const win = electron.BrowserWindow.mock.results[0]?.value;
    expect(win?.loadURL).toHaveBeenCalledWith('http://127.0.0.1:7790');
  });
});
