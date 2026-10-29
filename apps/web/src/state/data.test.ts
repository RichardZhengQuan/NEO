import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import type { Notification } from '@neo/protocol';
import { addNotification, loadNotifications, useData } from './data.js';
import { useSession } from './session.js';

const notification = (id: string, readAt: number | null): Notification => ({
  id, kind: 'system', title: id, body: 'Update', createdAt: 0, readAt, data: null,
});

beforeEach(() => {
  useSession.setState({ client: null, sessionEpoch: 0 });
  useData.setState({ notifications: [], unreadNotifications: 0 });
});
afterEach(() => { useSession.setState({ client: null }); });

describe('notification read timestamps', () => {
  it('counts only absent read timestamps as unread when loading', async () => {
    const items = [notification('epoch', 0), notification('later', 1000), notification('unread', null)];
    const client = { notifications: { list: vi.fn().mockResolvedValue({ items, nextCursor: null }) } } as unknown as NeoClient;
    useSession.setState({ client });

    await loadNotifications(client);

    expect(client.notifications.list).toHaveBeenCalledExactlyOnceWith({ limit: 50 });
    expect(useData.getState().notifications).toEqual(items);
    expect(useData.getState().unreadNotifications).toBe(1);
  });

  it.each([0, 1000, null])('increments the event counter only for an unread notification (%s)', (readAt) => {
    useData.setState({ unreadNotifications: 2 });
    const item = notification('new', readAt);

    addNotification(item);

    expect(useData.getState().notifications).toEqual([item]);
    expect(useData.getState().unreadNotifications).toBe(readAt === null ? 3 : 2);
  });
});


describe('retained notification upserts', () => {
  it('does not count a repeated unread event twice and keeps its latest data', () => {
    addNotification(notification('same', null));
    const replacement = { ...notification('same', null), body: 'Updated' };

    addNotification(replacement);
    addNotification(replacement);

    expect(useData.getState().notifications).toEqual([replacement]);
    expect(useData.getState().unreadNotifications).toBe(1);
  });

  it.each([
    [null, 0, 0], [null, 1000, 0], [0, null, 1], [1000, null, 1],
    [0, 1000, 0], [1000, 0, 0], [0, 0, 0], [null, null, 1],
  ])('replaces a retained read timestamp %s with %s', (before, after, unread) => {
    const original = notification('same', before);
    useData.setState({ notifications: [original], unreadNotifications: before === null ? 1 : 0 });
    const replacement = notification('same', after);

    addNotification(replacement);

    expect(useData.getState().notifications).toEqual([replacement]);
    expect(useData.getState().unreadNotifications).toBe(unread);
  });

  it('adjusts only the retained contribution without discarding the existing counter baseline', () => {
    useData.setState({ notifications: [notification('same', null)], unreadNotifications: 8 });
    addNotification(notification('same', 0));
    expect(useData.getState().unreadNotifications).toBe(7);
    addNotification(notification('same', 1000));
    expect(useData.getState().unreadNotifications).toBe(7);
    addNotification(notification('same', null));
    expect(useData.getState().unreadNotifications).toBe(8);
  });

  it('keeps the existing 100-item retention cap and handles a duplicate at the cap', () => {
    const items = Array.from({ length: 100 }, (_, index) => notification(`item-${index}`, 0));
    useData.setState({ notifications: items, unreadNotifications: 3 });
    addNotification(notification('item-50', 1000));
    expect(useData.getState().notifications).toHaveLength(100);
    expect(useData.getState().unreadNotifications).toBe(3);

    const added = notification('new', null);
    addNotification(added);
    addNotification(added);
    expect(useData.getState().notifications).toHaveLength(100);
    expect(useData.getState().notifications[0]).toEqual(added);
    expect(useData.getState().notifications.some((item) => item.id === 'item-99')).toBe(false);
    expect(useData.getState().unreadNotifications).toBe(4);
  });

  it.each(['epoch', 'client'] as const)('keeps current notification state when a load belongs to a stale %s', async (changed) => {
    let release!: (page: { items: Notification[]; nextCursor: null }) => void;
    const client = { notifications: { list: vi.fn(() => new Promise((resolve) => { release = resolve; })) } } as unknown as NeoClient;
    useSession.setState({ client });
    const pending = loadNotifications(client);
    useSession.setState(changed === 'epoch' ? { sessionEpoch: 1 } : { client: {} as NeoClient });
    const current = notification('current', null);
    useData.setState({ notifications: [current], unreadNotifications: 4 });

    release({ items: [notification('stale', null)], nextCursor: null });
    await pending;

    expect(useData.getState().notifications).toEqual([current]);
    expect(useData.getState().unreadNotifications).toBe(4);
  });
});
