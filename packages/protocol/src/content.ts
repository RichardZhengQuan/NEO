/**
 * Conversations, messages and content parts.
 *
 * Storage model: one user `Message` per user turn, and ONE assistant `Message`
 * per agent turn whose `parts` interleave every step of that turn in order —
 * reasoning, text, tool calls, tool results, UI blocks. `toChatMessages()`
 * (transcript.ts) turns that into the provider-neutral wire transcript.
 */
import { z } from 'zod';
import { ErrorShapeSchema } from './errors.js';
import { UIBlockSchema, isSafeLinkUrl } from './ui.js';

export const ModelRefSchema = z.object({
  /** ProviderConfig.id */
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export function modelRefToString(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function parseModelRef(s: string): ModelRef | null {
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export function addUsage(a: Usage | null | undefined, b: Usage | null | undefined): Usage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const out: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
  const cr = sum(a.cacheReadTokens, b.cacheReadTokens);
  const cw = sum(a.cacheWriteTokens, b.cacheWriteTokens);
  const rt = sum(a.reasoningTokens, b.reasoningTokens);
  if (cr !== undefined) out.cacheReadTokens = cr;
  if (cw !== undefined) out.cacheWriteTokens = cw;
  if (rt !== undefined) out.reasoningTokens = rt;
  return out;
}

// ───────────────────────────── parts ─────────────────────────────

export const TextPartSchema = z.object({ type: z.literal('text'), text: z.string() });

export const SourceSchema = z.object({
  title: z.string().max(1000),
  url: z.string().url().max(4000).refine(url => {
    if (!/^https?:\/\//i.test(url) || !isSafeLinkUrl(url)) return false;
    try { const parsed = new URL(url); return !parsed.username && !parsed.password; } catch { return false; }
  }, 'Sources must use safe http(s) URLs'),
  snippet: z.string().max(4000).optional(),
});
export type Source = z.infer<typeof SourceSchema>;
/** Third-party citations, never user-authored memory input. */
export const SourcesPartSchema = z.object({ type: z.literal('sources'), items: z.array(SourceSchema).max(100) });
export type SourcesPart = z.infer<typeof SourcesPartSchema>;
/** Opaque server-tool replay data, scoped to the original provider and model. */
export const ProviderPartSchema = z.object({
  type: z.literal('provider_part'),
  provider: z.string(),
  model: z.string(),
  data: z.unknown(),
});
export type ProviderPart = z.infer<typeof ProviderPartSchema>;

export const ImagePartSchema = z
  .object({
    type: z.literal('image'),
    mediaType: z.string().regex(/^image\/[\w.+-]+$/),
    /** Base64 (no data: prefix). Preferred: bytes are stable across requests. */
    data: z.string().optional(),
    url: z.string().url().optional(),
    alt: z.string().max(500).optional(),
  })
  .refine((p) => Boolean(p.data) !== Boolean(p.url), 'Provide exactly one of data or url');

/**
 * Model reasoning. `data` is an opaque provider payload (e.g. an Anthropic
 * thinking-block signature) that MUST be replayed verbatim to the same
 * provider+model and dropped for any other.
 */
export const ReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  redacted: z.boolean().optional(),
  data: z.unknown().optional(),
});

export const ToolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
  provider: z.string().optional(),
  data: z.unknown().optional(),
});

export const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  /** JSON-serializable value given back to the model. */
  output: z.unknown(),
  isError: z.boolean().optional(),
  /** Short human summary for tool chips ("Created reminder for 5:00 PM"). */
  summary: z.string().optional(),
  /** True when the output contains sensitive memories (withheld from cloud replay unless allowed). */
  sensitive: z.boolean().optional(),
});

/** A rendered generative-UI block. `id` addresses it for UI actions. */
export const UIPartSchema = z.object({
  type: z.literal('ui'),
  id: z.string().min(1),
  block: UIBlockSchema,
  toolCallId: z.string().optional(),
});

/** The user interacted with a UI block (button, form submit). Lives in a user message. */
export const UIEventPartSchema = z.object({
  type: z.literal('ui_event'),
  messageId: z.string().min(1),
  uiId: z.string().min(1),
  actionId: z.string().min(1),
  label: z.string().optional(),
  payload: z.unknown().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Per-turn context NEO injects into the user message (current time, recalled
 * memories). Hidden in UIs, but persisted and replayed byte-for-byte so the
 * transcript stays append-only (prompt caching + preserved thinking).
 */
export const ContextPartSchema = z.object({
  type: z.literal('context'),
  text: z.string(),
  /** True when the text includes sensitive memories (only ever shared with local models unless allowed). */
  sensitive: z.boolean().optional(),
});

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
  ReasoningPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
  UIPartSchema,
  UIEventPartSchema,
  ContextPartSchema,
  SourcesPartSchema,
  ProviderPartSchema,
]);

