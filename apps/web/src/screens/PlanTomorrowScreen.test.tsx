import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@neo/ui';
import type { Reminder, Task } from '@neo/protocol';
import type { PlanTomorrow } from '../lib/plan-tomorrow.js';
import { appDictionaries } from '../i18n.js';
import { PlanTomorrowScreen } from './PlanTomorrowScreen.js';

const actions = vi.hoisted(() => ({ setChoice: vi.fn(), setDisclosure: vi.fn(), review: vi.fn(), edit: vi.fn(), apply: vi.fn(), retry: vi.fn(), reload: vi.fn() }));
vi.mock('../actions/plan-tomorrow.js', () => ({ usePlanTomorrow: () => scene }));

const NOW = Date.parse('2026-10-12T01:00:00Z');
const TOMORROW = Date.parse('2026-10-13T02:00:00Z');
function task(id: string, title = id): Task {
  return { id, title, listId: 'list_inbox', done: false, doneAt: null, dueAt: null, priority: 0, notes: null, tags: [], order: 0, parentId: null, createdAt: NOW, updatedAt: NOW };
}
function reminder(id: string, status: Reminder['status'] = 'scheduled'): Reminder {
  return { id, title: `Reminder ${id}`, dueAt: TOMORROW, timezone: 'Asia/Singapore', notes: null, recurrence: null, status, firedCount: 0, lastFiredAt: null, messageId: null, createdAt: NOW, updatedAt: NOW };
}
function makePlan(): PlanTomorrow {
  const tasks = [task('one', 'Write proposal'), task('two', 'Review budget'), task('three', 'Send files'), task('four', 'Book dentist')];
  return { key: 'scene', date: '2026-10-13', timezone: 'Asia/Singapore', private: false, epoch: 1, token: {}, stage: 'edit', status: 'ready', loadError: null, limited: false,
    baselines: Object.fromEntries(tasks.map((item) => [item.id, item])), acceptedTasks: {}, reminderIds: [], suggestedIds: ['one', 'two', 'three'],
    choices: Object.fromEntries(tasks.map((item, index) => [item.id, { include: index < 3, time: '10:00', addReminder: false }])), operations: [], disclosures: { alternatives: false, reminders: false },
  };
}
function makeScene() {
  const plan = makePlan();
  return { plan, loading: false, loadError: null as string | null, tasks: Object.values(plan.baselines), reminders: [reminder('scheduled'), reminder('completed', 'completed')], suggestedIds: plan.suggestedIds,
    invalid: {} as Record<string, string>, ...actions };
}
let scene = makeScene();
function view(locale = 'en') { return <I18nProvider locale={locale} messages={appDictionaries}><PlanTomorrowScreen /></I18nProvider>; }

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); scene = makeScene(); });

