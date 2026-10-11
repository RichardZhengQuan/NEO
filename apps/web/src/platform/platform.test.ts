import { describe, expect, it } from 'vitest';
import type { Reminder } from '@neo/protocol';
import {
  MAX_LOCAL_NOTIFICATIONS,
  createPlatform,
  detectPlatform,
  notificationIdFor,
  planReminderNotifications,
  staleNotificationIds,
  urlBase64ToUint8Array,
} from './index.js';

const desktop = { getConfig: async () => ({ serverUrl: 'http://127.0.0.1:1', token: 't' }), platform: 'darwin', openExternal: () => undefined };

describe('detectPlatform', () => {
  it('desktop bridge → electron', () => {
    expect(detectPlatform({ desktop, native: false, nativePlatform: 'web' })).toBe('electron');
  });
  it('native iOS/Android → capacitor', () => {
    expect(detectPlatform({ desktop: undefined, native: true, nativePlatform: 'ios' })).toBe('capacitor');
    expect(detectPlatform({ desktop: undefined, native: true, nativePlatform: 'android' })).toBe('capacitor');
  });
  it('plain web → browser (Capacitor web shim is not native)', () => {
    expect(detectPlatform({ desktop: undefined, native: false, nativePlatform: 'web' })).toBe('browser');
    expect(detectPlatform({ desktop: null, native: true, nativePlatform: 'web' })).toBe('browser');
  });
  it('ignores a malformed desktop object', () => {
    expect(detectPlatform({ desktop: {} as never, native: false, nativePlatform: 'web' })).toBe('browser');
  });
  it('creates the matching bridge', () => {
    expect(createPlatform({ desktop, native: false, nativePlatform: 'web' }).kind).toBe('electron');
    expect(createPlatform({ desktop: undefined, native: true, nativePlatform: 'android' }).devicePlatform).toBe('android');
    expect(createPlatform({ desktop: undefined, native: false, nativePlatform: 'web' }).kind).toBe('browser');
  });
  it('electron never shows its own notifications', async () => {
    const bridge = createPlatform({ desktop, native: false, nativePlatform: 'web' });
    const status = await bridge.notificationStatus({} as never);
    expect(status).toEqual({ channel: 'os', permission: 'granted', enabled: true });
  });
});

function reminder(id: string, dueAt: number, status: Reminder['status'] = 'scheduled', notes: string | null = null): Reminder {
  return { id, title: `R ${id}`, notes, dueAt, timezone: 'UTC', recurrence: null, status, firedCount: 0, lastFiredAt: null, conversationId: null, createdAt: 0, updatedAt: 0 };
}

describe('local notification planning', () => {
  const now = 1_000_000;

  it('ids are stable, positive 31-bit integers', () => {
    const a = notificationIdFor('rem_abc123');
    expect(a).toBe(notificationIdFor('rem_abc123'));
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(0x7fffffff);
    expect(Number.isInteger(a)).toBe(true);
    expect(notificationIdFor('rem_abc124')).not.toBe(a);
  });

  it('skips past, completed and cancelled reminders', () => {
    const plan = planReminderNotifications(
      [reminder('rem_past', now - 1), reminder('rem_now', now), reminder('rem_done', now + 5, 'completed'), reminder('rem_cancel', now + 5, 'cancelled'), reminder('rem_fired', now + 5, 'fired'), reminder('rem_ok', now + 10)],
      now,
    );
    expect(plan.map((p) => p.reminderId)).toEqual(['rem_ok']);
  });

  it('keeps the 64 soonest, sorted', () => {
    const many = Array.from({ length: 100 }, (_, i) => reminder(`rem_${i}`, now + (100 - i) * 1000));
    const plan = planReminderNotifications(many, now);
    expect(plan).toHaveLength(MAX_LOCAL_NOTIFICATIONS);
    expect(plan[0]!.reminderId).toBe('rem_99');
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.at).toBeGreaterThanOrEqual(plan[i - 1]!.at);
    expect(new Set(plan.map((p) => p.id)).size).toBe(plan.length);
  });

  it('maps title, body, time, deep link', () => {
    const [p] = planReminderNotifications([reminder('rem_x', now + 60_000, 'scheduled', ' Bring snacks ')], now, { defaultBody: "It's time" });
    expect(p).toEqual({ id: notificationIdFor('rem_x'), reminderId: 'rem_x', title: 'R rem_x', body: 'Bring snacks', at: now + 60_000, url: 'neo://reminders/rem_x' });
    const [q] = planReminderNotifications([reminder('rem_y', now + 1)], now, { defaultBody: "It's time" });
    expect(q!.body).toBe("It's time");
  });

  it('finds notifications to cancel', () => {
    const plan = planReminderNotifications([reminder('rem_a', now + 1)], now);
    expect(staleNotificationIds([{ id: plan[0]!.id }, { id: 42 }], plan)).toEqual([42]);
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes url-safe base64', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID-_8'))).toEqual([1, 2, 3, 251, 255]);
  });
});