export type TextPart = z.infer<typeof TextPartSchema>;
export type ImagePart = z.infer<typeof ImagePartSchema>;
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>;
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;
export type UIPart = z.infer<typeof UIPartSchema>;
export type UIEventPart = z.infer<typeof UIEventPartSchema>;
export type ContextPart = z.infer<typeof ContextPartSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type ContentPartType = ContentPart['type'];

/** Parts a client may send in a user message. */
export const UserInputPartSchema = z.discriminatedUnion('type', [TextPartSchema, ImagePartSchema]);
export type UserInputPart = z.infer<typeof UserInputPartSchema>;

// ───────────────────────────── messages & conversations ─────────────────────────────

export const RoleSchema = z.enum(['user', 'assistant', 'system']);
export type Role = z.infer<typeof RoleSchema>;

export const MessageStatusSchema = z.enum(['streaming', 'complete', 'error', 'cancelled']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Public timeline identity; conversationId is retained for internal provenance. */
  episodeId: z.string().optional(),
  role: RoleSchema,
  parts: z.array(ContentPartSchema),
  createdAt: z.number(),
  turnId: z.string().nullable().optional(),
  model: ModelRefSchema.nullable().optional(),
  status: MessageStatusSchema,
  error: ErrorShapeSchema.nullable().optional(),
  usage: UsageSchema.nullable().optional(),
  /** True when this assistant message was generated in a turn that involved sensitive memories. */
  sensitive: z.boolean().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Legacy storage field; every new turn uses the global Text capability. */
  model: ModelRefSchema.nullable(),
  /** Legacy storage field; offRecord controls new episodes. */
  incognito: z.boolean(),
  pinned: z.boolean(),
  archived: z.boolean(),
  /** System prompt frozen at the first turn (append-only transcript; see ARCHITECTURE.md). */
  systemPrompt: z.string().nullable(),
  /** Tool names frozen at the first turn. null → not started yet. */
  toolset: z.array(z.string()).nullable(),
  lastMessageAt: z.number().nullable(),
  /** First ~120 chars of the latest visible text. */
  preview: z.string().nullable(),
  kind: z.literal('episode').optional(),
  offRecord: z.boolean().optional(),
  /** Only newly created off-record episodes are ephemeral. */
  ephemeral: z.boolean().optional(),
  startedAt: z.number().optional(),
  closedAt: z.number().nullable().optional(),
  /** Resolved search mode recorded at the first turn. Persists across restarts so the episode boundary check is stable. */
  searchMode: z.enum(['native', 'engine', 'off']).optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** An episode's public metadata has no chat title, pin, archive or model override. */
export const EpisodeSchema = z.object({
  id: z.string(),
  kind: z.literal('episode'),
  offRecord: z.boolean(),
  ephemeral: z.boolean(),
  startedAt: z.number(),
  closedAt: z.number().nullable(),
  lastMessageAt: z.number().nullable(),
});
export type Episode = z.infer<typeof EpisodeSchema>;

export const TimelineMessageSchema = MessageSchema.extend({ episodeId: z.string() });
export type TimelineMessage = z.infer<typeof TimelineMessageSchema>;

export function episodeOf(conversation: Conversation): Episode {
  return {
    id: conversation.id,
    kind: 'episode',
    offRecord: conversation.offRecord ?? conversation.incognito,
    ephemeral: conversation.ephemeral ?? false,
    startedAt: conversation.startedAt ?? conversation.createdAt,
    closedAt: conversation.closedAt ?? null,
    lastMessageAt: conversation.lastMessageAt,
  };
}

// ───────────────────────────── helpers ─────────────────────────────

/** Concatenate the visible text parts of a message. */
export function textOf(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Parts that clients should render (context parts are hidden). */
export function visibleParts(parts: readonly ContentPart[]): ContentPart[] {
  return parts.filter((p) => p.type !== 'context' && p.type !== 'provider_part');
}

/** One-line preview of a message for lists and notifications. */
export function previewOf(parts: readonly ContentPart[], max = 120): string {
  const t = textOf(parts).replace(/\s+/g, ' ').trim();
  if (t) return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  const ui = parts.find((p): p is UIPart => p.type === 'ui');
  if (ui) return `[${ui.block.type}]`;
  return '';
}

/** How a UI interaction is described to the model. */
export function describeUiEvent(part: UIEventPart): string {
  const bits = [`The user activated "${part.label ?? part.actionId}" (action ${part.actionId}) on UI element ${part.uiId}.`];
  if (part.values && Object.keys(part.values).length) bits.push(`Form values: ${JSON.stringify(part.values)}`);
  if (part.payload !== undefined) bits.push(`Payload: ${JSON.stringify(part.payload)}`);
  return `<ui_event>${bits.join(' ')}</ui_event>`;
}
