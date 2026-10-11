/**
 * loadConfig — precedence: defaults < config file < env vars < overrides.
 * `~` in dataDir/webDir is expanded to the home directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEMO_PROVIDER, NeoConfigSchema, NeoError, PROVIDER_PRESETS, deepMerge, isLanAddress, type NeoConfig } from '@neo/protocol';
import type { LoadConfigOptions } from './index.js';
import { validatePushAllowedHosts } from './push-policy.js';

/** Additive server-only configuration, without changing the protocol config contract. */
export type NeoConfigWithPushHosts = NeoConfig & { push: NeoConfig['push'] & { allowedHosts?: string[] } };

export function expandTilde(path: string): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    return homedir() + path.slice(1);
  }
  return path;
}

/** Build an env-derived provider entry and merge into the providers array (by id). */
function upsertEnvProvider(providers: Record<string, unknown>[], id: string, patch: Record<string, unknown>): void {
  const idx = providers.findIndex((p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['id'] === id);
  if (idx >= 0) {
    const current = providers[idx]!;
    providers[idx] = deepMerge(current, {
      ...patch,
      ...(typeof current['defaultModel'] === 'string' ? { defaultModel: current['defaultModel'] } : {}),
    });
  } else {
    providers.push({ id, enabled: true, ...patch });
  }
}

export function loadConfig(options: LoadConfigOptions = {}): NeoConfig {
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  // 1. Schema defaults (all prefault({}) values applied by NeoConfigSchema.parse({}))
  let raw: Record<string, unknown> = {};

  // 2. Config file
  let filePath = options.path ?? env['NEO_CONFIG'];
  if (!filePath) {
    // Try default location relative to dataDir (resolved later), but we don't know dataDir yet.
    // Use a temporary dataDir from env to locate the file.
    const tentativeDataDir = expandTilde(options.overrides?.dataDir ?? env['NEO_DATA_DIR'] ?? '~/.neo');
    const candidate = join(tentativeDataDir, 'config.json');
    if (existsSync(candidate)) filePath = candidate;
  }
  if (filePath) {
    try {
      const text = readFileSync(expandTilde(filePath), 'utf8');
      raw = deepMerge(raw, JSON.parse(text) as Record<string, unknown>);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw NeoError.from(err, 'config_error');
      // file not found — ignore
    }
  }

  // 3. Env vars
  const envPatch: Record<string, unknown> = {};
  if (env['NEO_MODE']) envPatch['mode'] = env['NEO_MODE'];
  if (env['NEO_DATA_DIR']) envPatch['dataDir'] = env['NEO_DATA_DIR'];

  const serverPatch: Record<string, unknown> = {};
  if (env['NEO_HOST']) serverPatch['host'] = env['NEO_HOST'];
  if (env['NEO_PORT']) serverPatch['port'] = Number(env['NEO_PORT']);
  if (env['NEO_TOKEN']) serverPatch['authToken'] = env['NEO_TOKEN'];
  if (env['NEO_PUBLIC_URL']) serverPatch['publicUrl'] = env['NEO_PUBLIC_URL'];
  if (env['NEO_WEB_DIR']) serverPatch['webDir'] = env['NEO_WEB_DIR'];
  if (env['NEO_TRUST_PROXY'] !== undefined) {
    const value = env['NEO_TRUST_PROXY'].trim().toLowerCase();
    if (!['true', 'false', '1', '0'].includes(value)) throw new NeoError('config_error', 'NEO_TRUST_PROXY must be true or false');
    serverPatch['trustProxy'] = value === 'true' || value === '1';
  }
  if (Object.keys(serverPatch).length) envPatch['server'] = serverPatch;

  const tunnelPatch: Record<string, unknown> = {};
  if (env['NEO_TUNNEL_LAN'] !== undefined) {
    const value = env['NEO_TUNNEL_LAN'].trim().toLowerCase();
    if (!['true', 'false', '1', '0'].includes(value)) throw new NeoError('config_error', 'NEO_TUNNEL_LAN must be true or false');
    tunnelPatch['lan'] = value === 'true' || value === '1';
  }
  if (env['NEO_TUNNEL_HOST']) tunnelPatch['host'] = env['NEO_TUNNEL_HOST'];
  if (env['NEO_TUNNEL_PORT'] !== undefined) tunnelPatch['port'] = Number(env['NEO_TUNNEL_PORT']);
  if (env['NEO_TUNNEL_ADVERTISE'] !== undefined) {
    const addresses = env['NEO_TUNNEL_ADVERTISE'].split(',').map((address) => address.trim()).filter(Boolean);
    if (!addresses.every(isLanAddress)) throw new NeoError('config_error', 'NEO_TUNNEL_ADVERTISE must contain host:port addresses');
    tunnelPatch['advertise'] = addresses;
  }
  if (env['NEO_RELAY_URL'] !== undefined) tunnelPatch['relayUrl'] = env['NEO_RELAY_URL'];
  if (Object.keys(tunnelPatch).length) envPatch['tunnel'] = tunnelPatch;

  if (env['NEO_LOG_LEVEL']) envPatch['log'] = { level: env['NEO_LOG_LEVEL'] };

  // Merge env patch into raw
  raw = deepMerge(raw, envPatch);

  // Env-created providers: start from what raw has (or defaults)
  const rawProviders: Record<string, unknown>[] =
    Array.isArray((raw as Record<string, unknown>)['providers'])
      ? ([...(raw as Record<string, unknown[]>)['providers']!] as Record<string, unknown>[])
      : [{ ...DEMO_PROVIDER }];

  if (env['ANTHROPIC_API_KEY']) {
    upsertEnvProvider(rawProviders, 'anthropic', {
      kind: 'anthropic',
      label: 'Anthropic Claude',
      apiKey: env['ANTHROPIC_API_KEY'],
      defaultModel: PROVIDER_PRESETS.anthropic.defaultModel,
    });
  }
  if (env['OPENAI_API_KEY']) {
    upsertEnvProvider(rawProviders, 'openai', {
      kind: 'openai',
      label: 'OpenAI',
      apiKey: env['OPENAI_API_KEY'],
      defaultModel: PROVIDER_PRESETS.openai.defaultModel,
    });
  }
  if (env['GEMINI_API_KEY']) {
    upsertEnvProvider(rawProviders, 'gemini', {
      kind: 'gemini',
      label: 'Google Gemini',
      apiKey: env['GEMINI_API_KEY'],
      defaultModel: PROVIDER_PRESETS.gemini.defaultModel,
    });
  }
  if (env['OLLAMA_BASE_URL']) {
    upsertEnvProvider(rawProviders, 'ollama', {
      kind: 'ollama',
      label: 'Ollama',
      baseUrl: env['OLLAMA_BASE_URL'],
      defaultModel: PROVIDER_PRESETS.ollama.defaultModel,
    });
  }
  (raw as Record<string, unknown>)['providers'] = rawProviders;

  // 4. Overrides (highest precedence)
  if (options.overrides) {
    raw = deepMerge(raw, options.overrides as Record<string, unknown>);
  }

  // Expand ~ in string path fields
  if (typeof (raw as Record<string, unknown>)['dataDir'] === 'string') {
    (raw as Record<string, unknown>)['dataDir'] = expandTilde((raw as Record<string, unknown>)['dataDir'] as string);
  }
  const serverObj = (raw as Record<string, unknown>)['server'];
  if (typeof serverObj === 'object' && serverObj !== null && typeof (serverObj as Record<string, unknown>)['webDir'] === 'string') {
    (serverObj as Record<string, unknown>)['webDir'] = expandTilde((serverObj as Record<string, unknown>)['webDir'] as string);
  }

  try {
    const config: NeoConfigWithPushHosts = NeoConfigSchema.parse(raw);
    const push = raw['push'];
    if (typeof push === 'object' && push !== null && 'allowedHosts' in push) {
      config.push.allowedHosts = validatePushAllowedHosts(push.allowedHosts);
    }
    // Schema defaults are filled after the raw merge, so normalize paths last.
    config.dataDir = expandTilde(config.dataDir);
    if (config.server.webDir) config.server.webDir = expandTilde(config.server.webDir);
    if (config.plugins.dir) config.plugins.dir = expandTilde(config.plugins.dir);
    return config;
  } catch (err) {
    throw NeoError.from(err, 'config_error');
  }
}
