/**
 * ReminderStore on node:sqlite.
 *
 * `anchor_at` (not part of the Reminder type) is the first dueAt of the
 * series; it fixes the local time of day for recurrences. Updating `dueAt`
 * re-anchors the reminder; snoozing changes `dueAt` only.
 */
import { createHash } from 'node:crypto';
import {
  NeoError,
  ReminderInputSchema,
  ReminderPatchSchema,
  newId,
  type Clock,
  type Reminder,
  type ReminderFiring,
  type ReminderInput,
  type ReminderListQuery,
  type ReminderPatch,
  type ReminderStore,
} from '@neo/protocol';
import { fromJson, toJson, toNum, toNumOrNull, type NeoDatabase } from '@neo/storage';
import { nextOccurrence } from '../recurrence.js';
import { assertTimeZone } from '../time.js';
import { changes, clampLimit, parseInput, requireText } from './validate.js';

type Row = Record<string, unknown>;
type ChangeEvent = { type: 'upsert'; reminder: Reminder } | { type: 'delete'; id: string };

/** Longest accepted snooze: one year. */
const MAX_SNOOZE_MINUTES = 366 * 24 * 60;

function toReminder(r: Row): Reminder {
  return {
    id: r.id as string,
    title: r.title as string,
    notes: (r.notes as string | null) ?? null,
    dueAt: toNum(r.due_at),
    timezone: r.timezone as string,
    recurrence: fromJson(r.recurrence, null),
    status: r.status as Reminder['status'],
    firedCount: toNum(r.fired_count),
    lastFiredAt: toNumOrNull(r.last_fired_at),
    messageId: (r.message_id as string | null) ?? null,
    ...(typeof r.creation_key === 'string' ? { creationKey: r.creation_key } : {}),
    createdAt: toNum(r.created_at),
    updatedAt: toNum(r.updated_at),
  };
}

