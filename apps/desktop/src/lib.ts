/**
 * Pure helpers for the Electron main process (no Electron imports).
 * Kept separate so they can be fully tested with vitest without mocking Electron.
 */
import { deflateSync } from 'node:zlib';
import * as path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Notification, ReminderFiring, TunnelRoute } from '@neo/protocol';

// ───────────────────────────── web directory ─────────────────────────────

/**
 * Resolve the directory that contains the built web app.
 *
 * Dev (not packed): the web build lives at `<appPath>/../web/dist`
 * (i.e. `apps/web/dist` in the monorepo).
 *
 * Packaged: electron-builder copies it into `<resourcesPath>/web`.
 */
export function resolveWebDir(appPath: string, resourcesPath: string, isPacked: boolean): string {
  if (isPacked) {
    return path.join(resourcesPath, 'web');
  }
  // In development appPath is the repository root (or apps/desktop depending on
  // how electron is launched); resolve relative to the monorepo apps directory.
  return path.join(appPath, '..', 'web', 'dist');
}

// ───────────────────────────── URL safety ─────────────────────────────

/**
 * Only http, https, mailto, and tel URLs may be opened by an external handler.
 * Blocks javascript:, file:, neo:// (handled internally), and everything else.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'mailto:' ||
      parsed.protocol === 'tel:'
    );
  } catch {
    return false;
  }
}

/**
 * Returns true when the given URL is part of the same origin as the server
 * (so the renderer is allowed to navigate there without triggering the external
 * browser policy).
 */
export function isSameOrigin(url: string, serverUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(serverUrl);
    return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
  } catch {
    return false;
  }
}

// ───────────────────────────── notification text ─────────────────────────

/**
 * Format the OS notification title + body for a fired reminder, following the
 * server's notifier spec (IMPLEMENTATION_PLAN.md, WP-server).
 */
export function formatReminderNotification(firing: ReminderFiring): {
  title: string;
  body: string;
  deepLink: string;
} {
  const { reminder, missed } = firing;
  const deepLink = reminder.messageId
    ? `neo://timeline/${encodeURIComponent(reminder.messageId)}`
    : `neo://reminders/${reminder.id}`;

  if (missed) {
    return {
      title: 'Missed reminder',
      body: `Missed while you were away: ${reminder.title}`,
      deepLink,
    };
  }

  return {
    title: reminder.title,
    body: reminder.notes ?? "It's time",
    deepLink,
  };
}

/**
 * Format an OS notification for a `notification.created` event of kind `system`.
 * Returns null for non-system notifications (reminders are handled separately
 * via `formatReminderNotification`).
 */
export function formatSystemNotification(notification: Notification): { title: string; body: string } | null {
  if (notification.kind !== 'system') return null;
  return { title: notification.title, body: notification.body };
}

// ───────────────────────────── deep links ─────────────────────────────

/**
 * Map a `neo://` deep-link URL to a hash-based route understood by the web app.
 * Returns `#/` for unrecognised inputs.
 *
 * Examples:
 *   neo://reminders/rem_abc → #/reminders/rem_abc
 *   neo://chat/con_xyz      → #/chat/con_xyz
 */
export function deepLinkToHash(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'neo:') return '#/';
    const host = parsed.hostname;
    // The URL path (after host) without leading slash
    const id = parsed.pathname.replace(/^\//, '') || '';
    switch (host) {
      case 'reminders': return id ? `#/reminders/${id}` : '#/reminders';
      case 'tasks':     return id ? `#/tasks/${id}`     : '#/tasks';
      case 'notes':     return id ? `#/notes/${id}`     : '#/notes';
      case 'memory':    return id ? `#/memory/${id}`    : '#/memory';
      case 'timeline': {
        const messageId = parsed.searchParams.get('messageId') ?? id;
        return messageId ? `#/timeline?messageId=${encodeURIComponent(messageId)}` : '#/timeline';
      }
      case 'chat':      return id ? `#/chat/${id}`      : '#/chat';
      default:          return '#/';
    }
  } catch {
    return '#/';
  }
}

// ───────────────────────────── tray icon ─────────────────────────────