describe('Plan tomorrow working scene', () => {
  it('shows a grounded recommendation and keeps other tasks behind a disclosure', () => {
    const rendered = render(view());
    expect(screen.getByRole('heading', { name: 'Plan tomorrow', level: 1 })).toBeTruthy();
    expect(screen.getByText('Reminder scheduled')).toBeTruthy();
    expect(screen.queryByText('Reminder completed')).toBeNull();
    expect(rendered.container.querySelector('.plan-alternatives')?.getAttribute('open')).toBeNull();
    expect(screen.getByRole('button', { name: 'Review plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Target time for Write proposal$/), { target: { value: '11:30' } });
    expect(actions.setChoice).toHaveBeenCalledWith('one', { time: '11:30' });
    fireEvent.keyDown(screen.getByLabelText(/Target time for Write proposal$/), { key: 'Enter' });
    expect(actions.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }));
    expect(actions.review).toHaveBeenCalledOnce();
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it('restores disclosure choices and sends changes back to the retained plan', () => {
    scene.plan.disclosures = { alternatives: true, reminders: true };
    scene.reminders = [1, 2, 3, 4, 5].map((id) => reminder(String(id)));
    const rendered = render(view());
    const alternatives = rendered.container.querySelector('.plan-alternatives') as HTMLDetailsElement;
    const moreReminders = rendered.container.querySelector('.plan-context__more') as HTMLDetailsElement;
    expect(alternatives.open).toBe(true);
    expect(moreReminders.open).toBe(true);
    alternatives.open = false;
    fireEvent(alternatives, new Event('toggle'));
    expect(actions.setDisclosure).toHaveBeenCalledWith('alternatives', false);
    moreReminders.open = false;
    fireEvent(moreReminders, new Event('toggle'));
    expect(actions.setDisclosure).toHaveBeenCalledWith('reminders', false);
  });

  it('does not suggest later tasks as tomorrow obligations', () => {
    scene.suggestedIds = [];
    scene.plan.suggestedIds = [];
    scene.plan.choices = Object.fromEntries(scene.tasks.map((item) => [item.id, { include: false, time: '10:00', addReminder: false }]));
    render(view());
    expect(screen.getByText('No open tasks are due by tomorrow. Choose another task below if needed.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review plan' }) as HTMLButtonElement).disabled).toBe(true);
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it('shows exact due-time and reminder changes before the explicit apply action', () => {
    scene.plan.stage = 'review';
    scene.plan.operations = [
      { id: 'due:one', taskId: 'one', title: 'Write proposal', kind: 'due', before: NOW, after: TOMORROW, status: 'pending' },
      { id: 'reminder:one', taskId: 'one', title: 'Write proposal', kind: 'reminder', before: null, after: TOMORROW, status: 'pending' },
    ];
    render(view());
    expect(screen.getByText('Nothing changes until you apply.')).toBeTruthy();
    expect(screen.getByText('Task due time')).toBeTruthy();
    expect(screen.getByText('New reminder')).toBeTruthy();
    expect(screen.getAllByText('Before')).toHaveLength(2);
    expect(screen.getAllByText('After')).toHaveLength(2);
    expect(screen.getByText('No reminder')).toBeTruthy();
    expect(actions.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(actions.apply).toHaveBeenCalledOnce();
  });

  it('explains a source change during review and offers explicit refresh before approval', () => {
    scene.plan.stage = 'review';
    scene.plan.operations = [{ id: 'due:one', taskId: 'one', title: 'Write proposal', kind: 'due', before: null, after: TOMORROW, status: 'pending' }];
    scene.invalid = { one: 'changed' };
    const rendered = render(view());
    expect(screen.getByText('This task changed since you started. Refresh to review its latest values.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply changes' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
    expect(actions.reload).toHaveBeenCalledOnce();
    expect(actions.apply).not.toHaveBeenCalled();
    scene.plan = { ...scene.plan, stage: 'edit' };
    scene.invalid = {};
    rendered.rerender(view());
    expect(screen.getByRole('button', { name: 'Review plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  });

  it('moves keyboard focus to the review heading only after an explicit review action', () => {
    const rendered = render(view());
    const review = screen.getByRole('button', { name: 'Review plan' });
    review.focus();
    expect(document.activeElement).toBe(review);
    fireEvent.click(review);
    scene.plan = { ...scene.plan, stage: 'review', operations: [{ id: 'due:one', taskId: 'one', title: 'Write proposal', kind: 'due', before: null, after: TOMORROW, status: 'pending' }] };
    rendered.rerender(view());
    const heading = screen.getByRole('heading', { name: 'Review changes' });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
  });

  it('does not autofocus a resumed review or an unrelated stage update', () => {
    scene.plan.stage = 'review';
    const resumed = render(view());
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: 'Review changes' }));
    resumed.unmount();
    scene = makeScene();
    const rendered = render(view());
    const input = screen.getByLabelText(/Target time for Write proposal$/);
    input.focus();
    scene.plan = { ...scene.plan, stage: 'review' };
    rendered.rerender(view());
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: 'Review changes' }));
  });

  it('allows repairing invalid times but prevents writes to stale source tasks', () => {
    scene.invalid = { one: 'time', two: 'changed' };
    render(view());
    expect((screen.getByLabelText(/Target time for Write proposal$/) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText(/Target time for Review budget$/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Review plan' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Target time for Write proposal$/), { target: { value: '12:00' } });
    expect(actions.setChoice).toHaveBeenCalledWith('one', { time: '12:00' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
    expect(actions.reload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByLabelText('Include Review budget'));
    expect(actions.setChoice).toHaveBeenCalledWith('two', { include: false });
  });

  it('distinguishes pending, saved and failed results and offers retry only for remaining changes', () => {
    scene.plan.stage = 'saving';
    scene.plan.operations = [
      { id: 'due:one', taskId: 'one', title: 'Write proposal', kind: 'due', before: null, after: TOMORROW, status: 'saved' },
      { id: 'reminder:one', taskId: 'one', title: 'Write proposal', kind: 'reminder', before: null, after: TOMORROW, status: 'saving' },
    ];
    const rendered = render(view());
    expect(screen.getByText('Saved 1 of 2 changes.')).toBeTruthy();
    expect(screen.queryByText('All changes saved')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
    scene.plan = { ...scene.plan, stage: 'partial', operations: [{ ...scene.plan.operations[0]!, status: 'saved' }, { ...scene.plan.operations[1]!, status: 'error', error: 'Connection lost' }] };
    rendered.rerender(view());
    fireEvent.click(screen.getByRole('button', { name: 'Retry remaining changes' }));
    expect(actions.retry).toHaveBeenCalledOnce();
  });

  it('provides read-only recovery for an unconfirmed reminder without offering blind retry', () => {
    scene.plan.stage = 'partial';
    scene.plan.operations = [{ id: 'reminder:one', taskId: 'one', title: 'Write proposal', kind: 'reminder', before: null, after: TOMORROW, status: 'error', reason: 'reminder-unknown' }];
    render(view());
    expect(screen.getByRole('button', { name: 'Check reminders' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry remaining changes' })).toBeNull();
  });

  it('offers read-only reconciliation for an uncertain privacy-interrupted reminder and hides blocked edit controls', () => {
    scene.plan.stage = 'partial';
    scene.plan.operations = [{ id: 'reminder:one', taskId: 'one', title: 'Write proposal', kind: 'reminder', before: null, after: TOMORROW, status: 'error', reason: 'session', uncertain: true }];
    render(view());
    expect(screen.getByRole('button', { name: 'Check reminders' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry remaining changes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check saved changes' }));
    expect(actions.reload).toHaveBeenCalledOnce();
    expect(actions.retry).not.toHaveBeenCalled();
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it('waits for initial source loading before presenting an empty day and supports load retry', () => {
    scene.plan = { ...scene.plan, status: 'loading', baselines: {}, choices: {}, suggestedIds: [] };
    scene.loading = true;
    scene.tasks = [];
    scene.reminders = [];
    const rendered = render(view());
    expect(screen.getByRole('status', { name: 'Loading your day…' })).toBeTruthy();
    expect(screen.queryByText('No open tasks to plan')).toBeNull();
    scene.plan = { ...scene.plan, status: 'error' };
    scene.loading = false;
    scene.loadError = 'Offline';
    rendered.rerender(view());
    expect(screen.getByText('Couldn’t load your tasks and reminders.')).toBeTruthy();
    expect(screen.queryByText('No open tasks to plan')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(actions.reload).toHaveBeenCalledOnce();
  });

  it('shows the empty state only after a successful empty source load and translates the scene', () => {
    scene.plan = { ...scene.plan, baselines: {}, choices: {}, suggestedIds: [] };
    scene.tasks = [];
    scene.reminders = [];
    const rendered = render(view());
    expect(screen.getByText('No open tasks to plan')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review plan' })).toBeNull();
    rendered.rerender(view('zh-CN'));
    expect(screen.getByRole('heading', { name: '规划明天', level: 1 })).toBeTruthy();
    expect(rendered.container.textContent).not.toMatch(/plan\./);
  });
});
