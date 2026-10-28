import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, type MemoryStats } from '@neo/protocol';
import { I18nProvider } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { useSession } from '../../state/session.js';
import { StatsTab } from './StatsTab.js';

const loadStats = vi.fn<() => Promise<MemoryStats>>();

beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  // As in TasksScreen tests, force the native Intl default as well as TZ.
  const DateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new DateTimeFormat(locales, { ...options, timeZone: options?.timeZone ?? 'Asia/Singapore' });
  });
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 28, 12));
  loadStats.mockReset();
  useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'America/New_York' }, client: { memory: { stats: loadStats } } as unknown as NeoClient });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function show(lastConsolidationAt: number | null): Promise<HTMLElement> {
  const stats: MemoryStats = { total: 1, byKind: { episode: 0, fact: 1, entity: 0, preference: 0, skill: 0, goal: 0, summary: 0 }, byStatus: { active: 1, archived: 0, superseded: 0 }, edges: 0, lastConsolidationAt, embeddingModel: 'test-embedding' };
  const loaded = Promise.resolve(stats);
  loadStats.mockReturnValue(loaded);
  render(<I18nProvider locale="en" messages={appDictionaries}><StatsTab /></I18nProvider>);
  await act(async () => { await loaded; });
  expect(loadStats).toHaveBeenCalledOnce();
  return screen.getByText('Last consolidated').closest<HTMLElement>('.neo-stat')!;
}

describe('StatsTab consolidation date', () => {
  it('shows the absolute caption in the session timezone', async () => {
    const at = Date.UTC(2026, 9, 28, 2, 25);
    expect(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(at)).toBe('Oct 28, 2026, 10:25 AM');

    const tile = await show(at);

    expect(tile.querySelector('.neo-stat__caption')?.textContent).toBe('Oct 27, 2026, 10:25 PM');
    expect(tile.querySelector('.neo-stat__value')?.textContent).toBe('10 hours ago');
  });

  it('shows both the relative value and absolute caption for the Unix epoch', async () => {
    const tile = await show(0);

    expect(tile.querySelector('.neo-stat__value')?.textContent).toBe('57 years ago');
    expect(tile.querySelector('.neo-stat__caption')?.textContent).toBe('Dec 31, 1969, 7:00 PM');
    expect(tile.textContent).not.toContain('Never');
  });

  it('shows Never without a caption when no consolidation has happened', async () => {
    const tile = await show(null);

    expect(tile.querySelector('.neo-stat__value')?.textContent).toBe('Never');
    expect(tile.querySelector('.neo-stat__caption')).toBeNull();
  });
});
