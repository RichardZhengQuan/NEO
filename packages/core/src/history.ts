/**
 * Conversation history trimming (docs/ARCHITECTURE.md, "Context assembly").
 *
 * The transcript is append-only, so trimming may only drop whole turns from the
 * FRONT (oldest first); it never edits the middle. A turn is a user message plus
 * everything up to the next user message. The last user turn (the one being
 * answered) is never dropped, even when it alone exceeds the budget: sending it
 * is better than sending nothing.
 */
import type { Message } from '@neo/protocol';
import { estimateMessageTokens } from '@neo/protocol';

/**
 * Trim `messages` (oldest → newest) to about `budget` estimated tokens.
 * Returns the same array when nothing needs trimming; otherwise a suffix that
 * starts with a user message.
 */
export function trimHistory(messages: readonly Message[], budget: number): readonly Message[] {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  if (total <= budget) return messages;

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return messages;

  // Index of the first user message at or after `from`.
  const nextUser = (from: number): number => {
    let i = from;
    while (i < messages.length && messages[i]!.role !== 'user') i++;
    return i;
  };

  let start = nextUser(0);
  for (let i = 0; i < start; i++) total -= estimateMessageTokens(messages[i]!);
  while (total > budget && start < lastUser) {
    const next = nextUser(start + 1);
    for (let i = start; i < next; i++) total -= estimateMessageTokens(messages[i]!);
    start = next;
  }
  return messages.slice(start);
}
