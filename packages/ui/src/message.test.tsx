import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Message, ToolConfirmation } from '@neo/protocol';
import { I18nProvider } from './i18n.js';
import { MessageView } from './message.js';

afterEach(cleanup);

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
