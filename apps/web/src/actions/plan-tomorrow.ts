import { useEffect, useMemo, useState } from 'react';
import type { NeoClient } from '@neo/client';
import type { Reminder, Task } from '@neo/protocol';
import { buildPlanReceipts, initialPlanChoices, invalidPlanChoices, matchingPlanReminder, samePlanTask, type PlanChoice, type PlanInvalidReason, type PlanReceipt, type PlanTomorrow } from '../lib/plan-tomorrow.js';
import { deviceTimeZone } from '../lib/time.js';
import { httpStatus } from '../lib/errors.js';
import { navigate } from '../router.js';
import { upsertReminder, upsertTask, useData } from '../state/data.js';
import { loadOffRecord } from '../state/connection.js';
import { ensurePlanTomorrow, planForSession, setPlanChoice, setPlanDisclosure, updatePlanTomorrow, usePlanTomorrowState } from '../state/plan-tomorrow.js';
import { isCurrentSession, requireClient, useSession } from '../state/session.js';
import { useTimeline } from '../state/timeline.js';

export type { PlanChoice, PlanInvalidReason, PlanReceipt, PlanTomorrow } from '../lib/plan-tomorrow.js';
const MAX_SOURCE_ITEMS = 500;
const loads = new Map<object, Promise<void>>();
const applications = new Map<object, Promise<void>>();
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unable to save this change';

function current(plan: PlanTomorrow, client: NeoClient, writes = false): boolean {
  const privacy = useTimeline.getState();
  return isCurrentSession(plan.epoch, client) && usePlanTomorrowState.getState().drafts[plan.key]?.token === plan.token && privacy.offRecord === plan.private &&
    (!writes || (privacy.offRecordLoaded && !privacy.startingOffRecord && !privacy.endingOffRecord));
}

async function sources(client: NeoClient, plan: PlanTomorrow): Promise<{ tasks: Record<string, Task>; reminders: Reminder[]; limited: boolean } | null> {
  const [tasks, reminders] = await Promise.all([client.tasks.list({ limit: MAX_SOURCE_ITEMS }), client.reminders.list({ limit: MAX_SOURCE_ITEMS })]);
  if (!current(plan, client)) return null;
  const taskMap = Object.fromEntries(tasks.items.map((task) => [task.id, task]));
  useData.setState({ tasks: taskMap, tasksLoaded: true, reminders: Object.fromEntries(reminders.items.map((reminder) => [reminder.id, reminder])), remindersLoaded: true });
  return { tasks: taskMap, reminders: reminders.items, limited: tasks.items.length >= MAX_SOURCE_ITEMS || reminders.items.length >= MAX_SOURCE_ITEMS };
}

export function openPlanTomorrow(input: { date?: string; timezone: string; intent?: string }): PlanTomorrow {
  const plan = ensurePlanTomorrow(input);
  navigate({ name: 'plan-tomorrow', date: plan.date });
  return plan;
}

/** Explicit reload rebases editable choices; the pre-apply read deliberately does not. */
export function loadPlanTomorrow(key: string, rebase = false): Promise<void> {
  const plan = usePlanTomorrowState.getState().drafts[key];
  if (!plan) return Promise.resolve();
  const pending = loads.get(plan.token);
  if (pending) return pending;
  const client = requireClient();
  updatePlanTomorrow(key, plan.token, (draft) => ({ ...draft, status: 'loading', loadError: null }));
  let loading!: Promise<void>;
  loading = (async () => {
    try {
      const fetched = await sources(client, plan);
      if (!fetched) return;
      updatePlanTomorrow(key, plan.token, (draft) => {
        const initial = initialPlanChoices(Object.values(fetched.tasks), plan.date, plan.timezone);
        const first = Object.keys(draft.baselines).length === 0;
        const baselines = first ? Object.fromEntries(Object.values(fetched.tasks).filter((task) => !task.done).map((task) => [task.id, task])) : rebase ? { ...draft.baselines, ...fetched.tasks } : draft.baselines;
        const operations = rebase ? draft.operations.map((receipt) => {
          if (!receipt.uncertain) return receipt;
          if (receipt.kind === 'reminder') {
            const existing = matchingPlanReminder(fetched.reminders, receipt, plan.timezone);
            return existing ? { ...receipt, status: 'saved' as const, reminderId: existing.id, uncertain: false, reason: undefined, error: undefined } : receipt;
          }
          const task = fetched.tasks[receipt.taskId];
          return task && task.dueAt === receipt.after && task.title === receipt.title ? { ...receipt, status: 'saved' as const, uncertain: false, reason: undefined, error: undefined } : receipt;
        }) : draft.operations;
        const unresolved = operations.some((receipt) => receipt.uncertain);
        return { ...draft, status: 'ready', loadError: null, limited: fetched.limited, baselines,
          reminderIds: fetched.reminders.filter((reminder) => reminder.status === 'scheduled').map((reminder) => reminder.id),
          suggestedIds: first || rebase ? initial.suggestedIds : draft.suggestedIds,
          choices: first ? initial.choices : rebase ? { ...initial.choices, ...draft.choices } : draft.choices,
          acceptedTasks: rebase ? {} : draft.acceptedTasks, operations,
          stage: rebase ? unresolved ? operations.some((receipt) => receipt.status === 'saved') ? 'partial' : 'error' : 'edit' : draft.stage,
        };
      });
    } catch (error) {
      if (current(plan, client)) updatePlanTomorrow(key, plan.token, (draft) => ({ ...draft, status: 'error', loadError: errorText(error) }));
    } finally { if (loads.get(plan.token) === loading) loads.delete(plan.token); }
  })();
  loads.set(plan.token, loading);
  return loading;
}

