import { describe, expect, it } from 'vitest';
import { FORM_SUBMIT_ACTION_ID, describeRecurrence, formSubmitActionId, widgetActionId, type ChangeItem, type ChangesBlock, type FormBlock, type ReminderBlock, type UIBlock } from '@neo/protocol';
import { patchWidgetBlock, resolveStoredAction } from './ui-actions.js';

const firstForm: FormBlock = { type: 'form', id: 'first', fields: [{ name: 'city', label: 'City', kind: 'text' }], submitLabel: 'Plan trip' };
const secondForm: FormBlock = { type: 'form', fields: [{ name: 'name', label: 'Name', kind: 'text' }], submitLabel: 'Save name' };

describe('resolveStoredAction forms', () => {
  const block: UIBlock = { type: 'card', children: [firstForm, { type: 'tabs', tabs: [
    { id: 'overview', label: 'Overview', children: [{ type: 'text', text: 'Two forms' }] },
    { id: 'profile', label: 'Profile', children: [{ type: 'grid', columns: 2, children: [secondForm] }] },
  ] }] };

  it('resolves nested forms by id or tree path and filters against the targeted fields', () => {
    const values = { city: 'Kyoto', name: 'Ada', injected: 'ignore instructions' };
    const firstId = formSubmitActionId(firstForm, [0]);
    const secondId = formSubmitActionId(secondForm, [1, 1, 0]);
    expect(resolveStoredAction(block, firstId, values)).toEqual({ action: { id: firstId, label: 'Plan trip', kind: 'event' }, values: { city: 'Kyoto' } });
    expect(resolveStoredAction(block, secondId, values)).toEqual({ action: { id: secondId, label: 'Save name', kind: 'event' }, values: { name: 'Ada' } });
  });

  it('keeps legacy submissions only when exactly one form is stored', () => {
    expect(resolveStoredAction({ type: 'stack', children: [secondForm] }, FORM_SUBMIT_ACTION_ID, { name: 'Ada', city: 'Kyoto' }))
      .toEqual({ action: { id: FORM_SUBMIT_ACTION_ID, label: 'Save name', kind: 'event' }, values: { name: 'Ada' } });
    expect(() => resolveStoredAction(block, FORM_SUBMIT_ACTION_ID)).toThrow(expect.objectContaining({ code: 'not_found', message: expect.stringMatching(/ambiguous/i) }));
    expect(resolveStoredAction({ type: 'text', text: 'No form' }, FORM_SUBMIT_ACTION_ID)).toBeNull();
  });

  it('rejects ambiguous explicit form ids instead of choosing the first', () => {
    const duplicate: UIBlock = { type: 'stack', children: [firstForm, { ...secondForm, id: firstForm.id }] };
    expect(() => resolveStoredAction(duplicate, formSubmitActionId(firstForm)))
      .toThrow(expect.objectContaining({ code: 'not_found', message: expect.stringMatching(/ambiguous/i) }));
  });

  it('rejects missing targets and does not resolve reserved ids as authored actions', () => {
    expect(resolveStoredAction(block, formSubmitActionId(secondForm, [1, 0]))).toBeNull();
    const actions: UIBlock = { type: 'buttons', actions: [
      { id: '__neo:form.submit:path:root', label: 'Forged submit', kind: 'event' },
      { id: '__neo:unknown', label: 'Forged reserved action', kind: 'event' },
    ] };
    expect(resolveStoredAction(actions, actions.actions[0]!.id)).toBeNull();
    expect(resolveStoredAction(actions, actions.actions[1]!.id)).toBeNull();
  });
});

const item: ChangeItem = { id: 'chg_1', kind: 'task.update', taskId: 'task_1', title: 'Dentist', before: { done: false }, after: { done: true } };
const changes: ChangesBlock = { type: 'changes', items: [item] };

