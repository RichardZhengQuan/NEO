/**
 * ConfirmationManager — tool calls waiting for the user's decision.
 *
 * Entries are keyed by the server-generated `ToolConfirmation.id` nonce, never by the
 * provider's tool-call id: those can repeat across turns and conversations, and a late
 * answer to an old call must not approve a new one.
 *
 * waitForDecision() registers a ToolConfirmation and resolves exactly once:
 *   - the user calls resolve()        → { approve, always?, reason: 'user' }
 *   - the timeout fires               → { approve: false, reason: 'timeout' }
 *   - the turn's signal aborts, or cancelTurn()/cancelTool()/cancelAll() is called
 *                                     → { approve: false, reason: 'cancelled' }
 * Settled entries are removed immediately, so nothing leaks.
 */
import { NeoError, type ConfirmationDecision, type ToolConfirmation } from '@neo/protocol';

export type ConfirmationOutcome = ConfirmationDecision & { reason: 'user' | 'timeout' | 'cancelled' };

interface PendingEntry {
  confirmation: ToolConfirmation;
  finish(outcome: ConfirmationOutcome): void;
}

const CANCELLED: ConfirmationOutcome = { approve: false, reason: 'cancelled' };

export class ConfirmationManager {
  private readonly pending = new Map<string, PendingEntry>();

  /**
   * Register a confirmation and wait for its outcome. Never rejects (except for
   * a duplicate pending confirmation id, which is a caller bug).
   */
  waitForDecision(confirmation: ToolConfirmation, timeoutMs: number, signal: AbortSignal): Promise<ConfirmationOutcome> {
    const id = confirmation.id;
    if (this.pending.has(id)) {
      return Promise.reject(new NeoError('conflict', `Confirmation ${id} is already pending.`));
    }
    return new Promise<ConfirmationOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => entry.finish(CANCELLED);
      const entry: PendingEntry = {
        confirmation,
        finish: (outcome) => {
          if (this.pending.get(id) !== entry) return;
          this.pending.delete(id);
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
      };
      this.pending.set(id, entry);
      if (signal.aborted) {
        entry.finish(CANCELLED);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => entry.finish({ approve: false, reason: 'timeout' }), Math.max(0, timeoutMs));
    });
  }

  /** Deliver the user's decision for confirmation `id`. Returns false when nothing is pending under it. */
  resolve(id: string, decision: ConfirmationDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const approve = decision.approve === true;
    entry.finish(approve && decision.always ? { approve, always: true, reason: 'user' } : { approve, reason: 'user' });
    return true;
  }

  /** Resolve the pending confirmations of one turn as cancelled. Returns how many were pending. */
  cancelTurn(turnId: string): number {
    const entries = [...this.pending.values()].filter((e) => e.confirmation.turnId === turnId);
    for (const entry of entries) entry.finish(CANCELLED);
    return entries.length;
  }

  /** Resolve pending confirmations for a revoked tool as cancelled, across all turns. */
  cancelTool(name: string): number {
    const entries = [...this.pending.values()].filter((entry) => entry.confirmation.name === name);
    for (const entry of entries) entry.finish(CANCELLED);
    return entries.length;
  }

  /** Resolve every pending confirmation as cancelled (shutdown). */
  cancelAll(): void {
    for (const entry of [...this.pending.values()]) entry.finish(CANCELLED);
  }

  /** Whether a confirmation for this tool call is pending (used to keep tool-call ids unique). */
  hasToolCall(toolCallId: string): boolean {
    for (const entry of this.pending.values()) if (entry.confirmation.toolCallId === toolCallId) return true;
    return false;
  }

  /** Pending confirmations, oldest first. */
  list(): ToolConfirmation[] {
    return [...this.pending.values()].map((e) => e.confirmation);
  }
}