export function createReminderStore(db: NeoDatabase, options: { clock?: Clock; defaultTimezone?: string } = {}): ReminderStore {
  const clock = options.clock ?? (() => Date.now());
  const defaultTimezone = options.defaultTimezone ?? 'UTC';
  const listeners = new Set<(event: ChangeEvent) => void>();

  const emit = (event: ChangeEvent) => {
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the mutation that already happened.
      }
    }
  };

  const row = (id: string): Row | undefined => db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Row | undefined;
  const get = (id: string): Reminder | null => {
    const r = row(id);
    return r ? toReminder(r) : null;
  };
  const mustGet = (id: string): Reminder => {
    const r = get(id);
    if (!r) throw new NeoError('not_found', `Reminder ${id} not found.`);
    return r;
  };
  const finite = (n: number, what: string) => {
    if (!Number.isFinite(n)) throw new NeoError('bad_request', `Invalid ${what}: ${n}`);
    return n;
  };

  return {
    list(query: ReminderListQuery = {}) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (query.status?.length) {
        // Dedupe statuses so a caller that passes the same value many times
        // can't push the IN(…) clause past SQLite's variable limit.
        const statuses = [...new Set(query.status)];
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        args.push(...statuses);
      }
      if (typeof query.from === 'number' && Number.isFinite(query.from)) {
        where.push('due_at >= ?');
        args.push(query.from);
      }
      if (typeof query.to === 'number' && Number.isFinite(query.to)) {
        where.push('due_at <= ?');
        args.push(query.to);
      }
      args.push(clampLimit(query.limit, 100, 500));
      const sql = `SELECT * FROM reminders${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY due_at ASC, created_at ASC LIMIT ?`;
      return (db.prepare(sql).all(...args) as Row[]).map(toReminder);
    },

    get,

    create(input: ReminderInput): Reminder {
      const data = parseInput(ReminderInputSchema, input, 'reminder');
      const normalized = {
        title: requireText(data.title, 'title'), notes: data.notes ?? null, dueAt: Math.round(data.dueAt),
        timezone: assertTimeZone(data.timezone ?? defaultTimezone), recurrence: data.recurrence ?? null,
        messageId: data.messageId ?? null,
      };
      // Keep the accepted creation identity independent of later edits, snoozes and recurrence advancement.
      const recurrence = normalized.recurrence ? {
        ...normalized.recurrence,
        ...(normalized.recurrence.byWeekday ? { byWeekday: [...new Set(normalized.recurrence.byWeekday)].sort((a, b) => a - b) } : {}),
        ...(normalized.recurrence.byMonthDay ? { byMonthDay: [...new Set(normalized.recurrence.byMonthDay)].sort((a, b) => a - b) } : {}),
      } : null;
      const fingerprint = data.creationKey ? createHash('sha256').update(JSON.stringify({ ...normalized, recurrence })).digest('hex') : null;
      const result = db.transaction(() => {
        if (data.creationKey) {
          if (db.prepare('SELECT 1 FROM reminder_creation_tombstones WHERE creation_key = ?').get(data.creationKey)) {
            throw new NeoError('conflict', 'This reminder creation key belongs to a deleted reminder. Use a new key to create another reminder.');
          }
          const existing = db.prepare('SELECT * FROM reminders WHERE creation_key = ?').get(data.creationKey) as Row | undefined;
          if (existing) {
            if (existing.creation_fingerprint !== fingerprint) throw new NeoError('conflict', 'This reminder creation key was already used with different values.');
            return { reminder: toReminder(existing), created: false };
          }
        }
        const now = clock();
        const reminder: Reminder = {
          id: newId('rem', now), ...normalized,
          ...(data.creationKey ? { creationKey: data.creationKey } : {}),
          status: 'scheduled', firedCount: 0, lastFiredAt: null, createdAt: now, updatedAt: now,
        };
        db.prepare(
          `INSERT INTO reminders (id, title, notes, due_at, anchor_at, timezone, recurrence, status, fired_count, last_fired_at, message_id, creation_key, creation_fingerprint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          reminder.id, reminder.title, reminder.notes, reminder.dueAt, reminder.dueAt, reminder.timezone,
          toJson(reminder.recurrence), reminder.status, 0, null, reminder.messageId, data.creationKey ?? null, fingerprint, now, now,
        );
        return { reminder, created: true };
      });
      if (result.created) emit({ type: 'upsert', reminder: result.reminder });
      return result.reminder;
    },

    update(id: string, patch: ReminderPatch): Reminder {
      const data = parseInput(ReminderPatchSchema, patch, 'reminder update');
      // Read raw row so we can access snoozed_due_at without a second query.
      const existingRow = row(id);
      if (!existingRow) throw new NeoError('not_found', `Reminder ${id} not found.`);
      const existing = toReminder(existingRow);
      const now = clock();
      const next: Reminder = { ...existing, updatedAt: now };
      if (data.title !== undefined) next.title = requireText(data.title, 'title');
      if (data.notes !== undefined) next.notes = data.notes;
      if (data.timezone !== undefined) next.timezone = assertTimeZone(data.timezone);
      if (data.recurrence !== undefined) next.recurrence = data.recurrence;
      const dueAtMoved = data.dueAt !== undefined && Math.round(data.dueAt) !== existing.dueAt;
      const timezoneMoved = data.timezone !== undefined && data.timezone !== existing.timezone;
      if (data.dueAt !== undefined) next.dueAt = Math.round(data.dueAt);
      if (data.status !== undefined) next.status = data.status;
      // Moving a reminder that already fired to a new time means "remind me again".
      // Guard with dueAtMoved only: a timezone-only patch must not re-arm a fired
      // reminder because dueAt is still in the past.
      else if (dueAtMoved && existing.status === 'fired') next.status = 'scheduled';

      // anchor_at / snoozed_due_at update rules:
      //  dueAtMoved: set anchor_at = new dueAt; clear snoozed_due_at so the
      //    new time is not silently overwritten by a snoozed redelivery in markFired.
      //  timezoneMoved && !dueAtMoved && snoozed: set anchor_at = snoozedDueAt
      //    (original occurrence epoch) so markFired does not treat the snoozed
      //    redelivery as a true occurrence from the wrong anchor.  Leave
      //    snoozed_due_at intact — the snooze is still active and must fire normally.
      //  timezoneMoved && !dueAtMoved && !snoozed: set anchor_at = next.dueAt
      //    so the recurrence advances from the right wall-clock time in the new zone.
      const reanchor = dueAtMoved || timezoneMoved;
      const existingSnoozedDueAt = toNumOrNull(existingRow.snoozed_due_at);
      // When timezone-only and the reminder is snoozed, reanchor to the original
      // occurrence (snoozedDueAt), not the snooze delivery epoch.
      const anchorValue = (timezoneMoved && !dueAtMoved && existingSnoozedDueAt !== null)
        ? existingSnoozedDueAt
        : next.dueAt;
      db.prepare(
        `UPDATE reminders SET title = ?, notes = ?, due_at = ?,
           anchor_at = CASE WHEN ? THEN ? ELSE anchor_at END,
           snoozed_due_at = CASE WHEN ? THEN NULL ELSE snoozed_due_at END,
           timezone = ?, recurrence = ?, status = ?, updated_at = ? WHERE id = ?`,
      ).run(next.title, next.notes, next.dueAt, reanchor ? 1 : 0, anchorValue, dueAtMoved ? 1 : 0, next.timezone, toJson(next.recurrence), next.status, now, id);
      emit({ type: 'upsert', reminder: next });
      return next;
    },

    delete(id: string): boolean {
      const deleted = db.transaction(() => {
        const existing = row(id);
        if (!existing || changes(db.prepare('DELETE FROM reminders WHERE id = ?').run(id)) === 0) return false;
        // Keep a consumed key after its live row is gone, so a delayed retry cannot undo deletion.
        if (typeof existing.creation_key === 'string') {
          db.prepare('INSERT OR IGNORE INTO reminder_creation_tombstones (creation_key, deleted_at) VALUES (?, ?)').run(existing.creation_key, clock());
        }
        return true;
      });
      if (deleted) emit({ type: 'delete', id });
      return deleted;
    },

    snooze(id: string, minutes: number): Reminder {
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_SNOOZE_MINUTES) {
        throw new NeoError('bad_request', `Invalid snooze: minutes must be between 1 and ${MAX_SNOOZE_MINUTES}.`);
      }
      const r = row(id);
      if (!r) throw new NeoError('not_found', `Reminder ${id} not found.`);
      const existing = toReminder(r);
      const now = clock();
      const dueAt = now + Math.round(minutes * 60_000);
      // Preserve the original occurrence time so markFired can distinguish a
      // snoozed redelivery from a true occurrence.  If the reminder is already
      // snoozed, keep the first snooze's anchor rather than overwriting it.
      const snoozedDueAt = toNumOrNull(r.snoozed_due_at) ?? existing.dueAt;
      const updated: Reminder = { ...existing, dueAt, status: 'scheduled', updatedAt: now };
      db.prepare('UPDATE reminders SET due_at = ?, snoozed_due_at = ?, status = ?, updated_at = ? WHERE id = ?').run(dueAt, snoozedDueAt, 'scheduled', now, id);
      emit({ type: 'upsert', reminder: updated });
      return updated;
    },

    complete(id: string): Reminder {
      const existing = mustGet(id);
      const now = clock();
      const updated: Reminder = { ...existing, status: 'completed', updatedAt: now };
      db.prepare('UPDATE reminders SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, id);
      emit({ type: 'upsert', reminder: updated });
      return updated;
    },

    due(now: number): Reminder[] {
      return (db.prepare("SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at ASC, created_at ASC").all(finite(now, 'time')) as Row[]).map(toReminder);
    },

    nextDue(excludeIds?: ReadonlySet<string>): Reminder | null {
      if (excludeIds?.size) {
        // Walk the scheduled reminders in due-order and skip excluded ids in JS,
        // so the SQL query binds no per-id variables and stays under SQLite's
        // ~999 variable limit regardless of excludeIds.size.
        const rows = db.prepare(
          "SELECT * FROM reminders WHERE status = 'scheduled' ORDER BY due_at ASC LIMIT ?",
        ).all(excludeIds.size + 1) as Row[];
        for (const r of rows) {
          if (!excludeIds.has(r.id as string)) return toReminder(r);
        }
        return null;
      }
      const r = db.prepare("SELECT * FROM reminders WHERE status = 'scheduled' ORDER BY due_at ASC LIMIT 1").get() as Row | undefined;
      return r ? toReminder(r) : null;
    },

    markFired(id: string, firedAt: number, missed = false): ReminderFiring {
      finite(firedAt, 'firing time');
      const firing = db.transaction((): ReminderFiring => {
        const r = row(id);
        if (!r) throw new NeoError('not_found', `Reminder ${id} not found.`);
        const existing = toReminder(r);
        if (existing.status !== 'scheduled') {
          throw new NeoError('conflict', `Reminder ${id} is ${existing.status}, not scheduled.`);
        }
        const now = clock();
        const snoozedDueAt = toNumOrNull(r.snoozed_due_at);
        const isSnoozedRedelivery = snoozedDueAt !== null;
        let result: ReminderFiring;
        // A snoozed redelivery re-delivers the current occurrence without
        // consuming a new one from the series.  Restore the already-scheduled
        // next dueAt and leave firedCount unchanged.  Non-recurring reminders
        // have no next occurrence to restore; fall through to the normal firing
        // path so they reach 'fired' rather than staying 'scheduled'.
        if (isSnoozedRedelivery && existing.recurrence !== null) {
          // If the series is already exhausted, the snoozed redelivery must not
          // re-arm the reminder.  Call nextOccurrence from snoozedDueAt with the
          // current firedCount (unchanged: the snooze was not a new occurrence) to
          // determine whether there is any remaining occurrence in the series.
          const seriesExhausted =
            nextOccurrence(existing.recurrence, toNum(r.anchor_at), snoozedDueAt, existing.timezone, existing.firedCount) === null;
          if (seriesExhausted) {
            // Re-deliver the occurrence but leave the series terminated.
            const reminder: Reminder = {
              ...existing,
              status: 'fired',
              dueAt: existing.dueAt,
              // firedCount is unchanged: the snooze was not a new occurrence.
              lastFiredAt: firedAt,
              updatedAt: now,
            };
            db.prepare('UPDATE reminders SET status = ?, snoozed_due_at = NULL, last_fired_at = ?, updated_at = ? WHERE id = ?').run(
              'fired', firedAt, now, id,
            );
            result = { reminder, occurrenceAt: existing.dueAt, firedAt, missed, nextDueAt: null };
          } else {
            const reminder: Reminder = {
              ...existing,
              status: 'scheduled',
              dueAt: snoozedDueAt,
              // firedCount is unchanged: the snooze was not a new occurrence.
              lastFiredAt: firedAt,
              updatedAt: now,
            };
            db.prepare('UPDATE reminders SET status = ?, due_at = ?, snoozed_due_at = NULL, last_fired_at = ?, updated_at = ? WHERE id = ?').run(
              'scheduled', snoozedDueAt, firedAt, now, id,
            );
            result = { reminder, occurrenceAt: existing.dueAt, firedAt, missed, nextDueAt: snoozedDueAt };
          }
        } else {
          const firedCount = existing.firedCount + 1;
          // Advance past both the occurrence and the firing time, so a long downtime
          // collapses every missed occurrence into this one firing.
          const nextDueAt = existing.recurrence
            ? nextOccurrence(existing.recurrence, toNum(r.anchor_at), Math.max(firedAt, existing.dueAt), existing.timezone, firedCount)
            : null;
          const reminder: Reminder = {
            ...existing,
            status: nextDueAt === null ? 'fired' : 'scheduled',
            dueAt: nextDueAt ?? existing.dueAt,
            firedCount,
            lastFiredAt: firedAt,
            updatedAt: now,
          };
          db.prepare('UPDATE reminders SET status = ?, due_at = ?, snoozed_due_at = NULL, fired_count = ?, last_fired_at = ?, updated_at = ? WHERE id = ?').run(
            reminder.status, reminder.dueAt, firedCount, firedAt, now, id,
          );
          result = { reminder, occurrenceAt: existing.dueAt, firedAt, missed, nextDueAt };
        }
        // Atomically record the pending firing for crash-safe re-delivery.
        const pendingFiringId = newId('pfr', firedAt);
        db.prepare(
          `INSERT INTO pending_firings (id, reminder_id, occurrence_at, fired_at, missed, next_due_at, fired_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(pendingFiringId, id, result.occurrenceAt, firedAt, missed ? 1 : 0, result.nextDueAt ?? null, result.reminder.firedCount, now);
        return { ...result, pendingFiringId };
      });
      emit({ type: 'upsert', reminder: firing.reminder });
      return firing;
    },

    pendingFirings(): ReminderFiring[] {
      type PRow = Record<string, unknown>;
      const rows = db.prepare('SELECT * FROM pending_firings ORDER BY created_at ASC').all() as PRow[];
      const result: ReminderFiring[] = [];
      const staleIds: string[] = [];
      for (const pRow of rows) {
        const reminderId = pRow.reminder_id as string;
        const current = get(reminderId);
        if (!current || current.status === 'completed' || current.status === 'cancelled') {
          staleIds.push(pRow.id as string);
          continue;
        }
        // Reconstruct the reminder state at the time of this specific firing so that
        // replayed firings carry the correct firedCount, lastFiredAt and dueAt for
        // their occurrence rather than the current (post-all-firings) state.
        const nextDueAt = toNumOrNull(pRow.next_due_at);
        const storedFiredCount = pRow.fired_count as number | null;
        const reminder: Reminder = {
          ...current,
          firedCount: storedFiredCount ?? current.firedCount,
          lastFiredAt: toNum(pRow.fired_at),
          dueAt: nextDueAt ?? current.dueAt,
          // status reflects the reminder state immediately after this firing
          status: nextDueAt !== null ? 'scheduled' : 'fired',
          updatedAt: toNum(pRow.created_at),
        };
        result.push({
          reminder,
          occurrenceAt: toNum(pRow.occurrence_at),
          firedAt: toNum(pRow.fired_at),
          missed: Boolean(pRow.missed),
          nextDueAt,
          pendingFiringId: pRow.id as string,
        });
      }
      for (const staleId of staleIds) {
        db.prepare('DELETE FROM pending_firings WHERE id = ?').run(staleId);
      }
      return result;
    },

    clearPendingFiring(id: string): void {
      db.prepare('DELETE FROM pending_firings WHERE id = ?').run(id);
    },

    onChange(listener: (event: ChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    clearMessageLinks(messageIds: string[]): void {
      if (!messageIds.length) return;
      const now = clock();
      const affected = db.transaction(() => {
        const reminders: Reminder[] = [];
        // Range deletions are unbounded; keep each query within SQLite's parameter limit.
        for (let i = 0; i < messageIds.length; i += 500) {
          const ids = messageIds.slice(i, i + 500);
          const placeholders = ids.map(() => '?').join(', ');
          reminders.push(...(db.prepare(`SELECT * FROM reminders WHERE message_id IN (${placeholders})`).all(...ids) as Row[]).map(toReminder));
          db.prepare(`UPDATE reminders SET message_id = NULL, updated_at = ? WHERE message_id IN (${placeholders})`)
            .run(now, ...ids);
        }
        return reminders;
      });
      for (const reminder of affected) emit({ type: 'upsert', reminder: { ...reminder, messageId: null, updatedAt: now } });
    },
  };
}
