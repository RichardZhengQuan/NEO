import { describe, expect, it } from 'vitest';
import type { ChangeItem, ChangesBlock, UIBlock } from '@neo/protocol';
import { patchWidgetBlock, resolveStoredAction } from './ui-actions.js';

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
