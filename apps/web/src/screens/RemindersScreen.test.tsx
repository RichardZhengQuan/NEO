import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_SETTINGS, type Reminder } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import * as platform from '../platform/index.js';
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

  it('preserves a title draft when reminder title is updated remotely', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RemindersScreen /></ConfirmProvider></I18nProvider>);
    openEditor();
    const input = screen.getByRole('textbox', { name: /Remind me to/ }) as HTMLInputElement;

    // User types a draft title
    fireEvent.change(input, { target: { value: 'User draft' } });
    expect(input.value).toBe('User draft');

    // Remote update changes the title to something different
    act(() => { useData.setState({ reminders: { [reminder.id]: { ...reminder, title: 'Remote title', updatedAt: 1 } } }); });

    // Local draft must survive — must NOT be overwritten by the remote value
    expect(input.value).toBe('User draft');
  });

  it('preserves a notes draft when reminder notes is updated remotely', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RemindersScreen /></ConfirmProvider></I18nProvider>);
    openEditor();
    const input = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;

    // User types a draft
    fireEvent.change(input, { target: { value: 'User draft notes' } });
    expect(input.value).toBe('User draft notes');

    // Remote update changes notes to something different
    act(() => { useData.setState({ reminders: { [reminder.id]: { ...reminder, notes: 'Remote notes', updatedAt: 1 } } }); });

    // Local draft must survive
    expect(input.value).toBe('User draft notes');
  });
});

describe('reminder recurrence end date timezones', () => {
  let restorePlatform: () => void;
  beforeEach(() => {
    vi.stubEnv('TZ', 'Asia/Singapore');
    const stablePlatform = platform.getPlatform();
    const spy = vi.spyOn(platform, 'getPlatform').mockReturnValue(stablePlatform);
    restorePlatform = () => { spy.mockRestore(); };
  });
  afterEach(() => {
    restorePlatform();
    vi.unstubAllEnvs();
  });

  it.each(['list', 'editor'] as const)('shows the reminder timezone in the %s and follows editor timezone changes', async (surface) => {
    const recurring: Reminder = {
      ...reminder,
      timezone: 'America/Los_Angeles',
      recurrence: { freq: 'daily', interval: 1, until: Date.parse('2026-10-28T06:25:00Z') },
    };
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'America/New_York' } });
    useData.setState({ reminders: { [recurring.id]: recurring } });
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Singapore');
    await act(async () => {
      render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RemindersScreen /></ConfirmProvider></I18nProvider>);
    });
    if (surface === 'editor') openEditor();
    const view = surface === 'editor' ? within(screen.getByRole('dialog')) : screen;
    expect(view.getByText('Every day · until Oct 27, 2026')).toBeTruthy();
    if (surface === 'editor') {
      fireEvent.change(view.getByRole('combobox', { name: 'Timezone' }), { target: { value: 'Asia/Tokyo' } });
      expect(view.getByText('Every day · until Oct 28, 2026')).toBeTruthy();
      expect(screen.getAllByText('Every day · until Oct 27, 2026')).toHaveLength(1);
    }
  });

  it.each(['list', 'editor'] as const)('falls back to the session timezone in the %s when the reminder timezone is empty', async (surface) => {
    const recurring: Reminder = {
      ...reminder,
      timezone: '',
      recurrence: { freq: 'daily', interval: 1, until: Date.parse('2026-10-28T00:25:00Z') },
    };
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'America/New_York' } });
    useData.setState({ reminders: { [recurring.id]: recurring } });
    await act(async () => {
      render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RemindersScreen /></ConfirmProvider></I18nProvider>);
    });
    if (surface === 'editor') openEditor();
    const view = surface === 'editor' ? within(screen.getByRole('dialog')) : screen;
    expect(view.getByText('Every day · until Oct 27, 2026')).toBeTruthy();
  });
});
