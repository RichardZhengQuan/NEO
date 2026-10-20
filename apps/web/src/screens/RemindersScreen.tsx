/**
 * Reminders NEO set for you: due now, upcoming by day, done. Snooze /
 * complete / edit / delete, an editor that understands the user's timezone
 * and repeats, and a nudge to turn on notifications. There is no manual add:
 * you ask NEO ("remind me to stretch in 30 minutes").
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { RecurrenceInput, Reminder } from '@neo/protocol';
import {
  Button,
  Chip,
  EmptyState,
  Icon,
  IconButton,
  Modal,
  Select,
  Skeleton,
  TextArea,
  TextField,
  dayKey,
  formatDate,
  formatRelative,
  formatTime,
  useConfirm,
  useLocale,
  useT,
} from '@neo/ui';
import { Menu } from '../components/Menu.js';
import { PageHeader } from '../components/PageHeader.js';
import { errorMessage } from '../lib/errors.js';
import { describeRecurrence, presetOf, preserveRecurrence, recurrenceFor, weekdayName, type RepeatPreset } from '../lib/recurrence.js';
import { fromLocalInputValue, listTimeZones, nextTimeOfDay, toLocalInputValue, tomorrowAt, wallTimeOf } from '../lib/time.js';
import { getPlatform, type NotificationStatus } from '../platform/index.js';
import { loadReminders, removeReminder, upsertReminder, useData } from '../state/data.js';
import { runReminderAction } from '../state/events.js';
import { pushToast } from '../state/notifications.js';
import { currentSessionEpoch, isCurrentSession, requireClient, useSession } from '../state/session.js';

const ACTIVE = new Set<Reminder['status']>(['scheduled', 'fired']);

export function ReminderEditor({ reminder, open, onClose }: { reminder: Reminder; open: boolean; onClose: () => void }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const [timezone, setTimezone] = useState(reminder.timezone);
  const [title, setTitle] = useState(reminder.title);
  const [notes, setNotes] = useState(reminder.notes ?? '');
  const [due, setDue] = useState(() => toLocalInputValue(reminder.dueAt, reminder.timezone));
  const [preset, setPreset] = useState<RepeatPreset>(presetOf(reminder.recurrence));
  const presetChanged = preset !== presetOf(reminder.recurrence);
  const [interval, setInterval] = useState(reminder.recurrence?.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(reminder.recurrence?.byWeekday ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => listTimeZones(), []);
  const serverRef = useRef({
    title: reminder.title,
    notes: reminder.notes ?? '',
    timezone: reminder.timezone,
    due: toLocalInputValue(reminder.dueAt, reminder.timezone),
    preset: presetOf(reminder.recurrence) as RepeatPreset,
    interval: reminder.recurrence?.interval ?? 1,
    weekdays: (reminder.recurrence?.byWeekday ?? []) as number[],
  });

  // Remote edits (another device) resync untouched fields when the server version advances.
  useEffect(() => {
    const prev = serverRef.current;
    const next = {
      title: reminder.title,
      notes: reminder.notes ?? '',
      timezone: reminder.timezone,
      due: toLocalInputValue(reminder.dueAt, reminder.timezone),
      preset: presetOf(reminder.recurrence) as RepeatPreset,
      interval: reminder.recurrence?.interval ?? 1,
      weekdays: (reminder.recurrence?.byWeekday ?? []) as number[],
    };
    serverRef.current = next;
    // Only resync a field if the user hasn't edited it since the last server sync.
    setTitle((curr) => (curr === prev.title ? next.title : curr));
    setNotes((curr) => (curr === prev.notes ? next.notes : curr));
    setTimezone((curr) => (curr === prev.timezone ? next.timezone : curr));
    setDue((curr) => (curr === prev.due ? next.due : curr));
    setPreset((curr) => (curr === prev.preset ? next.preset : curr));
    setInterval((curr) => (curr === prev.interval ? next.interval : curr));
    setWeekdays((curr) =>
      curr.length === prev.weekdays.length && curr.every((d, i) => d === prev.weekdays[i])
        ? next.weekdays
        : curr,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminder.updatedAt]);
  const dueAt = fromLocalInputValue(due, timezone);
  const weekday = dueAt ? wallTimeOf(dueAt, timezone).weekday : 1;
  const generated = recurrenceFor(preset, { interval, weekdays, weekday });
  const recurrence: RecurrenceInput | null = presetChanged ? generated : preserveRecurrence(reminder.recurrence, generated);

  const quick = (ms: number) => setDue(toLocalInputValue(ms, timezone));
  const now = Date.now();

  const save = async () => {
    const epoch = currentSessionEpoch();
    if (!title.trim() || dueAt === null) {
      setError(t('reminders.error_required'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const client = requireClient();
      const body = { title: title.trim(), notes: notes.trim() || null, dueAt, timezone, recurrence };
      const saved = await client.reminders.update(reminder.id, { ...body, ...(reminder.status !== 'scheduled' && dueAt > Date.now() ? { status: 'scheduled' as const } : {}) });
      if (!isCurrentSession(epoch)) return;
      upsertReminder(saved);
      void getPlatform().syncReminders(client);
      pushToast({ tone: 'success', title: t('reminders.saved') });
      onClose();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('reminders.edit')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="check" onClick={() => void save()} loading={saving} disabled={!title.trim() || dueAt === null}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label={t('reminders.title')} value={title} onChange={setTitle} required maxLength={500} placeholder={t('reminders.title_placeholder')} autoFocus />
        <div className="neo-field">
          <TextField label={t('reminders.when')} type="datetime-local" value={due} onChange={setDue} required help={dueAt && dueAt < now ? t('reminders.in_past') : dueAt ? formatRelative(dueAt, locale) : undefined} />
          <div className="neo-tags" style={{ marginTop: '0.25rem' }}>
            <Chip size="sm" onClick={() => quick(now + 30 * 60_000)}>
              {t('reminders.quick_30m')}
            </Chip>
            <Chip size="sm" onClick={() => quick(now + 60 * 60_000)}>
              {t('reminders.quick_1h')}
            </Chip>
            <Chip size="sm" onClick={() => quick(nextTimeOfDay(20, 0, now, timezone))}>
              {t('reminders.quick_tonight')}
            </Chip>
            <Chip size="sm" onClick={() => quick(tomorrowAt(9, 0, now, timezone))}>
              {t('reminders.quick_tomorrow')}
            </Chip>
          </div>
        </div>
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' }}>
          <Select
            label={t('reminders.repeat')}
            value={preset}
            onChange={(v) => { setPreset(v as RepeatPreset); }}
            options={(['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'] as const).map((p) => ({ value: p, label: t(`reminders.repeat_${p}`) }))}
          />
          {preset !== 'none' && preset !== 'weekdays' && (
            <TextField label={t('reminders.every')} type="number" inputMode="numeric" min={1} max={1000} value={String(interval)} onChange={(v) => setInterval(Math.max(1, Number(v) || 1))} help={describeRecurrence(recurrence, t, locale)} />
          )}
        </div>
        {preset === 'weekly' && (
          <div className="neo-field">
            <span className="neo-label">{t('reminders.on_days')}</span>
            <div className="neo-tags" role="group" aria-label={t('reminders.on_days')}>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <Chip key={d} size="sm" pressed={weekdays.includes(d)} onClick={() => setWeekdays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))}>
                  {weekdayName(d, locale)}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <TextArea label={t('reminders.notes')} value={notes} onChange={setNotes} rows={2} maxLength={5000} placeholder={t('reminders.notes_placeholder')} />
        <Select label={t('reminders.timezone')} value={timezone} onChange={setTimezone} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} help={t('reminders.timezone_help')} />
        {error && (
          <p className="neo-error-text" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ReminderRow({ reminder, highlight, onEdit }: { reminder: Reminder; highlight: boolean; onEdit: () => void }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const ref = useRef<HTMLLIElement>(null);
  const [busy, setBusy] = useState(false);
  const active = ACTIVE.has(reminder.status);
  const tz = reminder.timezone;

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  const snooze = async (minutes: number) => {
    setBusy(true);
    await runReminderAction(requireClient(), reminder.id, 'snooze', t, minutes);
    setBusy(false);
  };
  const complete = async () => {
    setBusy(true);
    await runReminderAction(requireClient(), reminder.id, 'done', t);
    setBusy(false);
  };
  const remove = async () => {
    const epoch = currentSessionEpoch();
    const ok = await confirm({ title: t('reminders.delete_title'), message: t('reminders.delete_text', { title: reminder.title }), confirmLabel: t('common.delete'), danger: true });
    if (!ok || !isCurrentSession(epoch)) return;
    try {
      await requireClient().reminders.delete(reminder.id);
      if (!isCurrentSession(epoch)) return;
      removeReminder(reminder.id);
      void getPlatform().syncReminders(requireClient());
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };
  const tomorrowMinutes = Math.min(60 * 24 * 30, Math.max(1, Math.ceil((tomorrowAt(9, 0, Date.now(), tz) - Date.now()) / 60_000)));

  return (
    <li ref={ref} className="row" data-highlight={highlight || undefined} id={`reminder-${reminder.id}`}>
      <span className="neo-card__icon" style={reminder.status === 'fired' ? { background: 'var(--neo-tone-warning-bg)', color: 'var(--neo-tone-warning-text)' } : active ? { background: 'var(--neo-accent-muted)', color: 'var(--neo-accent-text)' } : undefined}>
        <Icon name={reminder.status === 'fired' ? 'bell-ring' : active ? 'bell' : 'check'} size={16} />
      </span>
      <div className="row__main">
        <div className="row__title" style={!active ? { color: 'var(--neo-text-muted)', textDecoration: 'line-through' } : undefined}>
          {reminder.title}
        </div>
        <div className="row__meta">
          <span>
            {formatTime(reminder.dueAt, locale, tz)}
            {active && ` · ${formatRelative(reminder.dueAt, locale)}`}
          </span>
          {reminder.recurrence && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <Icon name="repeat" size={12} />
              {describeRecurrence(reminder.recurrence, t, locale)}
            </span>
          )}
          {reminder.status === 'fired' && <span style={{ color: 'var(--neo-tone-warning-text)', fontWeight: 600 }}>{t('reminder.status.fired')}</span>}
        </div>
        {reminder.notes && (
          <div className="neo-help" style={{ marginTop: '0.25rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {reminder.notes}
          </div>
        )}
      </div>
      {active && <IconButton icon="check" label={t('reminders.mark_done', { title: reminder.title })} variant="secondary" size="sm" loading={busy} onClick={() => void complete()} />}
      <Menu
        label={t('reminders.actions', { title: reminder.title })}
        items={[
          { label: t('reminder.snooze_10'), icon: 'alarm-clock', onSelect: () => void snooze(10), hidden: !active },
          { label: t('reminder.snooze_60'), icon: 'alarm-clock', onSelect: () => void snooze(60), hidden: !active },
          { label: t('reminders.snooze_tomorrow'), icon: 'calendar', onSelect: () => void snooze(tomorrowMinutes), hidden: !active },
          { label: t('common.edit'), icon: 'edit', onSelect: onEdit, separated: active },
          { label: t('common.delete'), icon: 'trash', danger: true, onSelect: () => void remove() },
        ]}
      />
    </li>
  );
}

function NotificationNudge(): ReactElement | null {
  const t = useT();
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const platform = getPlatform();
  useEffect(() => {
    void platform.notificationStatus(requireClient()).then(setStatus).catch(() => undefined);
  }, [platform]);
  if (!status || status.enabled || status.reason === 'no-vapid' || status.reason === 'unsupported' || status.permission === 'denied') return null;
  return (
    <div className="neo-callout" data-tone="accent" style={{ alignItems: 'center', marginBottom: '1rem' }}>
      <span className="neo-callout__icon">
        <Icon name="bell" size={17} />
      </span>
      <p style={{ margin: 0, flex: 1, fontSize: '0.875rem' }}>{status.reason ? t(`notify.reason.${status.reason}`) : t('reminders.nudge')}</p>
      {!status.reason && (
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void platform
              .enableNotifications(requireClient())
              .then(setStatus)
              .finally(() => setBusy(false));
          }}
        >
          {t('notify.enable')}
        </Button>
      )}
    </div>
  );
}

export function RemindersScreen({ highlightId }: { highlightId?: string }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const reminders = useData((s) => s.reminders);
  const loaded = useData((s) => s.remindersLoaded);
  const timeZone = useSession((s) => s.settings?.timezone);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    void loadReminders(requireClient()).catch((err) => pushToast({ tone: 'error', title: errorMessage(err, t) }));
    // Relative times ("in 5 minutes") stay fresh.
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [t]);

  const all = Object.values(reminders);
  const now = Date.now();
  const due = all.filter((r) => r.status === 'fired' || (r.status === 'scheduled' && r.dueAt <= now)).sort((a, b) => a.dueAt - b.dueAt);
  const upcoming = all.filter((r) => r.status === 'scheduled' && r.dueAt > now).sort((a, b) => a.dueAt - b.dueAt);
  const done = all.filter((r) => !ACTIVE.has(r.status)).sort((a, b) => (b.lastFiredAt ?? b.updatedAt) - (a.lastFiredAt ?? a.updatedAt));

  const today = dayKey(now, timeZone);
  const tomorrow = dayKey(now + 86_400_000, timeZone);
  const byDay = new Map<string, Reminder[]>();
  for (const r of upcoming) {
    const k = dayKey(r.dueAt, timeZone);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  const dayLabel = (k: string, sample: Reminder) => (k === today ? t('reminders.today') : k === tomorrow ? t('reminders.tomorrow') : formatDate(sample.dueAt, locale, timeZone, 'full'));
  const highlightDone = Boolean(highlightId && done.some((r) => r.id === highlightId));

  const list = (items: Reminder[]) => (
    <ul className="row-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((r) => (
        <ReminderRow key={r.id} reminder={r} highlight={r.id === highlightId} onEdit={() => setEditing(r)} />
      ))}
    </ul>
  );

  return (
    <div className="page">
      <PageHeader title={t('nav.reminders')} />
      <div className="page-body">
        <div className="page-inner">
          <NotificationNudge />
          {!loaded ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <Skeleton height={64} />
              <Skeleton height={64} />
              <Skeleton height={64} />
            </div>
          ) : due.length === 0 && upcoming.length === 0 && done.length === 0 ? (
            <EmptyState icon="bell" title={t('reminders.empty_title')} description={t('reminders.empty_text')} />
          ) : (
            <>
              {due.length > 0 && (
                <section>
                  <h2 className="group-title">{t('reminders.due_now')}</h2>
                  {list(due)}
                </section>
              )}
              {[...byDay.entries()].map(([k, items]) => (
                <section key={k}>
                  <h2 className="group-title">{dayLabel(k, items[0]!)}</h2>
                  {list(items)}
                </section>
              ))}
              {upcoming.length === 0 && due.length === 0 && <p className="neo-help">{t('reminders.nothing_upcoming')}</p>}
              {done.length > 0 && (
                <section>
                  <button type="button" className="nav-item" aria-expanded={showDone || highlightDone} onClick={() => setShowDone((v) => !v)} style={{ marginTop: '1rem' }}>
                    <Icon name={showDone || highlightDone ? 'chevron-down' : 'chevron-right'} size={15} />
                    {t('reminders.done_count', { n: done.length })}
                  </button>
                  {(showDone || highlightDone) && list(done.slice(0, 100))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {editing && <ReminderEditor key={editing.id} reminder={reminders[editing.id] ?? editing} open onClose={() => setEditing(null)} />}
    </div>
  );
}
