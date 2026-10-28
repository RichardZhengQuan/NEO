import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_SETTINGS, type Reminder } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import * as platform from '../platform/index.js';
import { useData } from '../state/data.js';
import { requireClient, startSession, useSession } from '../state/session.js';
import { ReminderEditor, RemindersScreen } from './RemindersScreen.js';

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

describe('ReminderEditor epoch due time', () => {
  beforeEach(() => {
    // Keep native Intl: this fake-timers version substitutes its clock for numeric 0.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(60_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('shows past-time help when the edited time parses to the Unix epoch', () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ReminderEditor reminder={{ ...reminder, dueAt: 60_000 }} open onClose={vi.fn()} /></I18nProvider>);
    const input = screen.getByLabelText(/^When/) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '1970-01-01T00:00' } });

    expect(input.value).toBe('1970-01-01T00:00');
    expect(screen.getByText('That time has already passed.').id).toBe(input.getAttribute('aria-describedby'));
  });

  it.each([
    { timezone: 'UTC', due: '1970-01-01T00:00', weekday: 4, day: 'Thu' },
    { timezone: 'America/Los_Angeles', due: '1969-12-31T16:00', weekday: 3, day: 'Wed' },
  ])('uses the epoch weekday in $timezone when defaulting a weekly recurrence', async ({ timezone, due, weekday, day }) => {
    const onClose = vi.fn();
    render(<I18nProvider locale="en" messages={appDictionaries}><ReminderEditor reminder={{ ...reminder, dueAt: 60_000, timezone }} open onClose={onClose} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText(/^When/), { target: { value: due } });

    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: 'weekly' } });

    expect(screen.getByText(`Every ${day}`)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(requireClient().reminders.update).toHaveBeenCalledWith(reminder.id, expect.objectContaining({
      dueAt: 0,
      timezone,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [weekday] },
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows relative-time help when the edited epoch is still in the future', () => {
    vi.setSystemTime(-60_000);
    render(<I18nProvider locale="en" messages={appDictionaries}><ReminderEditor reminder={{ ...reminder, dueAt: 60_000 }} open onClose={vi.fn()} /></I18nProvider>);
    const input = screen.getByLabelText(/^When/) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '1970-01-01T00:00' } });

    expect(input.value).toBe('1970-01-01T00:00');
    expect(screen.getByText('in 1 minute').id).toBe(input.getAttribute('aria-describedby'));
  });
});
