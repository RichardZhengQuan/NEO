/**
 * The one place server events are applied to app state.
 *
 * Agent events and conversation events go through the pure conversation
 * reducer; productivity, memory, notification and settings events update
 * their stores; a few produce toasts (reminders firing, approvals needed in a
 * conversation you are not looking at). `EventSequencer` detects gaps in the
 * WebSocket `seq` so the app can refetch what it missed.
 */
import type { NeoClient } from '@neo/client';
import type { ServerEvent } from '@neo/protocol';
import { formatTime, type TranslateFn } from '@neo/ui';
import { applyConversationEvent, findConfirmation } from './conversations.js';
import { addNotification, bumpMemoryVersion, refreshPendingMemories, removeNote, removeReminder, removeTask, upsertNote, upsertReminder, upsertTask } from './data.js';
import { dismissToastKey, pushToast } from './notifications.js';
import { currentSessionEpoch, isCurrentSession, setSettings } from './session.js';

export interface EventContext {
  client: NeoClient;
  t: TranslateFn;
  locale: string;
  /** The persona's name, for messages like "Nova wants to remember…". */
  assistantName(): string;
  /** Conversation currently on screen (toasts are skipped for it). */
  activeConversationId(): string | null;
  openLink(url: string): void;
  /** Re-plan on-device reminder notifications (debounced by the caller). */
  syncReminders(): void;
  /** Run `fn` after `ms`, coalescing calls with the same key. */
  debounce(key: string, fn: () => void, ms: number): void;
}

/** Detects missed events from the monotonic per-process `seq`. */
export class EventSequencer {
  private last = -1;

  /** Baseline after (re)connecting: the server's current seq from `ready`. */
  reset(seq: number): void {
    this.last = seq;
  }

  /** Record an event; returns true when one or more events were skipped. */
  observe(seq: number): boolean {
    if (this.last < 0) {
      this.last = seq;
      return false;
    }
    const gap = seq > this.last + 1;
    if (seq > this.last) this.last = seq;
    return gap;
  }

  get lastSeq(): number {
    return this.last;
  }
}

/** Snooze or complete a reminder from a toast, notification button or widget. */
export async function runReminderAction(client: NeoClient, reminderId: string, action: 'snooze' | 'done', t: TranslateFn, minutes = 10): Promise<void> {
  const epoch = currentSessionEpoch();
  try {
    const reminder = action === 'snooze' ? await client.reminders.snooze(reminderId, minutes) : await client.reminders.complete(reminderId);
    if (!isCurrentSession(epoch)) return;
    upsertReminder(reminder);
    dismissToastKey(`reminder:${reminderId}`);
    pushToast({ tone: 'success', title: action === 'snooze' ? t('toast.snoozed', { n: minutes }) : t('toast.reminder_done'), icon: action === 'snooze' ? 'alarm-clock' : 'check-circle' });
  } catch {
    if (!isCurrentSession(epoch)) return;
    pushToast({ tone: 'error', title: t('toast.reminder_action_failed') });
  }
}

export function handleServerEvent(event: ServerEvent, ctx: EventContext): void {
  const { t } = ctx;
  switch (event.type) {
    // ── conversations & turns ──
    case 'turn.started':
    case 'text.delta':
    case 'reasoning.delta':
    case 'part.added':
    case 'tool.started':
    case 'tool.finished':
    case 'memory.recalled':
    case 'message.completed':
    case 'turn.finished':
    case 'turn.failed':
    case 'conversation.updated':
    case 'conversation.deleted':
      applyConversationEvent(event);
      return;

    case 'tool.confirmation': {
      applyConversationEvent(event);
      const c = event.confirmation;
      if (ctx.activeConversationId() !== c.conversationId) {
        pushToast({
          tone: 'warning',
          key: `confirm:${c.id}`,
          icon: 'shield',
          title: t('toast.confirm_needed', { name: ctx.assistantName() }),
          body: c.description || c.title,
          duration: null,
          actions: [{ label: t('toast.review'), primary: true, onClick: () => ctx.openLink(`neo://chat/${c.conversationId}`) }],
        });
      }
      return;
    }

    case 'tool.confirmation_resolved': {
      const resolved = findConfirmation(event.conversationId, event.turnId, event.toolCallId, event.confirmationId);
      applyConversationEvent(event);
      if (resolved) dismissToastKey(`confirm:${resolved.id}`);
      return;
    }

    case 'memory.written':
      applyConversationEvent(event);
      if (event.pending.length) {
        ctx.debounce('pending-memories', () => void refreshPendingMemories(ctx.client), 300);
        if (ctx.activeConversationId() !== event.conversationId) {
          pushToast({
            tone: 'memory',
            key: `memory:${event.turnId}`,
            icon: 'brain',
            title: t('toast.memory_pending', { n: event.pending.length, name: ctx.assistantName() }),
            body: event.pending.map((p) => p.label).slice(0, 3).join(' · '),
            duration: 9000,
            actions: [{ label: t('toast.review'), primary: true, onClick: () => ctx.openLink('neo://memory/pending') }],
          });
        }
      }
      return;

    // ── reminders ──
    case 'reminder.fired': {
      const { reminder, missed, occurrenceAt } = event.firing;
      upsertReminder(reminder);
      ctx.syncReminders();
      const when = formatTime(occurrenceAt, ctx.locale, reminder.timezone);
      pushToast({
        tone: 'reminder',
        key: `reminder:${reminder.id}`,
        icon: 'bell-ring',
        title: reminder.title,
        body: missed ? t('toast.reminder_missed', { time: when }) : reminder.notes?.trim() || t('toast.reminder_now'),
        duration: null,
        actions: [
          { label: t('reminder.snooze_10'), onClick: () => runReminderAction(ctx.client, reminder.id, 'snooze', t) },
          { label: t('reminder.done'), primary: true, onClick: () => runReminderAction(ctx.client, reminder.id, 'done', t) },
        ],
      });
      return;
    }
    case 'reminder.updated':
      upsertReminder(event.reminder);
      if (event.reminder.status === 'completed' || event.reminder.status === 'cancelled') dismissToastKey(`reminder:${event.reminder.id}`);
      ctx.syncReminders();
      return;
    case 'reminder.deleted':
      removeReminder(event.reminderId);
      dismissToastKey(`reminder:${event.reminderId}`);
      ctx.syncReminders();
      return;

    // ── tasks & notes ──
    case 'task.updated':
      upsertTask(event.task);
      return;
    case 'task.deleted':
      removeTask(event.taskId);
      return;
    case 'note.updated':
      upsertNote(event.note);
      return;
    case 'note.deleted':
      removeNote(event.noteId);
      return;

    // ── memory, notifications, settings ──
    case 'memory.changed':
      ctx.debounce('memory-version', bumpMemoryVersion, 250);
      if (event.change.type === 'pending' || event.change.type === 'updated' || event.change.type === 'deleted' || event.change.type === 'created') {
        ctx.debounce('pending-memories', () => void refreshPendingMemories(ctx.client), 500);
      }
      return;
    case 'notification.created':
      addNotification(event.notification);
      if (event.notification.kind === 'system') pushToast({ tone: 'info', title: event.notification.title, body: event.notification.body });
      return;
    case 'settings.updated':
      setSettings(event.settings);
      return;

    default:
      return;
  }
}
