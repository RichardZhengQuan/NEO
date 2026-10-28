import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, mkdirSync, realpathSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { configureDisposableProfile } from './lib.js';
import { loadConfig } from '@neo/server';

const profiles: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const profile of profiles.splice(0)) rmSync(profile, { recursive: true, force: true });
});
function app() { return { setPath: vi.fn(), setAppLogsPath: vi.fn() }; }
function fresh() {
  const profile = realpathSync(mkdtempSync(path.join(tmpdir(), 'neo-private-profile-')));
  profiles.push(profile);
  return profile;
}

describe('configureDisposableProfile', () => {
  it('leaves normal startup paths untouched when not opted in', () => {
    const desktopApp = app();
    expect(configureDisposableProfile(desktopApp, undefined)).toBeUndefined();
    expect(desktopApp.setPath).not.toHaveBeenCalled();
    expect(desktopApp.setAppLogsPath).not.toHaveBeenCalled();
  });
  it.each(['', ' ', 'relative', '/', '/tmp/profile\0invalid'])('rejects explicit invalid path %j before applying paths', (value) => {
    const desktopApp = app();
    expect(() => configureDisposableProfile(desktopApp, value)).toThrow('absolute private profile');
    expect(desktopApp.setPath).not.toHaveBeenCalled();
  });
  it('creates private real directories and permits relaunch into that same profile', () => {
    const profile = fresh();
    const desktopApp = app();
    expect(configureDisposableProfile(desktopApp, profile)).toBe(profile);
    for (const child of ['', 'session', 'logs', 'crashes', 'data']) {
      expect(lstatSync(path.join(profile, child)).mode & 0o777).toBe(0o700);
    }
    expect(configureDisposableProfile(desktopApp, profile)).toBe(profile);
  });
  it('rejects a permissive existing directory without chmod or app-path effects', () => {
    const profile = fresh();
    chmodSync(profile, 0o755);
    const desktopApp = app();
    expect(() => configureDisposableProfile(desktopApp, profile)).toThrow('mode 0700');
    expect(lstatSync(profile).mode & 0o777).toBe(0o755);
    expect(desktopApp.setPath).not.toHaveBeenCalled();
  });
  it('rejects a symlink before applying app paths', () => {
    const parent = fresh();
    const target = fresh();
    const profile = path.join(parent, 'linked');
    symlinkSync(target, profile);
    const desktopApp = app();
    expect(() => configureDisposableProfile(desktopApp, profile)).toThrow('real directories');
    expect(desktopApp.setPath).not.toHaveBeenCalled();
  });
});


describe('disposable profile tree isolation', () => {
  it.each(['data', 'session', 'logs', 'crashes', 'startup-mode.json', 'reminder-catchup.json', 'data/neo.db', 'data/neo.db-wal', 'data/neo.db-shm', 'data/key', 'data/token', 'data/vapid.json', 'data/tunnel-identity.json'])('refuses linked persisted path %s before app effects', (entry) => {
    const root = fresh(); configureDisposableProfile(app(), root);
    const outside = fresh();
    mkdirSync(path.dirname(path.join(root, entry)), { recursive: true, mode: 0o700 });
    rmSync(path.join(root, entry), { recursive: true, force: true });
    symlinkSync(outside, path.join(root, entry));
    const desktopApp = app();
    expect(() => configureDisposableProfile(desktopApp, root)).toThrow(/unlinked/);
    expect(desktopApp.setPath).not.toHaveBeenCalled();
    expect(desktopApp.setAppLogsPath).not.toHaveBeenCalled();
  });
  it('refuses a linked ancestor without creating profile data outside', () => {
    const parent = fresh(); const outside = fresh();
    symlinkSync(outside, path.join(parent, 'linked'));
    expect(() => configureDisposableProfile(app(), path.join(parent, 'linked', 'profile'))).toThrow(/real directories/);
    expect(() => lstatSync(path.join(outside, 'profile'))).toThrow();
  });
  it('refuses hardlinked persisted files before app effects', () => {
    const root = fresh(); configureDisposableProfile(app(), root); const outside = fresh();
    writeFileSync(path.join(outside, 'state'), 'synthetic');
    linkSync(path.join(outside, 'state'), path.join(root, 'startup-mode.json'));
    const desktopApp = app();
    expect(() => configureDisposableProfile(desktopApp, root)).toThrow(/unlinked/);
    expect(desktopApp.setPath).not.toHaveBeenCalled();
  });
  it('accepts real persisted state on relaunch and canonicalizes system temporary aliases', () => {
    const root = fresh();
    configureDisposableProfile(app(), root);
    writeFileSync(path.join(root, 'startup-mode.json'), JSON.stringify('local'));
    writeFileSync(path.join(root, 'data', 'neo.db'), 'synthetic database');
    const alias = process.platform === 'darwin' ? root.replace(/^\/private\/var\//, '/var/').replace(/^\/private\/tmp\//, '/tmp/') : root;
    expect(configureDisposableProfile(app(), alias)).toBe(root);
  });
  it('keeps ambient and profile config out of explicit smoke configuration', () => {
    const root = fresh(); configureDisposableProfile(app(), root);
    const ambient = fresh(); const external = path.join(ambient, 'config.json');
    writeFileSync(external, JSON.stringify({ providers: [{ id:'synthetic',kind:'openai',apiKey:'synthetic-key' }], tunnel:{relayUrl:'wss://synthetic.invalid'} }));
    writeFileSync(path.join(root,'data/config.json'), '{invalid-profile-config');
    vi.stubEnv('NEO_CONFIG', external);
    vi.stubEnv('NEO_DATA_DIR', ambient);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key');
    vi.stubEnv('NEO_RELAY_URL', 'wss://synthetic-ambient.invalid');
    const config = loadConfig({ env: {}, path: path.join(root,'.smoke-config-disabled.json'), overrides: { dataDir: path.join(root,'data') } });
    expect(config.providers).toEqual([]);
    expect(config.tunnel.relayUrl).toBe('');
    expect(config.dataDir).toBe(path.join(root,'data'));
    writeFileSync(path.join(root,'.smoke-config-disabled.json'), '{}');
    expect(() => configureDisposableProfile(app(), root)).toThrow(/reserved config/);
  });
});


describe('disposable profile ownership marker', () => {
  it('refuses nonempty unmarked roots before reading their contents or applying app paths', () => {
    const root = fresh(); writeFileSync(path.join(root,'personal-state'), 'synthetic');
    const desktopApp = app();
    expect(() => configureDisposableProfile(desktopApp, root)).toThrow(/empty or already marked/);
    expect(desktopApp.setPath).not.toHaveBeenCalled();
  });
  it.each(['invalid','linked','hardlinked'])('refuses %s marker before app paths', (kind) => {
    const root = fresh(); const outside = fresh();
    const marker = path.join(root,'.neo-disposable-profile');
    const target = path.join(outside,'marker'); writeFileSync(target,'neo-disposable-profile-v1\n',{mode:0o600});
    if (kind === 'linked') symlinkSync(target,marker);
    else if (kind === 'hardlinked') linkSync(target,marker);
    else writeFileSync(marker,'wrong',{mode:0o600});
    const desktopApp = app();
    expect(() => configureDisposableProfile(desktopApp,root)).toThrow(/marker/);
    expect(desktopApp.setPath).not.toHaveBeenCalled();
  });
});
