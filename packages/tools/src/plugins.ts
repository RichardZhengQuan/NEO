/**
 * Plugin loader: imports every *.mjs / *.js file of a directory (in name
 * order) and returns the plugins whose default export is a NeoPlugin.
 *
 * Plugins run in-process with full privileges, so only trusted code belongs
 * there. Invalid files, plugins and tools are skipped with a log line; tool
 * names already provided by an earlier plugin are skipped too. Returned tools
 * carry the plugin permission policy: `confirm` unless their risk is `read`.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { silentLogger, type Logger, type NeoPlugin, type ToolDefinition } from '@neo/protocol';
import { hasJsonSchema, normalizePluginTool, toolDefinitionProblem } from './tool-definition.js';

const PLUGIN_FILE = /\.(mjs|js)$/;

function pluginProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the default export is not an object';
  const p = value as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name.trim()) return 'the plugin needs a non-empty "name"';
  if (p.version !== undefined && typeof p.version !== 'string') return '"version" must be a string';
  if (p.description !== undefined && typeof p.description !== 'string') return '"description" must be a string';
  if (p.tools !== undefined && !Array.isArray(p.tools)) return '"tools" must be an array';
  return null;
}

export async function loadPlugins(dir: string, logger: Logger = silentLogger): Promise<NeoPlugin[]> {
  let files: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    files = entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && PLUGIN_FILE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') logger.debug('no plugin directory', { dir });
    else logger.warn('could not read the plugin directory', { dir, error: String(err) });
    return [];
  }

  const plugins: NeoPlugin[] = [];
  const toolNames = new Set<string>();

  for (const file of files) {
    let mod: unknown;
    try {
      // A file URL, not a path: raw paths break on Windows drive letters and on "#" / "%" in directory names.
      mod = await import(pathToFileURL(join(dir, file)).href);
    } catch (err) {
      logger.warn('plugin failed to load', { file, error: String(err) });
      continue;
    }
    const exported = (mod as { default?: unknown }).default;
    const problem = pluginProblem(exported);
    if (problem) {
      logger.warn('plugin skipped', { file, problem });
      continue;
    }
    const plugin = exported as NeoPlugin;
    const tools: ToolDefinition[] = [];
    (plugin.tools ?? []).forEach((tool: unknown, index: number) => {
      const name = (tool as { name?: unknown } | null)?.name;
      const label = typeof name === 'string' ? name : `#${index}`;
      const toolProblem = toolDefinitionProblem(tool);
      if (toolProblem) {
        logger.warn('plugin tool skipped', { file, plugin: plugin.name, tool: label, problem: toolProblem });
        return;
      }
      const def = tool as ToolDefinition;
      if (toolNames.has(def.name)) {
        logger.warn('plugin tool skipped: another plugin already provides this name', { file, plugin: plugin.name, tool: def.name });
        return;
      }
      toolNames.add(def.name);
      if (!hasJsonSchema(def.inputSchema)) {
        logger.warn('plugin tool schema is not a zod 4 schema; the model sees a generic object schema', { file, plugin: plugin.name, tool: def.name });
      }
      tools.push(normalizePluginTool(def));
    });
    const loaded: NeoPlugin = { name: plugin.name, tools };
    if (plugin.version !== undefined) loaded.version = plugin.version;
    if (plugin.description !== undefined) loaded.description = plugin.description;
    logger.info('plugin loaded', { file, name: plugin.name, tools: tools.map((t) => t.name) });
    plugins.push(loaded);
  }
  return plugins;
}
