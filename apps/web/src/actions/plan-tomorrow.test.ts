import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, type Reminder, type ReminderInput, type Task, type TaskPatch } from '@neo/protocol';
import { navigate } from '../router.js';
import { useData } from '../state/data.js';
import { ensurePlanTomorrow, planForSession, resetPlanTomorrow, setPlanChoice, setPlanDisclosure, usePlanTomorrowState } from '../state/plan-tomorrow.js';
import { useSession } from '../state/session.js';
import { emptyEntry, useTimeline } from '../state/timeline.js';
import { applyPlanTomorrow, editPlanTomorrow, loadPlanTomorrow, openPlanTomorrow, reviewPlanTomorrow } from './plan-tomorrow.js';

vi.mock('../router.js', () => ({ navigate: vi.fn() }));
const NOW = Date.parse('2026-10-12T04:00:00Z');
const task = (id: string): Task => ({ id, title: `Task ${id}`, listId: 'inbox', notes: null, dueAt: null, done: false, doneAt: null, priority: 1, tags: [], order: 0, parentId: null, createdAt: 1, updatedAt: 1 });
const reminder = (body: ReminderInput, id: string): Reminder => ({ ...body, id, notes: body.notes ?? null, timezone: body.timezone ?? 'UTC', recurrence: null, status: 'scheduled', firedCount: 0, lastFiredAt: null, messageId: null, createdAt: NOW, updatedAt: NOW });

function fixture(ids = ['a', 'b']) {
  const tasks = Object.fromEntries(ids.map((id) => [id, task(id)]));
  const reminders: Reminder[] = [];
  const listTasks = vi.fn(async () => ({ items: Object.values(tasks) }));
  const updateTask = vi.fn(async (id: string, patch: TaskPatch) => {
    const updated = { ...tasks[id]!, ...patch, updatedAt: tasks[id]!.updatedAt + 1 } as Task;
    tasks[id] = updated;
    return updated;
  });
  const listReminders = vi.fn(async () => ({ items: [...reminders] }));
  const createReminder = vi.fn(async (body: ReminderInput) => { const created = reminder(body, `r${reminders.length + 1}`); reminders.push(created); return created; });
  const client = { tasks: { list: listTasks, update: updateTask }, reminders: { list: listReminders, create: createReminder } } as unknown as NeoClient;
  useSession.setState({ client, sessionEpoch: 10, settings: { ...DEFAULT_SETTINGS, timezone: 'UTC' } });
  return { tasks, reminders, client, listTasks, updateTask, listReminders, createReminder };
}

async function ready() {
  const plan = ensurePlanTomorrow({ timezone: 'UTC', now: NOW });
  await loadPlanTomorrow(plan.key);
  return plan;
}

const currentPlan = (key: string) => usePlanTomorrowState.getState().drafts[key]!;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetPlanTomorrow();
  useTimeline.setState({ ...emptyEntry(), offRecordLoaded: true }, true);
  useData.setState({ tasks: {}, reminders: {}, tasksLoaded: false, remindersLoaded: false });
});
afterEach(() => { vi.useRealTimers(); resetPlanTomorrow(); });