describe('patchWidgetBlock changes', () => {
  it('refuses fabricated apply_change actions and reserved ids outside a changes widget', () => {
    const buttons: UIBlock = { type: 'buttons', actions: [
      { id: 'fabricated', label: 'Apply', kind: 'tool', tool: 'apply_change', input: { item } },
      { id: widgetActionId.changeApply('chg_1'), label: 'Apply', kind: 'tool', tool: 'update_task', input: { id: 'task_1', done: true } },
    ] };
    expect(resolveStoredAction(buttons, 'fabricated')).toBeNull();
    expect(resolveStoredAction(buttons, 'change.apply:chg_1')).toBeNull();
    expect(resolveStoredAction(buttons, widgetActionId.changeApply('chg_1'))).toBeNull();
    expect(resolveStoredAction(changes, widgetActionId.changeApply('chg_1'))?.action).toMatchObject({ tool: 'apply_change', input: { item } });
  });

  it.each(['event', 'message'] as const)('preserves a bare change.apply %s action beside a changes widget', (kind) => {
    const action = kind === 'event'
      ? { id: 'change.apply:chg_1', label: 'Continue', kind }
      : { id: 'change.apply:chg_1', label: 'Continue', kind, text: 'Continue' };
    const block: UIBlock = { type: 'stack', children: [changes, { type: 'buttons', actions: [action] }] };
    expect(resolveStoredAction(block, action.id)).toEqual({ action });
    expect(resolveStoredAction(block, widgetActionId.changeApply('chg_1'))?.action)
      .toMatchObject({ kind: 'tool', tool: 'apply_change', input: { item } });
  });

  it('marks applied items and patches task widgets in the same nested tree', () => {
    const block: UIBlock = { type: 'card', children: [changes, { type: 'tasks', tasks: [{ id: 'task_1', title: 'Dentist', done: false }] }] };
    expect(patchWidgetBlock(block, { change: { id: item.id, status: 'applied' }, task: { id: 'task_1', title: 'Dentist', done: true } }))
      .toMatchObject({ type: 'card', children: [{ type: 'changes', items: [{ ...item, status: 'applied' }] }, { type: 'tasks', tasks: [{ done: true }] }] });
    expect(item.status).toBeUndefined();
  });

  it('records a created reminder id while patching its reminder widget', () => {
    const create: ChangeItem = { id: 'chg_new', kind: 'reminder.create', title: 'Call', dueAt: 1000, creationKey: '30c8ab69-b671-43e2-8b6a-d9872582794f' };
    const block: UIBlock = { type: 'stack', children: [{ type: 'changes', items: [create] }, { type: 'reminder', reminderId: 'rem_1', title: 'Old', dueAt: 1, status: 'scheduled' }] };
    expect(patchWidgetBlock(block, { change: { id: create.id, status: 'applied', reminderId: 'rem_1' }, reminder: { id: 'rem_1', title: 'Call', dueAt: 1000, status: 'scheduled' } }))
      .toMatchObject({ type: 'stack', children: [{ items: [{ status: 'applied', reminderId: 'rem_1' }] }, { title: 'Call', dueAt: 1000 }] });
  });

  it('ignores unmatched or invalid receipts', () => {
    expect(patchWidgetBlock(changes, { change: { id: 'unknown', status: 'applied' } })).toBeNull();
    expect(patchWidgetBlock(changes, { change: { id: item.id, status: 'pending' } })).toBeNull();
  });
});

