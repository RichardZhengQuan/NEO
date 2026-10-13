import { describe, expect, it } from 'vitest';
import {
  FORM_SUBMIT_ACTION_ID,
  NeoError,
  UI_ACTION_ID_PREFIX,
  UIBlockSchema,
  childBlocks,
  formSubmitActionId,
  resolveWidgetAction,
  uiBlockKey,
  validateUIBlocks,
  walkUIBlocks,
  widgetActionId,
  type FormBlock,
  type ReminderBlock,
  type UIBlock,
} from './index.js';

const reminder = (reminderId: string): ReminderBlock => ({
  type: 'reminder', reminderId, title: reminderId, dueAt: 0, status: 'fired',
});
const form: FormBlock = { type: 'form', fields: [{ name: 'name', label: 'Name', kind: 'text' }] };

describe('targeted reminder actions', () => {
  const first = reminder('rem_first');
  const second = reminder('rem_second');
  const containers: { name: string; root: UIBlock }[] = [
    { name: 'card', root: { type: 'card', children: [first, second] } },
    { name: 'grid', root: { type: 'grid', columns: 2, children: [first, second] } },
    { name: 'tabs', root: { type: 'tabs', tabs: [
      { id: 'one', label: 'First', children: [first] },
      { id: 'two', label: 'Second', children: [second] },
    ] } },
  ];

  it.each(containers)('targets each reminder in a $name', ({ root }) => {
    for (const target of [first, second]) {
      const complete = widgetActionId.reminderComplete(target.reminderId);
      expect(resolveWidgetAction(root, complete)).toEqual({
        id: complete, label: 'Done', kind: 'tool', tool: 'complete_reminder', input: { id: target.reminderId },
      });
      const snooze = widgetActionId.reminderSnooze(target.reminderId, 10);
      expect(resolveWidgetAction(root, snooze)).toEqual({
        id: snooze, label: 'Snooze 10 min', kind: 'tool', tool: 'snooze_reminder', input: { id: target.reminderId, minutes: 10 },
      });
    }
    expect(resolveWidgetAction(root, widgetActionId.reminderComplete('unknown'))).toBeNull();
    expect(resolveWidgetAction(root, widgetActionId.reminderSnooze('unknown', 10))).toBeNull();
  });

  it('encodes reminder ids containing delimiters and Unicode', () => {
    const target = reminder('rem:id / % ⏰');
    expect(widgetActionId.reminderComplete(target.reminderId)).toBe('__neo:reminder.complete:rem%3Aid%20%2F%20%25%20%E2%8F%B0');
    expect(widgetActionId.reminderSnooze(target.reminderId, 15)).toBe('__neo:reminder.snooze:rem%3Aid%20%2F%20%25%20%E2%8F%B0:15');
    expect(resolveWidgetAction(target, widgetActionId.reminderComplete(target.reminderId))).toMatchObject({ input: { id: target.reminderId } });
    expect(resolveWidgetAction(target, widgetActionId.reminderSnooze(target.reminderId, 15))).toMatchObject({ input: { id: target.reminderId, minutes: 15 } });
  });

  it.each([
    '__neo:reminder.complete:%',
    '__neo:reminder.complete:rem_first:extra',
    '__neo:reminder.snooze:%:10',
    '__neo:reminder.snooze:rem_first:0',
    '__neo:reminder.snooze:rem_first:1441',
    '__neo:reminder.snooze:rem_first:1.5',
    '__neo:reminder.snooze:rem_first:NaN',
    '__neo:reminder.snooze:rem_first:10:extra',
    'reminder.complete:extra',
  ])('rejects malformed reminder action %s', (actionId) => {
    expect(resolveWidgetAction(first, actionId)).toBeNull();
  });

  it('accepts legacy ids only with one reminder', () => {
    const root: UIBlock = { type: 'card', children: [{ type: 'text', text: 'Reminder' }, first] };
    expect(resolveWidgetAction(root, 'reminder.complete')).toMatchObject({ tool: 'complete_reminder', input: { id: first.reminderId } });
    expect(resolveWidgetAction(root, 'reminder.snooze:10')).toMatchObject({ tool: 'snooze_reminder', input: { id: first.reminderId, minutes: 10 } });
    expect(resolveWidgetAction({ type: 'text', text: 'No reminder' }, 'reminder.complete')).toBeNull();
    expect(resolveWidgetAction({ type: 'text', text: 'No reminder' }, 'reminder.snooze:10')).toBeNull();
  });

  it.each(containers)('rejects ambiguous legacy ids in a $name', ({ root }) => {
    for (const actionId of ['reminder.complete', 'reminder.snooze:10']) {
      expect(() => resolveWidgetAction(root, actionId)).toThrow(NeoError);
      expect(() => resolveWidgetAction(root, actionId)).toThrow(expect.objectContaining({ code: 'not_found', message: expect.stringContaining('ambiguous') }));
    }
  });

  it('counts repeated reminder blocks when rejecting a legacy action', () => {
    const root: UIBlock = { type: 'stack', children: [first, first] };
    expect(() => resolveWidgetAction(root, 'reminder.complete')).toThrow(/ambiguous/);
    expect(resolveWidgetAction(root, widgetActionId.reminderComplete(first.reminderId))).toMatchObject({ input: { id: first.reminderId } });
  });
});

