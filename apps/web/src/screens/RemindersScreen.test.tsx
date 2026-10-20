import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, type Reminder } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { useData } from '../state/data.js';
import { requireClient, startSession, useSession } from '../state/session.js';
import { RemindersScreen } from './RemindersScreen.js';

vi.mock('@neo/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@neo/client')>(),
  NeoClient: vi.fn(() => ({ reminders: { update: vi.fn(), list: vi.fn() } })),
}));
vi.mock('../state/data.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../state/data.js')>(),
  loadReminders: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../platform/index.js', () => ({
  getPlatform: () => ({ syncReminders: vi.fn(), notificationStatus: vi.fn().mockResolvedValue({ enabled: true }) }),
}));

const now = Date.now();
const reminder: Reminder = {
  id: 'rem_sync',
  title: 'Old title',
  notes: 'Old notes',
  dueAt: now + 60 * 60_000,
  timezone: 'UTC',
  status: 'scheduled',
  recurrence: null,
  firedCount: 0,
  messageId: null,
  createdAt: 0,
  updatedAt: 0,
  lastFiredAt: null,
};

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: `Options for ${reminder.title}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  startSession({ serverUrl: 'https://reminders.example', token: 'test' }, 'manual');
  useSession.setState({ settings: DEFAULT_SETTINGS });
  useData.setState({ reminders: { [reminder.id]: reminder }, remindersLoaded: true });
  vi.mocked(requireClient().reminders.update).mockImplementation(async (_id, patch) => ({ ...reminder, ...patch }) as Reminder);
});
afterEach(cleanup);

describe('ReminderEditor store updates', () => {
  it('resyncs an untouched title when reminder updates remotely', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RemindersScreen /></ConfirmProvider></I18nProvider>);
    openEditor();
    const input = screen.getByRole('textbox', { name: /Remind me to/ }) as HTMLInputElement;
    expect(input.value).toBe('Old title');

    act(() => { useData.setState({ reminders: { [reminder.id]: { ...reminder, title: 'New title', updatedAt: 1 } } }); });

    expect(input.value).toBe('New title');
  });

  it('resyncs untouched notes when reminder updates remotely', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RemindersScreen /></ConfirmProvider></I18nProvider>);
    openEditor();
    const input = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(input.value).toBe('Old notes');

    act(() => { useData.setState({ reminders: { [reminder.id]: { ...reminder, notes: 'New notes', updatedAt: 1 } } }); });

    expect(input.value).toBe('New notes');
  });
});
