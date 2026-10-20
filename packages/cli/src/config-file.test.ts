/**
 * Config-file tests: writeInitConfig, resolveDataDir, readToken, runInitWizard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  expandHome,
  resolveDataDir,
  tokenPath,
  readToken,
  writeInitConfig,
  runInitWizard,
} from './config-file.js';
import type { InitAnswers, PromptFn } from './config-file.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neo-cli-test-'));
}

// ── expandHome ───────────────────────────────────────────────────────────────

describe('expandHome', () => {
  it('expands leading ~/', () => {
    const result = expandHome('~/.neo');
    expect(result).toBe(path.join(os.homedir(), '.neo'));
  });

  it('expands bare ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });

  it('leaves absolute paths alone', () => {
    expect(expandHome('/var/lib/neo')).toBe('/var/lib/neo');
  });

  it('leaves relative paths alone', () => {
    expect(expandHome('some/relative')).toBe('some/relative');
  });
});

// ── resolveDataDir ───────────────────────────────────────────────────────────

describe('resolveDataDir', () => {
  const origEnv = process.env['NEO_DATA_DIR'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NEO_DATA_DIR'];
    } else {
      process.env['NEO_DATA_DIR'] = origEnv;
    }
  });

  it('uses the flag when provided', () => {
    delete process.env['NEO_DATA_DIR'];
    expect(resolveDataDir('/custom/dir')).toBe('/custom/dir');
  });

  it('falls back to NEO_DATA_DIR env', () => {
    process.env['NEO_DATA_DIR'] = '/env/dir';
    expect(resolveDataDir()).toBe('/env/dir');
  });

  it('defaults to ~/.neo when neither flag nor env is set', () => {
    delete process.env['NEO_DATA_DIR'];
    expect(resolveDataDir()).toBe(path.join(os.homedir(), '.neo'));
  });

  it('flag beats env', () => {
    process.env['NEO_DATA_DIR'] = '/env/dir';
    expect(resolveDataDir('/flag/dir')).toBe('/flag/dir');
  });
});

// ── readToken ────────────────────────────────────────────────────────────────

describe('readToken', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when token file does not exist', () => {
    expect(readToken(tmpDir)).toBeNull();
  });

  it('returns the trimmed token when file exists', () => {
    fs.writeFileSync(tokenPath(tmpDir), '  abc123  \n');
    expect(readToken(tmpDir)).toBe('abc123');
  });

  it('returns null for empty token file', () => {
    fs.writeFileSync(tokenPath(tmpDir), '   \n');
    expect(readToken(tmpDir)).toBeNull();
  });
});

// ── writeInitConfig ──────────────────────────────────────────────────────────

describe('writeInitConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseAnswers: InitAnswers = {
    providerKind: 'anthropic',
    apiKey: 'sk-test-key',
    baseUrl: '',
    defaultModel: 'claude-3-5-haiku-latest',
    mode: 'local',
    host: '127.0.0.1',
    port: 7777,
  };

  it('creates config.json in the data directory', () => {
    writeInitConfig(tmpDir, baseAnswers);
    const cfgPath = path.join(tmpDir, 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
  });

  it('writeInitConfig does not follow a symlink at the old predictable tmp path', () => {
    if (process.platform === 'win32') return;
    const sentinelPath = path.join(tmpDir, 'sentinel.txt');
    const sentinelContent = 'sentinel-content';
    fs.writeFileSync(sentinelPath, sentinelContent, { mode: 0o644 });
    const symlinkPath = path.join(tmpDir, `.neo-config-tmp-${process.pid}`);
    fs.symlinkSync(sentinelPath, symlinkPath);

    writeInitConfig(tmpDir, baseAnswers);

    expect(fs.readFileSync(sentinelPath, 'utf8')).toBe(sentinelContent);
  });

  it('config.json contains expected fields', () => {
    writeInitConfig(tmpDir, baseAnswers);
    const cfgPath = path.join(tmpDir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(cfg['mode']).toBe('local');
    expect(cfg['dataDir']).toBe(tmpDir);
    const providers = cfg['providers'] as { kind: string; apiKey: string }[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.kind).toBe('anthropic');
    expect(providers[0]?.apiKey).toBe('sk-test-key');
  });

  it('settings.defaultModel uses provider and model', () => {
    writeInitConfig(tmpDir, baseAnswers);
    const cfgPath = path.join(tmpDir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const settings = cfg['settings'] as { defaultModel: { provider: string; model: string } };
    expect(settings.defaultModel.provider).toBe('anthropic');
    expect(settings.defaultModel.model).toBe('claude-3-5-haiku-latest');
  });

  it('server mode adds server.host and server.port', () => {
    const serverAnswers: InitAnswers = { ...baseAnswers, mode: 'server', host: '0.0.0.0', port: 9000 };
    writeInitConfig(tmpDir, serverAnswers);
    const cfgPath = path.join(tmpDir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(cfg['mode']).toBe('server');
    const server = cfg['server'] as { host: string; port: number };
    expect(server.host).toBe('0.0.0.0');
    expect(server.port).toBe(9000);
  });

  it('merges with existing config when file already exists', () => {
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ customField: 'preserved', mode: 'local' }));
    writeInitConfig(tmpDir, baseAnswers);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(cfg['customField']).toBe('preserved');
  });

  it('writeInitConfig forces mode 0o600 on an existing config file', () => {
    if (process.platform === 'win32') return;
    fs.chmodSync(tmpDir, 0o755);
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, '{}', { mode: 0o644 });
    fs.chmodSync(cfgPath, 0o644);
    writeInitConfig(tmpDir, baseAnswers);
    // This test must fail before the fix
    expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o600);
  });

  it('writeInitConfig forces mode 0o700 on an existing data directory', () => {
    if (process.platform === 'win32') return;
    fs.chmodSync(tmpDir, 0o755);
    const dataDir = path.join(tmpDir, 'data');
    const resolvedDataDir = expandHome(dataDir);
    fs.mkdirSync(resolvedDataDir, { mode: 0o755 });
    fs.chmodSync(resolvedDataDir, 0o755);
    writeInitConfig(dataDir, baseAnswers);
    // This test must fail before the fix
    expect(fs.statSync(resolvedDataDir).mode & 0o777).toBe(0o700);
  });

  it('writes to custom configPath when provided', () => {
    const customPath = path.join(tmpDir, 'custom-config.json');
    writeInitConfig(tmpDir, baseAnswers, customPath);
    expect(fs.existsSync(customPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(customPath, 'utf8')) as Record<string, unknown>;
    expect(cfg['mode']).toBe('local');
  });

  it('creates data directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested');
    writeInitConfig(nestedDir, baseAnswers);
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it('writes no providers or default model when AI setup is skipped', () => {
    writeInitConfig(tmpDir, { ...baseAnswers, providerKind: null, apiKey: '', defaultModel: '' });
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    expect(cfg.providers).toEqual([]);
    expect(cfg.settings.defaultModel).toBeNull();
  });
});

// ── runInitWizard ────────────────────────────────────────────────────────────

describe('runInitWizard', () => {
  it('allows skipping AI setup without offering a mock provider', async () => {
    const questions: string[] = [];
    const responses = ['0', 'local'];
    const answers = await runInitWizard(async question => {
      questions.push(question);
      return responses.shift() ?? '';
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain('Skip for now');
    expect(questions.join('\n')).not.toMatch(/demo|mock/i);
    expect(answers).toMatchObject({ providerKind: null, apiKey: '', defaultModel: '', mode: 'local' });
  });

  it('rejects an invalid choice instead of configuring a mock provider', async () => {
    await expect(runInitWizard(async () => '999')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('returns expected answers with anthropic preset', async () => {
    // PROVIDER_PRESETS keys: anthropic is index 0 typically, but we probe with "1"
    // We create a deterministic prompt mock based on what questions are asked
    const promptHistory: string[] = [];
    const responses = ['1', 'sk-ant-test', '', 'local'];
    let callIndex = 0;

    const mockPrompt: PromptFn = async (question) => {
      promptHistory.push(question);
      return responses[callIndex++] ?? '';
    };

    const answers = await runInitWizard(mockPrompt);
    // Should get the first preset's kind
    expect(answers.apiKey).toBe('sk-ant-test');
    expect(answers.mode).toBe('local');
    expect(answers.defaultModel).toBe('claude-sonnet-5-5');
  });

  it('server mode returns host and port', async () => {
    // anthropic has needsKey=true, no baseUrl prompt → 6 questions
    const responses = ['1', 'sk-ant-test', 'claude-opus-5-5', 'server', '0.0.0.0', '9000'];
    let callIndex = 0;

    const mockPrompt: PromptFn = async () => {
      return responses[callIndex++] ?? '';
    };

    const answers = await runInitWizard(mockPrompt);
    expect(answers.mode).toBe('server');
    expect(answers.host).toBe('0.0.0.0');
    expect(answers.port).toBe(9000);
  });

  it('throws on non-numeric port in server mode', async () => {
    const responses = ['0', 'server', '', 'abc'];
    await expect(runInitWizard(async () => responses.shift() ?? '')).rejects.toMatchObject({
      code: 'bad_request', message: 'Invalid port: abc',
    });
  });

  it('throws on out-of-range port in server mode', async () => {
    const responses = ['0', 'server', '', '99999'];
    await expect(runInitWizard(async () => responses.shift() ?? '')).rejects.toMatchObject({
      code: 'bad_request', message: 'Invalid port: 99999',
    });
  });

  it.each(['7777junk', '1e4', '-1', '65536', '8080.5', '+8080', '0x1f90', '8080 90'])(
    'throws on invalid decimal port %j in server mode', async (input) => {
      const responses = ['0', 'server', '', input];
      await expect(runInitWizard(async () => responses.shift() ?? '')).rejects.toMatchObject({
        code: 'bad_request', message: `Invalid port: ${input}`,
      });
    },
  );

  it('never writes port: null to config', async () => {
    const tmpDir = makeTempDir();
    try {
      const responses = ['0', 'server', '', 'abc'];
      const init = async () => {
        const answers = await runInitWizard(async () => responses.shift() ?? '');
        writeInitConfig(tmpDir, answers);
      };
      await expect(init()).rejects.toMatchObject({ code: 'bad_request' });
      expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([['0', 0], ['65535', 65535], [' 8080 ', 8080], ['008080', 8080]] as const)(
    'accepts decimal port %j in server mode', async (input, port) => {
      const responses = ['0', 'server', '', input];
      const answers = await runInitWizard(async () => responses.shift() ?? '');
      expect(answers.port).toBe(port);
    },
  );

  it.each(['', '   '])('uses the default port for blank input %j in server mode', async (input) => {
    const responses = ['0', 'server', '', input];
    const answers = await runInitWizard(async () => responses.shift() ?? '');
    expect(answers.port).toBe(7777);
  });

  it('uses default model when empty string entered', async () => {
    const responses = ['1', 'sk-ant-test', '', '', 'local'];
    let callIndex = 0;

    const mockPrompt: PromptFn = async () => {
      return responses[callIndex++] ?? '';
    };

    const answers = await runInitWizard(mockPrompt);
    // default model should be non-empty (from preset)
    expect(typeof answers.defaultModel).toBe('string');
  });
});
