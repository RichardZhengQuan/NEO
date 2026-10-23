import { describe, it, expect, vi } from 'vitest';
import type { ReminderFiring, Notification } from '@neo/protocol';
import {
  resolveWebDir,
  isSafeExternalUrl,
  isSameOrigin,
  formatReminderNotification,
  formatSystemNotification,
  deepLinkToHash,
  createTrayIconPng,
  parseStartupMode,
  loadStartupMode,
  saveStartupMode,
  pickFirstLaunchStrings,
} from './lib.js';

// ─────────────────────────── fs/promises mock ───────────────────────────

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn<(p: string, enc: string) => Promise<string>>().mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  ),
  writeFile: vi.fn<(p: string, d: string, enc: string) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock('node:fs/promises', () => fsMock);

// ───────────────────────────── resolveWebDir ─────────────────────────────

describe('resolveWebDir', () => {
  it('returns resourcesPath/web when packed', () => {
    const result = resolveWebDir('/app', '/resources', true);
    expect(result).toBe('/resources/web');
  });

  it('returns appPath/../web/dist in dev', () => {
    const result = resolveWebDir('/repo/apps/desktop', '', false);
    // path.join normalizes, result should end with web/dist under apps/
    expect(result).toContain('web');
    expect(result).toContain('dist');
    expect(result).not.toContain('resources');
  });
});

// ───────────────────────────── URL safety ─────────────────────────────

