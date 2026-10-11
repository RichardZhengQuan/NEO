/**
 * Structural validation and normalization of tool definitions that come from
 * outside this package (plugins). Built-in tools are trusted as written.
 */
import { PermissionLevelSchema, ToolRiskSchema, toolInputJsonSchema, type PermissionLevel, type ToolDefinition, type ToolRisk } from '@neo/protocol';
import { z } from 'zod';

/** snake_case, starts with a letter, ≤ 64 chars (what every provider accepts). */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** A human-readable reason why `def` is not a usable ToolDefinition, or null when it is. */
export function toolDefinitionProblem(def: unknown): string | null {
  if (typeof def !== 'object' || def === null) return 'not an object';
  const t = def as Record<string, unknown>;
  if (typeof t.name !== 'string' || !TOOL_NAME_PATTERN.test(t.name)) return 'name must be snake_case (a-z, 0-9, _), start with a letter and be at most 64 characters';
  if (typeof t.title !== 'string' || !t.title.trim()) return 'title must be a non-empty string';
  if (typeof t.description !== 'string' || !t.description.trim()) return 'description must be a non-empty string';
  if (typeof t.execute !== 'function') return 'execute must be a function';
  if (t.describeCall !== undefined && typeof t.describeCall !== 'function') return 'describeCall must be a function';
  if (!ToolRiskSchema.safeParse(t.risk).success) return `risk must be one of ${ToolRiskSchema.options.join(', ')}`;
  if (t.defaultPermission !== undefined && !PermissionLevelSchema.safeParse(t.defaultPermission).success) {
    return `defaultPermission must be one of ${PermissionLevelSchema.options.join(', ')}`;
  }
  const schema = t.inputSchema as { safeParse?: unknown; safeParseAsync?: unknown } | undefined;
  if (typeof schema !== 'object' || schema === null || (typeof schema.safeParse !== 'function' && typeof schema.safeParseAsync !== 'function')) {
    return 'inputSchema must be a zod schema (an object with safeParse)';
  }
  return null;
}

/** True when the schema converts to JSON Schema (a zod 4 schema). */
export function hasJsonSchema(schema: unknown): boolean {
  try {
    toolInputJsonSchema(schema as z.ZodType);
    return true;
  } catch {
    return false;
  }
}

type ForeignSchema = {
  safeParse?: (v: unknown) => ForeignResult;
  safeParseAsync?: (v: unknown) => Promise<ForeignResult>;
};
type ForeignResult = { success: boolean; data?: unknown; error?: { issues?: { message?: unknown; path?: unknown }[] } };

/**
 * Wrap a schema that only quacks like zod (e.g. zod 3, or a hand-written
 * validator): the model sees a generic object schema, and the plugin's own
 * validator still decides what is valid.
 */
export function adaptForeignSchema(schema: unknown): z.ZodType {
  const foreign = schema as ForeignSchema;
  return z.looseObject({}).transform(async (value, ctx) => {
    const result = typeof foreign.safeParseAsync === 'function' ? await foreign.safeParseAsync(value) : (foreign.safeParse as NonNullable<ForeignSchema['safeParse']>)(value);
    if (result.success) return result.data;
    const issues = result.error?.issues?.length ? result.error.issues : [{ message: 'Invalid input' }];
    for (const issue of issues) {
      const path = Array.isArray(issue.path) ? issue.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number') : [];
      ctx.addIssue({ code: 'custom', message: String(issue.message ?? 'Invalid input'), path });
    }
    return z.NEVER;
  });
}

/** Plugin tools ask before running unless they only read: `confirm`, or `deny` when the plugin asks for it. */
export function pluginDefaultPermission(risk: ToolRisk, requested: PermissionLevel | undefined): PermissionLevel {
  if (requested === 'deny') return 'deny';
  if (risk === 'read') return requested ?? 'auto';
  return 'confirm';
}

/**
 * A plain copy of a (validated) plugin tool with the plugin permission policy
 * applied. Methods are bound, so class-based tool objects keep working.
 */
export function normalizePluginTool(def: ToolDefinition): ToolDefinition {
  const out: ToolDefinition = {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: hasJsonSchema(def.inputSchema) ? def.inputSchema : adaptForeignSchema(def.inputSchema),
    risk: def.risk,
    defaultPermission: pluginDefaultPermission(def.risk, def.defaultPermission),
    execute: def.execute.bind(def),
  };
  if (def.untrustedOutput) out.untrustedOutput = true;
  if (def.uiOnly) out.uiOnly = true;
  if (def.describeCall) out.describeCall = def.describeCall.bind(def);
  return out;
}
