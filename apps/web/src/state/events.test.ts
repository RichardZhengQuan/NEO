import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import type { Reminder, ServerEvent } from '@neo/protocol';
import { DEFAULT_SETTINGS, type ProviderView } from '@neo/protocol';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { EventSequencer, handleServerEvent, runReminderAction, type EventContext } from './events.js';
import { emptyEntry, useTimeline } from './timeline.js';
import { loadReminders, refreshLoadedData, useData } from './data.js';
import { useToasts } from './notifications.js';
import { useSession } from './session.js';

const t = createTranslator('en', buildMessages('en', appDictionaries));

const reminder: Reminder = {
  id: 'rem_1',
  title: 'Stretch',
  notes: null,
  dueAt: 1000,
  timezone: 'UTC',
  recurrence: null,
  status: 'fired',
  firedCount: 1,
  lastFiredAt: 1000,
  messageId: null,
  createdAt: 0,
  updatedAt: 0,
};

function fakeClient() {
  return {
    reminders: {
      list: vi.fn(async () => ({ items: [reminder], nextCursor: null })),
      snooze: vi.fn(async (id: string) => ({ ...reminder, id, status: 'scheduled' as const, dueAt: 9999 })),
      complete: vi.fn(async (id: string) => ({ ...reminder, id, status: 'completed' as const })),
    },
  };
}

function context(over: Partial<EventContext> = {}) {
  const client = fakeClient();
  const ctx: EventContext = {
    client: client as unknown as NeoClient,
    t,
    locale: 'en',
    assistantName: () => 'NEO',
    timelineActive: () => false,
    openLink: vi.fn(),
    syncReminders: vi.fn(),
    debounce: (_key, fn) => fn(),
    ...over,
  };
  useSession.setState({ client: ctx.client });
  return { ctx, client };
}

beforeEach(() => {
  useTimeline.setState(emptyEntry(), true);
  useData.setState({ reminders: {}, reminderDeletions: {}, tasks: {}, notes: {}, memoryVersion: 0, notifications: [], unreadNotifications: 0 });
  useToasts.setState({ toasts: [] });
  useSession.setState({ settings: null });
});
afterEach(() => vi.restoreAllMocks());

describe('EventSequencer', () => {
  it('detects gaps after a baseline', () => {
    const s = new EventSequencer();
    s.reset(10);
    expect(s.observe(11)).toBe(false);
    expect(s.observe(12)).toBe(false);
    expect(s.observe(15)).toBe(true);
    expect(s.observe(16)).toBe(false);
    expect(s.lastSeq).toBe(16);
  });
  it('ignores duplicates and starts from the first event without a baseline', () => {
    const s = new EventSequencer();
    expect(s.observe(40)).toBe(false);
    expect(s.observe(40)).toBe(false);
    expect(s.observe(41)).toBe(false);
  });
});

