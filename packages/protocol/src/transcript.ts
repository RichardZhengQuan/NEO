/**
 * Stored messages → provider-neutral transcript.
 *
 * This is the single place that decides what the model sees from history, so
 * that every request for a conversation is a byte-stable prefix of the next
 * one (append-only). Adapters only translate ChatMessage[] to wire format.
 */
import type { ContentPart, Message, ToolCallPart, ToolResultPart } from './content.js';
import { describeUiEvent } from './content.js';
import type { ChatMessage } from './providers.js';

export const SENSITIVE_TOOL_PLACEHOLDER = '<neo_tool_result>(This tool result contained private memories and is withheld from this model.)</neo_tool_result>';
export const SENSITIVE_ASSISTANT_PLACEHOLDER = '<neo_assistant>(This assistant turn referenced private memories and is withheld from this model.)</neo_assistant>';

export interface ToChatOptions {
  /** Drop reasoning parts entirely (e.g. when switching to a model that cannot read them). Default false. */
  dropReasoning?: boolean;
  /**
   * Replace context parts flagged `sensitive` with a placeholder. Use when the conversation is now
   * answered by a model outside the user's infrastructure and sensitive sharing is not allowed.
   */
  omitSensitiveContext?: boolean;
}

export const SENSITIVE_CONTEXT_PLACEHOLDER =
  '<neo_context>(This turn\'s context contained private memories and is withheld from this model.)</neo_context>';

const CANCELLED_RESULT = 'This tool call did not complete (the turn was cancelled or failed).';

/**
 * Rules:
 * - user/system: text, image kept; context → text; ui_event → text via describeUiEvent; others dropped.
 *   system-role messages become user text wrapped in <neo_notice>…</neo_notice>.
 * - assistant: split into steps. Reasoning/text/tool_call accumulate into an assistant entry;
 *   tool_result parts go to the following `tool` entry; ui parts are dropped (the render_ui tool result
 *   already told the model what was shown).
 * - every tool_call gets a tool_result (a synthetic error result is added for unfinished calls).
 * - consecutive user entries are merged; empty entries are dropped.
 */
export function toChatMessages(messages: readonly Message[], options: ToChatOptions = {}): ChatMessage[] {
  const out: ChatMessage[] = [];
  const pushEntry = (entry: ChatMessage) => {
    if (entry.parts.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === 'user' && entry.role === 'user') {
      last.parts.push(...entry.parts);
      return;
    }
    out.push(entry);
  };

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const entry of splitAssistant(msg.parts, options, msg.sensitive)) pushEntry(entry);
      continue;
    }
    const parts: ContentPart[] = [];
    for (const p of msg.parts) {
      switch (p.type) {
        case 'text':
          if (p.text) parts.push(msg.role === 'system' ? { type: 'text', text: `<neo_notice>${p.text}</neo_notice>` } : p);
          break;
        case 'image':
          parts.push(p);
          break;
        case 'context':
          if (p.sensitive && options.omitSensitiveContext) parts.push({ type: 'text', text: SENSITIVE_CONTEXT_PLACEHOLDER });
          else if (p.text) parts.push({ type: 'text', text: p.text });
          break;
        case 'ui_event':
          parts.push({ type: 'text', text: describeUiEvent(p) });
          break;
        default:
          break;
      }
    }
    pushEntry({ role: 'user', parts });
  }
  return out;
}

function splitAssistant(parts: readonly ContentPart[], options: ToChatOptions, msgSensitive?: boolean): ChatMessage[] {
  const omit = options.omitSensitiveContext === true;
  const omitAssistant = omit && msgSensitive === true;
  const entries: ChatMessage[] = [];
  let assistant: ContentPart[] = [];
  let results: ToolResultPart[] = [];
  let pendingCalls: ToolCallPart[] = [];

  const flush = () => {
    if (assistant.length) entries.push({ role: 'assistant', parts: assistant });
    // Close every call of this step, in call order.
    const byId = new Map(results.map((r) => [r.toolCallId, r]));
    const closed: ToolResultPart[] = pendingCalls.map((c) => {
      const r = byId.get(c.id) ?? { type: 'tool_result', toolCallId: c.id, name: c.name, output: CANCELLED_RESULT, isError: true };
      // Arguments, summaries and other outputs of a private-derived turn may quote the same memory.
      if (omitAssistant || (omit && r.sensitive)) {
        return { type: 'tool_result', toolCallId: r.toolCallId, name: r.name, output: SENSITIVE_TOOL_PLACEHOLDER, ...(r.isError ? { isError: true } : {}) };
      }
      return r;
    });
    // Results without a matching call in this step (should not happen) are dropped: they would be rejected by providers.
    if (closed.length) entries.push({ role: 'tool', parts: closed });
    assistant = [];
    results = [];
    pendingCalls = [];
  };

  let assistantPlaceholderEmitted = false;
  for (const p of parts) {
    switch (p.type) {
      case 'reasoning':
        if (results.length) flush();
        // Reasoning from a sensitive-derived turn may quote private memories too.
        if (!options.dropReasoning && !omitAssistant) assistant.push(p);
        break;
      case 'text':
        if (results.length) flush();
        if (p.text) {
          // Replace all text from a sensitive-derived assistant turn with one placeholder.
          if (omitAssistant) {
            if (!assistantPlaceholderEmitted) {
              assistant.push({ type: 'text', text: SENSITIVE_ASSISTANT_PLACEHOLDER });
              assistantPlaceholderEmitted = true;
            }
          } else {
            assistant.push(p);
          }
        }
        break;
      case 'tool_call':
        if (results.length) flush();
        assistant.push(omitAssistant ? { type: 'tool_call', id: p.id, name: p.name, input: {} } : p);
        pendingCalls.push(p);
        break;
      case 'tool_result':
        results.push(p);
        break;
      default:
        break;
    }
  }
  flush();
  // A reasoning-only step (turn cancelled mid-thought) carries nothing the model can use and some
  // providers reject it; it is dropped deterministically so the transcript stays stable.
  return entries.filter((e) => !(e.role === 'assistant' && e.parts.every((p) => p.type === 'reasoning')));
}

/** Rough token estimate (≈4 chars/token for latin text, ≈1 char/token for CJK). Never use for billing. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Token estimate for one stored message (images count as a flat 1000). */
export function estimateMessageTokens(msg: Message): number {
  let n = 4;
  for (const p of msg.parts) {
    switch (p.type) {
      case 'text':
      case 'context':
      case 'reasoning':
        n += estimateTokens(p.text);
        break;
      case 'image':
        n += 1000;
        break;
      case 'tool_call':
        n += estimateTokens(JSON.stringify(p.input ?? null)) + 10;
        break;
      case 'tool_result':
        n += estimateTokens(typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? null)) + 10;
        break;
      case 'ui_event':
        n += 40;
        break;
      case 'ui':
        break;
    }
  }
  return n;
}
