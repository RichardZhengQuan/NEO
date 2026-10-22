import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type Dispatch, type SetStateAction } from 'react';
import { createRetainedStateStore, RetainedStateProvider, RetainedStateScope, useRetainedState } from './retained-state.js';

afterEach(cleanup);

function Counter({ capture, initial = 0 }: { capture?: (set: Dispatch<SetStateAction<number>>) => void; initial?: number }) {
  const [value, setValue] = useRetainedState('count', initial);
  capture?.(setValue);
  return <button onClick={() => setValue((current) => current + 1)}>Count {value}</button>;
}

describe('session retained state', () => {
  it('retains a control across unmounts with the same store and uses local state outside a provider', () => {
    const store = createRetainedStateStore();
    const view = () => <RetainedStateProvider store={store}><RetainedStateScope scope="task"><Counter /></RetainedStateScope></RetainedStateProvider>;
    const first = render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    first.unmount();
    const second = render(view());
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeTruthy();
    second.unmount();
    const local = render(<Counter />);
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    local.unmount();
    render(<Counter />);
    expect(screen.getByRole('button', { name: 'Count 0' })).toBeTruthy();
  });

  it('uses the new control defaults when switching scopes with identical component shapes', () => {
    const store = createRetainedStateStore();
    const view = (scope: string, initial: number) => <RetainedStateProvider store={store}><RetainedStateScope scope={scope}><Counter initial={initial} /></RetainedStateScope></RetainedStateProvider>;
    const rendered = render(view('first', 1));
    fireEvent.click(screen.getByRole('button', { name: 'Count 1' }));
    rendered.rerender(view('second', 10));
    expect(screen.getByRole('button', { name: 'Count 10' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Count 10' }));
    rendered.rerender(view('first', 1));
    expect(screen.getByRole('button', { name: 'Count 2' })).toBeTruthy();
    rendered.rerender(view('second', 10));
    expect(screen.getByRole('button', { name: 'Count 11' })).toBeTruthy();
  });

  it('shares fresh snapshots and functional updates among subscribers to the same key', () => {
    const store = createRetainedStateStore();
    render(<RetainedStateProvider store={store}><Counter /><Counter /></RetainedStateProvider>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Count 0' })[0]!);
    expect(screen.getAllByRole('button', { name: 'Count 1' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Count 1' })[1]!);
    expect(screen.getAllByRole('button', { name: 'Count 2' })).toHaveLength(2);
  });

  it('clears namespace prefixes exactly and keeps similarly named paths isolated', () => {
    const store = createRetainedStateStore();
    const a = store.getSnapshot(['messages', 'one', 'draft'], 'a');
    const b = store.getSnapshot(['messages', 'one-more', 'draft'], 'b');
    const c = store.getSnapshot(['messages:one', 'draft'], 'c');
    store.set(['messages', 'one', 'draft'], a.token, 'changed');
    store.set(['messages', 'one-more', 'draft'], b.token, 'kept');
    store.clearScope(['messages', 'one']);
    expect(store.getSnapshot(['messages', 'one', 'draft'], 'reset').value).toBe('reset');
    expect(store.getSnapshot(['messages', 'one-more', 'draft'], 'reset').value).toBe('kept');
    expect(store.getSnapshot(['messages:one', 'draft'], 'reset')).toBe(c);
  });

  it('invalidates stale async setters on clear and makes mounted controls writable with a fresh token', () => {
    const store = createRetainedStateStore();
    let current: Dispatch<SetStateAction<number>> = () => {};
    render(<RetainedStateProvider store={store}><Counter capture={(setter) => { current = setter; }} /></RetainedStateProvider>);
    const stale = current;
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    act(() => store.clear());
    expect(screen.getByRole('button', { name: 'Count 0' })).toBeTruthy();
    act(() => stale(99));
    expect(screen.getByRole('button', { name: 'Count 0' })).toBeTruthy();
    act(() => current((value) => value + 1));
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeTruthy();
  });

  it('keeps snapshots stable and initializes each key only once until it is cleared', () => {
    const store = createRetainedStateStore();
    let initializations = 0;
    const initialize = () => ++initializations;
    const first = store.getSnapshot(['x'], initialize);
    expect(store.getSnapshot(['x'], initialize)).toBe(first);
    expect(initializations).toBe(1);
    store.clearScope(['x']);
    const next = store.getSnapshot(['x'], initialize);
    expect(next.value).toBe(2);
    store.set(['x'], first.token, 100);
    expect(store.getSnapshot(['x'], initialize)).toBe(next);
  });
});
