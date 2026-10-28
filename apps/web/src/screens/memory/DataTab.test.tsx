import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, type MemoryExport } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { readFileText } from '../../lib/download.js';
import { useSession } from '../../state/session.js';
import { DataTab } from './DataTab.js';

vi.mock('../../lib/download.js', () => ({ downloadJson: vi.fn(), readFileText: vi.fn() }));

beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  // Match TasksScreen's device-timezone setup: changing TZ in a test worker
  // alone does not change native Intl formatting on every runtime.
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

describe('DataTab import date', () => {
  it.each([
    [Date.UTC(2026, 9, 28, 2, 25), 'Oct 27, 2026, 10:25 PM', 'Oct 28, 2026, 10:25 AM'],
    [0, 'Dec 31, 1969, 7:00 PM', 'Jan 1, 1970, 7:30 AM'],
  ])('shows export time %i in the session timezone', async (exportedAt, expected, deviceDate) => {
    expect(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(exportedAt)).toBe(deviceDate);
    const data: MemoryExport = { format: 'neo-memory', version: 1, exportedAt, nodes: [], edges: [] };
    const read = Promise.resolve(JSON.stringify(data));
    vi.mocked(readFileText).mockReturnValue(read);
    const file = new File(['memory'], 'memory.json', { type: 'application/json' });
    const { container } = render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><DataTab /></ConfirmProvider></I18nProvider>);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await read;
    });

    expect(readFileText).toHaveBeenCalledWith(file);
    expect(screen.getByText('memory.json')).toBeTruthy();
    expect(screen.getByText(`0 memories · 0 links · exported ${expected}`)).toBeTruthy();
  });
});
