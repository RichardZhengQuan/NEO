import { afterEach, describe, it, expect, vi } from 'vitest';
import { ipcMain, shell } from 'electron';
import { startServer } from '@neo/server';

// Mock node:fs/promises so catch-up state persistence doesn't touch disk.
const fsMock = vi.hoisted(() => ({
  readFile: vi.fn<(p: string, enc: string) => Promise<string>>().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn<(p: string, d: string, enc: string) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock('node:fs/promises', () => fsMock);

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

const clientMock = vi.hoisted(() => ({
  onStatus: null as ((status: string) => void) | null,
  onEvent: null as ((e: unknown) => void) | null,
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
    dialog: {},
    ipcMain: { handle: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    MenuItem: vi.fn(),
    Notification,
    nativeImage: { createFromBuffer: vi.fn(() => ({ setTemplateImage: vi.fn() })) },
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
        return { close: vi.fn() };
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
  clientMock.onStatus = null;
  // Reset fs mock to default (no persisted state).
  fsMock.readFile.mockRejectedValue(new Error('ENOENT'));
  fsMock.writeFile.mockResolvedValue(undefined);
  clientMock.onEvent = null;
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

  it('uses lastFiredAtFrom from persisted state to avoid duplicate on rapid restart', async () => {
    const firedAt = Date.now() - 5_000; // fired 5 s ago
    const lastRunAt = firedAt + 1_000;  // previous process completed catch-up 1 s after firing
    // Simulate persisted state from the previous process run.
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify({ lastRunAt }));

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

  it('persists catch-up window floor even when ElectronNotification.isSupported() is false', async () => {
    const overdueReminder = {
      id: 'r-unsupported-1',
      title: 'Check voicemail',
      notes: null,
      dueAt: Date.now() - 60 * 60 * 1000,
      status: 'fired',
      firedCount: 1,
      lastFiredAt: Date.now(),
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
    // isSupported() defaults to false in the mock — no spy override.
    // This simulates a machine where notifications are not supported.

    const beforeCatchup = Date.now();
    clientMock.onStatus?.('open');
    await flushCatchup();

    // No notification should have been shown (notifications unsupported).
    expect(Notification).not.toHaveBeenCalled();

    // savePersistedState must have been called despite isSupported() === false,
    // so the catch-up floor advances and stale reminders do not re-fire if
    // notification support is later granted.
    expect(fsMock.writeFile).toHaveBeenCalled();
    const writeArgs = fsMock.writeFile.mock.calls[fsMock.writeFile.mock.calls.length - 1]!;
    const written = JSON.parse(writeArgs[1] as string) as { lastRunAt: number };
    expect(written.lastRunAt).toBeGreaterThanOrEqual(beforeCatchup);
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
