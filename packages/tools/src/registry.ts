/**
 * ToolRegistry: registration, permissions, validation and never-throwing execution.
 */
import {
  NeoError,
  silentLogger,
  toolSpec,
  wrapUntrusted,
  type Logger,
  type PermissionLevel,
  type ToolCallRequest,
  type ToolContext,
  type ToolDefinition,
  type ToolInfo,
  type ToolRegistry,
  type ToolResult,
  type ToolSpec,
} from '@neo/protocol';
import type { z } from 'zod';
import { normalizePluginTool, toolDefinitionProblem } from './tool-definition.js';

export interface ToolRegistryOptions {
  /** User overrides; tools without one use their defaultPermission. */
  permissions?: Record<string, PermissionLevel>;
  logger?: Logger;
}

interface Entry {
  def: ToolDefinition;
  source: 'builtin' | 'plugin';
}

/** At most this many zod issues are echoed back to the model. */
const MAX_ISSUES = 20;

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const lines = issues.slice(0, MAX_ISSUES).map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`);
  if (issues.length > MAX_ISSUES) lines.push(`…and ${issues.length - MAX_ISSUES} more`);
  return lines.join('; ');
}

export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const tools = new Map<string, Entry>();
  const permissions = new Map<string, PermissionLevel>(Object.entries(options.permissions ?? {}));
  const logger: Logger = options.logger ?? silentLogger;

  const permissionFor = (name: string): PermissionLevel =>
    permissions.get(name) ?? tools.get(name)?.def.defaultPermission ?? 'auto';

  const specs = (names?: readonly string[]): ToolSpec[] => {
    const entries = names ? names.map((n) => tools.get(n)).filter((e): e is Entry => e !== undefined) : [...tools.values()];
    const out: ToolSpec[] = [];
    for (const e of entries) {
      if (e.def.uiOnly || permissionFor(e.def.name) === 'deny') continue;
      try {
        out.push(toolSpec(e.def));
      } catch (err) {
        // One broken schema (typically a plugin) must not take every request down with it.
        logger.error('tool schema cannot be converted to JSON Schema; tool skipped', { tool: e.def.name, error: String(err) });
      }
    }
    return out;
  };

  const errorResult = (def: ToolDefinition | undefined, error: string, extra: Record<string, unknown> = {}): ToolResult => {
    const output = { error, ...extra };
    return { isError: true, output: def?.untrustedOutput ? wrapUntrusted(def.name, JSON.stringify(output)) : output };
  };

  const execute = async (call: ToolCallRequest, ctx: ToolContext): Promise<ToolResult> => {
    const def = tools.get(call.name)?.def;
    try {
      if (!def) return errorResult(undefined, `Unknown tool "${call.name}".`);
      if (def.uiOnly && ctx.origin !== 'ui') return errorResult(def, `The tool "${call.name}" can only be used from the app's controls.`);
      if (ctx.signal?.aborted) return errorResult(def, 'The operation was cancelled.', { code: 'cancelled' });

      const schema = def.inputSchema as z.ZodType & { safeParseAsync?: z.ZodType['safeParseAsync'] };
      const input = call.input ?? {};
      const parsed = typeof schema.safeParseAsync === 'function' ? await schema.safeParseAsync(input) : schema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues;
        return errorResult(def, `Invalid input for ${call.name}: ${describeIssues(issues)}`, { issues: issues.slice(0, MAX_ISSUES) });
      }
      if (ctx.signal?.aborted) return errorResult(def, 'The operation was cancelled.', { code: 'cancelled' });

      const result = (await def.execute(parsed.data, ctx)) as ToolResult | undefined;
      if (typeof result !== 'object' || result === null || !('output' in result)) {
        logger.error('tool returned an invalid result', { tool: call.name });
        return errorResult(def, `The tool "${call.name}" returned an invalid result.`);
      }
      if (def.untrustedOutput) {
        const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null);
        return { ...result, output: wrapUntrusted(def.name, text) };
      }
      return result;
    } catch (err) {
      const neo = NeoError.from(err);
      const log = neo.status >= 500 ? logger.error : logger.warn;
      log.call(logger, 'tool failed', { tool: call.name, code: neo.code, error: neo.message });
      return errorResult(def, neo.message, { code: neo.code });
    }
  };

  return {
    register(def: ToolDefinition, source: 'builtin' | 'plugin' = 'builtin') {
      if (source === 'plugin') {
        const problem = toolDefinitionProblem(def);
        if (problem) {
          logger.warn('plugin tool rejected', { tool: (def as { name?: unknown })?.name, problem });
          return;
        }
        if (tools.get(def.name)?.source === 'builtin') {
          logger.warn('plugin tool rejected: a built-in tool has this name', { tool: def.name });
          return;
        }
        tools.set(def.name, { def: normalizePluginTool(def), source });
        return;
      }
      tools.set(def.name, { def, source });
    },

    unregister(name: string): boolean {
      return tools.delete(name);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name)?.def;
    },

    list(): ToolDefinition[] {
      return [...tools.values()].map((e) => e.def);
    },

    info(): ToolInfo[] {
      return [...tools.values()].map((e) => {
        const permission = permissionFor(e.def.name);
        return {
          name: e.def.name,
          title: e.def.title,
          description: e.def.description,
          risk: e.def.risk,
          permission,
          enabled: permission !== 'deny',
          source: e.source,
        };
      });
    },

    specs,
    permissionFor,

    setPermission(name: string, level: PermissionLevel) {
      permissions.set(name, level);
    },

    execute,
  };
}
