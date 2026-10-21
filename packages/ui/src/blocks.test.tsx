import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChangesBlock, Reminder, ReminderBlock, UIBlock } from '@neo/protocol';
import { BlockRenderer, formatCell, type LiveData, type OnUIAction } from './blocks.js';
import { I18nProvider } from './i18n.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const reminder: ReminderBlock = { type: 'reminder', reminderId: 'rem_1', title: 'Stretch', notes: 'Walk outside\nBring water', dueAt: 1791864000000, timezone: 'UTC', recurrenceText: 'every day', status: 'scheduled' };
const fresh: Reminder = { id: 'rem_1', title: 'Stretch', notes: null, dueAt: reminder.dueAt, timezone: 'UTC', recurrence: null, status: 'scheduled', firedCount: 0, lastFiredAt: null, messageId: null, createdAt: 0, updatedAt: 0 };

function widget(block: UIBlock, live?: LiveData, onAction?: OnUIAction, locale = 'en') {
  return <I18nProvider locale={locale}><BlockRenderer block={block} live={live} onAction={onAction} /></I18nProvider>;
}

describe('ChangeDetails: reminder.update timezone', () => {
  it('renders a timezone-only reminder update with the from and to zones in the approval card', () => {
    const block: ChangesBlock = {
      type: 'changes',
      timezone: 'UTC',
      items: [{
        id: 'c1',
        kind: 'reminder.update',
        status: 'pending',
        reminderId: 'rem_1',
        title: 'Stretch',
        before: { timezone: 'America/New_York' },
        after: { timezone: 'America/Los_Angeles' },
      }],
    };
    const { container } = render(widget(block));
    const details = container.querySelector('.neo-change__details');
    expect(details).toBeTruthy();
    expect(details?.textContent).toContain('America/New_York');
    expect(details?.textContent).toContain('America/Los_Angeles');
    expect(details?.textContent).toBe('Timezone: America/New_York → America/Los_Angeles');
  });
});

