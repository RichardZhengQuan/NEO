import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, type ConsolidationReport } from '@neo/protocol';
import { I18nProvider } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { useSession } from '../../state/session.js';
import { JournalEntry } from './JournalTab.js';

beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  // As in TasksScreen tests, force the native Intl default as well as TZ.
  const DateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new DateTimeFormat(locales, { ...options, timeZone: options?.timeZone ?? 'Asia/Singapore' });
  });
  useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'America/New_York' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('JournalEntry date', () => {
  it.each([
    [Date.UTC(2026, 9, 28, 2, 25), 'Oct 27, 2026, 10:25 PM', 'Oct 28, 2026, 10:25 AM'],
    [0, 'Dec 31, 1969, 7:00 PM', 'Jan 1, 1970, 7:30 AM'],
  ])('shows finish time %i in the session timezone', (finishedAt, expected, deviceDate) => {
    expect(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(finishedAt)).toBe(deviceDate);
    const report: ConsolidationReport = { id: 'report_1', startedAt: finishedAt - 1000, finishedAt, archived: 0, edgesDecayed: 0, edgesPruned: 0, episodesConsolidated: 0, factsCreated: 0, linksCreated: 0, entitiesMerged: 0, notes: ['Checked memories'] };

    render(<I18nProvider locale="en" messages={appDictionaries}><JournalEntry report={report} /></I18nProvider>);

    expect(screen.getByRole('heading', { name: expected })).toBeTruthy();
    expect(screen.getByText('Checked memories')).toBeTruthy();
  });
});
