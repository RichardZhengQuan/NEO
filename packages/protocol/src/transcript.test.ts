import { describe, expect, it } from 'vitest';
import type { Message, UIEventPart } from './content.js';
import { describeUiEvent } from './content.js';
import { estimateMessageTokens, estimateTokens } from './transcript.js';

const event: UIEventPart = {
  type: 'ui_event',
  messageId: 'msg_form',
  uiId: 'feedback_form',
  actionId: 'submit',
};

const message = (parts: Message['parts']): Message => ({
  id: 'msg_submission',
  conversationId: 'conv_1',
  role: 'user',
  parts,
  createdAt: 0,
  status: 'complete',
});

const estimateEventTokens = (part: UIEventPart): number =>
  estimateMessageTokens(message([part])) - estimateMessageTokens(message([]));

describe('estimateMessageTokens ui_event', () => {
  it('estimates the full provider text for large form values and payloads', () => {
    const parts: UIEventPart[] = [
      { ...event, values: { feedback: 'a'.repeat(20_000) } },
      { ...event, payload: { feedback: 'a'.repeat(20_000) } },
    ];

    for (const part of parts) {
      const estimate = estimateEventTokens(part);
      const expected = estimateTokens(describeUiEvent(part));

      expect(estimate).toBeGreaterThan(expected * 0.5);
      expect(estimate).not.toBe(40);
      expect(estimate).toBe(expected);
    }
  });

  it('estimates a minimal event without values or payload', () => {
    const estimate = estimateEventTokens(event);

    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBe(estimateTokens(describeUiEvent(event)));
  });

  it('places moderate form values between minimal and large event estimates', () => {
    const moderate: UIEventPart = { ...event, values: { feedback: 'a'.repeat(1_000) } };
    const large: UIEventPart = { ...event, values: { feedback: 'a'.repeat(20_000) } };
    const estimate = estimateEventTokens(moderate);

    expect(estimate).toBeGreaterThan(estimateEventTokens(event));
    expect(estimate).toBeLessThan(estimateEventTokens(large));
    expect(estimate).toBe(estimateTokens(describeUiEvent(moderate)));
  });
});
