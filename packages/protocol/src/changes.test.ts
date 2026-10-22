import { describe, expect, it } from 'vitest';
import {
  ChangeItemSchema, ChangesBlockSchema, TOOL_ONLY_BLOCK_TYPES, UI_BLOCK_TYPES,
  extractInlineUI, findToolOnlyBlock, newId, resolveWidgetAction, uiBlockToText, validateUIBlocks, widgetActionId,
  type ChangeItem, type ChangesBlock, type UIBlock,
} from './index.js';

const before = Date.UTC(2026, 9, 13, 1);
const after = Date.UTC(2026, 9, 13, 7);
const item: ChangeItem = { id: 'chg_dentist', kind: 'task.update', taskId: 'task_dentist', title: 'Dentist', before: { dueAt: before }, after: { dueAt: after } };
const block: ChangesBlock = { type: 'changes', title: 'Tomorrow', note: 'A quieter morning', timezone: 'Asia/Singapore', items: [item] };
const reminder: ChangeItem = { id: 'chg_call', kind: 'reminder.create', title: 'Call mom', dueAt: after, creationKey: '30c8ab69-b671-43e2-8b6a-d9872582794f' };

describe('changes contract', () => {
  it('accepts each kind and treats omitted status as pending', () => {
    expect(ChangeItemSchema.safeParse(item).success).toBe(true);
    expect(ChangeItemSchema.safeParse(reminder).success).toBe(true);
    expect(ChangeItemSchema.safeParse({ id: 'chg_rem', kind: 'reminder.update', reminderId: 'rem_1', title: 'Call', before: { title: 'Call' }, after: { title: 'Call mom' } }).success).toBe(true);
    expect(validateUIBlocks(block).ok).toBe(true);
    expect(UI_BLOCK_TYPES).toContain('changes');
    expect(TOOL_ONLY_BLOCK_TYPES).toEqual(['changes']);
    expect(newId('chg', before)).toMatch(/^chg_/);
  });

  it.each([
    { ...item, after: {} },
    { ...item, before: {} },
    { ...item, before: { dueAt: before, done: false } },
    { ...item, after: { dueAt: after, priority: 4 } },
    { ...item, after: { dueAt: after, other: true } },
    { ...item, after: { dueAt: undefined } },
    { ...item, kind: 'task.delete' },
    { ...reminder, creationKey: 'not-a-uuid' },
    { ...reminder, title: '' },
  ])('rejects malformed change %#', (value) => {
    expect(ChangeItemSchema.safeParse(value).success).toBe(false);
  });

  it('requires 1–50 uniquely identified items', () => {
    expect(ChangesBlockSchema.safeParse({ ...block, items: [] }).success).toBe(false);
    expect(ChangesBlockSchema.safeParse({ ...block, items: [item, item] }).success).toBe(false);
    expect(ChangesBlockSchema.safeParse({ ...block, items: Array.from({ length: 51 }, (_, i) => ({ ...item, id: String(i) })) }).success).toBe(false);
  });
});

describe('changes actions and text', () => {
  it('resolves only pending stored items and ignores client-supplied values', () => {
    const actionId = widgetActionId.changeApply(item.id);
    const action = resolveWidgetAction(block, actionId, { item: reminder });
    expect(action).toEqual({ id: actionId, label: 'Apply change', kind: 'tool', tool: 'apply_change', input: { item } });
    expect(action?.kind === 'tool' && action.input?.item).toBe(item);
    expect(resolveWidgetAction({ ...block, items: [{ ...item, status: 'applied' }] }, actionId)).toBeNull();
    expect(resolveWidgetAction(block, widgetActionId.changeApply('unknown'))).toBeNull();
  });

  it('renders title, note, localized due times, new reminders and applied status', () => {
    const text = uiBlockToText({ ...block, items: [{ ...item, status: 'applied' }, reminder] });
    expect(text).toContain('Tomorrow\nA quieter morning');
    expect(text).toContain('• Dentist: due Oct 13, 2026, 9:00 AM → Oct 13, 2026, 3:00 PM (applied)');
    expect(text).toContain('• New reminder: Call mom, Oct 13, 2026, 3:00 PM');
    expect(uiBlockToText({ ...block, items: [{ ...item, before: { dueAt: null, title: 'Dentist', priority: 0, done: false }, after: { dueAt: after, title: 'Dental check', priority: 2, done: true } }] }))
      .toContain('No due date → Oct 13, 2026, 3:00 PM; title Dentist → Dental check; priority 0 → 2; Mark done');
  });

  it('finds nested tool-only blocks and removes them from inline output', () => {
    const nested: UIBlock = { type: 'tabs', tabs: [{ id: 'tab', label: 'Review', children: [{ type: 'accordion', items: [{ id: 'section', title: 'Edits', children: [block] }] }] }] };
    expect(findToolOnlyBlock([nested])).toBe(block);
    expect(findToolOnlyBlock([{ type: 'text', text: 'Safe' }])).toBeNull();
    const result = extractInlineUI('Review\n```neo-ui\n' + JSON.stringify([{ type: 'text', text: 'Safe' }, nested, block]) + '\n```');
    expect(result.text).toBe('Review');
    expect(findToolOnlyBlock(result.blocks)).toBeNull();
    expect(result.blocks[0]).toEqual({ type: 'text', text: 'Safe' });
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('propose_changes');
  });
});
