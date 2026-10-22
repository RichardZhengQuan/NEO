import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Message, UIBlock } from '@neo/protocol';
import { BlockList } from './blocks.js';
import { MessageView } from './message.js';
import { I18nProvider } from './i18n.js';
import { createRetainedStateStore, RetainedStateProvider, type RetainedStateStore } from './retained-state.js';

afterEach(cleanup);

function frame(store: RetainedStateStore, ui: ReactElement) {
  return <RetainedStateProvider store={store}><I18nProvider locale="en">{ui}</I18nProvider></RetainedStateProvider>;
}
function form(defaultValue = 'Original'): UIBlock {
  return { type: 'form', fields: [{ name: 'draft', label: 'Draft', kind: 'textarea', defaultValue }], submitLabel: 'Send draft' };
}
function message(id: string, block: UIBlock, uiId = 'ui_shared'): Message {
  return { id, conversationId: 'conversation', episodeId: 'conversation', role: 'assistant', createdAt: 1, status: 'complete', parts: [{ type: 'ui', id: uiId, block }] };
}
function value(label = 'Draft') { return (screen.getByLabelText(label) as HTMLTextAreaElement).value; }

describe('generated chat edit preservation', () => {
  it('preserves independent no-id form edits when changing tabs and retains the selected tab after page remount', () => {
    const store = createRetainedStateStore();
    const block: UIBlock = { type: 'tabs', tabs: [
      { id: 'edit', label: 'Edit', children: [form()] },
      { id: 'compare', label: 'Compare', children: [{ type: 'text', text: 'The comparison' }] },
      { id: 'other', label: 'Other draft', children: [form('Other original')] },
    ] };
    const ui = () => frame(store, <MessageView message={message('m1', block)} />);
    const first = render(ui());
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'My first edit' } });
    // Switch directly between identical form shapes before any non-form view.
    fireEvent.click(screen.getByRole('tab', { name: 'Other draft' }));
    expect(value()).toBe('Other original');
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'My other edit' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
    expect(value()).toBe('My first edit');
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Other draft' }));
    expect(value()).toBe('My other edit');
    first.unmount();
    render(ui());
    expect(screen.getByRole('tab', { name: 'Other draft' }).getAttribute('aria-selected')).toBe('true');
    expect(value()).toBe('My other edit');
  });

  it('keeps edits through accordion close/reopen and preserves its open choice across remount', () => {
    const store = createRetainedStateStore();
    const block: UIBlock = { type: 'accordion', items: [{ id: 'draft', title: 'Message draft', open: true, children: [form()] }] };
    const ui = () => frame(store, <MessageView message={message('m1', block)} />);
    const first = render(ui());
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Keep these words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Message draft' }));
    expect(screen.queryByLabelText('Draft')).toBeNull();
    first.unmount();
    render(ui());
    expect(screen.getByRole('button', { name: 'Message draft' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Message draft' }));
    expect(value()).toBe('Keep these words');
  });

  it('isolates drafts across messages, UI parts, and sibling blocks without ids', () => {
    const store = createRetainedStateStore();
    const one = message('m1', form());
    const two = message('m2', form('Second'));
    const first = render(frame(store, <><MessageView message={one} /><MessageView message={two} /></>));
    fireEvent.change(screen.getAllByLabelText('Draft')[0]!, { target: { value: 'Only message one' } });
    expect((screen.getAllByLabelText('Draft')[1] as HTMLTextAreaElement).value).toBe('Second');
    first.unmount();
    const multi = { ...one, parts: [{ type: 'ui' as const, id: 'ui_one', block: form('Part one') }, { type: 'ui' as const, id: 'ui_two', block: form('Part two') }] };
    const second = render(frame(store, <MessageView message={multi} />));
    fireEvent.change(screen.getAllByLabelText('Draft')[0]!, { target: { value: 'Only part one' } });
    expect((screen.getAllByLabelText('Draft')[1] as HTMLTextAreaElement).value).toBe('Part two');
    second.unmount();
    render(frame(store, <BlockList blocks={[form('Sibling one'), form('Sibling two')]} />));
    fireEvent.change(screen.getAllByLabelText('Draft')[0]!, { target: { value: 'Only sibling one' } });
    expect((screen.getAllByLabelText('Draft')[1] as HTMLTextAreaElement).value).toBe('Sibling two');
  });

  it('retains date, select, checkbox and multi-option choices after page remount', () => {
    const store = createRetainedStateStore();
    const block: UIBlock = { type: 'form', fields: [
      { name: 'day', label: 'Dinner day', kind: 'date', defaultValue: '2026-10-15' },
      { name: 'time', label: 'Dinner time', kind: 'select', options: [{ value: '18:30', label: '6:30 PM' }, { value: '19:00', label: '7:00 PM' }] },
      { name: 'outside', label: 'Outside table', kind: 'checkbox' },
      { name: 'food', label: 'Food choices', kind: 'multiselect', options: [{ value: 'vegetarian', label: 'Vegetarian' }, { value: 'seafood', label: 'Seafood' }] },
    ] };
    const ui = () => frame(store, <MessageView message={message('m1', block)} />);
    const first = render(ui());
    fireEvent.change(screen.getByLabelText('Dinner day'), { target: { value: '2026-10-16' } });
    fireEvent.change(screen.getByLabelText('Dinner time'), { target: { value: '19:00' } });
    fireEvent.click(screen.getByLabelText('Outside table'));
    fireEvent.click(screen.getByRole('button', { name: 'Vegetarian' }));
    first.unmount();
    render(ui());
    expect((screen.getByLabelText('Dinner day') as HTMLInputElement).value).toBe('2026-10-16');
    expect((screen.getByLabelText('Dinner time') as HTMLSelectElement).value).toBe('19:00');
    expect((screen.getByLabelText('Outside table') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Vegetarian' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Seafood' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('retains pending submission through page changes, blocks duplicates, and records completion in the remounted form', async () => {
    const store = createRetainedStateStore();
    let complete = () => {};
    const onUiAction = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const ui = () => frame(store, <MessageView message={message('m1', form())} onUiAction={onUiAction} />);
    const first = render(ui());
    fireEvent.click(screen.getByRole('button', { name: 'Send draft' }));
    expect(onUiAction).toHaveBeenCalledTimes(1);
    first.unmount();
    render(ui());
    const submit = screen.getByRole('button', { name: /Send draft$/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onUiAction).toHaveBeenCalledTimes(1);
    await act(async () => complete());
    expect(await screen.findByText('Sent')).toBeTruthy();
  });

  it('deleting a message scope removes its edits and rejects stale pending completion without clearing another message', async () => {
    const store = createRetainedStateStore();
    let complete = () => {};
    const onUiAction = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const ui = () => frame(store, <><MessageView message={message('m1', form())} onUiAction={onUiAction} /><MessageView message={message('m2', form('Second'))} /></>);
    const first = render(ui());
    fireEvent.change(screen.getAllByLabelText('Draft')[0]!, { target: { value: 'Private edit' } });
    fireEvent.change(screen.getAllByLabelText('Draft')[1]!, { target: { value: 'Keep second edit' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Send draft' })[0]!);
    first.unmount();
    store.clearScope(['messages', 'm1']);
    await act(async () => complete());
    render(ui());
    expect((screen.getAllByLabelText('Draft')[0] as HTMLTextAreaElement).value).toBe('Original');
    expect((screen.getAllByLabelText('Draft')[1] as HTMLTextAreaElement).value).toBe('Keep second edit');
    await waitFor(() => expect(screen.queryByText('Sent')).toBeNull());
    expect((screen.getAllByRole('button', { name: 'Send draft' })[0] as HTMLButtonElement).disabled).toBe(false);
  });
});
