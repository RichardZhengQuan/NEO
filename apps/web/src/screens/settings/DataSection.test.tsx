import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS } from '@neo/protocol';
import { ConfirmProvider, I18nProvider, buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { useToasts } from '../../state/notifications.js';
import { useSession } from '../../state/session.js';
import { DataSection } from './DataSection.js';

vi.mock('../../platform/index.js', () => ({ getPlatform: () => ({ kind: 'web' }) }));

const t = createTranslator('en', buildMessages('en', appDictionaries));
const now = new Date('2026-10-12T10:30:00Z');
let client: NeoClient;

function renderSection() {
  return render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><DataSection /></ConfirmProvider></I18nProvider>);
}

async function chooseConfirm(label = t('common.delete')) {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: label }));
}

function deleteButton() {
  return screen.getByRole('button', { name: t('dataSettings.delete_range') });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  client = {
    timeline: {
      deleteRange: vi.fn().mockResolvedValue({ deleted: 2, messageIds: ['message_1', 'message_2'], derivedMemories: 0 }),
      list: vi.fn().mockResolvedValue({ items: [], episodes: [], nextCursor: null }),
    },
    memory: { forgetBySource: vi.fn().mockResolvedValue({ deleted: 3 }) },
  } as unknown as NeoClient;
  useSession.setState((s) => ({ client, serverUrl: 'https://a.example', health: null, source: 'manual', settings: { ...DEFAULT_SETTINGS, timezone: 'Asia/Singapore' }, sessionEpoch: s.sessionEpoch + 1 }));
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Settings Data timeline range deletion', () => {
  it('confirms and deletes the last hour', async () => {
    renderSection();
    fireEvent.click(deleteButton());
    expect(client.timeline.deleteRange).not.toHaveBeenCalled();
    await chooseConfirm();
    await waitFor(() => expect(client.timeline.deleteRange).toHaveBeenCalledWith({ from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), to: now.toISOString() }));
    await waitFor(() => expect(deleteButton().hasAttribute('disabled')).toBe(false));
  });

  it('deletes today from midnight in the configured timezone through the current time', async () => {
    renderSection();
    fireEvent.change(screen.getByRole('combobox', { name: t('dataSettings.range') }), { target: { value: 'today' } });
    fireEvent.click(deleteButton());
    await chooseConfirm();
    await waitFor(() => expect(client.timeline.deleteRange).toHaveBeenCalledWith({ from: '2026-10-11T16:00:00.000Z', to: now.toISOString() }));
  });

  it('uses custom date and time inputs in the configured timezone as ISO bounds', async () => {
    renderSection();
    fireEvent.change(screen.getByRole('combobox', { name: t('dataSettings.range') }), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText(t('dataSettings.from')), { target: { value: '2026-10-10T09:00' } });
    fireEvent.change(screen.getByLabelText(t('dataSettings.to')), { target: { value: '2026-10-11T18:30' } });
    fireEvent.click(deleteButton());
    await chooseConfirm();
    await waitFor(() => expect(client.timeline.deleteRange).toHaveBeenCalledWith({ from: '2026-10-10T01:00:00.000Z', to: '2026-10-11T10:30:00.000Z' }));
  });

  it.each(['missing', 'reversed'])('rejects a %s custom range before confirmation', (kind) => {
    renderSection();
    fireEvent.change(screen.getByRole('combobox', { name: t('dataSettings.range') }), { target: { value: 'custom' } });
    if (kind === 'reversed') {
      fireEvent.change(screen.getByLabelText(t('dataSettings.from')), { target: { value: '2026-10-12T10:00' } });
      fireEvent.change(screen.getByLabelText(t('dataSettings.to')), { target: { value: '2026-10-11T10:00' } });
    }
    fireEvent.click(deleteButton());
    expect(screen.getByRole('alert').textContent).toBe(t('dataSettings.invalid_range'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.timeline.deleteRange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: t('dataSettings.range') }), { target: { value: 'last_hour' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancelling leaves the timeline and memories unchanged', async () => {
    renderSection();
    fireEvent.click(deleteButton());
    await chooseConfirm(t('common.cancel'));
    await waitFor(() => expect(deleteButton().hasAttribute('disabled')).toBe(false));
    expect(client.timeline.deleteRange).not.toHaveBeenCalled();
    expect(client.memory.forgetBySource).not.toHaveBeenCalled();
  });

  it('offers the derived memory count and forgets only the deleted source messages', async () => {
    vi.mocked(client.timeline.deleteRange).mockResolvedValueOnce({ deleted: 2, messageIds: ['message_1', 'message_2'], derivedMemories: 3 });
    renderSection();
    fireEvent.click(deleteButton());
    await chooseConfirm();
    await waitFor(() => expect(screen.getByRole('button', { name: t('timeline.forget_memories', { n: 3 }) })).toBeDefined());
    expect(client.memory.forgetBySource).not.toHaveBeenCalled();
    await chooseConfirm(t('timeline.forget_memories', { n: 3 }));
    await waitFor(() => expect(client.memory.forgetBySource).toHaveBeenCalledWith(['message_1', 'message_2']));
  });

  it('keeps memories when the second confirmation is cancelled', async () => {
    vi.mocked(client.timeline.deleteRange).mockResolvedValueOnce({ deleted: 2, messageIds: ['message_1', 'message_2'], derivedMemories: 3 });
    renderSection();
    fireEvent.click(deleteButton());
    await chooseConfirm();
    await screen.findByRole('button', { name: t('timeline.forget_memories', { n: 3 }) });
    await chooseConfirm(t('common.cancel'));
    await waitFor(() => expect(deleteButton().hasAttribute('disabled')).toBe(false));
    expect(client.timeline.deleteRange).toHaveBeenCalledTimes(1);
    expect(client.memory.forgetBySource).not.toHaveBeenCalled();
  });

  it('does not delete after switching servers while the confirmation is open', async () => {
    renderSection();
    fireEvent.click(deleteButton());
    await screen.findByRole('dialog');
    act(() => { useSession.setState((s) => ({ client: {} as NeoClient, sessionEpoch: s.sessionEpoch + 1 })); });
    await chooseConfirm();
    await waitFor(() => expect(deleteButton().hasAttribute('disabled')).toBe(false));
    expect(client.timeline.deleteRange).not.toHaveBeenCalled();
  });

  it('discards a late deletion response after switching servers', async () => {
    let resolve!: (value: { deleted: number; messageIds: string[]; derivedMemories: number }) => void;
    vi.mocked(client.timeline.deleteRange).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    renderSection();
    fireEvent.click(deleteButton());
    await chooseConfirm();
    await waitFor(() => expect(client.timeline.deleteRange).toHaveBeenCalledTimes(1));
    act(() => { useSession.setState((s) => ({ client: {} as NeoClient, sessionEpoch: s.sessionEpoch + 1 })); });
    await act(async () => { resolve({ deleted: 2, messageIds: ['message_1', 'message_2'], derivedMemories: 3 }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.memory.forgetBySource).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
