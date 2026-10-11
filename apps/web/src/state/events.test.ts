import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import type { Reminder, ServerEvent } from '@neo/protocol';
import { DEFAULT_SETTINGS } from '@neo/protocol';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { EventSequencer, handleServerEvent, runReminderAction, type EventContext } from './events.js';
import { useConversations } from './conversations.js';
import { useData } from './data.js';
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
  conversationId: null,
  createdAt: 0,
  updatedAt: 0,
};

function fakeClient() {
  return {
    reminders: {
      snooze: vi.fn(async (id: string) => ({ ...reminder, id, status: 'scheduled' as const, dueAt: 9999 })),
      complete: vi.fn(async (id: string) => ({ ...reminder, id, status: 'completed' as const })),
    },
    memory: { stats: vi.fn(async () => ({ pending: 3 })) },
  };
}

function context(over: Partial<EventContext> = {}) {
  const client = fakeClient();
  const ctx: EventContext = {
    client: client as unknown as NeoClient,
    t,
    locale: 'en',
    assistantName: () => 'NEO',
    activeConversationId: () => null,
    openLink: vi.fn(),
    syncReminders: vi.fn(),
    debounce: (_key, fn) => fn(),
    ...over,
  };
  useSession.setState({ client: ctx.client });
  return { ctx, client };
}

beforeEach(() => {
  useConversations.setState({ conversations: {}, entries: {}, listLoaded: false, archivedLoaded: false });
  useData.setState({ reminders: {}, tasks: {}, notes: {}, memoryVersion: 0, pendingMemories: 0, notifications: [], unreadNotifications: 0 });
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
  it('routes agent events to the conversation cache', () => {
    const { ctx } = context();
    handleServerEvent(
      {
        type: 'turn.started',
        conversationId: 'conv_1',
        turnId: 'turn_1',
        userMessage: { id: 'msg_u', conversationId: 'conv_1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1, status: 'complete' },
        assistantMessageId: 'msg_a',
        model: { provider: 'demo', model: 'neo-demo' },
      },
      ctx,
    );
    expect(useConversations.getState().entries.conv_1!.turn?.turnId).toBe('turn_1');
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
    expect(ctx.syncReminders).toHaveBeenCalledTimes(2);
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

  it('tool.confirmation for another conversation shows a review toast; resolution removes it', () => {
    const { ctx } = context({ activeConversationId: () => 'conv_other' });
    const confirmation = { id: 'cnf_1', conversationId: 'conv_1', turnId: 't', messageId: 'm', toolCallId: 'tc_1', name: 'forget', title: 'Forget', input: {}, description: 'Forget 2 memories', risk: 'dangerous' as const, requestedAt: 0, expiresAt: 1 };
    handleServerEvent({ type: 'tool.confirmation', conversationId: 'conv_1', turnId: 't', confirmation }, ctx);
    expect(useConversations.getState().entries.conv_1!.confirmations).toHaveLength(1);
    const toast = useToasts.getState().toasts[0]!;
    expect(toast.body).toBe('Forget 2 memories');
    expect(toast.key).toBe('confirm:cnf_1');
    void toast.actions![0]!.onClick();
    expect(ctx.openLink).toHaveBeenCalledWith('neo://chat/conv_1');
    handleServerEvent({ type: 'tool.confirmation_resolved', conversationId: 'conv_1', turnId: 't', toolCallId: 'tc_1', approved: true, reason: 'user' }, ctx);
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(useConversations.getState().entries.conv_1!.confirmations).toHaveLength(0);
  });

  it('no toast for a confirmation in the conversation on screen', () => {
    const { ctx } = context({ activeConversationId: () => 'conv_1' });
    const confirmation = { id: 'cnf_2', conversationId: 'conv_1', turnId: 't', messageId: 'm', toolCallId: 'tc_1', name: 'forget', title: 'Forget', input: {}, description: 'x', risk: 'dangerous' as const, requestedAt: 0, expiresAt: 1 };
    handleServerEvent({ type: 'tool.confirmation', conversationId: 'conv_1', turnId: 't', confirmation }, ctx);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('memory.written with pending items refreshes the badge and offers a review', async () => {
    const { ctx, client } = context();
    handleServerEvent({ type: 'memory.written', conversationId: 'conv_1', turnId: 't', created: [], updated: [], pending: [{ id: 'mem_1', kind: 'fact', label: 'Vegetarian', status: 'pending' }] }, ctx);
    await vi.waitFor(() => expect(useData.getState().pendingMemories).toBe(3));
    expect(client.memory.stats).toHaveBeenCalled();
    expect(useToasts.getState().toasts[0]!.title).toBe('NEO wants to remember 1 thing');
    expect(useConversations.getState().entries.conv_1!.notices.t).toBeTruthy();
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

  it('conversation.deleted removes the conversation', () => {
    const { ctx } = context();
    useConversations.setState({ conversations: { conv_9: { id: 'conv_9' } as never } });
    handleServerEvent({ type: 'conversation.deleted', conversationId: 'conv_9' }, ctx);
    expect(useConversations.getState().conversations.conv_9).toBeUndefined();
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
