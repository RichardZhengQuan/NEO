/**
 * Electron main process — on-device mode.
 *
 * Starts the NEO server on a random localhost port, then shows the web UI
 * inside a secure BrowserWindow.  Notifications, tray and login-item settings
 * are managed here so they work even when the window is hidden.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  Notification as ElectronNotification,
  nativeImage,
  protocol,
  shell,
  Tray,
} from 'electron';
import electronUpdater from 'electron-updater';
import { loadConfig, startServer } from '@neo/server';
import { NeoClient } from '@neo/client';
import type { ConnectionStatus, EventEnvelope } from '@neo/client';
import { createTunnelTransport, type TunnelTransport } from '@neo/tunnel';
import {
  createTrayIconPng,
  deepLinkToHash,
  formatReminderNotification,
  formatSystemNotification,
  isSafeExternalUrl,
  isSameOrigin,
  loadStartupMode,
  nextStartupModeForSwitch,
  pickFirstLaunchStrings,
  resolveWebDir,
  saveStartupMode,
  type DesktopMode,
  type RemoteMode,
} from './lib.js';
import {
  attachUpdaterErrorHandler,
  checkForUpdatesOnReady,
  createCheckForUpdatesHandler,
} from './updater.js';
import type { NeoServer } from '@neo/server';
import type { ServerEvent, TunnelRoute } from '@neo/protocol';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const { autoUpdater } = electronUpdater;

// ESM polyfill for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────────────────────────── single instance ─────────────────────────────

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  // Another instance is already running; quit this one.
  app.quit();
  process.exit(0);
}

// ───────────────────────────── state ─────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let neoServer: NeoServer | null = null;
let isQuitting = false;
let shutdownPromise: Promise<void> | null = null;
let shutdownDone = false;
/** URL of the web build's index.html; app:// in connect mode, http:// in local mode. */
let currentWebFileUrl: string | null = null;
let appProtocolRegistered = false;
/** In connect mode: true once the OS-notification listener has been started. */
let notifListenerActive = false;
let currentNotifConnection: { close: () => void } | null = null;
let currentNotifTransport: TunnelTransport | null = null;
let notifCleanupRegistered = false;
/** In connect mode: the credentials remembered after saveMode is called. */
let connectCredentials: { serverUrl: string; token: string; tunnel: TunnelRoute | null } | null = null;
/**
 * A neo://pair?... URL that arrived via open-url before the window was ready.
 * Delivered to the renderer once it is created.
 */
let pendingPairUrl: string | null = null;

// ───────────────────────────── web directory ─────────────────────────────

function getWebDir(): string {
  return resolveWebDir(app.getAppPath(), process.resourcesPath ?? '', app.isPackaged);
}