describe('Plan tomorrow review and real receipts', () => {
  it('restarts a deferred source read after a privacy roundtrip and ignores its old response', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { time: '15:45', addReminder: true });
    setPlanDisclosure(plan.key, 'alternatives', true);
    reviewPlanTomorrow(plan.key);
    const pending = deferred<{ items: Task[] }>();
    f.listTasks.mockImplementationOnce(() => pending.promise);
    const oldLoad = loadPlanTomorrow(plan.key);
    const oldToken = currentPlan(plan.key).token;
    expect(currentPlan(plan.key).status).toBe('loading');
    useTimeline.setState({ offRecord: true });
    expect(currentPlan(plan.key).status).toBe('idle');
    expect(currentPlan(plan.key).token).not.toBe(oldToken);
    useTimeline.setState({ offRecord: false });
    f.tasks.a = { ...f.tasks.a!, title: 'Newest server title', updatedAt: 2 };
    await loadPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).status).toBe('ready');
    pending.resolve({ items: [{ ...task('a'), title: 'Stale response title' }] });
    await oldLoad;
    expect(useData.getState().tasks.a?.title).toBe('Newest server title');
    expect(currentPlan(plan.key).status).toBe('ready');
    expect(currentPlan(plan.key).choices.a).toEqual({ include: true, time: '15:45', addReminder: true });
    expect(currentPlan(plan.key).stage).toBe('review');
    expect(currentPlan(plan.key).disclosures.alternatives).toBe(true);
    expect(currentPlan(plan.key).operations).toHaveLength(2);
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.createReminder).not.toHaveBeenCalled();
  });

  it('keeps a deferred source load valid when a privacy transition fails without changing mode', async () => {
    const f = fixture(['a']);
    const plan = ensurePlanTomorrow({ timezone: 'UTC', now: NOW });
    const pending = deferred<{ items: Task[] }>();
    f.listTasks.mockImplementationOnce(() => pending.promise);
    const loading = loadPlanTomorrow(plan.key);
    const originalToken = currentPlan(plan.key).token;
    useTimeline.setState({ startingOffRecord: true });
    useTimeline.setState({ startingOffRecord: false });
    expect(currentPlan(plan.key).status).toBe('loading');
    expect(currentPlan(plan.key).token).toBe(originalToken);
    pending.resolve({ items: Object.values(f.tasks) });
    await loading;
    expect(currentPlan(plan.key).status).toBe('ready');
    expect(currentPlan(plan.key).choices.a?.include).toBe(true);
    expect(f.listTasks).toHaveBeenCalledOnce();
  });

  it('does not count an unchanged due time as a saved change or call the write APIs', async () => {
    const f = fixture(['a']);
    f.tasks.a = { ...f.tasks.a!, dueAt: Date.parse('2026-10-13T09:00Z') };
    const plan = await ready();
    reviewPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).stage).toBe('review');
    expect(currentPlan(plan.key).operations).toEqual([]);
    await applyPlanTomorrow(plan.key);
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.createReminder).not.toHaveBeenCalled();
  });

  it('applies an optional reminder alone when the task already has the selected due time', async () => {
    const f = fixture(['a']);
    f.tasks.a = { ...f.tasks.a!, dueAt: Date.parse('2026-10-13T09:00Z') };
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { addReminder: true });
    reviewPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).operations).toHaveLength(1);
    expect(currentPlan(plan.key).operations[0]?.kind).toBe('reminder');
    await applyPlanTomorrow(plan.key);
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.createReminder).toHaveBeenCalledOnce();
    expect(currentPlan(plan.key).operations[0]?.status).toBe('saved');
    expect(currentPlan(plan.key).stage).toBe('saved');
  });

  it('loads real saved context and writes only after review plus explicit Apply', async () => {
    const f = fixture();
    f.reminders.push(reminder({ title: 'Recurring context', dueAt: Date.parse('2026-10-13T08:00Z'), recurrence: { freq: 'daily', interval: 1 } }, 'existing'));
    const plan = await ready();
    expect(currentPlan(plan.key).reminderIds).toEqual(['existing']);
    setPlanChoice(plan.key, 'a', { time: '10:15', addReminder: true });
    reviewPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).stage).toBe('review');
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.createReminder).not.toHaveBeenCalled();
    await applyPlanTomorrow(plan.key);
    expect(f.updateTask).toHaveBeenCalledWith('a', { dueAt: Date.parse('2026-10-13T10:15Z') });
    expect(f.createReminder).toHaveBeenCalledOnce();
    expect(f.createReminder.mock.calls[0]![0]).toMatchObject({ title: 'Task a', timezone: 'UTC', dueAt: Date.parse('2026-10-13T10:15Z'), recurrence: null });
    expect(currentPlan(plan.key).stage).toBe('saved');
    expect(currentPlan(plan.key).operations.every((receipt) => receipt.status === 'saved')).toBe(true);
  });

  it('preserves selections, review and view choices when reopened across dates and privacy modes', async () => {
    fixture();
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { time: '15:45', addReminder: true });
    setPlanDisclosure(plan.key, 'alternatives', true);
    reviewPlanTomorrow(plan.key);
    ensurePlanTomorrow({ date: '2026-10-14', timezone: 'UTC' });
    const reopened = openPlanTomorrow({ date: plan.date, timezone: 'UTC' });
    expect(reopened.choices.a).toEqual({ include: true, time: '15:45', addReminder: true });
    expect(reopened.stage).toBe('review');
    expect(reopened.disclosures.alternatives).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'plan-tomorrow', date: '2026-10-13' });
    useTimeline.setState({ offRecord: true });
    const privatePlan = ensurePlanTomorrow({ date: plan.date, timezone: 'UTC' });
    expect(privatePlan.key).not.toBe(plan.key);
    useTimeline.setState({ offRecord: false });
    expect(usePlanTomorrowState.getState().drafts[privatePlan.key]).toBeUndefined();
    expect(planForSession(plan.date, 'UTC')?.choices.a?.time).toBe('15:45');
  });

  it('reports partial outcomes and retries only unapplied operations', async () => {
    const f = fixture();
    const plan = await ready();
    const normalUpdate = f.updateTask.getMockImplementation()!;
    f.updateTask.mockImplementation(async (id, patch) => { if (id === 'b' && f.updateTask.mock.calls.filter(([taskId]) => taskId === 'b').length === 1) throw new Error('Task save failed'); return normalUpdate(id, patch); });
    reviewPlanTomorrow(plan.key);
    await applyPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).stage).toBe('partial');
    expect(currentPlan(plan.key).operations.find((receipt) => receipt.taskId === 'a')?.status).toBe('saved');
    expect(currentPlan(plan.key).operations.find((receipt) => receipt.taskId === 'b')?.status).toBe('error');
    await applyPlanTomorrow(plan.key, true);
    expect(f.updateTask.mock.calls.filter(([id]) => id === 'a')).toHaveLength(1);
    expect(f.updateTask.mock.calls.filter(([id]) => id === 'b')).toHaveLength(2);
    expect(currentPlan(plan.key).stage).toBe('saved');
  });

  it.each(['changed', 'done', 'deleted'] as const)('blocks a %s source task before applying a reviewed plan', async (reason) => {
    const f = fixture(['a']);
    const plan = await ready();
    reviewPlanTomorrow(plan.key);
    if (reason === 'deleted') delete f.tasks.a;
    else f.tasks.a = { ...f.tasks.a!, updatedAt: 2, ...(reason === 'done' ? { done: true } : { title: 'New source title' }) };
    await applyPlanTomorrow(plan.key);
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(currentPlan(plan.key).operations[0]?.reason).toBe(reason);
    expect(currentPlan(plan.key).stage).toBe('error');
  });

  it('explicit refresh rebases changed source tasks but preserves editable choices and requires review', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { time: '16:00' });
    reviewPlanTomorrow(plan.key);
    f.tasks.a = { ...f.tasks.a!, title: 'Updated task', updatedAt: 2 };
    await applyPlanTomorrow(plan.key);
    await loadPlanTomorrow(plan.key, true);
    expect(currentPlan(plan.key).baselines.a?.title).toBe('Updated task');
    expect(currentPlan(plan.key).choices.a?.time).toBe('16:00');
    expect(currentPlan(plan.key).stage).toBe('edit');
    await applyPlanTomorrow(plan.key);
    expect(f.updateTask).not.toHaveBeenCalled();
    reviewPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).operations[0]).toMatchObject({ title: 'Updated task', before: null, status: 'pending' });
    await applyPlanTomorrow(plan.key);
    expect(f.updateTask).toHaveBeenCalledOnce();
  });

  it('reconciles a reminder accepted before its response was lost without creating a duplicate', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { addReminder: true });
    reviewPlanTomorrow(plan.key);
    f.createReminder.mockImplementationOnce(async (body) => { f.reminders.push(reminder(body, 'accepted')); throw new Error('Response lost'); });
    await applyPlanTomorrow(plan.key);
    expect(f.createReminder).toHaveBeenCalledOnce();
    expect(currentPlan(plan.key).operations.find((receipt) => receipt.kind === 'reminder')).toMatchObject({ status: 'saved', reminderId: 'accepted' });
    await applyPlanTomorrow(plan.key, true);
    expect(f.createReminder).toHaveBeenCalledOnce();
  });

  it('checks existing reminder scope before creating and never blindly retries an uncertain create', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { addReminder: true });
    reviewPlanTomorrow(plan.key);
    f.createReminder.mockRejectedValueOnce(new Error('Connection lost'));
    await applyPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).stage).toBe('partial');
    await applyPlanTomorrow(plan.key, true);
    expect(f.createReminder).toHaveBeenCalledOnce();
    expect(currentPlan(plan.key).operations.find((receipt) => receipt.kind === 'reminder')).toMatchObject({ status: 'error', reason: 'reminder-unknown', uncertain: true });
    const after = currentPlan(plan.key).operations.find((receipt) => receipt.kind === 'reminder')!.after;
    const creationKey = currentPlan(plan.key).operations.find((receipt) => receipt.kind === 'reminder')!.creationKey;
    f.reminders.push(reminder({ title: 'Task a', dueAt: after, timezone: 'UTC', creationKey }, 'late-accepted'));
    await applyPlanTomorrow(plan.key, true);
    expect(currentPlan(plan.key).stage).toBe('saved');
    expect(f.createReminder).toHaveBeenCalledOnce();
  });

  it('keeps an uncertain reminder receipt visible instead of allowing replacement at a new time', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { addReminder: true });
    reviewPlanTomorrow(plan.key);
    f.createReminder.mockRejectedValueOnce(new Error('Response lost'));
    await applyPlanTomorrow(plan.key);
    editPlanTomorrow(plan.key);
    setPlanChoice(plan.key, 'a', { time: '17:00', addReminder: false });
    expect(currentPlan(plan.key).stage).toBe('partial');
    expect(currentPlan(plan.key).choices.a?.time).toBe('09:00');
    await loadPlanTomorrow(plan.key, true);
    expect(currentPlan(plan.key).stage).toBe('partial');
    expect(currentPlan(plan.key).operations.find((receipt) => receipt.kind === 'reminder')?.uncertain).toBe(true);
    await applyPlanTomorrow(plan.key, true);
    expect(f.createReminder).toHaveBeenCalledOnce();
  });

  it('deduplicates simultaneous Apply controls', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    reviewPlanTomorrow(plan.key);
    await Promise.all([applyPlanTomorrow(plan.key), applyPlanTomorrow(plan.key)]);
    expect(f.updateTask).toHaveBeenCalledOnce();
  });

  it('retains the creation UUID for retry and gives a fresh intentional plan a new UUID', async () => {
    const f = fixture(['a']);
    const first = await ready();
    setPlanChoice(first.key, 'a', { addReminder: true });
    reviewPlanTomorrow(first.key);
    const firstKey = currentPlan(first.key).operations.find((receipt) => receipt.kind === 'reminder')!.creationKey;
    expect(firstKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    f.createReminder.mockRejectedValueOnce(Object.assign(new Error('Request rejected'), { httpStatus: 429 }));
    await applyPlanTomorrow(first.key);
    await applyPlanTomorrow(first.key, true);
    expect(f.createReminder.mock.calls.map(([body]) => body.creationKey)).toEqual([firstKey, firstKey]);
    expect(f.createReminder.mock.calls.every(([body]) => body.notes === null)).toBe(true);
    resetPlanTomorrow();
    const second = await ready();
    setPlanChoice(second.key, 'a', { addReminder: true });
    reviewPlanTomorrow(second.key);
    const secondKey = currentPlan(second.key).operations.find((receipt) => receipt.kind === 'reminder')!.creationKey;
    expect(secondKey).not.toBe(firstKey);
    await applyPlanTomorrow(second.key);
    expect(f.createReminder).toHaveBeenCalledTimes(3);
    expect(f.reminders).toHaveLength(2);
  });

  it('does not accept an unreviewed source change merely because its due value matches the target', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    setPlanChoice(plan.key, 'a', { addReminder: true });
    reviewPlanTomorrow(plan.key);
    f.tasks.a = { ...f.tasks.a!, dueAt: Date.parse('2026-10-13T09:00Z'), priority: 3, updatedAt: 2 };
    await applyPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).operations[0]?.reason).toBe('changed');
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.createReminder).not.toHaveBeenCalled();
  });

  it('stops subsequent writes and ignores responses after switching sessions', async () => {
    const f = fixture();
    const plan = await ready();
    reviewPlanTomorrow(plan.key);
    const pending = deferred<Task>();
    f.updateTask.mockImplementationOnce(() => pending.promise);
    const applying = applyPlanTomorrow(plan.key);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.updateTask).toHaveBeenCalledOnce();
    resetPlanTomorrow();
    useSession.setState({ sessionEpoch: 11 });
    pending.resolve({ ...f.tasks.a!, dueAt: Date.parse('2026-10-13T09:00Z'), updatedAt: 2 });
    await applying;
    expect(f.updateTask).toHaveBeenCalledOnce();
    expect(usePlanTomorrowState.getState().drafts).toEqual({});
  });

  it('invalidates pending operations on privacy switches even if the original mode returns before the response', async () => {
    const f = fixture();
    const plan = await ready();
    reviewPlanTomorrow(plan.key);
    const pending = deferred<Task>();
    f.updateTask.mockImplementationOnce(() => pending.promise);
    const applying = applyPlanTomorrow(plan.key);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    useTimeline.setState({ offRecord: true });
    useTimeline.setState({ offRecord: false });
    expect(currentPlan(plan.key).token).not.toBe(plan.token);
    pending.resolve({ ...f.tasks.a!, dueAt: Date.parse('2026-10-13T09:00Z'), updatedAt: 2 });
    await applying;
    expect(f.updateTask).toHaveBeenCalledOnce();
    expect(currentPlan(plan.key).stage).toBe('partial');
    expect(currentPlan(plan.key).operations[0]).toMatchObject({ status: 'error', reason: 'session', uncertain: true });
  });

  it('keeps the captured date and refuses reviewed target times once they are past', async () => {
    const f = fixture(['a']);
    const plan = await ready();
    reviewPlanTomorrow(plan.key);
    vi.setSystemTime(Date.parse('2026-10-14T04:00Z'));
    await applyPlanTomorrow(plan.key);
    expect(currentPlan(plan.key).date).toBe('2026-10-13');
    expect(currentPlan(plan.key).operations[0]?.reason).toBe('past');
    expect(f.updateTask).not.toHaveBeenCalled();
  });
});
