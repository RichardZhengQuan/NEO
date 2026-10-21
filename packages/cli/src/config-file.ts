/**
 * Config file reading and writing for `neo init`.
 * Injectable prompt functions so the logic can be unit-tested without stdin.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NeoError, PROVIDER_PRESETS, type ProviderKind, type NeoConfig } from '@neo/protocol';
import { parsePort } from './args.js';

export type PromptFn = (question: string, options?: { secret?: boolean; choices?: string[] }) => Promise<string>;

export interface InitAnswers {
  providerKind: Exclude<ProviderKind, 'mock'> | null;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  mode: 'local' | 'server';
  host: string;
  port: number;
}

/** Expand `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Resolve the effective data directory (flag → env → default ~/.neo). */
export function resolveDataDir(dataDirFlag?: string): string {
  return expandHome(dataDirFlag ?? process.env['NEO_DATA_DIR'] ?? '~/.neo');
}

/** Resolve the token file path inside a data directory. */
export function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'token');
}

/** Read the owner token from the data directory, returning null if absent. */
export function readToken(dataDir: string): string | null {
  try {
    return fs.readFileSync(tokenPath(dataDir), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Read and parse the config file, returning null on any error. */
export function readConfigFile(filePath: string): Partial<NeoConfig> | null {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text) as Partial<NeoConfig>;
  } catch {
    return null;
  }
}

/**
 * Run the interactive init wizard with injected prompt functions.
 * Returns the answers gathered from the user.
 */
export async function runInitWizard(prompt: PromptFn): Promise<InitAnswers> {
  // 1. Provider preset
  const presetKeys = Object.keys(PROVIDER_PRESETS) as Exclude<ProviderKind, 'mock' | 'chatgpt'>[];
  const presetList = presetKeys
    .map((k, i) => {
      const p = PROVIDER_PRESETS[k];
      return `  ${i + 1}. ${p.label} — ${p.description}`;
    })
    .join('\n');

  const choiceStr = await prompt(
    `\nChoose your AI provider:\n${presetList}\n  0. Skip for now\n\nEnter number [0]`,
    { choices: ['0', ...presetKeys.map((_, i) => String(i + 1))] },
  );
  const choice = choiceStr.trim() || '0';
  const idx = Number(choice) - 1;
  const providerKind = choice === '0' ? null : presetKeys[idx];
  if (!/^\d+$/.test(choice) || providerKind === undefined) {
    throw new NeoError('bad_request', 'Choose a provider number or 0 to skip for now.');
  }
  const preset = providerKind === null ? null : PROVIDER_PRESETS[providerKind];

  // 2. API key (hidden for keyed providers)
  let apiKey = '';
  if (preset?.needsKey) {
    const keyUrl = preset.keyUrl ? ` (get one at ${preset.keyUrl})` : '';
    apiKey = await prompt(`\n${preset.label} API key${keyUrl}`, { secret: true });
  }

  // 3. Base URL (for openai-compatible / ollama)
  let baseUrl = preset?.baseUrl ?? '';
  if (providerKind === 'openai-compatible' || providerKind === 'ollama') {
    const defaultUrl = preset?.baseUrl ?? '';
    const entered = await prompt(`\nBase URL [${defaultUrl}]`);
    baseUrl = entered.trim() || defaultUrl;
  }

  // 4. Default model
  const suggestedDefault = preset?.defaultModel ?? preset?.suggestedModels[0] ?? '';
  const modelInput = preset ? await prompt(`\nDefault model [${suggestedDefault}]`) : '';
  const defaultModel = modelInput.trim() || suggestedDefault;

  // 5. Mode
  const modeInput = await prompt(`\nMode — local (on this machine) or server (remote, requires TLS)? [local]`, {
    choices: ['local', 'server', ''],
  });
  const mode: 'local' | 'server' = modeInput.trim() === 'server' ? 'server' : 'local';

  // 6. Host / port (only in server mode)
  let host = '127.0.0.1';
  let port = 7777;
  if (mode === 'server') {
    const hostInput = await prompt(`\nBind host [0.0.0.0]`);
    host = hostInput.trim() || '0.0.0.0';
    const portInput = await prompt(`\nPort [7777]`);
    const parsedPort = parsePort(portInput.trim() || '7777');
    if (typeof parsedPort !== 'number') {
      throw new NeoError('bad_request', parsedPort.error);
    }
    port = parsedPort;
  }

  return { providerKind, apiKey, baseUrl, defaultModel, mode, host, port };
}

/**
 * Write the config file for `neo init`.
 * Merges with any existing config and sets mode 0600.
 */
export function writeInitConfig(dataDir: string, answers: InitAnswers, configPath?: string): void {
  const resolvedDir = expandHome(dataDir);
  fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolvedDir, 0o700);

  const cfgPath = configPath ?? path.join(resolvedDir, 'config.json');

  // Load existing config to merge
  const existing = readConfigFile(cfgPath) ?? {};

  const providerConfig: Record<string, unknown> = {
    id: answers.providerKind,
    kind: answers.providerKind,
    enabled: true,
  };
  if (answers.apiKey) providerConfig['apiKey'] = answers.apiKey;
  if (answers.baseUrl) providerConfig['baseUrl'] = answers.baseUrl;
  if (answers.defaultModel) providerConfig['defaultModel'] = answers.defaultModel;

  const config: Record<string, unknown> = {
    ...existing,
    mode: answers.mode,
    dataDir: resolvedDir,
    providers: answers.providerKind === null ? [] : [providerConfig],
    settings: {
      ...((existing as Record<string, unknown>)['settings'] as Record<string, unknown> | undefined ?? {}),
      defaultModel: answers.providerKind === null ? null : { provider: answers.providerKind, model: answers.defaultModel },
    },
  };

  if (answers.mode === 'server') {
    config['server'] = {
      ...((existing as Record<string, unknown>)['server'] as Record<string, unknown> | undefined ?? {}),
      host: answers.host,
      port: answers.port,
    };
  } else {
    config['server'] = {
      ...((existing as Record<string, unknown>)['server'] as Record<string, unknown> | undefined ?? {}),
      host: '127.0.0.1',
      port: 7777,
    };
  }

  const json = JSON.stringify(config, null, 2);
  // Write to a temp file at 0o600 then rename atomically so the secret is
  // never visible at a permissive mode — even briefly.  A plain writeFileSync
  // + chmodSync leaves two windows: (1) an open fd held before our write
  // retains access after the chmod, and (2) a crash between the two calls
  // leaves the file at the world-readable mode.  renameSync is atomic on
  // POSIX: the target either has the old content or the new 0o600 content.
  const tmpPath = path.join(path.dirname(cfgPath), `.neo-config-tmp-${crypto.randomBytes(8).toString('hex')}`);
  let tmpFd: number | null = null;
  let tmpCreated = false;
  try {
    tmpFd = fs.openSync(tmpPath, 'wx', 0o600);
    tmpCreated = true;
    fs.writeSync(tmpFd, json, 0, 'utf8');
    fs.closeSync(tmpFd);
    tmpFd = null;
    fs.renameSync(tmpPath, cfgPath);
  } catch (err) {
    if (tmpFd !== null) {
      try { fs.closeSync(tmpFd); } catch { /* ignore */ }
    }
    if (tmpCreated) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
    }
    throw err;
  }
}