function registerAppProtocol(webDir: string): void {
  if (appProtocolRegistered) return;
  const webRoot = path.resolve(webDir);
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
    '.webmanifest': 'application/manifest+json',
  };
  protocol.handle('app', async (req) => {
    let filePath: string;
    try {
      const url = new URL(req.url);
      if (url.protocol !== 'app:' || url.host !== 'neo') {
        return new Response('Forbidden', { status: 403 });
      }
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      filePath = path.resolve(webRoot, relativePath);
      if (!filePath.startsWith(webRoot + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    try {
      const data = await readFile(filePath);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  appProtocolRegistered = true;
}

// ───────────────────────────── missing web build ─────────────────────────────

function showMissingWebBuildWindow(): void {
  const win = new BrowserWindow({
    width: 640,
    height: 360,
    resizable: false,
    show: false,
    title: 'NEO — build required',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEO — build required</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
    background:#1a1a1a;color:#fff;flex-direction:column;gap:1rem}
  h1{margin:0;font-size:1.4rem}p{margin:0;color:#999;font-size:.9rem}
  code{background:#2a2a2a;padding:.2em .4em;border-radius:4px;font-size:.85rem}
</style>
</head>
<body>
  <h1>Web build not found</h1>
  <p>Run <code>pnpm --filter @neo/web build</code> first, then restart NEO.</p>
</body>
</html>`;

  win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  win.once('ready-to-show', () => win.show());
  win.on('close', () => app.quit());
}

// ───────────────────────────── browser window ─────────────────────────────

function createWindow(serverUrl: string): void {
  const preload = path.join(__dirname, 'preload.cjs');
  const isDarwin = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 380,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a1a',
    titleBarStyle: isDarwin ? 'hiddenInset' : 'default',
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Show only when the renderer signals it is ready to avoid a flash of blank white.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
    // Deliver any pairing link that arrived before the window existed.
    if (pendingPairUrl) {
      mainWindow?.webContents.send('neo:pairLink', pendingPairUrl);
      pendingPairUrl = null;
    }
  });

  // Block or redirect navigation events.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url, serverUrl)) return; // allow internal navigation
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  // Intercept window.open() calls.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Hiding the window (X button on macOS) keeps reminders firing in the tray.
  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(serverUrl);
}

/** Restore the existing window, or reopen the renderer for the active mode. */
function restoreMainWindow(): void {
  if (isQuitting) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const url = neoServer?.url ?? currentWebFileUrl;
  if (url) {
    createWindow(url);
  } else if (process.platform === 'darwin') {
    // The native first-launch choice can still be awaiting the user's answer.
    app.focus({ steal: true });
  }
}

// ───────────────────────────── tray ─────────────────────────────

function buildTrayMenu(): Menu {
  const openItem = new MenuItem({
    label: 'Open NEO',
    click: restoreMainWindow,
  });

  const loginItem = new MenuItem({
    label: 'Launch at login',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click(item) {
      app.setLoginItemSettings({ openAtLogin: item.checked });
    },
  });

  const quitItem = new MenuItem({
    label: 'Quit NEO',
    accelerator: 'CmdOrCtrl+Q',
    click() {
      isQuitting = true;
      app.quit();
    },
  });

  return Menu.buildFromTemplate([
    openItem,
    { type: 'separator' },
    loginItem,
    { type: 'separator' },
    quitItem,
  ]);
}

function createTray(): void {
  if (tray) return;
  const iconBuf = createTrayIconPng();
  const iconImage = nativeImage.createFromBuffer(iconBuf);
  if (process.platform === 'darwin') {
    iconImage.setTemplateImage(true);
  }

  tray = new Tray(iconImage);
  tray.setToolTip('NEO');
  if (process.platform === 'darwin') tray.setTitle('NEO');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', restoreMainWindow);
}

// ───────────────────────────── app menu ─────────────────────────────

function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit NEO',
          accelerator: 'Cmd+Q',
          click() {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    });
  }

  template.push(
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for updates…',
          click: createCheckForUpdatesHandler({
            autoUpdater,
            // Narrow Electron's overloaded showMessageBox (the `(window, opts)`
            // overload would otherwise widen DialogLike away from a one-arg call).
            dialog: { showMessageBox: (opts) => dialog.showMessageBox(opts) },
          }),
        },
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}

// ───────────────────────────── IPC handlers ─────────────────────────────

function registerModeIpcHandlers(
  userData: string,
  getMode: () => DesktopMode,
  isAuthorized: (senderUrl: string) => boolean,
  lifecycle: Pick<typeof app, 'relaunch' | 'quit'>,
): void {
  const relaunch = lifecycle.relaunch.bind(lifecycle);
  const quit = lifecycle.quit.bind(lifecycle);

  ipcMain.handle('neo:getMode', async (event): Promise<DesktopMode> => {
    if (!isAuthorized(event.senderFrame?.url ?? '')) throw new Error('Unauthorized sender');
    return getMode();
  });

  ipcMain.handle('neo:switchMode', async (event, target: 'local' | 'remote') => {
    if (!isAuthorized(event.senderFrame?.url ?? '')) throw new Error('Unauthorized sender');
    const nextMode = nextStartupModeForSwitch(target);
    await saveStartupMode(userData, nextMode);
    relaunch();
    isQuitting = true;
    quit();
  });
}

/**
 * IPC handlers for connect mode (no embedded server).
 * Exposes neo:getConfig (throws until credentials are saved), neo:openExternal,
 * and neo:saveMode (persists credentials and starts the notification listener).
 */
function registerConnectIpcHandlers(userData: string, initialMode: RemoteMode): void {
  if (initialMode.serverUrl && initialMode.token) {
    connectCredentials = {
      serverUrl: initialMode.serverUrl,
      token: initialMode.token,
      tunnel: initialMode.tunnel ?? null,
    };
  }

  registerModeIpcHandlers(
    userData,
    () => connectCredentials
      ? { kind: 'remote', serverUrl: connectCredentials.serverUrl }
      : { kind: 'remote' },
    (senderUrl) => senderUrl.startsWith('app://neo/'),
    app,
  );

  ipcMain.handle('neo:getConfig', async (event) => {
    const senderUrl = event.senderFrame?.url ?? '';
    if (!senderUrl.startsWith('app://neo/')) {
      throw new Error('Unauthorized sender');
    }
    if (!connectCredentials) throw new Error('Not connected: no credentials saved yet');
    return { serverUrl: connectCredentials.serverUrl, token: connectCredentials.token };
  });

  ipcMain.handle('neo:openExternal', (event, url: unknown) => {
    const senderUrl = event.senderFrame?.url ?? '';
    if (!senderUrl.startsWith('app://neo/')) {
      throw new Error('Unauthorized sender');
    }
    if (typeof url !== 'string') return;
    if (!isSafeExternalUrl(url)) return;
    void shell.openExternal(url);
  });

  ipcMain.handle('neo:saveMode', (_event, mode: unknown) => {
    if (!mode || typeof mode !== 'object') return;
    const m = mode as Record<string, unknown>;
    if (m['kind'] !== 'remote' || typeof m['serverUrl'] !== 'string' || typeof m['token'] !== 'string') return;
    const serverUrl = m['serverUrl'];
    const token = m['token'];
    let tunnel: TunnelRoute | null = null;
    if (m['tunnel'] !== null && m['tunnel'] !== undefined) {
      const value = m['tunnel'];
      if (typeof value !== 'object' || Array.isArray(value)) {
        console.error('[NEO desktop] Refusing to save an invalid tunnel route');
        return;
      }
      const route = value as Record<string, unknown>;
      if (
        typeof route['serverId'] !== 'string' ||
        typeof route['publicKey'] !== 'string' ||
        !Array.isArray(route['lan']) ||
        !route['lan'].every((address: unknown) => typeof address === 'string') ||
        (route['relay'] !== undefined && route['relay'] !== null && typeof route['relay'] !== 'string')
      ) {
        console.error('[NEO desktop] Refusing to save an invalid tunnel route');
        return;
      }
      tunnel = {
        serverId: route['serverId'],
        publicKey: route['publicKey'],
        lan: [...route['lan']],
        relay: route['relay'] ?? null,
      };
    }
    const oldTunnel = connectCredentials?.tunnel ?? null;
    const sameTunnel = oldTunnel === null || tunnel === null
      ? oldTunnel === tunnel
      : oldTunnel.serverId === tunnel.serverId &&
        oldTunnel.publicKey === tunnel.publicKey &&
        (oldTunnel.relay ?? null) === tunnel.relay &&
        oldTunnel.lan.length === tunnel.lan.length &&
        oldTunnel.lan.every((address, index) => address === tunnel.lan[index]);
    if (
      connectCredentials?.serverUrl === serverUrl &&
      connectCredentials.token === token &&
      sameTunnel
    ) return;

    stopCurrentNotificationListener();
    notifListenerActive = false;
    connectCredentials = { serverUrl, token, tunnel };
    const saved: RemoteMode = { kind: 'remote', serverUrl, token, tunnel };
    void saveStartupMode(userData, saved).catch(() => {
      // Best-effort: if saving fails the credentials are still in memory.
    });
    if (!notifListenerActive) {
      notifListenerActive = true;
      startNotificationListener(serverUrl, token, tunnel);
    }
  });
}

function registerIpcHandlers(userData: string, serverUrl: string, ownerToken: string): void {
  registerModeIpcHandlers(
    userData,
    () => ({ kind: 'local' }),
    (senderUrl) => isSameOrigin(senderUrl, serverUrl),
    app,
  );

  ipcMain.handle('neo:getConfig', (event) => {
    // Validate that the request comes from our own renderer window.
    const senderUrl = event.senderFrame?.url ?? '';
    if (!isSameOrigin(senderUrl, serverUrl) && !senderUrl.startsWith('file://')) {
      throw new Error('Unauthorized sender');
    }
    return { serverUrl, token: ownerToken };
  });

  ipcMain.handle('neo:openExternal', (event, url: unknown) => {
    const senderUrl = event.senderFrame?.url ?? '';
    if (!isSameOrigin(senderUrl, serverUrl) && !senderUrl.startsWith('file://')) {
      throw new Error('Unauthorized sender');
    }
    if (typeof url !== 'string') return;
    if (!isSafeExternalUrl(url)) return;
    void shell.openExternal(url);
  });

  // In local mode, saveMode is a no-op: credentials are already baked in at
  // server start and there is no startup-mode.json to update.
  ipcMain.handle('neo:saveMode', () => undefined);
}

// ───────────────────────────── OS notifications ─────────────────────────────

function focusWindowAtHash(hash: string): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  if (hash && hash !== '#/') {
    // Navigate to the target route via hash change in the already-loaded page.
    void mainWindow.webContents.executeJavaScript(
      `window.location.hash = ${JSON.stringify(hash)}`,
    );
  }
}

function stopCurrentNotificationListener(): void {
  const connection = currentNotifConnection;
  const transport = currentNotifTransport;
  currentNotifConnection = null;
  currentNotifTransport = null;
  try {
    connection?.close();
  } finally {
    transport?.close();
  }
}

function registerNotificationCleanup(): void {
  if (notifCleanupRegistered) return;
  app.on('before-quit', stopCurrentNotificationListener);
  notifCleanupRegistered = true;
}

function startNotificationListener(
  serverUrl: string,
  ownerToken: string,
  tunnel: TunnelRoute | null,
): void {
  let client: NeoClient;
  if (tunnel) {
    const route = { ...tunnel, lan: [...tunnel.lan] };
    const transport = createTunnelTransport({ route });
    currentNotifTransport = transport;
    client = new NeoClient({
      baseUrl: transport.baseUrl,
      token: ownerToken,
      fetch: transport.fetch,
      WebSocket: transport.WebSocket,
    });
  } else {
    client = new NeoClient({ baseUrl: serverUrl, token: ownerToken });
  }

  // Record the time before connecting so we can detect reminders that fired
  // during the startup gap (after the scheduler tick but before the WS opens).
  // Use a generous lookback window because the scheduler fires reminders
  // synchronously inside startServer(), before this point is reached.
  const listenStartAt = Date.now();
  const STARTUP_CATCH_UP_WINDOW_MS = 60_000;
  // Track reminders already notified via WS events to avoid duplicates.
  const notifiedIds = new Set<string>();
  let catchupDone = false;

  // Persist the catch-up window start so a rapid restart does not re-show
  // reminders that were already delivered in the previous process.
  const catchupStateFile = path.join(app.getPath('userData'), 'reminder-catchup.json');
  let persistedLastRunAt = 0;
  // Best-effort: read the persisted last-run timestamp synchronously on
  // startup is not available, so we read it in the catch-up async block.
  const loadPersistedState = async (): Promise<number> => {
    try {
      const raw = await readFile(catchupStateFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'lastRunAt' in parsed && typeof (parsed as { lastRunAt: unknown }).lastRunAt === 'number') {
        return (parsed as { lastRunAt: number }).lastRunAt;
      }
    } catch {
      // File absent or unreadable — treat as first run.
    }
    return 0;
  };
  const savePersistedState = (lastRunAt: number): void => {
    writeFile(catchupStateFile, JSON.stringify({ lastRunAt }), 'utf8').catch(() => {
      // Non-fatal: persistence is best-effort.
    });
  };

  currentNotifConnection = client.connect({
    onEvent(envelope: EventEnvelope) {
      const event = envelope.event as ServerEvent;

      if (event.type === 'reminder.fired') {
        if (!ElectronNotification.isSupported()) return;
        notifiedIds.add(event.firing.reminder.id);
        // Persist the delivery time so a restart within the catch-up window
        // does not re-show this notification as a "Missed reminder".
        savePersistedState(Date.now());
        const { title, body, deepLink } = formatReminderNotification(event.firing);
        const notif = new ElectronNotification({ title, body });
        notif.on('click', () => focusWindowAtHash(deepLinkToHash(deepLink)));
        notif.show();
      }

      if (event.type === 'notification.created' && event.notification.kind === 'system') {
        if (!ElectronNotification.isSupported()) return;
        const formatted = formatSystemNotification(event.notification);
        if (!formatted) return;
        const notif = new ElectronNotification({ title: formatted.title, body: formatted.body });
        notif.show();
      }
    },
    onStatus(status: ConnectionStatus) {
      if (status === 'open' && !catchupDone) {
        catchupDone = true;
        // Catch up on reminders that fired during the startup gap (between the
        // scheduler's first tick and this WS connection becoming open).
        //
        // Use lastFiredAtFrom instead of status:'fired' so that:
        //   (a) recurring reminders (status='scheduled' after markFired) are included;
        //   (b) we only fetch reminders in the recent window, bypassing the 100-item
        //       default page size which would truncate heavy users' fired history.
        //
        // To avoid duplicates on rapid restart, floor the window at the persisted
        // last-run timestamp: reminders whose lastFiredAt predates the previous
        // catch-up were already delivered and must not be shown again.
        void (async () => {
          try {
            persistedLastRunAt = await loadPersistedState();
            // Use the more restrictive (later) of the two bounds so we never
            // re-notify reminders delivered in the previous process.
            const windowStart = Math.max(
              persistedLastRunAt,
              listenStartAt - STARTUP_CATCH_UP_WINDOW_MS,
            );
            const { items } = await client.reminders.list({ lastFiredAtFrom: windowStart });
            if (!ElectronNotification.isSupported()) {
              savePersistedState(Date.now());
              return;
            }
            for (const reminder of items) {
              if (
                reminder.lastFiredAt !== null &&
                !notifiedIds.has(reminder.id)
              ) {
                const firing = {
                  reminder,
                  occurrenceAt: reminder.lastFiredAt,
                  firedAt: reminder.lastFiredAt,
                  missed: true,
                  nextDueAt: null,
                };
                const { title, body, deepLink } = formatReminderNotification(firing);
                const notif = new ElectronNotification({ title, body });
                notif.on('click', () => focusWindowAtHash(deepLinkToHash(deepLink)));
                notif.show();
              }
            }
            // Record when this catch-up completed so subsequent startups can
            // use it as the floor of the next catch-up window.
            savePersistedState(Date.now());
          } catch {
            // Non-fatal: catch-up is best-effort.
          }
        })();
      }
      if (status === 'closed') {
        // Reconnect is handled internally by NeoClient; nothing to do here.
      }
    },
    reconnect: true,
  });

  // Close the current connection and its tunnel when the app quits.
  registerNotificationCleanup();
}

// ───────────────────────────── app lifecycle ─────────────────────────────

app.on('second-instance', restoreMainWindow);

// macOS: handle neo://pair?... deep links (the custom URL scheme must be
// registered in the app's Info.plist via electron-builder's protocols config).
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!url.startsWith('neo://pair')) return;
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('neo:pairLink', url);
  } else {
    // Window not yet created (app launched via the URL); queue for delivery.
    pendingPairUrl = url;
  }
});

// macOS: re-open and focus the window when clicking the Dock icon.
app.on('activate', restoreMainWindow);

app.on('window-all-closed', () => {
  // On non-macOS platforms, quit when all windows are closed.
  // On macOS the app stays alive (tray keeps running).
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

// ───────────────────────────── startup ─────────────────────────────

async function main(): Promise<void> {
  await app.whenReady();
  if (isQuitting) return;

  // Register neo:// so deep links work in dev builds. Packaged apps also
  // declare the scheme via electron-builder's protocols config in the Info.plist.
  app.setAsDefaultProtocolClient('neo');

  const userData = app.getPath('userData');
  const webDir = getWebDir();

  // The menu bar remains available in either mode and during the first choice.
  createTray();

  // ── Determine startup mode (first launch shows a dialog) ────────────────
  let mode = await loadStartupMode(userData);
  if (isQuitting) return;
  if (mode === null) {
    const strings = pickFirstLaunchStrings(app.getLocale());
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: [strings.runLocal, strings.connectRemote],
      message: strings.message,
      defaultId: 0,
      cancelId: 0,
    });
    if (isQuitting) return;
    mode = response === 0 ? 'local' : { kind: 'remote' };
    await saveStartupMode(userData, mode);
    if (isQuitting) return;
  }

  // ── Connect mode (no embedded server) ───────────────────────────────────
  if (mode !== 'local') {
    registerAppProtocol(webDir);
    currentWebFileUrl = 'app://neo/index.html';

    registerConnectIpcHandlers(userData, mode);
    Menu.setApplicationMenu(buildAppMenu());
    createWindow('app://neo/index.html');

    if (mode.serverUrl && mode.token && !notifListenerActive) {
      // Credentials are already saved — start the OS notification listener
      // immediately, using the encrypted transport when one was paired.
      notifListenerActive = true;
      startNotificationListener(mode.serverUrl, mode.token, mode.tunnel ?? null);
    } else {
      // Register cleanup before pairing, ready for the first saved connection.
      registerNotificationCleanup();
    }
    attachUpdaterErrorHandler({ autoUpdater });
    checkForUpdatesOnReady({ autoUpdater, isPackaged: app.isPackaged });
    return;
  }

  // ── Local (embedded server) mode ────────────────────────────────────────
  const dataDir = path.join(userData, 'data');

  const config = loadConfig({
    overrides: {
      mode: 'local',
      dataDir,
      server: {
        host: '127.0.0.1',
        port: 0, // OS picks a free port
        webDir,
      },
    },
  });

  // Start the embedded server.  It will fail gracefully below if the server
  // package is not yet built (CI: the desktop package builds before server).
  try {
    neoServer = await startServer(config);
  } catch (err) {
    if (isQuitting) return;
    console.error('[NEO desktop] Failed to start embedded server:', err);
    app.setName('NEO');
    showMissingWebBuildWindow();
    return;
  }

  if (isQuitting) {
    await neoServer.stop();
    return;
  }

  const { url: serverUrl, ownerToken } = neoServer;

  // Register IPC channels before creating the window.
  registerIpcHandlers(userData, serverUrl, ownerToken);

  // Set up the app menu.
  Menu.setApplicationMenu(buildAppMenu());

  // Open the main window.
  createWindow(serverUrl);
  attachUpdaterErrorHandler({ autoUpdater });
  checkForUpdatesOnReady({ autoUpdater, isPackaged: app.isPackaged });

  // Start listening for server events to show OS notifications.
  startNotificationListener(serverUrl, ownerToken, null);

  // Graceful shutdown: stop the server when the app quits.
  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    if (!shutdownPromise) {
      shutdownPromise = (neoServer?.stop() ?? Promise.resolve())
        .then(() => {
          shutdownDone = true;
          app.quit();
        })
        .catch((err: unknown) => {
          console.error('[NEO desktop] Error stopping server during quit:', err);
          shutdownDone = true;
          app.quit();
        });
    }
  });
}

main().catch((err: unknown) => {
  console.error('[NEO desktop] Unhandled startup error:', err);
  app.quit();
});
