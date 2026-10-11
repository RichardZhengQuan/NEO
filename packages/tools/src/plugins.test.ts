/** Review tests for loadPlugins. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '@neo/protocol';
import { loadPlugins } from './plugins.js';
import { createToolRegistry } from './registry.js';

const zodUrl = pathToFileURL(createRequire(import.meta.url).resolve('zod')).href;

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`), error: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`), child: () => logger };
  return { logger, lines };
}

const toolSrc = (name: string, risk: string, permission: string) => `{
    name: '${name}', title: '${name}', description: 'The ${name} tool.',
    inputSchema: z.object({ city: z.string() }), risk: '${risk}', defaultPermission: '${permission}',
    async execute({ city }) { return { output: { city } }; },
  }`;

const dirs: string[] = [];
async function tempDir(prefix = 'neo-plugins-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('loadPlugins', () => {
  it('loads only .mjs/.js files, sorted, and applies the plugin permission policy', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'b-weather.mjs'), `import { z } from '${zodUrl}';
export default { name: 'weather', version: '1.0.0', tools: [${toolSrc('get_weather', 'external', 'auto')}, ${toolSrc('weather_units', 'read', 'auto')}] };`);
    await writeFile(join(dir, 'a-other.js'), `import { z } from '${zodUrl}';
export default { name: 'other', tools: [${toolSrc('other_tool', 'write', 'auto')}] };`);
    await writeFile(join(dir, 'ignored.ts'), `export default { name: 'ts', tools: [] };`);
    await writeFile(join(dir, 'ignored.cjs'), `module.exports = { name: 'cjs', tools: [] };`);
    await writeFile(join(dir, 'notes.json'), `{}`);
    await mkdir(join(dir, 'folder.js'));

    const plugins = await loadPlugins(dir);
    expect(plugins.map((p) => p.name)).toEqual(['other', 'weather']);
    const tools = plugins.flatMap((p) => p.tools ?? []);
    expect(Object.fromEntries(tools.map((t) => [t.name, t.defaultPermission]))).toEqual({
      other_tool: 'confirm',
      get_weather: 'confirm',
      weather_units: 'auto',
    });
    const res = await tools.find((t) => t.name === 'get_weather')!.execute({ city: 'Oslo' }, {} as never);
    expect(res.output).toEqual({ city: 'Oslo' });
  });

  it('skips invalid plugins and invalid tools with a log, keeping the valid tools', async () => {
    const dir = await tempDir();
    const { logger, lines } = recordingLogger();
    await writeFile(join(dir, 'not-a-plugin.mjs'), 'export default { notAPlugin: true };');
    await writeFile(join(dir, 'syntax.mjs'), 'this is not valid JS!!!');
    await writeFile(join(dir, 'mixed.mjs'), `import { z } from '${zodUrl}';
export default { name: 'mixed', tools: [
  ${toolSrc('good_tool', 'read', 'auto')},
  { name: 'no_execute', title: 't', description: 'd', inputSchema: z.object({}), risk: 'read', defaultPermission: 'auto' },
  { name: 'Bad-Name', title: 't', description: 'd', inputSchema: z.object({}), risk: 'read', defaultPermission: 'auto', execute: async () => ({ output: 1 }) },
  { name: 'no_schema', title: 't', description: 'd', risk: 'read', defaultPermission: 'auto', execute: async () => ({ output: 1 }) },
  { name: 'bad_risk', title: 't', description: 'd', inputSchema: z.object({}), risk: 'nuclear', defaultPermission: 'auto', execute: async () => ({ output: 1 }) },
] };`);
    const plugins = await loadPlugins(dir, logger);
    expect(plugins.map((p) => p.name)).toEqual(['mixed']);
    expect(plugins[0]!.tools!.map((t) => t.name)).toEqual(['good_tool']);
    const log = lines.join('\n');
    for (const name of ['not-a-plugin.mjs', 'syntax.mjs', 'no_execute', 'Bad-Name', 'no_schema', 'bad_risk']) expect(log).toContain(name);
  });

  it('accepts zod-like schemas (zod 3, hand-written) and still validates with them', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'duck.mjs'), `export default { name: 'duck', tools: [{
      name: 'duck_tool', title: 'Duck', description: 'A tool with a hand-written validator.', risk: 'read', defaultPermission: 'auto',
      inputSchema: { safeParse: (x) => typeof x?.n === 'number' ? { success: true, data: { n: x.n * 2 } } : { success: false, error: { issues: [{ path: ['n'], message: 'n must be a number' }] } } },
      execute: async (input) => ({ output: input }),
    }] };`);
    const [plugin] = await loadPlugins(dir);
    const reg = createToolRegistry();
    for (const tool of plugin!.tools ?? []) reg.register(tool, 'plugin');
    expect(reg.specs()[0]).toMatchObject({ name: 'duck_tool', inputSchema: { type: 'object' } });
    const ctx = { toolCallId: 't', signal: new AbortController().signal, now: () => 0, timezone: 'UTC', locale: 'en', allowSensitive: false, origin: 'model' as const, logger: silentLogger };
    expect((await reg.execute({ id: '1', name: 'duck_tool', input: { n: 2 } }, ctx)).output).toEqual({ n: 4 });
    const bad = await reg.execute({ id: '1', name: 'duck_tool', input: { n: 'x' } }, ctx);
    expect(bad.isError).toBe(true);
    expect(String((bad.output as { error: string }).error)).toMatch(/n must be a number/);
  });

  it('skips a tool name that another plugin already provides', async () => {
    const dir = await tempDir();
    const { logger, lines } = recordingLogger();
    await writeFile(join(dir, 'a.mjs'), `import { z } from '${zodUrl}';\nexport default { name: 'a', tools: [${toolSrc('shared_tool', 'read', 'auto')}] };`);
    await writeFile(join(dir, 'b.mjs'), `import { z } from '${zodUrl}';\nexport default { name: 'b', tools: [${toolSrc('shared_tool', 'read', 'auto')}] };`);
    const plugins = await loadPlugins(dir, logger);
    expect(plugins.map((p) => p.tools?.length)).toEqual([1, 0]);
    expect(lines.join('\n')).toContain('shared_tool');
  });

  it('works when the plugin directory path contains URL-special characters', async () => {
    // In plain Node a raw path passed to import() is parsed as a URL ("%41" decodes to "A", "#" starts
    // a fragment), so loading must go through pathToFileURL. Vitest's module runner resolves raw paths
    // itself (and can't import "#" paths at all), so this is a regression check, not a reproduction.
    const dir = await tempDir('neo plugins %41-');
    await writeFile(join(dir, 'p.mjs'), `export default { name: 'special', tools: [] };`);
    expect((await loadPlugins(dir)).map((p) => p.name)).toEqual(['special']);
  });

  it('a missing directory yields no plugins', async () => {
    expect(await loadPlugins(join(tmpdir(), 'neo-definitely-missing-dir-1234'))).toEqual([]);
  });
});
