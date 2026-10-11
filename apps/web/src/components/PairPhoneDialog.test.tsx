import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider, buildMessages, createTranslator } from '@neo/ui';
import type { Device, PairingSession } from '@neo/protocol';
import type { NeoClient } from '@neo/client';
import { appDictionaries } from '../i18n.js';
import { handleServerEvent, type EventContext } from '../state/events.js';
import { useToasts } from '../state/notifications.js';
import { PairPhoneDialog } from './PairPhoneDialog.js';

const pairing = vi.hoisted(() => ({ create: vi.fn(), cancel: vi.fn() }));
vi.mock('../state/session.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../state/session.js')>(),
  requireClient: () => ({ pairing }),
}));
vi.mock('./QrCode.js', () => ({ QrCode: ({ value, label }: { value: string; label: string }) => <img alt={label} data-value={value} /> }));

const phone: Device = { id: 'dev_phone', name: 'My phone', platform: 'ios', owner: false, createdAt: 0, lastSeenAt: null };
const t = createTranslator('en', buildMessages('en', appDictionaries));
const ctx: EventContext = {
  client: { pairing } as unknown as NeoClient,
  t,
  locale: 'en',
  assistantName: () => 'NEO',
  activeConversationId: () => null,
  openLink: vi.fn(),
  syncReminders: vi.fn(),
  debounce: vi.fn(),
};

function session(id = 'pair_one', ttl = 300_000): PairingSession {
  return { id, code: 'a'.repeat(32), expiresAt: Date.now() + ttl, pairingUrl: `neo://pair?v=2&code=${id}&server=https://neo.example` };
}

async function show(onClose = vi.fn(), onPaired = vi.fn()) {
  const view = render(<I18nProvider locale="en" messages={appDictionaries}><PairPhoneDialog onClose={onClose} onPaired={onPaired} /></I18nProvider>);
  await act(async () => undefined);
  return { ...view, onClose, onPaired };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  pairing.create.mockReset().mockResolvedValue(session());
  pairing.cancel.mockReset().mockResolvedValue(undefined);
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PairPhoneDialog lifecycle', () => {
  it('cancels an unclaimed code when the dialog closes', async () => {
    const { onClose } = await show();
    expect(screen.getByRole('img', { name: 'Pairing QR code' })).toBeTruthy();
    expect(screen.getByText('Expires in 5:00').getAttribute('aria-live')).toBe('off');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(pairing.cancel).toHaveBeenCalledWith('pair_one');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels a code returned after closing while create is pending', async () => {
    let resolve!: (value: PairingSession) => void;
    pairing.create.mockReturnValueOnce(new Promise<PairingSession>((yes) => { resolve = yes; }));
    const { unmount, onClose } = await show();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { resolve(session('pair_late')); });
    expect(pairing.cancel).toHaveBeenCalledWith('pair_late');
  });

  it('expires without automatic refresh and creates a new code only on request', async () => {
    pairing.create.mockResolvedValueOnce(session('pair_one', 1500));
    await show();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('status').textContent).toBe('This code expired');
    expect(screen.queryByRole('img', { name: 'Pairing QR code' })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(pairing.create).toHaveBeenCalledTimes(1);
    pairing.create.mockResolvedValueOnce(session('pair_two'));
    fireEvent.click(screen.getByRole('button', { name: 'Show a new code' }));
    await act(async () => undefined);
    expect(pairing.create).toHaveBeenCalledTimes(2);
    expect(pairing.cancel).toHaveBeenCalledWith('pair_one');
    expect(screen.getByRole('img', { name: 'Pairing QR code' }).getAttribute('data-value')).toContain('pair_two');
  });

  it('only accepts its matching event, then reports the device and closes after two seconds', async () => {
    const { onClose, onPaired } = await show();
    act(() => handleServerEvent({ type: 'device.paired', device: phone, pairingId: 'pair_other' }, ctx));
    expect(screen.getByRole('status').textContent).toBe('Your pairing code is ready.');
    act(() => handleServerEvent({ type: 'device.paired', device: phone, pairingId: 'pair_one' }, ctx));
    expect(screen.getByRole('status').textContent).toBe('My phone is connected');
    expect(useToasts.getState().toasts).toEqual([]);
    expect(onPaired).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(onClose).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(onPaired).toHaveBeenCalledExactlyOnceWith(phone);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pairing.cancel).not.toHaveBeenCalled();
  });

  it('shows the owner-only error and retries a failed create', async () => {
    pairing.create.mockRejectedValueOnce({ httpStatus: 403 });
    await show();
    expect(screen.getByRole('alert').textContent).toBe('Only the owner device can pair new devices.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => undefined);
    expect(screen.getByRole('img', { name: 'Pairing QR code' })).toBeTruthy();
  });
});
