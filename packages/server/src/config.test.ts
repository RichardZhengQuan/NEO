/**
 * loadConfig precedence tests: defaults < file < env < overrides.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from './config.js';

let tempDir = '';

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'neo-cfg-test-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    tempDir = '';
  }
});

describe('loadConfig', () => {
  it('returns valid defaults with no input', () => {
    const cfg = loadConfig({ env: {} });
    expect(cfg.mode).toBe('local');
    expect(cfg.server.port).toBe(7777);
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.providers).toEqual([]);
    expect(cfg.dataDir).toBe(join(homedir(), '.neo'));
  });

  it('drops the old default demo and clears its initial model references on load', () => {
    const dir = makeTempDir();
    const path = join(dir, 'config.json');
    const ref = { provider: 'demo', model: 'neo-demo' };
    writeFileSync(path, JSON.stringify({
      providers: [{ id: 'demo', kind: 'mock', enabled: true, defaultModel: 'neo-demo' }],
      settings: { defaultModel: ref, memoryModel: ref, titleModel: ref, embedding: ref },
    }));
    const config = loadConfig({ path, env: {} });
    expect(config.providers).toEqual([]);
    expect(config.settings).toMatchObject({ defaultModel: null, memoryModel: null, titleModel: null, embedding: null });
  });

  it('preserves a real provider that happens to be named demo', () => {
    const ref = { provider: 'demo', model: 'real-model' };
    const config = loadConfig({ env: {}, overrides: {
      providers: [{ id: 'demo', kind: 'ollama', enabled: true, defaultModel: 'real-model' }],
      settings: { defaultModel: ref, memoryModel: ref },
    } });
    expect(config.providers[0]).toMatchObject({ id: 'demo', kind: 'ollama' });
    expect(config.settings).toMatchObject({ defaultModel: ref, memoryModel: ref });
  });

  it('keeps a real model choice when a legacy demo entry shares its id', () => {
    const ref = { provider: 'demo', model: 'real-model' };
    const config = loadConfig({ env: {}, overrides: {
      providers: [{ id: 'demo', kind: 'mock', enabled: true }, { id: 'demo', kind: 'ollama', enabled: true, defaultModel: 'real-model' }],
      settings: { defaultModel: ref },
    } });
    expect(config.providers).toHaveLength(1);
    expect(config.settings?.defaultModel).toEqual(ref);
  });

  it('reads a config file', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'config.json');
    writeFileSync(filePath, JSON.stringify({ server: { port: 9999 } }));
    const cfg = loadConfig({ path: filePath, env: {} });
    expect(cfg.server.port).toBe(9999);
  });

  it('env vars override config file', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'config.json');
    writeFileSync(filePath, JSON.stringify({ server: { port: 9999, host: '1.2.3.4' } }));
    const cfg = loadConfig({
      path: filePath,
      env: { NEO_PORT: '8888' },
    });
    expect(cfg.server.port).toBe(8888);
    expect(cfg.server.host).toBe('1.2.3.4'); // from file, not overridden
  });

  it('overrides take highest precedence', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'config.json');
    writeFileSync(filePath, JSON.stringify({ server: { port: 9999 } }));
    const cfg = loadConfig({
      path: filePath,
      env: { NEO_PORT: '8888' },
      overrides: { server: { port: 1234 } },
    });
    expect(cfg.server.port).toBe(1234);
  });

  it('reads NEO_MODE, NEO_DATA_DIR, NEO_HOST, NEO_TOKEN from env', () => {
    const dir = makeTempDir();
    const cfg = loadConfig({
      env: {
        NEO_MODE: 'server',
        NEO_DATA_DIR: dir,
        NEO_HOST: '0.0.0.0',
        NEO_TOKEN: 'my-secret-token-1234',
      },
    });
    expect(cfg.mode).toBe('server');
    expect(cfg.dataDir).toBe(dir);
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.server.authToken).toBe('my-secret-token-1234');
  });

  it('ANTHROPIC_API_KEY creates an anthropic provider', () => {
    const cfg = loadConfig({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    const anthropic = cfg.providers.find((p) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic?.apiKey).toBe('sk-ant-test');
  });

  it('OPENAI_API_KEY creates an openai provider', () => {
    const cfg = loadConfig({
      env: { OPENAI_API_KEY: 'sk-openai-test' },
    });
    const openai = cfg.providers.find((p) => p.id === 'openai');
    expect(openai).toBeDefined();
    expect(openai?.apiKey).toBe('sk-openai-test');
  });

  it('GEMINI_API_KEY creates a gemini provider', () => {
    const cfg = loadConfig({
      env: { GEMINI_API_KEY: 'AIza-test' },
    });
    const gemini = cfg.providers.find((p) => p.id === 'gemini');
    expect(gemini).toBeDefined();
  });

  it('OLLAMA_BASE_URL creates an ollama provider', () => {
    const cfg = loadConfig({
      env: { OLLAMA_BASE_URL: 'http://localhost:11434' },
    });
    const ollama = cfg.providers.find((p) => p.id === 'ollama');
    expect(ollama).toBeDefined();
  });

  it('expands ~ in dataDir', () => {
    const cfg = loadConfig({
      env: { NEO_DATA_DIR: '~/.neo' },
    });
    expect(cfg.dataDir).toBe(homedir() + '/.neo');
    expect(cfg.dataDir).not.toContain('~');
  });

  it('expands ~ in webDir via overrides', () => {
    const cfg = loadConfig({
      env: {},
      overrides: { server: { webDir: '~/public' } },
    });
    expect(cfg.server.webDir).toBe(homedir() + '/public');
  });

  it('respects NEO_CONFIG env var as file path', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'myconfig.json');
    writeFileSync(filePath, JSON.stringify({ server: { port: 5555 } }));
    const cfg = loadConfig({ env: { NEO_CONFIG: filePath } });
    expect(cfg.server.port).toBe(5555);
  });

  it('file < env precedence: env port beats file port', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'config.json');
    writeFileSync(filePath, JSON.stringify({ server: { port: 3000 } }));
    const cfg = loadConfig({ path: filePath, env: { NEO_PORT: '4000' } });
    expect(cfg.server.port).toBe(4000);
  });

  it('multiple env providers coexist', () => {
    const cfg = loadConfig({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENAI_API_KEY: 'sk-oai',
      },
    });
    expect(cfg.providers.find((p) => p.id === 'anthropic')).toBeDefined();
    expect(cfg.providers.find((p) => p.id === 'openai')).toBeDefined();
  });

  it('finds the default config under an overridden data directory', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ server: { port: 2020 } }));
    expect(loadConfig({ env: {}, overrides: { dataDir: dir } }).server.port).toBe(2020);
  });

  it('adds usable model defaults to environment-created providers', () => {
    const cfg = loadConfig({ env: { OPENAI_API_KEY: 'test', OLLAMA_BASE_URL: 'http://localhost:11434' } });
    expect(cfg.providers.find(p => p.id === 'openai')?.defaultModel).toBeTruthy();
    expect(cfg.providers.find(p => p.id === 'ollama')?.defaultModel).toBeTruthy();
  });

  it('preserves a config-file model when environment replaces its key', () => {
    const dir = makeTempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ providers: [{ id: 'openai', kind: 'openai', defaultModel: 'custom-model' }] }));
    const cfg = loadConfig({ path, env: { OPENAI_API_KEY: 'new-key' } });
    expect(cfg.providers[0]).toMatchObject({ defaultModel: 'custom-model', apiKey: 'new-key' });
  });

  it('expands plugin paths and normalizes configuration errors to NeoError', () => {
    expect(loadConfig({ env: {}, overrides: { plugins: { dir: '~/plugins' } } }).plugins.dir).toBe(join(homedir(), 'plugins'));
    const dir = makeTempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, '{invalid json');
    expect(() => loadConfig({ path, env: {} })).toThrowError(expect.objectContaining({ name: 'NeoError', code: 'config_error' }));
    expect(() => loadConfig({ env: { NEO_PORT: '-1' } })).toThrowError(expect.objectContaining({ name: 'NeoError', code: 'bad_request' }));
  });
});
