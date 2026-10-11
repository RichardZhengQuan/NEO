/**
 * NotificationStore: ephemeral in-app notifications.
 */
import { z } from 'zod';
import {
  NotificationSchema,
  newId,
  type Clock,
  type Notification,
  type NotificationInput,
  type NotificationStore,
} from '@neo/protocol';
import { fromJson, toNum, toNumOrNull, type NeoDatabase } from '@neo/storage';
import { changes, clampLimit, parseInput } from './validate.js';

const NotificationInputSchema = z.object({
  kind: NotificationSchema.shape.kind,
  title: z.string().max(1000),
  body: z.string().max(10_000),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.number().optional(),
});

type Row = Record<string, unknown>;

function toNotification(r: Row): Notification {
  return {
    id: r.id as string,
    kind: r.kind as Notification['kind'],
    title: r.title as string,
    body: r.body as string,
    createdAt: toNum(r.created_at),
    readAt: toNumOrNull(r.read_at),
    data: fromJson(r.data, null),
  };
}

export function createNotificationStore(db: NeoDatabase, options: { clock?: Clock } = {}): NotificationStore {
  const clock = options.clock ?? (() => Date.now());

  return {
    list(query: { unread?: boolean; limit?: number } = {}): Notification[] {
      const limit = clampLimit(query.limit, 50, 200);
      const sql = `SELECT * FROM notifications${query.unread ? ' WHERE read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`;
      return (db.prepare(sql).all(limit) as Row[]).map(toNotification);
    },

    create(input: NotificationInput): Notification {
      const data = parseInput(NotificationInputSchema, input, 'notification');
      const now = clock();
      const id = newId('ntf', now);
      const notif: Notification = {
        id,
        kind: data.kind,
        title: data.title,
        body: data.body,
        createdAt: data.createdAt ?? now,
        readAt: null,
        data: data.data ?? null,
      };

      db.prepare(
        `INSERT INTO notifications (id, kind, title, body, created_at, read_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(notif.id, notif.kind, notif.title, notif.body, notif.createdAt, null, notif.data !== null ? JSON.stringify(notif.data) : null);

      return notif;
    },

    markRead(ids: string[] | 'all'): number {
      const now = clock();
      if (ids === 'all') {
        return changes(db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now));
      }
      let count = 0;
      for (const id of ids) {
        count += changes(db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(now, id));
      }
      return count;
    },
  };
}
