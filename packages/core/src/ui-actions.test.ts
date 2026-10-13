import { describe, expect, it } from 'vitest';
import { FORM_SUBMIT_ACTION_ID, formSubmitActionId, type ChangeItem, type ChangesBlock, type FormBlock, type UIBlock } from '@neo/protocol';
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
      { id: 'change.apply:chg_1', label: 'Apply', kind: 'tool', tool: 'update_task', input: { id: 'task_1', done: true } },
    ] };
    expect(resolveStoredAction(buttons, 'fabricated')).toBeNull();
    expect(resolveStoredAction(buttons, 'change.apply:chg_1')).toBeNull();
    expect(resolveStoredAction(changes, 'change.apply:chg_1')?.action).toMatchObject({ tool: 'apply_change', input: { item } });
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
