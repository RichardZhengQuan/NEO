/**
 * Events. The agent runtime emits AgentEvents while a turn runs; the server
 * adds app-level events and fans everything out to every connected client
 * over one WebSocket (and per-turn over SSE).
 */
import { z } from 'zod';
import type { NeoSettings } from './config.js';
import type { ContentPart, Episode, Message, ModelRef, Usage } from './content.js';
import type { ErrorShape } from './errors.js';
import type { MemoryChangeEvent, MemoryKind, MemoryNodeSummary } from './memory.js';
import type { Note, Notification, Reminder, ReminderFiring, Task } from './productivity.js';
import type { ProviderView, StopReason } from './providers.js';
import type { ToolRisk } from './tools.js';

/** A tool call waiting for the user's decision. */
export interface ToolConfirmation {
  /**
   * Server-generated, single-use approval id (`cnf_…`). Clients answer with this id
   * (POST /api/confirmations/:id). Provider tool-call ids can repeat across turns and
   * conversations, so they never identify an approval on their own.
   */
  id: string;
  conversationId: string;
  episodeId: string;
  turnId: string;
  messageId: string;
  toolCallId: string;
  name: string;
  title: string;
  input: unknown;
  /** describeCall() output, e.g. "Delete note 'Groceries'". */
  description: string;
  risk: ToolRisk;
  requestedAt: number;
  expiresAt: number;
}

export interface RecalledMemorySummary {
  id: string;
  kind: MemoryKind;
  label: string;
  score: number;
  reason: string;
}

type TurnScoped = { conversationId: string; episodeId: string; turnId: string };

export const TimelineOffRecordEventSchema = z.object({ type: z.literal('timeline.off_record'), active: z.boolean() });
export type TimelineOffRecordEvent = z.infer<typeof TimelineOffRecordEventSchema>;

export type AgentEvent =
  | TimelineOffRecordEvent
  | { type: 'episode.started'; episodeId: string; episode: Episode }
  | { type: 'conversation.deleted'; conversationId: string; episodeId: string }
  | ({ type: 'turn.started'; userMessage: Message; assistantMessageId: string; model: ModelRef } & TurnScoped)
  | ({ type: 'text.delta'; messageId: string; text: string } & TurnScoped)
  | ({ type: 'reasoning.delta'; messageId: string; text: string } & TurnScoped)
  /** A finished non-delta part (tool_call, tool_result, ui, reasoning) was appended at `index`. */
  | ({ type: 'part.added'; messageId: string; index: number; part: ContentPart } & TurnScoped)
  | ({ type: 'tool.started'; messageId: string; toolCallId: string; name: string; title: string; input: unknown } & TurnScoped)
  | ({ type: 'tool.confirmation'; confirmation: ToolConfirmation } & TurnScoped)
  | ({
      type: 'tool.confirmation_resolved';
      /** The resolved `ToolConfirmation.id`. */
      confirmationId?: string;
      toolCallId: string;
      approved: boolean;
      reason: 'user' | 'timeout' | 'cancelled';
    } & TurnScoped)
  | ({
      type: 'tool.finished';
      messageId: string;
      toolCallId: string;
      name: string;
      isError: boolean;
      summary?: string | undefined;
    } & TurnScoped)
  | ({ type: 'memory.recalled'; items: RecalledMemorySummary[] } & TurnScoped)
  | ({ type: 'memory.written'; created: MemoryNodeSummary[]; updated: MemoryNodeSummary[] } & TurnScoped)
  | ({ type: 'message.completed'; message: Message } & TurnScoped)
  | ({ type: 'turn.finished'; stopReason: StopReason; usage: Usage | null } & TurnScoped)
  | ({ type: 'turn.failed'; error: ErrorShape } & TurnScoped)
  | { type: 'conversation.updated'; episodeId: string; conversation: Episode };

export type AgentEventType = AgentEvent['type'];

export type ServerEvent =
  | AgentEvent
  | { type: 'reminder.fired'; firing: ReminderFiring }
  | { type: 'reminder.updated'; reminder: Reminder }
  | { type: 'reminder.deleted'; reminderId: string }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'note.updated'; note: Note }
  | { type: 'note.deleted'; noteId: string }
  | { type: 'memory.changed'; change: MemoryChangeEvent }
  | { type: 'notification.created'; notification: Notification }
  | { type: 'provider.connected'; provider: ProviderView; state?: string }
  | { type: 'settings.updated'; settings: NeoSettings };

export type ServerEventType = ServerEvent['type'];

export interface EventEnvelope {
  /** Monotonic per server process; clients use it to detect gaps. */
  seq: number;
  at: number;
  event: ServerEvent;
}

// ───────────────────────────── WebSocket protocol ─────────────────────────────

/** Client → server. The first message must be `auth` (browsers cannot set WS headers). */
export type WsClientMessage =
  | { type: 'auth'; token: string; device?: string }
  | { type: 'subscribe'; conversations: string[] | 'all' }
  | { type: 'ping'; id?: string };

/** Server → client. */
export type WsServerMessage =
  | { type: 'ready'; serverVersion: string; seq: number }
  | { type: 'event'; envelope: EventEnvelope }
  | { type: 'pong'; id?: string }
  | { type: 'error'; error: ErrorShape };

/** True for events tied to one conversation (used for subscription filtering). */
export function eventConversationId(event: ServerEvent): string | null {
  if ('episodeId' in event) return event.episodeId;
  if ('conversationId' in event && typeof event.conversationId === 'string') return event.conversationId;
  return null;
}
