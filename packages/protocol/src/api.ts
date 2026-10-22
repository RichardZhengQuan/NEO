/**
 * HTTP API contract (base path /api). Request bodies are validated with these
 * schemas on the server; response types are shared with @neo/client.
 * See docs/API.md for the route table.
 */
import { z } from 'zod';
import { NeoSettingsSchema, type NeoSettings } from './config.js';
import type { AiSettings } from './ai.js';
import type { ErrorShape } from './errors.js';
import { UserInputPartSchema, type Message, type TimelineMessage } from './content.js';
import type { ToolConfirmation } from './events.js';
import type { UiActionConfirmation } from './services.js';
import { MemoryExportSchema, MemoryNodePatchSchema, RememberInputSchema } from './memory.js';
import {
  NoteInputSchema,
  NotePatchSchema,
  PushSubscriptionSchema,
  ReminderInputSchema,
  ReminderPatchSchema,
  TaskInputSchema,
  TaskListInputSchema,
  TaskPatchSchema,
  type Device,
} from './productivity.js';
import { ProviderConfigSchema, ProviderKindSchema, type ModelInfo, type ProviderView } from './providers.js';
import { PermissionLevelSchema } from './tools.js';
import { DevicePlatformSchema } from './pairing.js';
import type { UIAction } from './ui.js';

export const API_VERSION = '1';

export interface HealthResponse {
  ok: true;
  name: 'neo';
  version: string;
  apiVersion: string;
  mode: 'local' | 'server';
  onboarded: boolean;
  time: number;
}

export interface ListResponse<T> {
  items: T[];
  total?: number;
  nextCursor?: string | null;
}

// ───────────────────────────── timeline ─────────────────────────────

export interface TimelineQuery {
  before?: string;
  limit?: number;
  /** A timeline message id or ISO date. */
  around?: string;
}

export interface EpisodeBoundary {
  episodeId: string;
  startedAt: number;
  offRecord: boolean;
}

export interface TimelinePage {
  /** Episode blocks by start time, messages oldest-first inside each block. */
  items: TimelineMessage[];
  /** Boundaries whose first message occurs in this page. */
  episodes: EpisodeBoundary[];
  nextCursor: string | null;
}

export interface TimelineSearchSnippet {
  text: string;
  /** Ascending, nonoverlapping UTF-16 offsets in text; end is exclusive. */
  highlights: [start: number, end: number][];
}

export interface TimelineSearchHit {
  messageId: string;
  episodeId: string;
  createdAt: number;
  snippet: TimelineSearchSnippet;
}

export interface TimelineDeleteResult {
  deleted: number;
  messageIds: string[];
  /** Memories are retained until the user chooses forget-by-source. */
  derivedMemories: number;
}

export const OffRecordStateSchema = z.object({
  active: z.boolean(),
  episodeId: z.string().min(1).nullable(),
  startedAt: z.number().int().nonnegative().nullable(),
});
export type OffRecordState = z.infer<typeof OffRecordStateSchema>;
export const StartOffRecordRequestSchema = z.object({}).strict();
export const StartOffRecordResponseSchema = OffRecordStateSchema;
export type StartOffRecordResponse = OffRecordState;
export const EndOffRecordResponseSchema = z.object({ deleted: z.number().int().nonnegative() });
export type EndOffRecordResponse = z.infer<typeof EndOffRecordResponseSchema>;

export const SendMessageRequestSchema = z
  .object({
    text: z.string().max(100_000).optional(),
    parts: z.array(UserInputPartSchema).max(20).optional(),
    // Legacy entry hint; authoritative clients use explicit start/end.
    offRecord: z.boolean().optional(),
  })
  .refine((r) => Boolean(r.text?.trim()) || Boolean(r.parts?.length), 'Provide text or parts');
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/** 202 response. With `Accept: text/event-stream` the server instead streams the turn's AgentEvents as SSE. */
export interface SendMessageResponse {
  turnId: string;
  episodeId: string;
  userMessage: Message;
  assistantMessageId: string;
}

export const CancelTurnRequestSchema = z.object({ turnId: z.string().optional() });

export const UiActionRequestSchema = z.object({
  messageId: z.string().min(1),
  uiId: z.string().min(1),
  actionId: z.string().min(1),
  values: z.record(z.string(), z.unknown()).optional(),
  confirmationToken: z.string().min(1).max(200).optional(),
});
export type UiActionRequest = z.infer<typeof UiActionRequestSchema>;

export type UiActionResponse =
  | { kind: 'turn'; turnId: string; episodeId: string; assistantMessageId: string; userMessage: Message }
  | { kind: 'tool'; output: unknown; isError: boolean; summary?: string }
  | { kind: 'client'; action: UIAction }
  | { kind: 'confirm'; confirmation: UiActionConfirmation }
  | { kind: 'noop' };

export const ConfirmToolRequestSchema = z.object({ approve: z.boolean(), always: z.boolean().optional() });
export type ConfirmToolRequest = z.infer<typeof ConfirmToolRequestSchema>;
export type PendingConfirmationsResponse = ListResponse<ToolConfirmation>;

