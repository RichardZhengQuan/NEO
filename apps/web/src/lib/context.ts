/**
 * Recover "recalled memories" for messages loaded from history.
 *
 * Live turns get them from `memory.recalled` events. For stored messages the
 * only trace is the hidden context part core injected into the user message:
 *
 *   <neo_context>
 *   now: 2026-10-10 20:15 Saturday (Asia/Shanghai)
 *   memories:
 *   - [fact] The user is vegetarian (id mem_…)
 *   </neo_context>
 *
 * Parsing is best-effort: an unexpected format simply yields no chip.
 */
import { MEMORY_KINDS, type MemoryKind, type Message, type RecalledMemorySummary } from '@neo/protocol';

const LINE = /^\s*-\s*\[([a-z]+)\]\s+(.+?)\s+\(id\s+(mem_[A-Za-z0-9]+)\)\s*$/;

export function recalledFromContext(text: string): RecalledMemorySummary[] {
  const out: RecalledMemorySummary[] = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const kind = m[1] as MemoryKind;
    if (!MEMORY_KINDS.includes(kind)) continue;
    const label = m[2]!.length > 140 ? `${m[2]!.slice(0, 139)}…` : m[2]!;
    out.push({ id: m[3]!, kind, label, score: 0, reason: '' });
  }
  return out;
}

/** Recalled memories of the user message that started `assistant`'s turn. */
export function recalledForMessage(messages: readonly Message[], assistant: Message): RecalledMemorySummary[] {
  const idx = messages.indexOf(assistant);
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant') break;
    if (m.role !== 'user') continue;
    if (assistant.turnId && m.turnId && m.turnId !== assistant.turnId) break;
    const ctx = m.parts.find((p) => p.type === 'context');
    return ctx && ctx.type === 'context' ? recalledFromContext(ctx.text) : [];
  }
  return [];
}
