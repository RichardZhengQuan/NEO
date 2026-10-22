import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsStore } from './settings.js';
import { openNeoDatabase, type NeoDatabase } from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('settingsStore rollback safety', () => {
  it('does not update cache or re-persist after a rolled-back outer transaction', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light' });           // persist initial value

    expect(() =>
      db.transaction(() => {
        settings.update({ theme: 'dark' });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // SQL row must still hold theme === 'light'
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string };
    expect(JSON.parse(row.value).theme).toBe('light');

    // In-memory cache must also still hold theme === 'light'
    expect(settings.get().theme).toBe('light');

    // A subsequent update must NOT re-persist the rolled-back 'dark'
    settings.update({ locale: 'zh' });
    const row2 = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string };
    expect(JSON.parse(row2.value).theme).toBe('light');
  });

  it('does not re-persist a rolled-back theme when a later patch changes only the locale', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light' });

    expect(() => db.transaction(() => {
      settings.update({ theme: 'dark' });
      throw new Error('boom');
    })).toThrow('boom');

    settings.update({ locale: 'zh' });
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string };
    expect(JSON.parse(row.value)).toMatchObject({ theme: 'light', locale: 'zh' });
  });

  it('publishes cache changes and notifies listeners synchronously outside transactions', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    const seen: string[] = [];
    settings.onChange((next) => {
      expect(settings.get()).toBe(next);
      seen.push(next.theme);
    });

    const saved = settings.update({ theme: 'light' });
    expect(settings.get()).toBe(saved);
    expect(seen).toEqual(['light']);
  });

  it('defers nested updates until the outer commit and preserves successive patches', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light', locale: 'en' });
    const seen: string[] = [];
    settings.onChange((next) => {
      expect(settings.get()).toBe(next);
      seen.push(`${next.theme}:${next.locale}`);
    });

    const result = db.transaction(() => {
      expect(settings.update({ theme: 'dark' }).theme).toBe('dark');
      db.transaction(() => {
        expect(settings.update({ locale: 'zh' })).toMatchObject({ theme: 'dark', locale: 'zh' });
        expect(settings.get()).toMatchObject({ theme: 'light', locale: 'en' });
        expect(seen).toEqual([]);
      });
      expect(settings.get()).toMatchObject({ theme: 'light', locale: 'en' });
      expect(seen).toEqual([]);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(settings.get()).toMatchObject({ theme: 'dark', locale: 'zh' });
    expect(createSettingsStore(db).get()).toEqual(settings.get());
    expect(seen).toEqual(['dark:en', 'dark:zh']);
  });

  it('publication order keeps the cache equal to the latest committed value', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light', locale: 'en' });
    let reentrantWrites = 0;
    settings.onChange((next) => {
      if (next.theme === 'dark' && next.locale === 'en') {
        reentrantWrites++;
        settings.update({ theme: 'light' });
      }
    });

    db.transaction(() => {
      settings.update({ theme: 'dark' });
      settings.update({ locale: 'zh' });
    });

    expect(reentrantWrites).toBe(1);
    expect(settings.get()).toEqual(createSettingsStore(db).get());
    expect(settings.get()).toMatchObject({ theme: 'light', locale: 'zh' });
  });

  it('discards a rolled-back savepoint while publishing parent and later sibling updates', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light', locale: 'en' });
    const seen: string[] = [];
    settings.onChange((next) => seen.push(`${next.theme}:${next.locale}`));

    db.transaction(() => {
      settings.update({ theme: 'dark' });
      expect(() => db.transaction(() => {
        settings.update({ locale: 'zh' });
        throw new Error('inner');
      })).toThrow('inner');
      db.transaction(() => settings.update({ onboarded: true }));
      expect(settings.get()).toMatchObject({ theme: 'light', locale: 'en', onboarded: false });
      expect(seen).toEqual([]);
    });

    expect(settings.get()).toMatchObject({ theme: 'dark', locale: 'en', onboarded: true });
    expect(createSettingsStore(db).get()).toEqual(settings.get());
    expect(seen).toEqual(['dark:en', 'dark:en']);
  });

  it('discards notifications from a released savepoint when its outer transaction rolls back', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light' });
    const seen: string[] = [];
    settings.onChange((next) => seen.push(next.theme));

    expect(() => db.transaction(() => {
      db.transaction(() => settings.update({ theme: 'dark' }));
      expect(settings.get().theme).toBe('light');
      expect(seen).toEqual([]);
      throw new Error('outer');
    })).toThrow('outer');

    expect(settings.get().theme).toBe('light');
    expect(createSettingsStore(db).get().theme).toBe('light');
    expect(seen).toEqual([]);
    settings.update({ locale: 'zh' });
    expect(seen).toEqual(['light']);
  });
});

