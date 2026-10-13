import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formSubmitActionId, newId, widgetActionId, type FormBlock, type Message, type ReminderBlock, type ToolDefinition } from '@neo/protocol';
import { ev, harness } from './fakes.test-utils.js';

function reminderFixture(permission: 'auto' | 'confirm' = 'auto') {
  const first: ReminderBlock = { type: 'reminder', reminderId: 'rem_first', title: 'First reminder', dueAt: 1000, status: 'scheduled' };
  const second: ReminderBlock = { type: 'reminder', reminderId: 'rem_second', title: 'Second reminder', dueAt: 2000, status: 'scheduled' };
  const storedReminders = new Map([first, second].map((block) => [block.reminderId, { id: block.reminderId, title: block.title, dueAt: block.dueAt, status: block.status }]));
  const execute = vi.fn(async ({ id }: { id: string }) => {
    const reminder = { ...storedReminders.get(id)!, status: 'completed' as const };
    storedReminders.set(id, reminder);
    return { output: { reminder }, summary: `Completed: ${reminder.title}` };
  });
  const complete: ToolDefinition = {
    name: 'complete_reminder', title: 'Complete reminder', description: 'Complete reminder',
    inputSchema: z.object({ id: z.string() }), risk: 'write', defaultPermission: permission, execute,
  };
  const h = harness({ tools: [complete] });
  const message: Message = {
    id: newId('msg'), conversationId: h.conv.id, turnId: newId('turn'), role: 'assistant', status: 'complete', createdAt: h.clock(),
    parts: [{ type: 'ui', id: 'ui_reminders', block: { type: 'card', children: [{ type: 'grid', columns: 2, children: [first, second] }] } }],
  };
  h.conversations.appendMessage(message);
  const input = { conversationId: h.conv.id, messageId: message.id, uiId: 'ui_reminders', actionId: widgetActionId.reminderComplete(second.reminderId) };
  return { ...h, message, input, first, second, storedReminders, execute };
}

describe('nested UI action targeting in the runtime', () => {
  it('completes the second reminder and leaves the first stored reminder and widget untouched', async () => {
    const h = reminderFixture();
    const firstBefore = structuredClone(h.storedReminders.get(h.first.reminderId));
    await expect(h.runtime.handleUiAction(h.input)).resolves.toMatchObject({ kind: 'tool', result: { output: { reminder: { id: h.second.reminderId, status: 'completed' } } } });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0]![0]).toEqual({ id: h.second.reminderId });
    expect(h.storedReminders.get(h.first.reminderId)).toEqual(firstBefore);
    expect(h.storedReminders.get(h.second.reminderId)?.status).toBe('completed');
    expect(h.conversations.getMessage(h.message.id)!.parts[0]).toEqual({
      type: 'ui', id: h.input.uiId, block: { type: 'card', children: [{ type: 'grid', columns: 2, children: [h.first, { ...h.second, status: 'completed' }] }] },
    });
    expect(h.events.filter((event) => event.type === 'part.added' && event.messageId === h.message.id).at(-1))
      .toMatchObject({ part: { block: { children: [{ children: [h.first, { ...h.second, status: 'completed' }] }] } } });
  });

  it('rejects legacy controls when two reminders are stored', async () => {
    const h = reminderFixture();
    for (const actionId of ['reminder.complete', 'reminder.snooze:10']) {
      await expect(h.runtime.handleUiAction({ ...h.input, actionId }))
        .rejects.toMatchObject({ code: 'not_found', message: expect.stringMatching(/ambiguous/i) });
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.storedReminders.get(h.first.reminderId)?.status).toBe('scheduled');
    expect(h.storedReminders.get(h.second.reminderId)?.status).toBe('scheduled');
    expect(h.conversations.getMessage(h.message.id)).toEqual(h.message);
  });

  it('binds a confirmation token to its reminder target and consumes a mismatched replay', async () => {
    const h = reminderFixture('confirm');
    const confirmation = await h.runtime.handleUiAction(h.input);
    if (confirmation.kind !== 'confirm') throw new Error('Expected server confirmation');
    const confirmationToken = confirmation.confirmation.token;
    await expect(h.runtime.handleUiAction({ ...h.input, actionId: widgetActionId.reminderComplete(h.first.reminderId), confirmationToken }))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/match/i) });
    await expect(h.runtime.handleUiAction({ ...h.input, confirmationToken })).rejects.toMatchObject({ code: 'conflict' });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.conversations.getMessage(h.message.id)).toEqual(h.message);
    const retry = await h.runtime.handleUiAction(h.input);
    if (retry.kind !== 'confirm') throw new Error('Expected server confirmation');
    await expect(h.runtime.handleUiAction({ ...h.input, confirmationToken: retry.confirmation.token }))
      .resolves.toMatchObject({ kind: 'tool', result: { output: { reminder: { id: h.second.reminderId, status: 'completed' } } } });
    expect(h.storedReminders.get(h.first.reminderId)?.status).toBe('scheduled');
  });

  it('submits the second nested form as a labeled ui_event with only its own fields', async () => {
    const h = harness();
    const first: FormBlock = { type: 'form', id: 'trip', fields: [{ name: 'city', label: 'City', kind: 'text' }], submitLabel: 'Plan trip' };
    const second: FormBlock = { type: 'form', fields: [{ name: 'name', label: 'Name', kind: 'text' }], submitLabel: 'Save profile' };
    const message: Message = {
      id: newId('msg'), conversationId: h.conv.id, role: 'assistant', status: 'complete', createdAt: h.clock(),
      parts: [{ type: 'ui', id: 'ui_forms', block: { type: 'stack', children: [first, { type: 'accordion', items: [{ id: 'profile', title: 'Profile', children: [second] }] }] } }],
    };
    h.conversations.appendMessage(message);
    h.model.script([ev.text('Profile saved.'), ev.done()]);
    const actionId = formSubmitActionId(second, [1, 0]);
    const result = await h.runtime.handleUiAction({ conversationId: h.conv.id, messageId: message.id, uiId: 'ui_forms', actionId, values: { city: 'Kyoto', name: 'Ada', injected: true } });
    if (result.kind !== 'turn') throw new Error('Expected form event turn');
    expect(result.turn.userMessage.parts[1]).toEqual({ type: 'ui_event', messageId: message.id, uiId: 'ui_forms', actionId, label: 'Save profile', values: { name: 'Ada' } });
    await result.turn.done;
    expect(JSON.stringify(h.model.requests.at(-1)!.messages.at(-1))).toContain('Save profile');
    expect(JSON.stringify(h.model.requests.at(-1)!.messages.at(-1))).toContain(actionId);
  });
});
