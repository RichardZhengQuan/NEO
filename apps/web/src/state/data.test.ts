import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import type { Notification } from '@neo/protocol';
import { addNotification, loadNotifications, useData } from './data.js';
import { useSession } from './session.js';

const notification = (id: string, readAt: number | null): Notification => ({
  id, kind: 'system', title: id, body: 'Update', createdAt: 0, readAt, data: null,
});

beforeEach(() => {
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