describe('UI block targeting keys', () => {
  it('uses explicit ids when present and tree paths otherwise', () => {
    expect(uiBlockKey(form, [])).toBe('path:root');
    expect(uiBlockKey(form, [1, 0, 2])).toBe('path:1.0.2');
    const identified = { ...form, id: 'form:id / %' };
    expect(uiBlockKey(identified, [])).toBe('id:form%3Aid%20%2F%20%25');
    expect(uiBlockKey(identified, [1, 0, 2])).toBe(uiBlockKey(identified, []));
    expect(formSubmitActionId(form)).toBe('__neo:form.submit:path:root');
    expect(formSubmitActionId(form, [1, 0, 2])).toBe('__neo:form.submit:path:1.0.2');
    expect(formSubmitActionId(identified, [1, 0, 2])).toBe('__neo:form.submit:id:form%3Aid%20%2F%20%25');
    expect(FORM_SUBMIT_ACTION_ID).toBe('__submit');
  });

  it('traverses every container in childBlocks order without resetting at explicit ids', () => {
    const identified = { ...form, id: 'named-form' };
    const root: UIBlock = {
      type: 'card', id: 'root', children: [{
        type: 'grid', columns: 2, children: [{
          type: 'stack', id: 'stack', children: [{
            type: 'tabs', tabs: [
              { id: 'first', label: 'First', children: [{ type: 'text', text: 'Before' }, form] },
              { id: 'second', label: 'Second', children: [{
                type: 'accordion', items: [
                  { id: 'first', title: 'First', children: [identified] },
                  { id: 'second', title: 'Second', children: [{ type: 'text', text: 'Before' }, form] },
                ],
              }] },
            ],
          }],
        }],
      }],
    };
    const entries = [...walkUIBlocks(root)];
    const forms = entries.filter(({ block }) => block.type === 'form');
    expect(forms.map(({ path, key }) => ({ path, key }))).toEqual([
      { path: [0, 0, 0, 1], key: 'path:0.0.0.1' },
      { path: [0, 0, 0, 2, 0], key: 'id:named-form' },
      { path: [0, 0, 0, 2, 2], key: 'path:0.0.0.2.2' },
    ]);
    for (const { block, path, key } of entries) {
      let found: UIBlock = root;
      for (const index of path) found = childBlocks(found)[index]!;
      expect(found).toBe(block);
      expect(key).toBe(uiBlockKey(block, path));
      if (block.type === 'form') expect(formSubmitActionId(block, path)).toBe(`${UI_ACTION_ID_PREFIX}form.submit:${key}`);
    }
    expect([...walkUIBlocks(root)]).toEqual(entries);
  });
});

describe('reserved built-in action namespace', () => {
  it.each(['buttons', 'card', 'list'] as const)('rejects reserved model ids on %s while preserving stored schema compatibility', (type) => {
    const action = { id: '__neo:reminder.complete:rem_1', label: 'Done', kind: 'event' as const };
    const block: UIBlock = type === 'buttons' ? { type, actions: [action] }
      : type === 'card' ? { type, actions: [action] }
        : { type, items: [{ id: 'item', title: 'Reminder', action }] };
    expect(UIBlockSchema.safeParse(block).success).toBe(true);
    expect(validateUIBlocks(block)).toMatchObject({ ok: false, error: expect.stringContaining('reserved') });
  });

  it('leaves other model action characters and legacy stored widget blocks valid', () => {
    expect(validateUIBlocks({ type: 'buttons', actions: [{ id: 'model:action / %', label: 'Open', kind: 'event' }] }).ok).toBe(true);
    expect(validateUIBlocks({ type: 'card', children: [form, reminder('rem_1')] }).ok).toBe(true);
  });
});
