import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, NeoError, silentLogger } from '@neo/protocol';
import type { MemoryNode } from '@neo/protocol';
import { createMemoryService } from '@neo/memory';
import { createSettingsStore, openNeoDatabase } from '@neo/storage';
import type { NeoDatabase } from '@neo/storage';
import { createServices } from './services.js';
import type { NeoServices } from './index.js';
import { migratePersonaSettings, PERSONA_MEMORY_MIGRATION, storedPersona } from './persona-migration.js';

const clock = () => 1_800_000_000_000;
const databases: NeoDatabase[] = [];
const services: NeoServices[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(persona: unknown) {
  const db = openNeoDatabase(':memory:');
  databases.push(db);
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'settings', JSON.stringify({ persona, timezone: 'Asia/Singapore', memory: { allowedKinds: [] } }), 1,
  );
  const memory = createMemoryService({ db, clock });
  const settings = createSettingsStore(db);
  const run = () => migratePersonaSettings(db, memory, settings, storedPersona(db), clock);
  const raw = () => JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string }).value);
  return { db, memory, settings, run, raw };
}

describe('persona settings startup migration v1', () => {
  it('seeds customized legacy values once and drops every old persona field', async () => {
    const f = fixture({
      avatar: '🌙', name: 'Luna', tagline: 'A companion', tone: 'playful', traits: ['kind', 'patient'],
      instructions: 'Keep answers short. Call me Rich.', language: 'zh-CN', greeting: 'Hi',
    });
    await f.run();
    const first = await f.memory.search({ kinds: ['preference'], limit: 20 });
    expect(first.items).toHaveLength(7);
    expect(first.items.map(node => node.content)).toEqual(expect.arrayContaining([
      'Keep answers short.', 'Call me Rich.', 'The user calls me Luna',
      'The user wants me to use a playful tone', 'The user wants me to be kind', 'The user wants me to be patient', 'The user wants replies in zh-CN',
    ]));
    for (const node of first.items) {
      expect(node.tags).toContain('assistant-style');
      expect(node.source).toEqual({ by: 'user', note: 'migrated from persona settings' });
      expect(node.status).toBe('active');
    }
    expect(first.items.find(node => node.content === 'Keep answers short.')?.tags).toContain('assistant-style:length');
    expect(first.items.find(node => node.content === 'Call me Rich.')?.tags).toContain('assistant-style:user-name');
    expect(f.settings.get().persona).toEqual({ avatar: '🌙' });
    expect(f.raw().persona).toEqual({ avatar: '🌙' });
    expect(f.raw().timezone).toBe('Asia/Singapore');
    expect(f.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(PERSONA_MEMORY_MIGRATION)).toEqual({ value: String(clock()) });
    await f.run();
    expect((await f.memory.search({ kinds: ['preference'], limit: 20 })).items).toEqual(first.items);
  });

  it('does not seed defaults, tagline or greeting', async () => {
    const f = fixture({ avatar: null, name: 'NEO', tone: 'warm', traits: ['direct', 'curious', 'warm'], instructions: '  ', language: 'auto', tagline: 'Custom tagline', greeting: 'Custom greeting' });
    await f.run();
    expect((await f.memory.search({ limit: 20 })).items).toEqual([]);
    expect(f.raw().persona).toEqual({ avatar: null });
    await f.run();
    expect((await f.memory.stats()).total).toBe(0);
  });

  it('keeps standing instructions active when they override an old tone setting', async () => {
    const f = fixture({ tone: 'playful', instructions: 'Be more serious.' });
    await f.run();
    const active = (await f.memory.search({ kinds: ['preference'] })).items;
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toBe('Be more serious.');
    expect(active[0]?.source).toEqual({ by: 'user', note: 'migrated from persona settings' });
    const history = (await f.memory.get(active[0]!.id))?.history;
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({ status: 'superseded', content: 'The user wants me to use a playful tone' });
  });

  it('revises an opposing migrated trait while retaining independent compatible traits', async () => {
    const f = fixture({ traits: ['playful', 'warm'] });
    await f.run();
    const serious = await f.memory.remember({ content: 'The user wants NEO to be more serious.', kind: 'preference', source: { by: 'user' } });
    expect((await f.memory.search({ kinds: ['preference'] })).items.map(node => node.content)).toEqual(expect.arrayContaining([
      'The user wants me to be warm', 'The user wants NEO to be more serious.',
    ]));
    expect((await f.memory.search({ kinds: ['preference'] })).items).toHaveLength(2);
    expect((await f.memory.get(serious.id))?.history).toEqual([
      expect.objectContaining({ status: 'superseded', content: 'The user wants me to be playful' }),
    ]);
  });

  it.each(['Dr.', 'Mr.', 'Mrs.', 'Ms.', 'Prof.', 'J. R.'])('preserves preferred-name abbreviation %s', async (title) => {
    const f = fixture({ instructions: `Call me ${title} Rich. Keep answers short.` });
    await f.run();
    expect((await f.memory.search({ kinds: ['preference'] })).items.map(node => node.content)).toEqual(expect.arrayContaining([
      `Call me ${title} Rich.`, 'Keep answers short.',
    ]));
    expect((await f.memory.stats()).total).toBe(2);
  });

  it('preserves domain and decimal dots in arbitrary instructions', async () => {
    const f = fixture({ instructions: 'Use docs.example.com for references and round to 2.5 places. Keep answers short.' });
    await f.run();
    expect((await f.memory.search({ kinds: ['preference'] })).items.map(node => node.content)).toEqual(expect.arrayContaining([
      'Use docs.example.com for references and round to 2.5 places.', 'Keep answers short.',
    ]));
    expect((await f.memory.stats()).total).toBe(2);
  });

  it('atomically keeps first-boot configuration available if the raw persona write is interrupted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-persona-initialization-'));
    directories.push(directory);
    const path = join(directory, 'neo.db');
    const db = openNeoDatabase(path);
    db.exec(`CREATE TRIGGER fail_initial_persona_restore BEFORE UPDATE OF value ON settings
      BEGIN SELECT RAISE(ABORT, 'Interrupted settings initialization'); END`);
    db.close();
    const config = NeoConfigSchema.parse({ dataDir: directory, log: { level: 'silent' }, settings: { persona: { name: 'Luna', instructions: 'Keep answers short.' } } });
    await expect(createServices(config, { clock, logger: silentLogger })).rejects.toThrow('Interrupted settings initialization');
    const persisted = openNeoDatabase(path);
    expect(persisted.prepare('SELECT value FROM settings WHERE key = ?').get('settings')).toBeUndefined();
    persisted.exec('DROP TRIGGER fail_initial_persona_restore');
    persisted.close();
    const resumed = await createServices(config, { clock, logger: silentLogger });
    services.push(resumed);
    expect((await resumed.memory.search({ kinds: ['preference'] })).items.map(node => node.content)).toEqual(expect.arrayContaining([
      'The user calls me Luna', 'Keep answers short.',
    ]));
    expect(resumed.settings.get().persona).toEqual({ avatar: null });
  });

  it('retains raw values after an interrupted migration and resumes without duplicate writes', async () => {
    const f = fixture({ name: 'Luna', instructions: 'Keep answers short. Reply in Chinese.' });
    const remember = vi.spyOn(f.memory, 'remember');
    const original = remember.getMockImplementation()!;
    remember.mockImplementationOnce(original).mockRejectedValueOnce(new NeoError('bad_request', 'Unrelated invalid memory'));
    await expect(f.run()).rejects.toThrow('Unrelated invalid memory');
    expect(f.raw().persona).toMatchObject({ name: 'Luna', instructions: 'Keep answers short. Reply in Chinese.' });
    expect(f.db.prepare('SELECT 1 FROM memory_meta WHERE key = ?').get(PERSONA_MEMORY_MIGRATION)).toBeUndefined();
    expect((await f.memory.search({ kinds: ['preference'] })).items).toHaveLength(1);
    remember.mockRestore();
    await f.run();
    expect((await f.memory.search({ kinds: ['preference'] })).items).toHaveLength(3);
    expect(f.raw().persona).toEqual({ avatar: null });
  });

  it('keeps sensitive instructions private and drops only credential-bearing fragments', async () => {
    const f = fixture({ instructions: 'Always consider my diabetes when suggesting meals.' });
    await f.run();
    expect((await f.memory.search({ kinds: ['preference'] })).items[0]?.sensitivity).toBe('sensitive');
    expect((await f.memory.recall({ text: 'What should I cook?', allowSensitive: false })).items).toEqual([]);
    const secret = fixture({ instructions: 'Keep answers short. My password is secret-password-123.' });
    const logger = { ...silentLogger, warn: vi.fn() };
    await migratePersonaSettings(secret.db, secret.memory, secret.settings, storedPersona(secret.db), clock, logger);
    expect((await secret.memory.search({ kinds: ['preference'] })).items.map(node => node.content)).toEqual(['Keep answers short.']);
    expect(secret.raw().persona).toEqual({ avatar: null });
    expect(logger.warn).toHaveBeenCalledWith('A legacy persona preference contained credentials and was skipped.');
    expect(JSON.stringify(secret.db.prepare('SELECT * FROM memory_nodes').all())).not.toContain('secret-password-123');
    await secret.run();
    expect((await secret.memory.stats()).total).toBe(1);
  });

  it('migrates first-boot config and stored blobs at startup and recalls style on unrelated turns', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-persona-migration-'));
    directories.push(directory);
    const config = NeoConfigSchema.parse({ dataDir: directory, log: { level: 'silent' }, settings: { persona: { avatar: '🌙', name: 'Luna', instructions: 'Keep answers short. My password is secret-password-123.', tone: 'playful', traits: ['kind'], language: 'zh-CN' } } });
    const first = await createServices(config, { clock, logger: silentLogger });
    services.push(first);
    const nodes = (await first.memory.search({ kinds: ['preference'] })).items;
    expect(nodes).toHaveLength(5);
    expect(JSON.stringify(nodes)).not.toContain('secret-password-123');
    expect(first.settings.get().persona).toEqual({ avatar: '🌙' });
    const recalled = await first.memory.recall({ text: 'How far is the moon?', reinforce: false });
    expect(recalled.items.filter(item => item.node.tags.includes('assistant-style'))).toHaveLength(5);
    await first.close();
    const stored = openNeoDatabase(join(directory, 'neo.db'));
    const settings = JSON.parse((stored.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string }).value);
    expect(settings.persona).toEqual({ avatar: '🌙' });
    stored.close();
    const second = await createServices(config, { clock, logger: silentLogger });
    services.push(second);
    expect((await second.memory.search({ kinds: ['preference'] })).items.map((node: MemoryNode) => node.id).sort()).toEqual(nodes.map(node => node.id).sort());

    const legacyDirectory = mkdtempSync(join(tmpdir(), 'neo-persona-legacy-'));
    directories.push(legacyDirectory);
    const legacy = openNeoDatabase(join(legacyDirectory, 'neo.db'));
    legacy.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('settings', JSON.stringify({ persona: { avatar: '🌟', name: 'Nova', instructions: 'Call me Rich' } }), 1);
    legacy.close();
    const upgraded = await createServices(NeoConfigSchema.parse({ dataDir: legacyDirectory, log: { level: 'silent' } }), { clock, logger: silentLogger });
    services.push(upgraded);
    expect(upgraded.settings.get().persona).toEqual({ avatar: '🌟' });
    expect((await upgraded.memory.search({ kinds: ['preference'] })).items).toHaveLength(2);
  });
});
