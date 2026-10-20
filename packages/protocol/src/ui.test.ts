import { describe, expect, it } from 'vitest';
import {
  FORM_SUBMIT_ACTION_ID,
  MAX_UI_BLOCKS,
  NeoError,
  UI_ACTION_ID_PREFIX,
  UIBlockSchema,
  childBlocks,
  extractInlineUI,
  formSubmitActionId,
  formatTableCell,
  resolveWidgetAction,
  uiBlockKey,
  uiBlockToText,
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

describe('compatible block properties', () => {
  it('accepts stored blocks without the new optional properties', () => {
    const blocks: UIBlock[] = [
      reminder('rem_old'),
      { type: 'countdown', label: 'Launch', until: 0 },
      { type: 'table', columns: [{ key: 'cost', label: 'Cost', format: 'currency' }], rows: [{ cost: 12 }] },
      { type: 'memory', nodes: [{ id: 'mem_old', kind: 'fact', label: 'Old memory' }] },
    ];
    expect(validateUIBlocks(blocks)).toEqual({ ok: true, blocks });
    expect(uiBlockToText(blocks[2]!)).toContain('$12.00');
    expect(uiBlockToText(blocks[3]!)).toContain('[fact] Old memory');
    expect(uiBlockToText(blocks[3]!)).not.toContain('active');
  });

  it('accepts the new properties and forgotten widget snapshots', () => {
    const blocks: UIBlock[] = [
      { ...reminder('rem_notes'), notes: 'n'.repeat(5000) },
      { type: 'countdown', label: 'Launch', until: 0, timezone: 'Asia/Singapore' },
      { type: 'table', columns: [{ key: 'cost', label: 'Cost', format: 'currency', currency: 'SGD' }], rows: [] },
      { type: 'memory', nodes: [{ id: 'mem_old', kind: 'fact', label: 'Old memory', status: 'forgotten' }] },
    ];
    expect(validateUIBlocks(blocks)).toEqual({ ok: true, blocks });
  });

  it.each([
    { ...reminder('rem_notes'), notes: 'n'.repeat(5001) },
    { type: 'countdown', label: 'Launch', until: 0, timezone: 'z'.repeat(65) },
    ...['usd', 'US', 'USDD', '12$'].map((currency) => ({ type: 'table', columns: [{ key: 'cost', label: 'Cost', currency }], rows: [] })),
  ])('rejects out-of-contract properties: %j', (block) => {
    expect(validateUIBlocks(block).ok).toBe(false);
  });
});

describe('meaningful text fallback', () => {
  const instant = Date.UTC(2026, 9, 13, 16, 30);

  it('formats table columns with their currency and readable dates', () => {
    const text = uiBlockToText({
      type: 'table', columns: [
        { key: 'amount', label: 'Amount', format: 'number' },
        { key: 'price', label: 'Price', format: 'currency', currency: 'EUR' },
        { key: 'oldPrice', label: 'Old price', format: 'currency' },
        { key: 'fraction', label: 'Fraction', format: 'percent' },
        { key: 'date', label: 'Date', format: 'date' },
      ],
      rows: [{ amount: 1234.5, price: 42, oldPrice: 10, fraction: 0.42, date: instant }],
    });
    expect(text).toContain('1,234.5');
    expect(text).toContain('€42.00');
    expect(text).toContain('$10.00');
    expect(text).toContain('42%');
    expect(text).toContain(new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(instant));
    expect(text).not.toContain(String(instant));
    expect(text).not.toContain('0.42');
  });

  it('keeps table missing values, booleans, date strings and invalid formats readable', () => {
    expect(formatTableCell(null, 'number')).toBe('—');
    expect(formatTableCell(undefined, 'currency')).toBe('—');
    expect(formatTableCell('', 'text')).toBe('—');
    expect(formatTableCell(true, undefined)).toBe('✓');
    expect(formatTableCell(false, undefined)).toBe('✗');
    expect(formatTableCell('2026-10-13T16:30:00Z', 'date')).toBe(formatTableCell(instant, 'date'));
    expect(formatTableCell('unknown', 'date')).toBe('unknown');
    expect(formatTableCell(42, 'currency', 'en-US', 'invalid')).toBe('42');
  });

  it('includes full reminder notes and the countdown timezone', () => {
    const notes = 'Bring the documents.\nAsk about the renewal.';
    expect(uiBlockToText({ ...reminder('rem_notes'), notes })).toContain(notes);
    const text = uiBlockToText({ type: 'countdown', label: 'Launch', until: instant, timezone: 'Asia/Singapore' });
    expect(text).toContain('Oct 14, 2026, 12:30 AM');
  });

  it('includes every memory content, and the status only when it is not active', () => {
    const text = uiBlockToText({ type: 'memory', nodes: [
      { id: 'mem_1', kind: 'preference', label: 'Travel', content: 'The user prefers window seats.' },
      { id: 'mem_2', kind: 'fact', label: 'Old job', content: 'The user left the old job.', status: 'forgotten' },
      { id: 'mem_3', kind: 'goal', label: 'Fitness', content: 'Run a marathon.', status: 'archived' },
    ] });
    for (const value of ['Travel', 'The user prefers window seats.', 'The user left the old job.', '(forgotten)', 'Run a marathon.', '(archived)']) {
      expect(text).toContain(value);
    }
    expect(text).not.toContain('active');
  });

  it('does not resolve a forget control on a stored forgotten node', () => {
    const block: UIBlock = { type: 'memory', nodes: [{ id: 'mem_1', kind: 'fact', label: 'Forgotten', status: 'forgotten' }] };
    expect(resolveWidgetAction(block, widgetActionId.memoryForget('mem_1'))).toBeNull();
  });

  it.each<{ block: UIBlock; includes: string[] }>([
    { block: { type: 'progress', value: 0.42, caption: 'Waiting for upload' }, includes: ['42%', 'Waiting for upload'] },
    { block: { type: 'gallery', images: [{ url: 'https://example.test/photo.png', alt: 'Kyoto', caption: 'At sunset' }] }, includes: ['Kyoto', 'At sunset'] },
    { block: { type: 'code', code: 'const x = 1;', filename: 'index.ts' }, includes: ['index.ts', 'const x = 1;'] },
    { block: { type: 'buttons', actions: [{ id: 'open', label: 'Open', kind: 'link', url: 'neo://notes/note_1' }] }, includes: ['[Open]', 'neo://notes/note_1'] },
    { block: { type: 'list', items: [{ id: 'note_1', title: 'Note', action: { id: 'open', label: 'Open', kind: 'link', url: 'neo://notes/note_1' } }] }, includes: ['Note', 'neo://notes/note_1'] },
    { block: { type: 'card', actions: [{ id: 'open', label: 'Open', kind: 'link', url: 'neo://notes/note_1' }] }, includes: ['neo://notes/note_1'] },
    { block: { type: 'tasks', tasks: [{ id: 'task_1', title: 'Check records', done: false, dueAt: 0, priority: 3 }] }, includes: ['due', 'priority 3'] },
    { block: { type: 'changes', items: [{ id: 'change_1', kind: 'reminder.create', creationKey: '6db776c6-5c30-4366-9628-f138b352c361', title: 'Renew', dueAt: instant, timezone: 'UTC', notes: 'Bring ID' }] }, includes: ['Bring ID'] },
  ])('preserves visible details for $block.type', ({ block, includes }) => {
    const text = uiBlockToText(block);
    for (const value of includes) expect(text).toContain(value);
  });

  it('keeps form guidance, choices, bounds and default values', () => {
    const text = uiBlockToText({ type: 'form', fields: [
      { name: 'amount', label: 'Amount', kind: 'number', help: 'Monthly budget', placeholder: 'Enter amount', min: 0, max: 100, step: 5, defaultValue: 0 },
      { name: 'choice', label: 'Choice', kind: 'select', options: [{ label: 'Travel', value: 'travel' }], defaultValue: 'travel' },
      { name: 'tags', label: 'Tags', kind: 'multiselect', defaultValue: ['a', 'b'] },
    ] });
    for (const value of ['Monthly budget', 'Enter amount', 'min 0, max 100, step 5', 'Default: 0', 'Travel (travel)', 'Default: travel', 'Default: a, b']) expect(text).toContain(value);
  });
});

describe('extractInlineUI aggregate limits', () => {
  // Build a fence with one stack containing `childCount` text children.
  const makeFence = (childCount: number): string => {
    const children = Array.from({ length: childCount }, (_, i) => ({ type: 'text', text: `item ${i}` }));
    const block = { type: 'stack', children };
    return '```neo-ui\n' + JSON.stringify([block]) + '\n```';
  };

  it('reports a per-message limit error and drops blocks when 6 fences of 51 blocks each exceed MAX_UI_BLOCKS', () => {
    // 6 fences × (1 stack + 50 text children) = 6 × 51 = 306 total blocks, exceeds 300.
    const text = Array.from({ length: 6 }, () => makeFence(50)).join('\n');
    const result = extractInlineUI(text);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes(`${MAX_UI_BLOCKS}`))).toBe(true);
    expect(result.blocks.length).toBeLessThanOrEqual(MAX_UI_BLOCKS);
    expect(result.blocks.length).toBe(0);
  });

  it('reports a duplicate action-id error and drops blocks when two fences repeat the same action id', () => {
    const fence = (actionId: string) =>
      '```neo-ui\n' +
      JSON.stringify([{ type: 'buttons', actions: [{ id: actionId, label: 'Click', kind: 'event' }] }]) +
      '\n```';
    const text = fence('shared-action') + '\n' + fence('shared-action');
    const result = extractInlineUI(text);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('shared-action'))).toBe(true);
    expect(result.blocks.length).toBe(0);
  });

  it('enforces aggregate limit even when a prior fence produced a per-fence error', () => {
    // First fence has invalid JSON → per-fence parse error (errors.length becomes 1).
    // Subsequent 6 fences each have 51 blocks — together they exceed MAX_UI_BLOCKS.
    // The aggregate check must still fire despite errors.length > 0 after the first fence.
    const invalidFence = '```neo-ui\nnot-valid-json\n```';
    const bigFences = Array.from({ length: 6 }, () => makeFence(50)).join('\n');
    const result = extractInlineUI(invalidFence + '\n' + bigFences);
    // Per-fence parse error from the invalid fence.
    expect(result.errors.some((e) => e.includes('Invalid neo-ui JSON'))).toBe(true);
    // Aggregate error from exceeding MAX_UI_BLOCKS.
    expect(result.errors.some((e) => e.includes(`${MAX_UI_BLOCKS}`))).toBe(true);
    // All blocks dropped.
    expect(result.blocks.length).toBe(0);
  });
});