export function reviewPlanTomorrow(key: string): void {
  const plan = usePlanTomorrowState.getState().drafts[key];
  if (!plan || plan.status !== 'ready' || plan.stage === 'saving' || !Object.values(plan.choices).some((choice) => choice.include)) return;
  if (Object.keys(invalidPlanChoices(plan, useData.getState().tasks)).length) return;
  updatePlanTomorrow(key, plan.token, (draft) => ({ ...draft, stage: 'review', operations: buildPlanReceipts(draft) }));
}

export function editPlanTomorrow(key: string): void {
  const plan = usePlanTomorrowState.getState().drafts[key];
  if (plan && plan.stage !== 'saving' && !plan.operations.some((receipt) => receipt.uncertain)) updatePlanTomorrow(key, plan.token, (draft) => ({ ...draft, stage: 'edit' }));
}

function receiptUpdate(plan: PlanTomorrow, id: string, patch: Partial<PlanReceipt>): void {
  updatePlanTomorrow(plan.key, plan.token, (draft) => ({ ...draft, operations: draft.operations.map((receipt) => receipt.id === id ? { ...receipt, ...patch } : receipt) }));
}

function operationInvalid(plan: PlanTomorrow, receipt: PlanReceipt, tasks: Record<string, Task>): PlanInvalidReason | undefined {
  const expected = usePlanTomorrowState.getState().drafts[plan.key]?.acceptedTasks[receipt.taskId] ?? plan.acceptedTasks[receipt.taskId] ?? plan.baselines[receipt.taskId];
  const task = tasks[receipt.taskId];
  if (!task) return plan.limited ? 'source-unavailable' : 'deleted';
  if (task.done) return 'done';
  // A lost task-update response is safe to reconcile when the reviewed due value is now stored.
  if (receipt.after <= Date.now()) return 'past';
  if (receipt.kind === 'due' && (receipt.uncertain || receipt.status === 'error') && task.dueAt === receipt.after && task.title === expected?.title) return undefined;
  if (!expected || !samePlanTask(task, expected)) return 'changed';
  return undefined;
}

async function reconcileReminder(client: NeoClient, plan: PlanTomorrow, receipt: PlanReceipt): Promise<Reminder | undefined> {
  const { items } = await client.reminders.list({ from: receipt.after, to: receipt.after, limit: MAX_SOURCE_ITEMS });
  if (!current(plan, client, true)) return undefined;
  const existing = matchingPlanReminder(items, receipt, plan.timezone);
  if (existing) upsertReminder(existing);
  return existing;
}

