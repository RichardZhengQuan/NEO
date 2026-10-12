import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsStore } from './settings.js';
import { openNeoDatabase, type NeoDatabase } from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('AI settings upgrade', () => {
  it('adds automatic search to an existing Advanced AI blob without changing assignments', () => {
    db = openNeoDatabase(':memory:');
    const text = { provider: 'custom', model: 'chat' };
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('settings', JSON.stringify({ ai: { mode: 'advanced', capabilities: { text } } }), 1);
    const settings = createSettingsStore(db);
    expect(settings.get().ai).toMatchObject({ mode: 'advanced', capabilities: { text }, search: { mode: 'auto', engine: null } });
    settings.update({ ai: { search: { mode: 'off' } } });
    expect(createSettingsStore(db).get().ai.search).toEqual({ mode: 'off', engine: null });
  });
  it('loads an old blob with Text and embedding defaults and persists the new shape on update', () => {
    db = openNeoDatabase(':memory:');
    const text = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
    const embedding = { provider: 'openai', model: 'text-embedding-3-small' };
    const old = { defaultModel: text, memoryModel: { provider: 'other', model: 'legacy-memory' }, embedding, onboarded: true, theme: 'dark' };
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('settings', JSON.stringify(old), 1);
    const settings = createSettingsStore(db);
    expect(settings.get()).toMatchObject({ onboarded: true, theme: 'dark', ai: { mode: 'simple', search: { mode: 'auto', engine: null }, capabilities: { text, embedding, speechToText: null, textToSpeech: null, image: null, video: null } } });
    settings.update({ locale: 'zh' });
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string };
    expect(JSON.parse(stored.value)).toMatchObject({ ai: settings.get().ai, defaultModel: text, memoryModel: text, embedding });
    expect(createSettingsStore(db).get()).toEqual(settings.get());
  });

  it('uses a legacy memory-only model for Text and preserves Advanced assignments across restart', () => {
    db = openNeoDatabase(':memory:');
    const text = { provider: 'local', model: 'local-model' };
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('settings', JSON.stringify({ memoryModel: text }), 1);
    const settings = createSettingsStore(db);
    expect(settings.get().ai.capabilities.text).toEqual(text);
    const voice = { provider: 'cloud', model: 'voice-model' };
    settings.update({ ai: { mode: 'advanced', capabilities: { speechToText: voice } } });
    const reloaded = createSettingsStore(db);
    expect(reloaded.get().ai).toMatchObject({ mode: 'advanced', capabilities: { text, speechToText: voice } });
    reloaded.update({ defaultModel: { provider: 'new', model: 'new-text' }, embedding: null });
    expect(reloaded.get().ai.capabilities).toMatchObject({ text: { provider: 'new', model: 'new-text' }, embedding: null, speechToText: voice });
  });
});