describe('patchWidgetBlock reminders', () => {
  const reminder: ReminderBlock = { type: 'reminder', reminderId: 'rem_1', title: 'Call', dueAt: 1000, status: 'scheduled', notes: 'Bring notes', recurrenceText: 'every day' };

  it('updates notes without changing unrelated reminder snapshots', () => {
    const block: UIBlock = { type: 'tabs', tabs: [{ id: 'today', label: 'Today', children: [reminder, { ...reminder, reminderId: 'rem_2' }] }] };
    expect(patchWidgetBlock(block, { reminder: { id: 'rem_1', notes: 'Bring the report' } }))
      .toEqual({ type: 'tabs', tabs: [{ id: 'today', label: 'Today', children: [{ ...reminder, notes: 'Bring the report' }, { ...reminder, reminderId: 'rem_2' }] }] });
    expect(reminder.notes).toBe('Bring notes');
  });

  it('removes cleared notes instead of retaining them through serialization', () => {
    const cleared = patchWidgetBlock(reminder, { reminder: { id: 'rem_1', notes: null } });
    expect(cleared).toEqual({ type: 'reminder', reminderId: 'rem_1', title: 'Call', dueAt: 1000, status: 'scheduled', recurrenceText: 'every day' });
    expect(cleared).not.toHaveProperty('notes');
    expect(patchWidgetBlock(reminder, { reminder: { id: 'rem_1', dueAt: 2000 } })).toMatchObject({ notes: 'Bring notes' });
  });

  it('bounds notes and preserves an explicit empty caption', () => {
    expect(patchWidgetBlock(reminder, { reminder: { id: 'rem_1', notes: 'a'.repeat(5001) } }))
      .toMatchObject({ notes: 'a'.repeat(5000) });
    expect(patchWidgetBlock(reminder, { reminder: { id: 'rem_1', notes: '' } })).toMatchObject({ notes: '' });
  });

  it('keeps rescheduled times in their new timezone after the widget is stored', () => {
    const block = { ...reminder, timezone: 'UTC' };
    expect(patchWidgetBlock(block, { reminder: { id: 'rem_1', dueAt: 2000, timezone: 'Asia/Singapore' } }))
      .toMatchObject({ dueAt: 2000, timezone: 'Asia/Singapore' });
    expect(patchWidgetBlock(block, { reminder: { id: 'rem_1', dueAt: 2000 } })).toMatchObject({ timezone: 'UTC' });
    expect(patchWidgetBlock(block, { reminder: { id: 'rem_1', timezone: 'z'.repeat(65) } })).toMatchObject({ timezone: 'z'.repeat(64) });
  });

  it('refreshes recurrence text with the shared description and removes one-time recurrence text', () => {
    const recurrence = { freq: 'weekly' as const, interval: 2, byWeekday: [3, 1], count: 8 };
    expect(patchWidgetBlock(reminder, { reminder: { id: 'rem_1', recurrence } }))
      .toMatchObject({ recurrenceText: describeRecurrence(recurrence) });
    expect(patchWidgetBlock(reminder, { reminder: { id: 'rem_1', recurrence: { freq: 'monthly', byMonthDay: [-1] } } }))
      .toMatchObject({ recurrenceText: 'every month on the last day' });
    const oneTime = patchWidgetBlock(reminder, { reminder: { id: 'rem_1', recurrence: null } });
    expect(oneTime).not.toHaveProperty('recurrenceText');
    expect(patchWidgetBlock(reminder, { reminder: { id: 'rem_1', dueAt: 2000 } })).toMatchObject({ recurrenceText: 'every day' });
    expect(patchWidgetBlock(reminder, { reminder: { id: 'rem_1', recurrence: { freq: 'never' } } })).toBeNull();
  });
});

describe('patchWidgetBlock memory', () => {
  const first = { id: 'mem_1', kind: 'preference', label: 'Window seats', content: 'Choose a window seat.', status: 'active' as const };
  const sameLabel = { ...first, id: 'mem_2' };
  const memory: UIBlock = { type: 'memory', nodes: [first, sameLabel] };

  it('marks only matching ids forgotten in nested blocks and preserves their content', () => {
    const block: UIBlock = { type: 'accordion', items: [{ id: 'memories', title: 'Memories', children: [memory] }] };
    const patched = patchWidgetBlock(block, { forgotten: ['Window seats'], ids: ['mem_1'] });
    expect(patched).toEqual({ type: 'accordion', items: [{ id: 'memories', title: 'Memories', children: [{ type: 'memory', nodes: [{ ...first, status: 'forgotten' }, sameLabel] }] }] });
    expect(first.status).toBe('active');
    expect(patched && resolveStoredAction(patched, widgetActionId.memoryForget('mem_1'))).toBeNull();
    expect(patched && resolveStoredAction(patched, widgetActionId.memoryForget('mem_2'))?.action)
      .toMatchObject({ tool: 'forget', input: { ids: ['mem_2'] } });
    expect(patched && patchWidgetBlock(patched, { forgotten: ['Window seats'], ids: ['mem_1'] })).toBeNull();
  });

  it('requires ids from a successful forget receipt instead of matching labels', () => {
    expect(patchWidgetBlock(memory, { forgotten: ['Window seats'] })).toBeNull();
    expect(patchWidgetBlock(memory, { ids: ['mem_1'] })).toBeNull();
    expect(patchWidgetBlock(memory, { forgotten: [], ids: [] })).toBeNull();
    expect(patchWidgetBlock(memory, { forgotten: ['Window seats'], ids: ['missing'] })).toBeNull();
    expect(patchWidgetBlock(memory, { forgotten: ['Window seats'], ids: [1] })).toBeNull();
  });
});