async function runApply(plan: PlanTomorrow, client: NeoClient): Promise<void> {
  if (!current(plan, client, true)) return;
  updatePlanTomorrow(plan.key, plan.token, (draft) => ({ ...draft, stage: 'saving', loadError: null }));
  try {
    const fetched = await sources(client, plan);
    if (!fetched || !current(plan, client, true)) return;
    updatePlanTomorrow(plan.key, plan.token, (draft) => ({ ...draft, limited: fetched.limited }));
    for (const original of plan.operations) {
      if (!current(plan, client, true)) return;
      const draft = usePlanTomorrowState.getState().drafts[plan.key]!;
      const receipt = draft.operations.find((operation) => operation.id === original.id);
      if (!receipt || receipt.status === 'saved') continue;
      const invalid = operationInvalid({ ...draft, limited: fetched.limited }, receipt, useData.getState().tasks);
      if (invalid) { receiptUpdate(plan, receipt.id, { status: 'invalid', reason: invalid }); continue; }
      const due = draft.operations.find((operation) => operation.kind === 'due' && operation.taskId === receipt.taskId && operation.after === receipt.after);
      if (receipt.kind === 'reminder' && due && due.status !== 'saved') {
        receiptUpdate(plan, receipt.id, { status: 'error', reason: due?.reason, error: 'The task due time has not been saved' });
        continue;
      }
      receiptUpdate(plan, receipt.id, { status: 'saving', error: undefined, reason: undefined });
      try {
        if (receipt.kind === 'due') {
          const existing = useData.getState().tasks[receipt.taskId]!;
          if (receipt.uncertain && existing.dueAt !== receipt.after) {
            receiptUpdate(plan, receipt.id, { status: 'error', reason: 'session', error: 'The previous task update is unresolved. Check the saved task before trying again.' });
            continue;
          }
          const updated = existing.dueAt === receipt.after ? existing : await client.tasks.update(receipt.taskId, { dueAt: receipt.after });
          if (!current(plan, client, true)) return;
          upsertTask(updated);
          updatePlanTomorrow(plan.key, plan.token, (value) => ({ ...value, acceptedTasks: { ...value.acceptedTasks, [updated.id]: updated } }));
          receiptUpdate(plan, receipt.id, { status: 'saved', uncertain: false });
        } else {
          if (!receipt.creationKey) {
            receiptUpdate(plan, receipt.id, { status: 'error', uncertain: true, reason: 'reminder-unknown', error: 'Review this reminder again before creating it' });
            continue;
          }
          const existing = await reconcileReminder(client, plan, receipt);
          if (!current(plan, client, true)) return;
          if (existing) { receiptUpdate(plan, receipt.id, { status: 'saved', reminderId: existing.id, uncertain: false }); continue; }
          if (receipt.uncertain) {
            receiptUpdate(plan, receipt.id, { status: 'error', reason: 'reminder-unknown', error: 'The previous reminder request may still have succeeded. Check reminders before changing this plan.' });
            continue;
          }
          // Mark before the request: any interruption leaves the create outcome uncertain.
          receiptUpdate(plan, receipt.id, { uncertain: true });
          const created = await client.reminders.create({ title: receipt.title, dueAt: receipt.after, timezone: plan.timezone, notes: null, creationKey: receipt.creationKey, recurrence: null });
          if (!current(plan, client, true)) return;
          upsertReminder(created);
          receiptUpdate(plan, receipt.id, { status: 'saved', reminderId: created.id, uncertain: false });
        }
      } catch (error) {
        if (!current(plan, client, true)) return;
        if (receipt.kind === 'reminder') {
          try {
            const recovered = await reconcileReminder(client, plan, receipt);
            if (!current(plan, client, true)) return;
            if (recovered) { receiptUpdate(plan, receipt.id, { status: 'saved', reminderId: recovered.id, uncertain: false }); continue; }
          } catch { /* Retain the uncertain receipt; a later retry may only reconcile it. */ }
        }
        if (current(plan, client, true)) {
          const latest = usePlanTomorrowState.getState().drafts[plan.key]!.operations.find((operation) => operation.id === receipt.id);
          const status = httpStatus(error);
          const rejected = status !== null && status >= 400 && status < 500 && status !== 408;
          const uncertain = receipt.kind === 'reminder' && Boolean(latest?.uncertain) && !rejected;
          receiptUpdate(plan, receipt.id, { status: 'error', error: errorText(error), uncertain, reason: uncertain ? 'reminder-unknown' : undefined });
        }
      }
    }
  } catch (error) {
    if (current(plan, client, true)) updatePlanTomorrow(plan.key, plan.token, (draft) => ({ ...draft, loadError: errorText(error), operations: draft.operations.map((receipt) => receipt.status === 'saved' ? receipt : { ...receipt, status: 'error', error: 'Could not verify the saved tasks and reminders' }) }));
  } finally {
    if (current(plan, client, true)) updatePlanTomorrow(plan.key, plan.token, (draft) => ({ ...draft, stage: draft.operations.every((receipt) => receipt.status === 'saved') ? 'saved' : draft.operations.some((receipt) => receipt.status === 'saved') ? 'partial' : 'error' }));
  }
}

