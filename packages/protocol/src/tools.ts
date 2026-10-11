/**
 * Tools: what NEO can *do*. A tool is a zod-typed function plus metadata
 * (risk, default permission). The user decides per tool whether it runs
 * automatically, asks first, or is disabled.
 */
import { z } from 'zod';
import type { UIBlock } from './ui.js';
import type { ToolSpec } from './providers.js';
import type { Logger } from './services.js';

export const PermissionLevelSchema = z.enum(['auto', 'confirm', 'deny']);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

/**
 * - read:      only reads NEO's own data (time, tasks, memory search)
 * - write:     changes NEO's own data (create reminder, edit note)
 * - external:  talks to the outside world (web fetch/search); outputs are untrusted
 * - dangerous: destructive or irreversible (delete, forget) — defaults to confirm
 */
export const ToolRiskSchema = z.enum(['read', 'write', 'external', 'dangerous']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export interface ToolContext {
  toolCallId: string;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  signal: AbortSignal;
  now(): number;
  /** IANA zone of the user, e.g. "Asia/Shanghai". */
  timezone: string;
  locale: string;
  /** Whether sensitive memories may be revealed (true only for local models / when the user allowed it). */
  allowSensitive: boolean;
  /** Who triggered the call: the model during a turn, or the user via a UI action. */
  origin: 'model' | 'ui';
  logger: Logger;
}

export interface ToolResult {
  /** JSON-serializable value given to the model. Keep it compact. */
  output: unknown;
  /** Blocks rendered to the user (the model is told they were shown). */
  ui?: UIBlock[];
  isError?: boolean;
  /** Short human summary shown on tool chips. */
  summary?: string;
}

export interface ToolDefinition<I = any> {
  /** snake_case, unique, ≤ 64 chars. */
  name: string;
  /** Human title for chips/settings ("Create reminder"). */
  title: string;
  /** Model-facing description: when and how to use the tool. */
  description: string;
  inputSchema: z.ZodType<I>;
  risk: ToolRisk;
  defaultPermission: PermissionLevel;
  /** Output contains third-party content; the runtime wraps it as untrusted data. */
  untrustedOutput?: boolean;
  /** Only runnable from UI actions (origin 'ui'); never offered to the model (e.g. approve_memory). */
  uiOnly?: boolean;
  /** One line describing a concrete call, for confirmation prompts ("Delete note 'Groceries'"). */
  describeCall?(input: I): string;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/** Identity helper that infers the input type from the schema. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<z.infer<S>> & { inputSchema: S }): ToolDefinition<z.infer<S>> {
  return def;
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  risk: ToolRisk;
  permission: PermissionLevel;
  /** False when permission is 'deny' (the model never sees the tool). */
  enabled: boolean;
  source: 'builtin' | 'plugin';
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolRegistry {
  register(def: ToolDefinition, source?: 'builtin' | 'plugin'): void;
  unregister(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  info(): ToolInfo[];
  /** Specs for the model: tools whose permission is not 'deny' and that are not uiOnly (optionally restricted to `names`). */
  specs(names?: readonly string[]): ToolSpec[];
  permissionFor(name: string): PermissionLevel;
  setPermission(name: string, level: PermissionLevel): void;
  /**
   * Validate input with the tool's schema and run it. Never throws for tool
   * failures: unknown tool, invalid input, a uiOnly tool called with origin
   * 'model', or a thrown error become `{ isError: true, output: { error } }`.
   * Permission/confirmation is the caller's job.
   */
  execute(call: ToolCallRequest, ctx: ToolContext): Promise<ToolResult>;
}

/** JSON Schema for a tool input (draft 2020-12 minus `$schema`). */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== 'object') return { type: 'object', properties: { value: json }, required: ['value'] };
  return json;
}

export function toolSpec(def: ToolDefinition): ToolSpec {
  return { name: def.name, description: def.description, inputSchema: toolInputJsonSchema(def.inputSchema) };
}

/** Wrap third-party content so the model treats it as data, never as instructions. */
export function wrapUntrusted(source: string, content: string): string {
  const safe = content.replace(/<\/?untrusted_content[^>]*>/gi, '');
  return `<untrusted_content source="${source.replace(/"/g, "'")}">\n${safe}\n</untrusted_content>`;
}

/** A plugin: a module (dataDir/plugins/*.mjs) whose default export matches this shape. */
export interface NeoPlugin {
  name: string;
  version?: string;
  description?: string;
  tools?: ToolDefinition[];
}
