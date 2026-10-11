import {
  DEFAULT_SETTINGS,
  NeoError,
  NeoSettingsSchema,
  applySettingsPatch,
  deepMerge,
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
  const listeners = new Set<(s: NeoSettings) => void>();

  const read = (): NeoSettings => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    const stored = fromJson<Record<string, unknown>>(row?.value, {});
    const parsed = NeoSettingsSchema.safeParse(deepMerge(defaults, stored));
    return parsed.success ? parsed.data : defaults;
  };

  let current = read();

  return {
    get: () => current,
    update(patch: NeoSettingsPatch) {
      let next: NeoSettings;
      try {
        next = applySettingsPatch(current, patch);
      } catch (err) {
        if (err instanceof z.ZodError) throw new NeoError('bad_request', 'Invalid settings.', { details: z.treeifyError(err) });
        throw err;
      }
      db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(KEY, JSON.stringify(next), Date.now());
      current = next;
      for (const l of listeners) l(next);
      return next;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