describe('handleServerEvent', () => {
  it('routes agent events to the single timeline', () => {
    const { ctx } = context();
    handleServerEvent(
      {
        type: 'turn.started',
        episodeId: 'conv_1', conversationId: 'conv_1',
        turnId: 'turn_1',
        userMessage: { id: 'msg_u', episodeId: 'conv_1', conversationId: 'conv_1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1, status: 'complete' },
        assistantMessageId: 'msg_a',
        model: { provider: 'test', model: 'neo-test' },
      },
      ctx,
    );
    expect(useTimeline.getState().turn?.turnId).toBe('turn_1');
  });

  it('reminder.fired stores the reminder, re-plans local notifications and shows an actionable toast', async () => {
    const { ctx, client } = context();
    handleServerEvent({ type: 'reminder.fired', firing: { reminder, occurrenceAt: 1000, firedAt: 1000, missed: false, nextDueAt: null } }, ctx);
    expect(useData.getState().reminders.rem_1).toEqual(reminder);
    expect(ctx.syncReminders).toHaveBeenCalled();
    const [toast] = useToasts.getState().toasts;
    expect(toast).toMatchObject({ tone: 'reminder', title: 'Stretch', key: 'reminder:rem_1', duration: null });
    expect(toast!.actions!.map((a) => a.label)).toEqual(['Snooze 10 min', 'Done']);
    await toast!.actions![0]!.onClick();
    expect(client.reminders.snooze).toHaveBeenCalledWith('rem_1', 10);
    expect(useToasts.getState().toasts.some((x) => x.key === 'reminder:rem_1')).toBe(false);
    expect(useData.getState().reminders.rem_1!.status).toBe('scheduled');
  });

  it('missed reminders say so', () => {
    const { ctx } = context();
    handleServerEvent({ type: 'reminder.fired', firing: { reminder, occurrenceAt: 0, firedAt: 1000, missed: true, nextDueAt: null } }, ctx);
    expect(useToasts.getState().toasts[0]!.body).toMatch(/missed/i);
  });

  it('reminder.updated / deleted keep the cache and resync', () => {
    const { ctx } = context();
    handleServerEvent({ type: 'reminder.updated', reminder: { ...reminder, status: 'completed' } }, ctx);
    expect(useData.getState().reminders.rem_1!.status).toBe('completed');
    handleServerEvent({ type: 'reminder.deleted', reminderId: 'rem_1' }, ctx);
    expect(useData.getState().reminders.rem_1).toBeUndefined();
    expect(useData.getState().reminderDeletions.rem_1).toBe(true);
    expect(ctx.syncReminders).toHaveBeenCalledTimes(2);
    handleServerEvent({ type: 'reminder.updated', reminder }, ctx);
    expect(useData.getState().reminderDeletions.rem_1).toBeUndefined();
    expect(useData.getState().reminders.rem_1).toEqual(reminder);
  });

  it('keeps known deletions when a reminder list response still includes the old item', async () => {
    const { ctx } = context();
    handleServerEvent({ type: 'reminder.deleted', reminderId: 'rem_1' }, ctx);
    await loadReminders(ctx.client);
    expect(useData.getState().reminders.rem_1).toBeUndefined();
    expect(useData.getState().reminderDeletions.rem_1).toBe(true);
  });

  it('remindersLoaded is true after any successful load; remindersComplete is true only when fewer than 500 items', async () => {
    const { ctx, client } = context();
    // Partial list: fewer than MAX_PAGE items → list is complete
    client.reminders.list.mockResolvedValueOnce({ items: [reminder], nextCursor: null });
    await loadReminders(ctx.client);
    expect(useData.getState().remindersLoaded).toBe(true);
    expect(useData.getState().remindersComplete).toBe(true);

    // Reset state
    useData.setState({ reminders: {}, reminderDeletions: {}, remindersLoaded: false, remindersComplete: false });

    // Full page: exactly 500 items → list may be truncated; still marks as loaded (for reconnect), but not complete
    const fullPage = Array.from({ length: 500 }, (_, i) => ({ ...reminder, id: `rem_${i}` }));
    client.reminders.list.mockResolvedValueOnce({ items: fullPage, nextCursor: null });
    await loadReminders(ctx.client);
    expect(useData.getState().remindersLoaded).toBe(true);
    expect(useData.getState().remindersComplete).toBe(false);
  });

  it('refreshLoadedData reloads reminders when 500+ were loaded (reconnect does not skip)', async () => {
    const { ctx, client } = context();
    // Seed state as if we already loaded 500+ reminders
    const fullPage = Array.from({ length: 500 }, (_, i) => ({ ...reminder, id: `rem_${i}` }));
    client.reminders.list.mockResolvedValueOnce({ items: fullPage, nextCursor: null });
    await loadReminders(ctx.client);
    expect(useData.getState().remindersLoaded).toBe(true);
    expect(useData.getState().remindersComplete).toBe(false);

    // Now simulate a reconnect: refreshLoadedData should call loadReminders again
    const refreshPage = Array.from({ length: 10 }, (_, i) => ({ ...reminder, id: `rem_${i}` }));
    client.reminders.list.mockResolvedValueOnce({ items: refreshPage, nextCursor: null });
    await refreshLoadedData(ctx.client);
    // loadReminders was called again (once for initial load, once for refresh)
    expect(client.reminders.list).toHaveBeenCalledTimes(2);
  });

  it('task and note events update their caches', () => {
    const { ctx } = context();
    const task = { id: 'task_1', listId: 'list_inbox', title: 'Milk', notes: null, done: false, doneAt: null, dueAt: null, priority: 0, tags: [], order: 0, parentId: null, createdAt: 0, updatedAt: 0 };
    handleServerEvent({ type: 'task.updated', task }, ctx);
    expect(useData.getState().tasks.task_1).toEqual(task);
    handleServerEvent({ type: 'task.deleted', taskId: 'task_1' }, ctx);
    expect(useData.getState().tasks.task_1).toBeUndefined();
    const note = { id: 'note_1', title: 'N', content: '', tags: [], pinned: false, createdAt: 0, updatedAt: 0 };
    handleServerEvent({ type: 'note.updated', note }, ctx);
    expect(useData.getState().notes.note_1).toEqual(note);
    handleServerEvent({ type: 'note.deleted', noteId: 'note_1' }, ctx);
    expect(useData.getState().notes.note_1).toBeUndefined();
  });

  it('tool.confirmation away from the timeline shows a review toast; resolution removes it', () => {
    const { ctx } = context({ timelineActive: () => false });
    const confirmation = { id: 'cnf_1', episodeId: 'conv_1', conversationId: 'conv_1', turnId: 't', messageId: 'm', toolCallId: 'tc_1', name: 'forget', title: 'Forget', input: {}, description: 'Forget 2 memories', risk: 'dangerous' as const, requestedAt: 0, expiresAt: 1 };
    handleServerEvent({ type: 'tool.confirmation', episodeId: 'conv_1', conversationId: 'conv_1', turnId: 't', confirmation }, ctx);
    expect(useTimeline.getState().confirmations).toHaveLength(1);
    const toast = useToasts.getState().toasts[0]!;
    expect(toast.body).toBe('Forget 2 memories');
    expect(toast.key).toBe('confirm:cnf_1');
    void toast.actions![0]!.onClick();
    expect(ctx.openLink).toHaveBeenCalledWith('neo://timeline?messageId=m');
    handleServerEvent({ type: 'tool.confirmation_resolved', episodeId: 'conv_1', conversationId: 'conv_1', turnId: 't', toolCallId: 'tc_1', approved: true, reason: 'user' }, ctx);
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(useTimeline.getState().confirmations).toHaveLength(0);
  });

  it('no toast for a confirmation while the timeline is on screen', () => {
    const { ctx } = context({ timelineActive: () => true });
    const confirmation = { id: 'cnf_2', episodeId: 'conv_1', conversationId: 'conv_1', turnId: 't', messageId: 'm', toolCallId: 'tc_1', name: 'forget', title: 'Forget', input: {}, description: 'x', risk: 'dangerous' as const, requestedAt: 0, expiresAt: 1 };
    handleServerEvent({ type: 'tool.confirmation', episodeId: 'conv_1', conversationId: 'conv_1', turnId: 't', confirmation }, ctx);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('memory.changed bumps the memory version', () => {
    const { ctx } = context();
    handleServerEvent({ type: 'memory.changed', change: { type: 'consolidated', nodeIds: [] } }, ctx);
    expect(useData.getState().memoryVersion).toBe(1);
  });

  it('notification.created counts unread; system notifications toast', () => {
    const { ctx } = context();
    handleServerEvent({ type: 'notification.created', notification: { id: 'ntf_1', kind: 'system', title: 'Update', body: 'Hi', createdAt: 0, readAt: null, data: null } }, ctx);
    expect(useData.getState().unreadNotifications).toBe(1);
    expect(useToasts.getState().toasts[0]!.title).toBe('Update');
  });

  it('settings.updated replaces settings', () => {
    const { ctx } = context();
    handleServerEvent({ type: 'settings.updated', settings: { ...DEFAULT_SETTINGS, theme: 'dark' } } as ServerEvent, ctx);
    expect(useSession.getState().settings?.theme).toBe('dark');
  });

  it('replaces a reauthorized connection and clears its stale model cache', () => {
    const { ctx } = context();
    const provider: ProviderView = { id: 'chatgpt', kind: 'chatgpt', label: 'ChatGPT', enabled: true, hasApiKey: false, isLocal: false };
    useSession.setState({ providers: { items: [{ ...provider, needsReauthorization: true }], defaultModel: null }, models: { chatgpt: [] } });
    handleServerEvent({ type: 'provider.connected', provider }, ctx);
    expect(useSession.getState().providers?.items).toEqual([provider]);
    expect(useSession.getState().models.chatgpt).toBeUndefined();
  });

  it.each(['subscription_sharing_invalid_user', 'invalid_grant'])('refreshes account state after %s and ignores a stale session response', async (reason) => {
    let resolve!: (value: { items: ProviderView[]; defaultModel: null }) => void;
    const list = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    const { ctx } = context({ client: { providers: { list } } as unknown as NeoClient });
    useSession.setState({ providers: { items: [], defaultModel: null }, sessionEpoch: 1 });
    handleServerEvent({ type: 'turn.failed', episodeId: 'conv_1', conversationId: 'conv_1', turnId: 't', error: { code: 'provider_auth', message: 'Disconnected; sign in again.', details: { reason } } }, ctx);
    expect(list).toHaveBeenCalledOnce();
    useSession.setState({ sessionEpoch: 2 });
    resolve({ items: [{ id: 'chatgpt', kind: 'chatgpt', enabled: true, hasApiKey: false, isLocal: false, needsReauthorization: true }], defaultModel: null });
    await Promise.resolve();
    expect(useSession.getState().providers?.items).toEqual([]);
  });

  it('episode deletion removes its metadata', () => {
    const { ctx } = context();
    useTimeline.setState({ episodes: { conv_9: { episodeId: 'conv_9', startedAt: 1, offRecord: false } } });
    handleServerEvent({ type: 'conversation.deleted', episodeId: 'conv_9', conversationId: 'conv_9' }, ctx);
    expect(useTimeline.getState().episodes.conv_9).toBeUndefined();
  });
});

describe('runReminderAction', () => {
  it('completes and reports failures', async () => {
    const client = fakeClient();
    await runReminderAction(client as unknown as NeoClient, 'rem_1', 'done', t);
    expect(client.reminders.complete).toHaveBeenCalledWith('rem_1');
    expect(useToasts.getState().toasts.at(-1)!.tone).toBe('success');
    client.reminders.complete.mockRejectedValueOnce(new Error('offline'));
    await runReminderAction(client as unknown as NeoClient, 'rem_1', 'done', t);
    expect(useToasts.getState().toasts.at(-1)!.tone).toBe('error');
  });
});
