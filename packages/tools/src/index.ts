/**
 * @neo/tools — what NEO can do.
 *
 * FROZEN PUBLIC API (docs/IMPLEMENTATION_PLAN.md, WP-tools). Implementations
 * may add exports but must not change these signatures.
 */
import type {
  Clock,
  Logger,
  MemoryService,
  NeoPlugin,
  PermissionLevel,
  ProductivityStores,
  Recurrence,
  ReminderScheduler,
  ReminderStore,
  ToolDefinition,
  ToolRegistry,
} from '@neo/protocol';
import type { Migration, NeoDatabase } from '@neo/storage';

// ── Re-export implementations ────────────────────────────────────────────────

export { createToolRegistry } from './registry.js';
export type { ToolRegistryOptions } from './registry.js';

export { toolsMigrations, createProductivityStores } from './stores/index.js';

export { createReminderScheduler } from './scheduler.js';
export type { SchedulerOptions } from './scheduler.js';

export { nextOccurrence } from './recurrence.js';
export { utcToZoned, zonedTimeToUtc, parseDateTime, isValidTimeZone, formatLocalIso } from './time.js';
export { evaluateExpression } from './calc.js';

export { createBuiltinTools } from './builtins/index.js';
export { loadPlugins } from './plugins.js';
export { toolDefinitionProblem, pluginDefaultPermission } from './tool-definition.js';

// Web tool utilities for testing/extension
export { createWebFetchTool, createWebSearchTool, checkSsrf, htmlToText, isBlockedAddress, systemResolver } from './builtins/web.js';
export type { DnsResolver, WebFetchOptions } from './builtins/web.js';

// Re-export shared types
export type { WebSearchConfig, BuiltinToolDeps } from './types.js';

// ── Frozen public interface (kept verbatim) ───────────────────────────────────

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
}

// These types are re-exported for callers who only import from @neo/tools
export type {
  Clock,
  Logger,
  MemoryService,
  NeoPlugin,
  PermissionLevel,
  ProductivityStores,
  Recurrence,
  ReminderScheduler,
  ReminderStore,
  ToolDefinition,
  ToolRegistry,
  Migration,
  NeoDatabase,
};