describe('reminder state', () => {
  it('shows notes as a muted caption with the full text available', () => {
    const notes = 'A long reminder note.\n'.repeat(100);
    const { container } = render(widget({ ...reminder, notes }));
    const caption = container.querySelector('.neo-widget__notes');
    expect(caption?.textContent).toBe(notes);
    expect(caption?.getAttribute('title')).toBe(notes);
  });

  it('uses fresh notes and removes the caption when notes are cleared', () => {
    const view = render(widget(reminder, { reminders: { rem_1: { ...fresh, notes: 'Fresh notes' } } }));
    expect(screen.getByText('Fresh notes')).toBeTruthy();
    expect(screen.queryByText(reminder.notes!)).toBeNull();
    view.rerender(widget(reminder, { reminders: { rem_1: fresh } }));
    expect(view.container.querySelector('.neo-widget__notes')).toBeNull();
  });

  it('uses live recurrence and clears stale recurrence for one-off reminders', () => {
    const view = render(widget(reminder, { reminders: { rem_1: { ...fresh, recurrence: { freq: 'weekly', interval: 2, byWeekday: [1] } } } }));
    expect(screen.getByText('every 2 weeks on Mon')).toBeTruthy();
    expect(screen.queryByText('every day')).toBeNull();
    view.rerender(widget(reminder, { reminders: { rem_1: fresh } }));
    expect(screen.queryByText('every 2 weeks on Mon')).toBeNull();
    expect(screen.queryByText('every day')).toBeNull();
  });

  it.each([['en', 'Deleted'], ['zh-CN', '已删除']])('shows known deletions without active controls in %s', (locale, label) => {
    const { container } = render(widget(reminder, { reminders: { rem_1: null } }, vi.fn(), locale));
    expect(screen.getByText(label!)).toBeTruthy();
    expect(container.querySelector('[data-state="deleted"]')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps saved snapshots active when live data has not loaded their id', () => {
    render(widget(reminder, { reminders: {} }, vi.fn()));
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByText('Deleted')).toBeNull();
  });

  it('shows deleted status without active controls when list is loaded and id is missing', () => {
    const { container } = render(widget(reminder, { reminders: {}, remindersListLoaded: true }, vi.fn()));
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(container.querySelector('[data-state="deleted"]')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('task state', () => {
  it.each(['__proto__', 'constructor', 'toString'])('TasksRenderer treats the reserved id %s as a normal, isolated task', (id) => {
    render(widget({ type: 'tasks', tasks: [{ id, title: 'Work', done: false }] }));
    expect(screen.getByText(/0 of 1 done/i)).toBeTruthy();
  });
});

describe('accordion reserved ids', () => {
  // These tests render a "seed" item first so the retained-state map is initialised
  // without an own property for the reserved id.  When we rerender with an additional
  // item whose id is a reserved Object-prototype key, the map still has no own property
  // for it, so open[id] on origin/main returns the inherited prototype value — a truthy
  // function for 'constructor'/'toString' and Object.prototype for '__proto__' — and
  // incorrectly renders the new item as expanded.  The hasOwnProperty guard fixes this.
  it.each(['__proto__', 'constructor', 'toString'])(
    'AccordionRenderer does not expand a dynamically-added item whose id %s has no own entry in the open-state map',
    (id) => {
      const seed = { id: 'seed', title: 'Seed', open: false, children: [] as { type: 'text'; text: string }[] };
      const { rerender } = render(widget({ type: 'accordion', items: [seed] }));
      // The open-state map is now { seed: false } — no own property for the reserved id.
      const reserved = { id, title: 'Reserved', open: false, children: [{ type: 'text' as const, text: 'Must stay hidden' }] };
      rerender(widget({ type: 'accordion', items: [seed, reserved] }));
      const button = screen.getByRole('button', { name: 'Reserved' });
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('Must stay hidden')).toBeNull();
    }
  );
});

describe('changes reserved ids', () => {
  // The ChangesRenderer uses Object.fromEntries for initial state and spread+computed
  // keys for updates; both create own properties, so no Object.prototype method can
  // leak in as a boolean substitute through DOM-observable behaviour.  The
  // hasOwnProperty guard is defensive type-correctness.  We test the static invariant:
  // an item whose id is a reserved key and whose status is 'pending' is selected and
  // counted in the Apply button from the moment the block is rendered.
  it.each(['__proto__', 'constructor', 'toString'])(
    'ChangesRenderer counts an item with reserved id %s as pending and renders its checkbox as checked',
    (id) => {
      const block: import('@neo/protocol').ChangesBlock = {
        type: 'changes',
        items: [{ id, kind: 'task.update', taskId: 'task_1', title: 'Work', status: 'pending', before: { done: false }, after: { done: true } }],
      };
      render(widget(block, undefined, vi.fn()));
      const checkbox = screen.getByRole('checkbox', { name: 'Work' }) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      expect(screen.getByRole('button', { name: 'Apply 1 change' })).toBeTruthy();
    }
  );
});

describe('memory status', () => {
  it('MemoryRenderer shows a Forget control for an active node with id "__proto__"', () => {
    render(widget({ type: 'memory', nodes: [{ id: '__proto__', kind: 'fact', label: 'Likes tea', content: 'Likes tea', status: 'active' }] }, undefined, () => undefined));
    expect(screen.getByRole('button', { name: /forget/i })).toBeTruthy();
  });

  it('keeps a stored forgotten node resolved after remount despite stale live data', async () => {
    const block: UIBlock = { type: 'memory', nodes: [{ id: 'mem_1', kind: 'fact', label: 'Likes tea', status: 'active' }] };
    const onAction = vi.fn(async () => undefined);
    const view = render(widget(block, undefined, onAction));
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(await screen.findByText('Forgotten')).toBeTruthy();
    expect(onAction.mock.calls).toHaveLength(1);
    view.unmount();
    render(widget({ ...block, nodes: [{ ...block.nodes[0]!, status: 'forgotten' }] }, { memories: { mem_1: { status: 'active' } } }, onAction));
    expect(screen.getByRole('status').textContent).toBe('Forgotten');
    expect(screen.queryByRole('button', { name: 'Forget' })).toBeNull();
  });

  it('shows a stored forgotten status even without action handling', () => {
    render(widget({ type: 'memory', nodes: [{ id: 'mem_1', kind: 'fact', label: 'Likes tea', status: 'forgotten' }] }));
    expect(screen.getByText('Forgotten')).toBeTruthy();
  });
});

describe('formatted blocks', () => {
  it('TableRenderer renders "—" for a column keyed "toString" with no row value', () => {
    render(widget({ type: 'table', columns: [{ key: 'toString', label: 'Signature' }], rows: [{}] }));
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('uses countdown timezone for the visible date and timer label', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-13T00:00:00Z');
    const until = Date.parse('2026-10-14T00:00:00Z');
    render(widget({ type: 'countdown', label: 'Launch', until, timezone: 'Asia/Singapore' }));
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Launch: Oct 14, 2026, 8:00 AM');
    expect(screen.getByText('Oct 14, 2026, 8:00 AM')).toBeTruthy();
  });

  it.each(['en', 'zh-CN'])('uses table column currency and defaults old columns to USD in %s', (locale) => {
    const { container } = render(widget({ type: 'table', columns: [{ key: 'old', label: 'Old', format: 'currency' }, { key: 'eur', label: 'Euro', format: 'currency', currency: 'EUR' }, { key: 'jpy', label: 'Yen', format: 'currency', currency: 'JPY' }], rows: [{ old: 1234.5, eur: 1234.5, jpy: 1234.5 }] }, undefined, undefined, locale));
    expect(Array.from(container.querySelectorAll('td'), (cell) => cell.textContent)).toEqual(['USD', 'EUR', 'JPY'].map((currency) => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(1234.5)));
    expect(formatCell(1234.5, 'currency', locale, 'EUR')).toBe(new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(1234.5));
  });
});