describe('isSafeExternalUrl', () => {
  it('accepts http URLs', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
  });

  it('accepts https URLs', () => {
    expect(isSafeExternalUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('accepts mailto: URLs', () => {
    expect(isSafeExternalUrl('mailto:alice@example.com')).toBe(true);
  });

  it('accepts tel: URLs', () => {
    expect(isSafeExternalUrl('tel:+15551234567')).toBe(true);
  });

  it('rejects javascript: scheme', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects file: scheme', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects neo:// scheme', () => {
    expect(isSafeExternalUrl('neo://reminders/rem_abc')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeExternalUrl('')).toBe(false);
  });

  it('rejects malformed URL', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});

describe('isSameOrigin', () => {
  it('returns true for same origin', () => {
    expect(isSameOrigin('http://127.0.0.1:7777/chat', 'http://127.0.0.1:7777')).toBe(true);
  });

  it('returns true for hash change on same origin', () => {
    expect(isSameOrigin('http://127.0.0.1:7777/#/chat', 'http://127.0.0.1:7777')).toBe(true);
  });

  it('returns false for different port', () => {
    expect(isSameOrigin('http://127.0.0.1:8888', 'http://127.0.0.1:7777')).toBe(false);
  });

  it('returns false for different host', () => {
    expect(isSameOrigin('http://example.com', 'http://127.0.0.1:7777')).toBe(false);
  });

  it('returns false for malformed URL', () => {
    expect(isSameOrigin('not-a-url', 'http://127.0.0.1:7777')).toBe(false);
  });
});

// ───────────────────────────── notification text ─────────────────────────

function makeReminder(id = 'rem_1', title = 'Call Alice', notes: string | null = null) {
  return {
    id,
    title,
    notes,
    dueAt: Date.now(),
    timezone: 'UTC',
    recurrence: null,
    status: 'scheduled' as const,
    firedCount: 0,
    lastFiredAt: null,
    messageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeFiring(overrides: Partial<ReminderFiring> = {}): ReminderFiring {
  return {
    reminder: makeReminder(),
    occurrenceAt: Date.now(),
    firedAt: Date.now(),
    missed: false,
    nextDueAt: null,
    ...overrides,
  };
}

describe('formatReminderNotification', () => {
  it('formats a normal reminder with notes', () => {
    const firing = makeFiring({
      reminder: makeReminder('rem_1', 'Call Alice', 'Re: project status'),
    });
    const result = formatReminderNotification(firing);
    expect(result.title).toBe('Call Alice');
    expect(result.body).toBe('Re: project status');
    expect(result.deepLink).toBe('neo://reminders/rem_1');
  });

  it('opens a reminder notification at its timeline source message', () => {
    const reminder = { ...makeReminder('rem_3', 'Follow up'), messageId: 'msg_abc' };
    const firing = makeFiring({ reminder });
    const result = formatReminderNotification(firing);
    expect(result.deepLink).toBe('neo://timeline/msg_abc');
    expect(deepLinkToHash(result.deepLink)).toBe('#/timeline?messageId=msg_abc');

    // null messageId still goes to reminders
    const firing2 = makeFiring({ reminder: makeReminder('rem_4', 'Buy milk') });
    const result2 = formatReminderNotification(firing2);
    expect(result2.deepLink).toBe('neo://reminders/rem_4');
  });

  it('falls back to "It\'s time" when notes are null', () => {
    const firing = makeFiring();
    const result = formatReminderNotification(firing);
    expect(result.body).toBe("It's time");
  });

  it('formats a missed reminder', () => {
    const firing = makeFiring({ missed: true, reminder: makeReminder('rem_2', 'Buy groceries') });
    const result = formatReminderNotification(firing);
    expect(result.title).toBe('Missed reminder');
    expect(result.body).toContain('Missed while you were away');
    expect(result.body).toContain('Buy groceries');
    expect(result.deepLink).toBe('neo://reminders/rem_2');
  });
});

function makeNotification(kind: Notification['kind'], title = 'Test', body = 'Body'): Notification {
  return { id: 'n_1', kind, title, body, createdAt: Date.now(), readAt: null, data: null };
}

describe('formatSystemNotification', () => {
  it('returns title + body for system kind', () => {
    const n = makeNotification('system', 'Update available', 'A new version is ready.');
    const result = formatSystemNotification(n);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Update available');
    expect(result!.body).toBe('A new version is ready.');
  });

  it('returns null for reminder kind', () => {
    expect(formatSystemNotification(makeNotification('reminder'))).toBeNull();
  });

  it('returns null for memory kind', () => {
    expect(formatSystemNotification(makeNotification('memory'))).toBeNull();
  });

  it('returns null for task kind', () => {
    expect(formatSystemNotification(makeNotification('task'))).toBeNull();
  });
});

// ───────────────────────────── deep links ─────────────────────────────

describe('deepLinkToHash', () => {
  it('maps reminders with id', () => {
    expect(deepLinkToHash('neo://reminders/rem_abc')).toBe('#/reminders/rem_abc');
  });

  it('maps reminders root', () => {
    expect(deepLinkToHash('neo://reminders')).toBe('#/reminders');
  });

  it('maps chat with id', () => {
    expect(deepLinkToHash('neo://chat/con_xyz')).toBe('#/chat/con_xyz');
  });

  it('maps tasks', () => {
    expect(deepLinkToHash('neo://tasks/tsk_1')).toBe('#/tasks/tsk_1');
  });

  it('maps notes', () => {
    expect(deepLinkToHash('neo://notes/nte_1')).toBe('#/notes/nte_1');
  });

  it('maps memory', () => {
    expect(deepLinkToHash('neo://memory/mem_1')).toBe('#/memory/mem_1');
  });

  it('returns #/ for unknown host', () => {
    expect(deepLinkToHash('neo://unknown/foo')).toBe('#/');
  });

  it('returns #/ for non-neo protocol', () => {
    expect(deepLinkToHash('https://example.com')).toBe('#/');
  });

  it('returns #/ for malformed URL', () => {
    expect(deepLinkToHash('not a url')).toBe('#/');
  });
});

// ───────────────────────────── tray icon ─────────────────────────────

describe('createTrayIconPng', () => {
  it('returns a non-empty Buffer', () => {
    const buf = createTrayIconPng();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('starts with the PNG signature', () => {
    const buf = createTrayIconPng();
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50); // P
    expect(buf[2]).toBe(0x4e); // N
    expect(buf[3]).toBe(0x47); // G
  });

  it('has IHDR and IEND chunks', () => {
    const buf = createTrayIconPng();
    const str = buf.toString('ascii', 8, 16);
    // First chunk type after signature is IHDR length (4 bytes) then "IHDR"
    expect(buf.toString('ascii', 12, 16)).toBe('IHDR');
    void str;
    // IEND appears somewhere near the end
    expect(buf.toString('ascii', buf.length - 8, buf.length - 4)).toBe('IEND');
  });
});

it('maps timeline message notification links into the web timeline route', () => {
  expect(deepLinkToHash('neo://timeline?messageId=msg_1')).toBe('#/timeline?messageId=msg_1');
});

// ───────────────────────────── startup mode ─────────────────────────────

describe('parseStartupMode', () => {
  it('returns "local" for the string literal local', () => {
    expect(parseStartupMode(JSON.stringify('local'))).toBe('local');
  });

  it('returns RemoteMode for a remote object with credentials', () => {
    const mode = { kind: 'remote', serverUrl: 'https://neo.example.com', token: 'tok123' };
    const result = parseStartupMode(JSON.stringify(mode));
    expect(result).toEqual(mode);
  });

  it('returns RemoteMode with only kind when no credentials are set', () => {
    const result = parseStartupMode(JSON.stringify({ kind: 'remote' }));
    expect(result).toEqual({ kind: 'remote' });
  });

  it('returns null for invalid JSON', () => {
    expect(parseStartupMode('not json')).toBeNull();
  });

  it('returns null for unrecognised value', () => {
    expect(parseStartupMode(JSON.stringify({ kind: 'other' }))).toBeNull();
    expect(parseStartupMode(JSON.stringify(42))).toBeNull();
    expect(parseStartupMode(JSON.stringify(null))).toBeNull();
  });

  it('strips unknown fields from RemoteMode', () => {
    const raw = JSON.stringify({ kind: 'remote', serverUrl: 'https://neo.example.com', token: 'tok', extra: 'ignored' });
    const result = parseStartupMode(raw);
    expect(result).not.toBeNull();
    expect((result as unknown as Record<string, unknown>)['extra']).toBeUndefined();
  });
});

describe('loadStartupMode', () => {
  it('returns null when the file does not exist', async () => {
    fsMock.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await loadStartupMode('/neo-test');
    expect(result).toBeNull();
  });

  it('returns parsed StartupMode from file', async () => {
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify('local'));
    const result = await loadStartupMode('/neo-test');
    expect(result).toBe('local');
  });

  it('reads from the correct path', async () => {
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify({ kind: 'remote' }));
    await loadStartupMode('/my-data');
    expect(fsMock.readFile).toHaveBeenCalledWith(
      expect.stringContaining('startup-mode.json'),
      'utf8',
    );
  });
});

describe('saveStartupMode', () => {
  it('writes the mode as JSON to startup-mode.json', async () => {
    await saveStartupMode('/neo-test', 'local');
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('startup-mode.json'),
      JSON.stringify('local'),
      'utf8',
    );
  });

  it('writes RemoteMode with credentials', async () => {
    const mode = { kind: 'remote' as const, serverUrl: 'https://neo.example.com', token: 'tok' };
    await saveStartupMode('/neo-test', mode);
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('startup-mode.json'),
      JSON.stringify(mode),
      'utf8',
    );
  });
});

// ──────────────────────── pickFirstLaunchStrings ────────────────────────

describe('pickFirstLaunchStrings', () => {
  it('returns en strings for an en locale', () => {
    const s = pickFirstLaunchStrings('en-US');
    expect(s.message).toBe('How would you like to use NEO?');
    expect(s.runLocal).toBe('Run NEO on this Mac');
    expect(s.connectRemote).toBe('Connect to a NEO');
  });

  it('returns zh-CN strings for zh-CN', () => {
    const s = pickFirstLaunchStrings('zh-CN');
    expect(s.message).toBe('你想如何使用 NEO？');
    expect(s.runLocal).toBe('在这台 Mac 上运行 NEO');
    expect(s.connectRemote).toBe('连接到一个 NEO');
  });

  it('maps bare zh to zh-CN', () => {
    expect(pickFirstLaunchStrings('zh').message).toBe('你想如何使用 NEO？');
  });

  it('maps zh-Hans and zh-Hans-CN to zh-CN', () => {
    expect(pickFirstLaunchStrings('zh-Hans').runLocal).toBe('在这台 Mac 上运行 NEO');
    expect(pickFirstLaunchStrings('zh-Hans-CN').runLocal).toBe('在这台 Mac 上运行 NEO');
  });

  it('falls back to en for traditional Chinese locales', () => {
    expect(pickFirstLaunchStrings('zh-TW').runLocal).toBe('Run NEO on this Mac');
    expect(pickFirstLaunchStrings('zh-HK').runLocal).toBe('Run NEO on this Mac');
  });

  it('falls back to en for other locales and for empty / unknown input', () => {
    expect(pickFirstLaunchStrings('fr-FR').message).toBe('How would you like to use NEO?');
    expect(pickFirstLaunchStrings('').message).toBe('How would you like to use NEO?');
    expect(pickFirstLaunchStrings('xx-YY').message).toBe('How would you like to use NEO?');
  });

  it('is case-insensitive for the locale tag', () => {
    expect(pickFirstLaunchStrings('ZH-CN').runLocal).toBe('在这台 Mac 上运行 NEO');
    expect(pickFirstLaunchStrings('zh-cn').runLocal).toBe('在这台 Mac 上运行 NEO');
  });

  it('returns no stray "Settings" promise in either locale', () => {
    // Finding B from the Agent review on head 1cc8ad0: the dialog previously
    // claimed "You can change this later in Settings." but no Settings UI
    // existed. The fix removed the detail line, so neither locale has it.
    const en = pickFirstLaunchStrings('en');
    const zh = pickFirstLaunchStrings('zh-CN');
    const combined = `${en.message}|${en.runLocal}|${en.connectRemote}|${zh.message}|${zh.runLocal}|${zh.connectRemote}`;
    expect(combined.toLowerCase()).not.toContain('settings');
    expect(combined).not.toContain('设置');
  });
});