/** Called only by the explicit Apply / Retry controls after review. */
export function applyPlanTomorrow(key: string, retry = false): Promise<void> {
  const plan = usePlanTomorrowState.getState().drafts[key];
  if (!plan) return Promise.resolve();
  const pending = applications.get(plan.token);
  if (pending) return pending;
  if ((!retry && plan.stage !== 'review') || (retry && plan.stage !== 'partial' && plan.stage !== 'error') || plan.operations.length === 0) return Promise.resolve();
  const client = requireClient();
  const applying = runApply(plan, client).finally(() => { if (applications.get(plan.token) === applying) applications.delete(plan.token); });
  applications.set(plan.token, applying);
  return applying;
}

export function usePlanTomorrow(date?: string) {
  const timezone = useSession((state) => state.settings?.timezone) ?? deviceTimeZone();
  const client = useSession((state) => state.client);
  const epoch = useSession((state) => state.sessionEpoch);
  const privateMode = useTimeline((state) => state.offRecord);
  const privacyLoaded = useTimeline((state) => state.offRecordLoaded);
  const drafts = usePlanTomorrowState((state) => state.drafts);
  const sourceTasks = useData((state) => state.tasks);
  const sourceReminders = useData((state) => state.reminders);
  const plan = planForSession(date, timezone);
  const key = plan?.key;
  const [initializationError, setInitializationError] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let disposed = false;
    setInitializationError(null);
    void (async () => {
      try {
        // Direct scene URLs must establish privacy without relying on a WebSocket opening.
        if (!privacyLoaded) await loadOffRecord(client);
        if (disposed || !isCurrentSession(epoch, client)) return;
        const selected = ensurePlanTomorrow({ date: date ?? planForSession(undefined, timezone)?.date, timezone });
        if (selected.status === 'idle') await loadPlanTomorrow(selected.key);
      } catch (error) {
        if (!disposed && isCurrentSession(epoch, client)) setInitializationError(errorText(error));
      }
    })();
    return () => { disposed = true; };
  }, [date, timezone, client, epoch, privateMode, privacyLoaded, key]);
  const invalid = useMemo(() => plan ? invalidPlanChoices(plan, sourceTasks) : {}, [drafts, plan, sourceTasks]);
  return {
    plan, loading: !initializationError && (!privacyLoaded || !plan || plan.status === 'idle' || plan.status === 'loading'), loadError: initializationError ?? plan?.loadError ?? null,
    tasks: plan ? Object.keys(plan.choices).flatMap((id) => { const task = plan.acceptedTasks[id] ?? plan.baselines[id]; return task ? [task] : []; }) : [],
    reminders: Object.values(sourceReminders).filter((reminder) => reminder.status === 'scheduled'),
    suggestedIds: plan?.suggestedIds ?? [], invalid,
    setChoice: (id: string, patch: Partial<PlanChoice>) => { if (key) setPlanChoice(key, id, patch); },
    setDisclosure: (name: 'alternatives' | 'reminders', open: boolean) => { if (key) setPlanDisclosure(key, name, open); },
    review: () => { if (key) reviewPlanTomorrow(key); }, edit: () => { if (key) editPlanTomorrow(key); },
    apply: () => key ? applyPlanTomorrow(key) : Promise.resolve(), retry: () => key ? applyPlanTomorrow(key, true) : Promise.resolve(),
    reload: async () => {
      if (!client) return;
      setInitializationError(null);
      try {
        if (!useTimeline.getState().offRecordLoaded) await loadOffRecord(client);
        if (!isCurrentSession(epoch, client)) return;
        const selected = ensurePlanTomorrow({ date: date ?? planForSession(undefined, timezone)?.date, timezone });
        await loadPlanTomorrow(selected.key, true);
      } catch (error) { if (isCurrentSession(epoch, client)) setInitializationError(errorText(error)); }
    },
  };
}