// CRC32 lookup table (standard polynomial 0xedb88320)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Create a minimal 16×16 RGBA PNG icon (black circle on transparent background)
 * suitable for the Electron tray.  On macOS, mark the resulting NativeImage as
 * a template image so it adapts to light/dark mode.
 */
export function createTrayIconPng(): Buffer {
  const W = 16, H = 16;
  const r2 = 6 * 6; // radius 6 pixels

  // Each scanline: 1 filter byte + W*4 RGBA bytes
  const raw = Buffer.alloc((1 + W * 4) * H);
  for (let y = 0; y < H; y++) {
    const rowBase = y * (1 + W * 4);
    raw[rowBase] = 0; // filter = None
    for (let x = 0; x < W; x++) {
      const cx = x - 7.5, cy = y - 7.5;
      const inCircle = cx * cx + cy * cy <= r2;
      const off = rowBase + 1 + x * 4;
      raw[off]     = 0;              // R
      raw[off + 1] = 0;              // G
      raw[off + 2] = 0;              // B
      raw[off + 3] = inCircle ? 220 : 0; // A
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const compressed = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ───────────────────────────── startup mode ─────────────────────────────

export interface RemoteMode {
  kind: 'remote';
  serverUrl?: string;
  token?: string;
  tunnel?: TunnelRoute | null;
}

export type StartupMode = 'local' | RemoteMode;

export function parseStartupMode(raw: string): StartupMode | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (data === 'local') return 'local';
    if (data !== null && typeof data === 'object' && (data as Record<string, unknown>).kind === 'remote') {
      const d = data as Partial<RemoteMode>;
      const result: RemoteMode = { kind: 'remote' };
      if (typeof d.serverUrl === 'string') result.serverUrl = d.serverUrl;
      if (typeof d.token === 'string') result.token = d.token;
      if (d.tunnel !== undefined) result.tunnel = d.tunnel as TunnelRoute | null;
      return result;
    }
    return null;
  } catch { return null; }
}

export async function loadStartupMode(userData: string): Promise<StartupMode | null> {
  try {
    const raw = await readFile(path.join(userData, 'startup-mode.json'), 'utf8');
    return parseStartupMode(raw);
  } catch { return null; }
}

export async function saveStartupMode(userData: string, mode: StartupMode): Promise<void> {
  await writeFile(path.join(userData, 'startup-mode.json'), JSON.stringify(mode), 'utf8');
}

// ───────────────────────────── first-launch dialog i18n ─────────────────────────────

/**
 * Strings shown in the first-launch "Run NEO on this Mac or Connect to a NEO"
 * native dialog. The dialog runs before the renderer loads, so the web app's
 * i18n system is not available — we pick a built-in locale table here.
 *
 * Supported locales mirror apps/web/src/i18n.ts (en + zh-CN).
 */
export interface FirstLaunchDialogStrings {
  message: string;
  runLocal: string;
  connectRemote: string;
}

const FIRST_LAUNCH_STRINGS: Record<'en' | 'zh-CN', FirstLaunchDialogStrings> = {
  'en': {
    message: 'How would you like to use NEO?',
    runLocal: 'Run NEO on this Mac',
    connectRemote: 'Connect to a NEO',
  },
  'zh-CN': {
    message: '你想如何使用 NEO？',
    runLocal: '在这台 Mac 上运行 NEO',
    connectRemote: '连接到一个 NEO',
  },
};

/**
 * Pick the first-launch dialog strings for the given locale. Falls back to en
 * for any unsupported locale (including empty / unknown). zh / zh-Hans / zh-Hans-CN
 * also map to zh-CN; other zh variants (zh-TW, zh-HK) fall back to en until
 * their translations are added.
 */
export function pickFirstLaunchStrings(locale: string): FirstLaunchDialogStrings {
  const normalized = locale.toLowerCase();
  if (normalized === 'zh-cn' || normalized === 'zh' || normalized === 'zh-hans' || normalized.startsWith('zh-hans')) {
    return FIRST_LAUNCH_STRINGS['zh-CN'];
  }
  return FIRST_LAUNCH_STRINGS['en'];
}
