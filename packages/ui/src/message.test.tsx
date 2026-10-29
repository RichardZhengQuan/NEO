import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Message, ToolConfirmation } from '@neo/protocol';
import { I18nProvider } from './i18n.js';
import { ConfirmationCard, MessageView } from './message.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function wrap(ui: ReactElement, locale = 'en') {
  return render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
}

const message: Message = {
  id: 'msg_1',
  episodeId: 'conv_1',
  conversationId: 'conv_1',
  role: 'assistant',
  parts: [{ type: 'tool_call', id: 'tc_1', name: 'delete_note', input: { id: 'note_1' } }],
  createdAt: 1,
  status: 'streaming',
};

const confirmation: ToolConfirmation = {
  id: 'cnf_1',
  episodeId: 'conv_1',
  conversationId: 'conv_1',
  turnId: 'turn_1',
  messageId: message.id,
  toolCallId: 'tc_1',
  name: 'delete_note',
  title: 'Delete note',
  input: { id: 'note_1' },
  description: "Delete note 'Groceries'",
  risk: 'dangerous',
  requestedAt: Date.now(),
  expiresAt: Date.now() + 120_000,
};

async function expectDecisionsToStayDisabled() {
  const approve = screen.getByRole('button', { name: 'Allow' });
  const buttons = [
    approve,
    screen.getByRole('button', { name: 'Always allow' }),
    screen.getByRole('button', { name: 'Deny' }),
  ];
  for (const button of buttons) {
    expect(button.hasAttribute('disabled')).toBe(true);
  }

  await act(async () => { fireEvent.click(approve); });

  for (const button of buttons) {
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).not.toBe('true');
  }
}

describe('MessageView confirmations without onConfirm', () => {
  it('keeps matched confirmation decisions disabled after clicking Allow', async () => {
    wrap(<MessageView message={message} confirmations={[confirmation]} />);

    await expectDecisionsToStayDisabled();
  });

  it('keeps orphan confirmation decisions disabled after clicking Allow', async () => {
    const orphan: ToolConfirmation = { ...confirmation, id: 'cnf_orphan', toolCallId: 'tc_missing' };
    wrap(<MessageView message={message} confirmations={[orphan]} />);

    await expectDecisionsToStayDisabled();
  });
});

describe('confirmation expiry timestamps', () => {
  it.each([0, 10_000])('counts down to expiry %s, including epoch zero', (expiresAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(expiresAt - 2000);
    wrap(<ConfirmationCard confirmation={{ ...confirmation, requestedAt: expiresAt - 3000, expiresAt }} />);

    expect(screen.getByText('Expires in 0:02')).toBeDefined();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Expires in 0:01')).toBeDefined();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText(/Expires in/)).toBeNull();
  });

  it('keeps an already-expired epoch confirmation countdown hidden', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    wrap(<ConfirmationCard confirmation={{ ...confirmation, requestedAt: -1000, expiresAt: 0 }} />);

    expect(screen.queryByText(/Expires in/)).toBeNull();
  });
});


it('passes viewer timezone from MessageView through nested timeline UI parts', () => {
  const stored: Message = { ...message, status: 'complete', parts: [{ type: 'ui', id: 'ui_times', block: { type: 'card', children: [{ type: 'timeline', items: [{ time: 0, title: 'Epoch' }] }] } }] };
  const view = wrap(<MessageView message={stored} timezone="America/New_York" />);
  expect(view.container.querySelector('.neo-timeline__time')?.textContent).toBe('Dec 31, 1969, 7:00 PM');
  view.rerender(<I18nProvider locale="en"><MessageView message={stored} timezone="UTC" /></I18nProvider>);
  expect(view.container.querySelector('.neo-timeline__time')?.textContent).toBe('Jan 1, 1970, 12:00 AM');
  expect(stored.parts[0]).toEqual({ type: 'ui', id: 'ui_times', block: { type: 'card', children: [{ type: 'timeline', items: [{ time: 0, title: 'Epoch' }] }] } });
});
