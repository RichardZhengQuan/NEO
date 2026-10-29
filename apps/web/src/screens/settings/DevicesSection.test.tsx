import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import type { Device } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { useSession } from '../../state/session.js';
import { DevicesSection } from './DevicesSection.js';

// No pairing UI or phone-access request is needed to render the device rows.
vi.mock('../../platform/index.js', () => ({ getPlatform: () => ({ kind: 'capacitor' }) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(120_000);
});
afterEach(() => { cleanup(); vi.useRealTimers(); useSession.setState({ client: null }); });

describe('device activity timestamps', () => {
  it('renders epoch activity as a date and reserves Never connected for null', async () => {
    const devices: Device[] = [
      { id: 'epoch', name: 'Epoch device', platform: 'web', owner: false, createdAt: 0, lastSeenAt: 0 },
      { id: 'never', name: 'Unseen device', platform: 'web', owner: false, createdAt: 0, lastSeenAt: null },
      { id: 'recent', name: 'Recent device', platform: 'desktop', owner: true, createdAt: 0, lastSeenAt: 60_000 },
    ];
    const client = { devices: { list: vi.fn().mockResolvedValue({ items: devices }) } } as unknown as NeoClient;
    useSession.setState({ client });
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><DevicesSection /></ConfirmProvider></I18nProvider>);

    const rows = await screen.findAllByRole('listitem');
    const epochRow = rows.find((row) => within(row).queryByText('Epoch device'))!;
    expect(within(epochRow).getByText('Active 2 minutes ago')).toBeDefined();
    expect(within(epochRow).queryByText('Never connected')).toBeNull();
    const unseenRow = rows.find((row) => within(row).queryByText('Unseen device'))!;
    expect(within(unseenRow).getByText('Never connected')).toBeDefined();
    const recentRow = rows.find((row) => within(row).queryByText('Recent device'))!;
    expect(within(recentRow).getByText('Active 1 minute ago')).toBeDefined();
    expect(rows[0]).toBe(recentRow);
  });
});
