import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RecurrenceInput, Reminder } from '@neo/protocol';
import { I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { upsertReminder, type DataState } from '../state/data.js';
import { ReminderEditor } from './RemindersScreen.js';

const mockUpdate = vi.fn();
let reminder: Reminder;
vi.mock('../state/session.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../state/session.js')>(),
  requireClient: () => ({ reminders: { update: mockUpdate, list: vi.fn().mockResolvedValue({ items: [] }) } }),
}));
vi.mock('../state/data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/data.js')>();
  return {
    ...actual,
    loadReminders: vi.fn().mockResolvedValue(undefined),
    upsertReminder: vi.fn(),
    useData: (selector: (state: DataState) => unknown) => selector({ ...actual.useData.getState(), reminders: { [reminder.id]: reminder }, remindersLoaded: true }),
  };
});
vi.mock('../platform/index.js', () => ({
  getPlatform: () => ({ syncReminders: vi.fn().mockResolvedValue(undefined) }),
}));

const NOW = Date.UTC(2026, 9, 21, 9);
const UNTIL = 9999999999999;

function renderEditor(recurrence: Reminder['recurrence']) {
  reminder = { id: 'rem_recurrence', title: 'Call home', notes: null, dueAt: NOW + 86_400_000, timezone: 'UTC', recurrence, status: 'scheduled', firedCount: 0, lastFiredAt: null, messageId: null, createdAt: NOW, updatedAt: NOW };
  mockUpdate.mockResolvedValue(reminder);
  const onClose = vi.fn();
  const editor = (open: boolean) => <I18nProvider locale="en" messages={appDictionaries}><ReminderEditor reminder={reminder} open={open} onClose={onClose} /></I18nProvider>;
  const view = render(editor(false));
  view.rerender(editor(true));
  expect(screen.getByRole('dialog', { name: 'Edit reminder' })).toBeTruthy();
  return onClose;
}

async function saveAndExpect(recurrence: RecurrenceInput | null, title = reminder.title) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockUpdate).toHaveBeenCalledWith(reminder.id, expect.objectContaining({ title, recurrence }));
  expect(upsertReminder).toHaveBeenCalledWith(reminder);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ReminderEditor recurrence preservation', () => {
  it.each<{ name: string; recurrence: Reminder['recurrence'] }>([
    { name: 'hourly frequency and count', recurrence: { freq: 'hourly', interval: 2, count: 5 } },
    { name: 'monthly days', recurrence: { freq: 'monthly', interval: 1, byMonthDay: [1, 15] } },
    { name: 'daily end date', recurrence: { freq: 'daily', interval: 1, until: UNTIL } },
    { name: 'monthly last day and both end conditions', recurrence: { freq: 'monthly', interval: 1, byMonthDay: [-1], count: 5, until: UNTIL } },
    { name: 'daily weekday filter', recurrence: { freq: 'daily', interval: 1, byWeekday: [1, 3, 5] } },
    { name: 'every other week on weekdays', recurrence: { freq: 'weekly', interval: 2, byWeekday: [1, 2, 3, 4, 5] } },
    { name: 'yearly count', recurrence: { freq: 'yearly', interval: 2, count: 5 } },
    { name: 'one-off reminder', recurrence: null },
  ])('preserves $name when only the title changes', async ({ recurrence }) => {
    const onClose = renderEditor(recurrence);
    fireEvent.change(screen.getByRole('textbox', { name: /Remind me to/ }), { target: { value: 'Call home tonight' } });
    await saveAndExpect(recurrence, 'Call home tonight');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('preserves the end date when saving without edits', async () => {
    renderEditor({ freq: 'daily', interval: 1, until: UNTIL });
    await saveAndExpect({ freq: 'daily', interval: 1, until: UNTIL });
  });

  it('preserves byMonthDay when monthly preset is changed to daily and back', async () => {
    renderEditor({ freq: 'monthly', interval: 1, byMonthDay: [1, 15] });
    const repeatSelect = screen.getByRole('combobox', { name: 'Repeat' });
    fireEvent.change(repeatSelect, { target: { value: 'daily' } });
    fireEvent.change(repeatSelect, { target: { value: 'monthly' } });
    await saveAndExpect({ freq: 'monthly', interval: 1, byMonthDay: [1, 15] });
  });

  it('preserves count when monthly preset is changed to daily and back', async () => {
    renderEditor({ freq: 'monthly', interval: 1, count: 5 });
    const repeatSelect = screen.getByRole('combobox', { name: 'Repeat' });
    fireEvent.change(repeatSelect, { target: { value: 'daily' } });
    fireEvent.change(repeatSelect, { target: { value: 'monthly' } });
    await saveAndExpect({ freq: 'monthly', interval: 1, count: 5 });
  });

  it('preserves until when daily preset is changed to weekly and back', async () => {
    renderEditor({ freq: 'daily', interval: 1, until: UNTIL });
    const repeatSelect = screen.getByRole('combobox', { name: 'Repeat' });
    fireEvent.change(repeatSelect, { target: { value: 'weekly' } });
    fireEvent.change(repeatSelect, { target: { value: 'daily' } });
    await saveAndExpect({ freq: 'daily', interval: 1, until: UNTIL });
  });

  it.each<{ recurrence: Reminder['recurrence']; expected: RecurrenceInput }>([
    { recurrence: { freq: 'hourly', interval: 2, count: 5 }, expected: { freq: 'hourly', interval: 3, count: 5 } },
    { recurrence: { freq: 'monthly', interval: 1, byMonthDay: [1, 15], until: UNTIL }, expected: { freq: 'monthly', interval: 3, byMonthDay: [1, 15], until: UNTIL } },
  ])('applies an interval edit while preserving hidden fields in $recurrence.freq', async ({ recurrence, expected }) => {
    renderEditor(recurrence);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Every (interval)' }), { target: { value: '3' } });
    await saveAndExpect(expected);
  });

  it('applies weekly day edits while preserving end conditions', async () => {
    renderEditor({ freq: 'weekly', interval: 2, byWeekday: [1], count: 5, until: UNTIL });
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }));
    await saveAndExpect({ freq: 'weekly', interval: 2, byWeekday: [1, 3], count: 5, until: UNTIL });
  });

  it.each<{ name: string; original: Reminder['recurrence']; preset: string; expected: RecurrenceInput | null }>([
    { name: 'changes hourly to monthly', original: { freq: 'hourly', interval: 2, count: 5 }, preset: 'monthly', expected: { freq: 'monthly', interval: 2 } },
    { name: 'changes monthly to daily', original: { freq: 'monthly', interval: 1, byMonthDay: [1, 15], count: 5, until: UNTIL }, preset: 'daily', expected: { freq: 'daily', interval: 1 } },
    { name: 'removes recurrence', original: { freq: 'hourly', interval: 2, count: 5 }, preset: 'none', expected: null },
    { name: 'adds recurrence', original: null, preset: 'daily', expected: { freq: 'daily', interval: 1 } },
  ])('$name when the preset changes explicitly', async ({ original, preset, expected }) => {
    renderEditor(original);
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: preset } });
    await saveAndExpect(expected);
  });
});
