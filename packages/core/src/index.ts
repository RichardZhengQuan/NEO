/**
 * @neo/core — the agent runtime.
 *
 * Contracts are defined in @neo/protocol; internal episode stores retain their
 * conversation names for storage compatibility.
 */
export type {
  AgentEvent,
  AgentRuntimeApi,
  Clock,
  ConfirmationDecision,
  ConversationStore,
  Logger,
  MemoryService,
  Persona,
  ProviderRegistry,
  RecalledMemory,
  SendInput,
  SendTimelineInput,
  SettingsStore,
  ToolConfirmation,
  ToolRegistry,
  ToolSpec,
  TurnHandle,
  UiActionInput,
  UiActionResult,
} from '@neo/protocol';

export { NeoError } from '@neo/protocol';

// ── AgentRuntime ──────────────────────────────────────────────────────────────

export type { AgentRuntimeDeps } from './runtime.js';
export { AgentRuntime, createAgentRuntime } from './runtime.js';

// ── buildSystemPrompt / buildContextBlock ─────────────────────────────────────

export type { SystemPromptInput, ContextBlockInput } from './prompt.js';
export { buildSystemPrompt, buildContextBlock } from './prompt.js';

// ── History trimming ──────────────────────────────────────────────────────────

export { trimHistory } from './history.js';

// ── EventQueue ────────────────────────────────────────────────────────────────

export { EventQueue } from './event-queue.js';

// ── ConfirmationManager ───────────────────────────────────────────────────────

export type { ConfirmationOutcome } from './confirmations.js';
export { ConfirmationManager } from './confirmations.js';
