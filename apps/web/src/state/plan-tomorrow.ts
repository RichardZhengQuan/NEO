import { create } from 'zustand';
import { assertPlanTimeZone, tomorrowDate, validPlanDate, type PlanChoice, type PlanTomorrow } from '../lib/plan-tomorrow.js';
import { currentSessionEpoch } from './session.js';
import { useTimeline } from './timeline.js';

export type { PlanChoice, PlanInvalidReason, PlanReceipt, PlanTomorrow } from '../lib/plan-tomorrow.js';
export interface PlanTomorrowState { drafts: Record<string, PlanTomorrow>; latestKey: string | null }
export const usePlanTomorrowState = create<PlanTomorrowState>(() => ({ drafts: {}, latestKey: null }));

export function resetPlanTomorrow(): void {
  usePlanTomorrowState.setState({ drafts: {}, latestKey: null }, true);
}

export function planForSession(date?: string, timezone?: string): PlanTomorrow | null {
  const { drafts, latestKey } = usePlanTomorrowState.getState();
  const candidates = Object.values(drafts).filter((plan) => plan.epoch === currentSessionEpoch() && plan.private === useTimeline.getState().offRecord && (!date || plan.date === date) && (!timezone || plan.timezone === timezone));
  return candidates.find((plan) => plan.key === latestKey) ?? candidates.at(-1) ?? null;
}

export function ensurePlanTomorrow(input: { date?: string; timezone: string; intent?: string; now?: number }): PlanTomorrow {
  const timezone = assertPlanTimeZone(input.timezone);
  const date = input.date ?? tomorrowDate(input.now ?? Date.now(), timezone);
  if (!validPlanDate(date)) throw new Error('Invalid plan date');
  const epoch = currentSessionEpoch();
  const privateMode = useTimeline.getState().offRecord;
  const key = JSON.stringify([epoch, privateMode ? 'private' : 'recorded', date, timezone]);
  const existing = usePlanTomorrowState.getState().drafts[key];
  if (existing) {
    usePlanTomorrowState.setState({ latestKey: key });
    return existing;
  }
  const plan: PlanTomorrow = {
    key, date, timezone, private: privateMode, intent: input.intent, epoch, token: {}, stage: 'edit', status: 'idle', loadError: null, limited: false,
    baselines: {}, acceptedTasks: {}, reminderIds: [], suggestedIds: [], choices: {}, operations: [], disclosures: { alternatives: false, reminders: false },
  };
  usePlanTomorrowState.setState((state) => ({ drafts: { ...state.drafts, [key]: plan }, latestKey: key }));
  return plan;
}

/** The token binds every pending operation to this draft's current lifetime. */
export function updatePlanTomorrow(key: string, token: object, update: (plan: PlanTomorrow) => PlanTomorrow): void {
  usePlanTomorrowState.setState((state) => {
    const current = state.drafts[key];
    if (!current || current.token !== token) return state;
    return { drafts: { ...state.drafts, [key]: update(current) } };
  });
}

export function setPlanChoice(key: string, id: string, patch: Partial<PlanChoice>): void {
  const plan = usePlanTomorrowState.getState().drafts[key];
  if (!plan || plan.stage === 'saving' || !plan.choices[id] || plan.operations.some((receipt) => receipt.taskId === id && receipt.uncertain)) return;
  updatePlanTomorrow(key, plan.token, (current) => ({ ...current, stage: 'edit', choices: { ...current.choices, [id]: { ...current.choices[id]!, ...patch } } }));
}

export function setPlanDisclosure(key: string, name: 'alternatives' | 'reminders', open: boolean): void {
  const plan = usePlanTomorrowState.getState().drafts[key];
  if (plan) updatePlanTomorrow(key, plan.token, (current) => ({ ...current, disclosures: { ...current.disclosures, [name]: open } }));
}

useTimeline.subscribe((entry, previous) => {
  const ended = entry.offRecordLoaded && !entry.offRecord && (previous.offRecord || previous.startingOffRecord || previous.endingOffRecord);
  if (ended || entry.offRecord !== previous.offRecord || entry.startingOffRecord || entry.endingOffRecord) {
    usePlanTomorrowState.setState((state) => ({
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([, plan]) => !(ended && plan.private)).map(([key, plan]) => [key,
        plan.stage === 'saving' ? { ...plan, token: {}, stage: 'partial', operations: plan.operations.map((receipt) => receipt.status === 'saving' ? { ...receipt, status: 'error', reason: 'session', uncertain: true } : receipt) } : plan,
      ])),
      latestKey: ended && state.latestKey && state.drafts[state.latestKey]?.private ? null : state.latestKey,
    }));
  }
});
