import {
  DEFAULT_SETTINGS,
  NeoError,
  NeoSettingsSchema,
  applySettingsPatch,
  deepMerge,
  migrateSettings,
  type NeoSettings,
  type NeoSettingsPatch,
  type SettingsStore,
} from '@neo/protocol';
import { z } from 'zod';
import { fromJson, type NeoDatabase } from './db.js';

const KEY = 'settings';

/**
 * Settings persisted as one JSON document. Values stored by an older version
 * are merged over the current defaults, so new fields always get defaults.
 */
export function createSettingsStore(db: NeoDatabase, defaults: NeoSettings = DEFAULT_SETTINGS): SettingsStore {
  let updateGen = 0;
  let publishGen = 0;
  const listeners = new Set<(s: NeoSettings) => void>();

  const read = (): NeoSettings => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    const stored = fromJson<Record<string, unknown>>(row?.value, {});
    const parsed = NeoSettingsSchema.safeParse(deepMerge(defaults, migrateSettings(stored)));
    return parsed.success ? parsed.data : defaults;
  };

  let current = read();

  return {
    get: () => current,
    update(patch: NeoSettingsPatch) {
      let next: NeoSettings;
      try {
        // Read transaction-visible writes so successive patches keep earlier changes.
        next = applySettingsPatch(read(), patch);
      } catch (err) {
        if (err instanceof z.ZodError) throw new NeoError('bad_request', 'Invalid settings.', { details: z.treeifyError(err) });
        throw err;
      }
      db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(KEY, JSON.stringify(next), Date.now());
      // Publish only after the outermost commit; a rollback must leave the cache and listeners unchanged.
      const gen = ++updateGen;
      db.afterCommit(() => {
        if (gen <= publishGen) return;
        publishGen = gen;
        current = next;
        for (const l of listeners) {
          // Re-check before each delivery: a listener may call update() reentantly,
          // which fires its own afterCommit immediately (depth === 0), bumps publishGen
          // and notifies all listeners with the newer snapshot.  If that happened, this
          // publish has been superseded and the remaining listeners must not receive the
          // stale `next` — they already got the correct value from the nested publish.
          if (gen < publishGen) break;
          l(next);
        }
      });
      return next;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