// ───────────────────────────── memory ─────────────────────────────

export const CreateMemoryRequestSchema = RememberInputSchema;
export const UpdateMemoryRequestSchema = MemoryNodePatchSchema;
export const IdsRequestSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(1000) });
export type IdsRequest = z.infer<typeof IdsRequestSchema>;
export const ForgetBySourceRequestSchema = z.object({ messageIds: z.array(z.string().min(1)).min(1).max(1000) });
export type ForgetBySourceRequest = z.infer<typeof ForgetBySourceRequestSchema>;
export const LinkMemoryRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string().min(1),
  weight: z.number().min(0).max(1).optional(),
});
export const ForgetMatchingRequestSchema = z.object({ query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(200).optional() });
export const ImportMemoryRequestSchema = z.object({ data: MemoryExportSchema, mode: z.enum(['merge', 'replace']).optional() });

// ───────────────────────────── reminders, tasks, notes ─────────────────────────────

export const CreateReminderRequestSchema = ReminderInputSchema;
export const UpdateReminderRequestSchema = ReminderPatchSchema;
export const SnoozeRequestSchema = z.object({ minutes: z.number().int().min(1).max(60 * 24 * 30) });
export const CreateTaskRequestSchema = TaskInputSchema;
export const UpdateTaskRequestSchema = TaskPatchSchema;
export const CreateTaskListRequestSchema = TaskListInputSchema;
export const UpdateTaskListRequestSchema = TaskListInputSchema.partial();
export const CreateNoteRequestSchema = NoteInputSchema;
export const UpdateNoteRequestSchema = NotePatchSchema;
export const MarkReadRequestSchema = z.object({ ids: z.union([z.array(z.string()), z.literal('all')]) });

// ───────────────────────────── providers ─────────────────────────────

/**
 * id is generated from kind when omitted. apiKey is moved into the encrypted SecretStore.
 * apiKeySecret is intentionally omitted: clients supply a plaintext apiKey; the server
 * derives the secret-store reference (provider:<id>) and never accepts one from the client
 * (prevents cross-provider credential exfiltration via attacker-controlled baseUrl).
 */
export const CreateProviderRequestSchema = ProviderConfigSchema.omit({ apiKeySecret: true }).extend({
  id: ProviderConfigSchema.shape.id.optional(),
  /** Verify the connection and choose capabilities from the live model list before saving. */
  simple: z.boolean().optional(),
});
export type CreateProviderRequest = z.input<typeof CreateProviderRequestSchema>;
export const UpdateProviderRequestSchema = ProviderConfigSchema
  .omit({ id: true, kind: true, apiKeySecret: true, enabled: true })
  .partial()
  .extend({ enabled: z.boolean().optional() });
export type UpdateProviderRequest = z.input<typeof UpdateProviderRequestSchema>;

/** Test either a saved provider (POST /providers/:id/test) or an unsaved draft (POST /providers/test). */
export const TestProviderRequestSchema = z.object({
  kind: ProviderKindSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export interface ProvidersResponse {
  items: ProviderView[];
  ai?: AiSettings;
  /** Compatibility mirror of the global Text capability. */
  defaultModel: { provider: string; model: string } | null;
}
export type ModelsResponse = ListResponse<ModelInfo>;

export interface OpenRouterStartResponse {
  url: string;
  state: string;
  expiresAt: number;
}
export const CancelOpenRouterRequestSchema = z.object({ state: z.string().min(1).max(200) });

export const StartChatGPTRequestSchema = z.object({ providerId: ProviderConfigSchema.shape.id.optional() });
export interface ChatGPTStartResponse {
  url: string;
  state: string;
  expiresAt: number;
}
export const CancelChatGPTRequestSchema = z.object({ state: z.string().min(1).max(200) });
/** No credentials or account claims leave the server through sign-in status. */
export interface ChatGPTStatusResponse {
  status: 'waiting' | 'connected' | 'failed' | 'cancelled';
  provider?: ProviderView;
  error?: ErrorShape;
}

// ───────────────────────────── settings, tools, devices, push ─────────────────────────────

/** Deep-partial settings patch; the server merges then validates with NeoSettingsSchema. */
export const UpdateSettingsRequestSchema = z.record(z.string(), z.unknown());
export type SettingsResponse = NeoSettings;
export { NeoSettingsSchema };

export const SetToolPermissionRequestSchema = z.object({ permission: PermissionLevelSchema });

export const CreateDeviceRequestSchema = z.object({
  name: z.string().min(1).max(100),
  platform: DevicePlatformSchema.default('other'),
});
export interface CreateDeviceResponse {
  device: Device;
  /** Shown once. */
  token: string;
  /** v1 link (neo://pair?server=…&token=…) for advanced setups; phones pair with `POST /api/pairing`. */
  pairingUrl: string;
}

export const PushSubscribeRequestSchema = z.object({ subscription: PushSubscriptionSchema });
export interface VapidKeyResponse {
  publicKey: string | null;
}