describe('afterCommit', () => {
  it('runs immediately outside transactions and preserves registration order across nested commits', () => {
    db = openNeoDatabase(':memory:');
    const seen: string[] = [];
    db.afterCommit(() => seen.push('immediate'));
    expect(seen).toEqual(['immediate']);

    db.transaction(() => {
      db.afterCommit(() => seen.push('outer before'));
      db.transaction(() => {
        db.afterCommit(() => seen.push('inner before'));
        db.transaction(() => db.afterCommit(() => seen.push('deepest')));
        db.afterCommit(() => seen.push('inner after'));
      });
      db.afterCommit(() => seen.push('outer after'));
      expect(seen).toEqual(['immediate']);
    });

    expect(seen).toEqual(['immediate', 'outer before', 'inner before', 'deepest', 'inner after', 'outer after']);
  });

  it('restores transaction depth before callbacks register callbacks or open another transaction', () => {
    db = openNeoDatabase(':memory:');
    const seen: string[] = [];

    db.transaction(() => {
      db.afterCommit(() => {
        seen.push('committed');
        db.afterCommit(() => seen.push('immediate'));
        seen.push('after registration');
        db.transaction(() => {
          db.afterCommit(() => seen.push('new commit'));
          expect(seen).toEqual(['committed', 'immediate', 'after registration']);
        });
      });
    });

    expect(seen).toEqual(['committed', 'immediate', 'after registration', 'new commit']);
  });

  it('discards callbacks when COMMIT fails and stays usable for a later transaction', () => {
    db = openNeoDatabase(':memory:');
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED
      );
    `);
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light' });
    const seen: string[] = [];
    settings.onChange((next) => seen.push(next.theme));

    expect(() => db.transaction(() => {
      settings.update({ theme: 'dark' });
      db.prepare('INSERT INTO child VALUES (?, ?)').run(1, 99);
    })).toThrow(/FOREIGN/);

    expect(settings.get().theme).toBe('light');
    expect(createSettingsStore(db).get().theme).toBe('light');
    expect(seen).toEqual([]);
    db.transaction(() => settings.update({ locale: 'zh' }));
    expect(createSettingsStore(db).get()).toMatchObject({ theme: 'light', locale: 'zh' });
    expect(seen).toEqual(['light']);
  });

  it('discards callbacks even when rollback cleanup fails and stays usable', () => {
    db = openNeoDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const settings = createSettingsStore(db);
    settings.update({ theme: 'light' });
    const seen: string[] = [];
    settings.onChange((next) => seen.push(next.theme));

    expect(() => db.transaction(() => {
      settings.update({ theme: 'dark' });
      db.prepare('INSERT INTO t VALUES (?)').run(1);
      db.prepare('INSERT OR ROLLBACK INTO t VALUES (?)').run(1);
    })).toThrow(AggregateError);

    expect(settings.get().theme).toBe('light');
    expect(createSettingsStore(db).get().theme).toBe('light');
    expect(seen).toEqual([]);
    db.transaction(() => settings.update({ locale: 'zh' }));
    expect(createSettingsStore(db).get()).toMatchObject({ theme: 'light', locale: 'zh' });
    expect(seen).toEqual(['light']);
  });

  it('does not attempt to roll back a committed transaction when a callback throws', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    const error = new Error('callback');

    expect(() => db.transaction(() => {
      settings.update({ theme: 'dark' });
      db.afterCommit(() => { throw error; });
    })).toThrow(error);

    expect(settings.get().theme).toBe('dark');
    expect(createSettingsStore(db).get().theme).toBe('dark');
    db.transaction(() => settings.update({ locale: 'zh' }));
    expect(createSettingsStore(db).get()).toMatchObject({ theme: 'dark', locale: 'zh' });
  });

  it('runs all callbacks even when an earlier callback throws, preserving cache and listeners', () => {
    db = openNeoDatabase(':memory:');
    const settings = createSettingsStore(db);
    const error = new Error('early callback');

    // Register the throwing callback BEFORE settings.update(), so the settings
    // afterCommit callback is queued after the thrower. Without the fix the
    // loop would stop at the thrower and skip the settings cache/listener update.
    expect(() => db.transaction(() => {
      db.afterCommit(() => { throw error; });
      settings.update({ theme: 'dark' });
    })).toThrow(error);

    // The SQL write committed; the cache and listeners must reflect it.
    expect(settings.get().theme).toBe('dark');
    expect(createSettingsStore(db).get().theme).toBe('dark');
    db.transaction(() => settings.update({ locale: 'zh' }));
    expect(createSettingsStore(db).get()).toMatchObject({ theme: 'dark', locale: 'zh' });
  });
});

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
