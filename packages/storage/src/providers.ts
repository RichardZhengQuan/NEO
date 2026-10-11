import { NeoError, ProviderConfigSchema, type ProviderConfig, type SecretStore } from '@neo/protocol';
import { fromJson, type NeoDatabase } from './db.js';

/** Credential-bearing custom headers are never persisted as plaintext. */
export function isSecretProviderHeader(name: string): boolean {
  return /auth|key|token|secret/i.test(name) || /^(cookie|set-cookie)$/i.test(name);
}

const headerSecretName = (id: string, name: string): string => `provider:${id}:header:${name.toLowerCase()}`;
const headerReference = (id: string, name: string): string => `neo-secret:${headerSecretName(id, name)}`;

/** Move inline header credentials into the encrypted SecretStore, retaining only scoped references. */
export function protectProviderHeaders(config: ProviderConfig, secrets: SecretStore): ProviderConfig {
  if (!config.headers) return config;
  const credentialNames = new Set<string>();
  // Validate all credential headers before touching secrets, including when used outside a DB transaction.
  for (const [name, value] of Object.entries(config.headers)) {
    if (!isSecretProviderHeader(name)) continue;
    const normalized = name.toLowerCase();
    if (credentialNames.has(normalized)) throw new NeoError('bad_request', `Duplicate credential header "${name}".`);
    credentialNames.add(normalized);
    if (value === headerReference(config.id, name) && secrets.get(headerSecretName(config.id, name)) === undefined) {
      throw new NeoError('config_error', `Missing encrypted header for provider "${config.id}".`);
    }
  }
  const headers = Object.fromEntries(Object.entries(config.headers).map(([name, value]) => {
    if (!isSecretProviderHeader(name)) return [name, value];
    const secretName = headerSecretName(config.id, name);
    const reference = headerReference(config.id, name);
    // Only our own exact provider/header reference is recognized. Arbitrary secret names cannot be resolved.
    if (value !== reference) secrets.set(secretName, value);
    return [name, reference];
  }));
  return { ...config, headers };
}

/** Resolve encrypted header references solely for constructing a live adapter. */
export function resolveStoredProviderHeaders(config: ProviderConfig, secrets: SecretStore): ProviderConfig {
  if (!config.headers) return config;
  const headers = Object.fromEntries(Object.entries(config.headers).map(([name, value]) => {
    if (!isSecretProviderHeader(name) || value !== headerReference(config.id, name)) return [name, value];
    const secret = secrets.get(headerSecretName(config.id, name));
    if (secret === undefined) throw new NeoError('config_error', `Missing encrypted header for provider "${config.id}".`);
    return [name, secret];
  }));
  return { ...config, headers };
}

/** Provider configs added in the app (config-file providers are not stored here). */
export interface ProviderConfigStore {
  list(): ProviderConfig[];
  get(id: string): ProviderConfig | null;
  upsert(config: ProviderConfig): ProviderConfig;
  delete(id: string): boolean;
}

export function createProviderConfigStore(db: NeoDatabase, secrets?: SecretStore): ProviderConfigStore {
  const protect = (config: ProviderConfig): ProviderConfig => {
    if (secrets) return protectProviderHeaders(config, secrets);
    if (Object.entries(config.headers ?? {}).some(([name, value]) => isSecretProviderHeader(name) && value !== headerReference(config.id, name))) {
      throw new NeoError('config_error', 'Credential headers require an encrypted SecretStore.');
    }
    return config;
  };
  const parse = (text: unknown): ProviderConfig | null => {
    const r = ProviderConfigSchema.safeParse(fromJson(text, null));
    if (!r.success) return null;
    // Transparently migrate rows written by older versions before callers can use them.
    return db.transaction(() => {
      const safe = protect(r.data);
      const serialized = JSON.stringify(safe);
      if (serialized !== text) db.prepare('UPDATE provider_configs SET config = ?, updated_at = ? WHERE id = ?').run(serialized, Date.now(), safe.id);
      return safe;
    });
  };
  const removeUnusedHeaderSecrets = (id: string, headers?: Record<string, string>) => {
    if (!secrets) return;
    const keep = new Set(Object.keys(headers ?? {}).filter(isSecretProviderHeader).map((name) => headerSecretName(id, name)));
    for (const name of secrets.list()) {
      if (name.startsWith(`provider:${id}:header:`) && !keep.has(name)) secrets.delete(name);
    }
  };
  return {
    list() {
      return (db.prepare('SELECT config FROM provider_configs ORDER BY position, created_at').all() as { config: string }[])
        .map((r) => parse(r.config))
        .filter((c): c is ProviderConfig => c !== null);
    },
    get(id) {
      const row = db.prepare('SELECT config FROM provider_configs WHERE id = ?').get(id) as { config: string } | undefined;
      return row ? parse(row.config) : null;
    },
    upsert(config) {
      const valid = ProviderConfigSchema.parse(config);
      return db.transaction(() => {
        const safe = protect(valid);
        const now = Date.now();
        db.prepare(
          `INSERT INTO provider_configs (id, config, position, created_at, updated_at)
           VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM provider_configs), ?, ?)
           ON CONFLICT (id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
        ).run(safe.id, JSON.stringify(safe), now, now);
        removeUnusedHeaderSecrets(safe.id, safe.headers);
        return safe;
      });
    },
    delete(id) {
      return db.transaction(() => {
        const deleted = Number(db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id).changes) > 0;
        if (deleted) removeUnusedHeaderSecrets(id);
        return deleted;
      });
    },
  };
}
