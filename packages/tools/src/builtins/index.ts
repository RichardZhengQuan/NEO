/**
 * Assembles all built-in tools for NEO.
 */
import type { ToolDefinition } from '@neo/protocol';
import type { BuiltinToolDeps } from '../types.js';
import { getDatetimeTool } from './datetime.js';
import { calculateTool } from './calculate.js';
import { createReminderTools } from './reminders.js';
import { createTaskTools } from './tasks.js';
import { createNoteTools } from './notes.js';
import { createMemoryTools } from './memory.js';
import { createWebFetchTool, createWebSearchTool } from './web.js';
import { renderUiTool } from './render_ui.js';
import { createPlanTomorrowTool } from './plan_tomorrow.js';

export function createBuiltinTools(deps: BuiltinToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    getDatetimeTool,
    calculateTool,
    createPlanTomorrowTool(deps.stores),
    ...createReminderTools(deps.stores),
    ...createTaskTools(deps.stores),
    ...createNoteTools(deps.stores),
    ...createMemoryTools(deps.memory),
    // Without an injected fetch, web_fetch uses its own node:http(s) transport pinned to vetted addresses.
    createWebFetchTool({ fetch: deps.fetch, allowPrivateNetwork: deps.allowPrivateNetwork ?? false }),
    renderUiTool,
  ];

  // web_search is only added when explicitly configured
  if (deps.webSearch && deps.webSearch.provider !== 'none') {
    tools.push(createWebSearchTool(deps.webSearch, deps.fetch ?? globalThis.fetch));
  }

  return tools;
}

export { createWebFetchTool, createWebSearchTool } from './web.js';
export type { DnsResolver, WebFetchOptions } from './web.js';
