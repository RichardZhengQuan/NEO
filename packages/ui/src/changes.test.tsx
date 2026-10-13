import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChangesBlock, UIAction } from '@neo/protocol';
import { BlockRenderer, type OnUIAction } from './blocks.js';
import { I18nProvider } from './i18n.js';
import { createRetainedStateStore, RetainedStateProvider } from './retained-state.js';

afterEach(cleanup);

const morning = Date.parse('2026-10-14T01:00:00Z');
const afternoon = Date.parse('2026-10-14T07:00:00Z');
function changes(): ChangesBlock {
  return { type: 'changes', timezone: 'Asia/Shanghai', note: 'Here are the concrete edits.', items: [
    { kind: 'task.update', id: 'chg_one', taskId: 'task_one', title: 'Dentist', before: { dueAt: morning }, after: { dueAt: afternoon } },
    { kind: 'reminder.create', id: 'chg_two', title: 'Call mom', dueAt: morning, creationKey: '6ea24861-b93e-4ed1-9071-dabc331b9451' },
    { kind: 'reminder.update', id: 'chg_three', reminderId: 'rem_three', title: 'Stretch', before: { dueAt: afternoon, title: 'Stretch' }, after: { dueAt: morning, title: 'Walk' } },
  ] };
}

function view(block = changes(), onAction?: OnUIAction, locale = 'en') {
  return <I18nProvider locale={locale}><BlockRenderer block={block} uiId="ui_changes" onAction={onAction} /></I18nProvider>;
}

describe('changes widget', () => {
  it('shows before and after times in the block timezone, titles, and kind labels', () => {
    const { container } = render(view(changes(), vi.fn()));
    expect(screen.getByRole('region', { name: 'Proposed changes' })).toBeTruthy();
    expect(screen.getByText('Here are the concrete edits.')).toBeTruthy();
    expect(screen.getByText('Due: Oct 14, 2026, 9:00 AM → Oct 14, 2026, 3:00 PM')).toBeTruthy();
    expect(screen.getByText('Title: Stretch → Walk')).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
    expect(screen.getByText('New reminder')).toBeTruthy();
    expect(screen.getByText('Reminder')).toBeTruthy();
    expect(screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    expect(container.querySelector('.neo-fallback')).toBeNull();
  });

  it('renders no due date, priority, and completion edits, with translated labels', () => {
    const block: ChangesBlock = { type: 'changes', items: [
      { kind: 'task.update', id: 'chg_one', taskId: 'task_one', title: 'Work', before: { dueAt: morning, priority: 0, done: false }, after: { dueAt: null, priority: 3, done: true } },
      { kind: 'task.update', id: 'chg_two', taskId: 'task_two', title: 'Read', before: { done: true }, after: { done: false } },
    ] };
    const rendered = render(view(block, vi.fn()));
    expect(screen.getByText(/→ No due date$/)).toBeTruthy();
    expect(screen.getByText('No priority → High priority')).toBeTruthy();
    expect(screen.getByText('Mark done')).toBeTruthy();
    expect(screen.getByText('Reopen')).toBeTruthy();
    rendered.rerender(view(block, vi.fn(), 'zh-CN'));
    expect(screen.getByRole('region', { name: '建议的更改' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '应用 2 项更改' })).toBeTruthy();
    expect(screen.getByText('标为完成')).toBeTruthy();
  });

  it('applies selected pending items sequentially and disables controls until finished', async () => {
    const completions: (() => void)[] = [];
    const onAction = vi.fn<OnUIAction>(() => new Promise<void>((resolve) => { completions.push(resolve); }));
    render(view(changes(), onAction));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Applying…')).toBeTruthy();
    expect(screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).disabled)).toBe(true);
    expect((screen.getByRole('button', { name: 'Apply 3 changes' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => completions[0]!());
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
    await act(async () => completions[1]!());
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(3));
    await act(async () => completions[2]!());
    expect(await screen.findByRole('status', { name: '' })).toBeTruthy();
    expect(screen.getByText('All changes applied')).toBeTruthy();
    expect(onAction.mock.calls.map(([action]) => (action as UIAction).id)).toEqual(['change.apply:chg_one', 'change.apply:chg_two', 'change.apply:chg_three']);
    expect(onAction.mock.calls[0]).toEqual([
      { id: 'change.apply:chg_one', kind: 'tool', tool: 'apply_change', label: 'Apply change', input: {} },
      { uiId: 'ui_changes' },
    ]);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  });

  it('skips unchecked and already applied items', async () => {
    const block = changes();
    block.items[2]!.status = 'applied';
    const onAction = vi.fn<OnUIAction>(async () => {});
    render(view(block, onAction));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dentist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Call mom' })).toBeNull());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toMatchObject({ id: 'change.apply:chg_two' });
    expect((screen.getByRole('checkbox', { name: 'Dentist' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText('All changes applied')).toBeNull();
    expect((screen.getByRole('button', { name: 'Apply 0 changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the item error and retries only failed selections after partial success', async () => {
    let failed = false;
    const onAction = vi.fn(async (action: UIAction) => {
      if (action.id === 'change.apply:chg_two' && !failed) { failed = true; throw new Error('The reminder changed. Ask for a fresh plan.'); }
    });
    render(view(changes(), onAction));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    expect(await screen.findByRole('button', { name: 'Retry 1' })).toBeTruthy();
    expect(screen.getByText('The reminder changed. Ask for a fresh plan.')).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText('Applied')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry 1' }));
    expect(await screen.findByText('All changes applied')).toBeTruthy();
    expect(onAction.mock.calls.map(([action]) => action.id)).toEqual(['change.apply:chg_one', 'change.apply:chg_two', 'change.apply:chg_three', 'change.apply:chg_two']);
    expect(screen.queryByText('The reminder changed. Ask for a fresh plan.')).toBeNull();
  });

  it('retains selection across navigation inside a provider and uses local defaults outside it', () => {
    const store = createRetainedStateStore();
    const onAction = vi.fn();
    const retained = () => <RetainedStateProvider store={store}>{view(changes(), onAction)}</RetainedStateProvider>;
    const first = render(retained());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Call mom' }));
    first.unmount();
    const second = render(retained());
    expect((screen.getByRole('checkbox', { name: 'Call mom' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Apply 2 changes' })).toBeTruthy();
    second.unmount();
    const local = render(view(changes(), onAction));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Call mom' }));
    local.unmount();
    render(view(changes(), onAction));
    expect((screen.getByRole('checkbox', { name: 'Call mom' }) as HTMLInputElement).checked).toBe(true);
  });

  it('keeps pending applications and successes across remounts before the stored block refreshes', async () => {
    const store = createRetainedStateStore();
    let complete = () => {};
    const onAction = vi.fn<OnUIAction>(() => new Promise<void>((resolve) => { complete = resolve; }));
    const block = changes();
    block.items = [block.items[0]!];
    const retained = () => <RetainedStateProvider store={store}>{view(block, onAction)}</RetainedStateProvider>;
    const first = render(retained());
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    first.unmount();
    const second = render(retained());
    const button = screen.getByRole('button', { name: 'Apply 1 change' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => complete());
    expect(await screen.findByText('All changes applied')).toBeTruthy();
    second.unmount();
    render(retained());
    expect(screen.getByText('All changes applied')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('disables actions without an action handler and falls back for malformed data', () => {
    const rendered = render(view());
    expect((screen.getByRole('button', { name: 'Apply 3 changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).disabled)).toBe(true);
    rendered.rerender(view({ type: 'changes', items: [] } as unknown as ChangesBlock));
    expect(screen.getByText("Can't display this content")).toBeTruthy();
  });
});
