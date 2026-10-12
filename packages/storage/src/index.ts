/** @neo/storage — persistence on Node's built-in SQLite. */
import { migrate, openDatabase, type NeoDatabase } from './db.js';
import { storageMigrations } from './migrations.js';

export * from './db.js';
export { retireLegacyDemoProvider, storageMigrations } from './migrations.js';
export { createConversationStore } from './conversations.js';
export { createSettingsStore } from './settings.js';
export { createSecretStore, loadOrCreateKey } from './secrets.js';
export { createDeviceStore, createPushSubscriptionStore, hashToken, type StorageDeviceStore } from './devices.js';
export {
  createProviderConfigStore, isSecretProviderHeader, protectProviderHeaders, resolveStoredProviderHeaders,
  type ProviderConfigStore,
} from './providers.js';

/** Open a database and apply @neo/storage's own migrations. Other packages run theirs on the same handle. */
export function openNeoDatabase(path: string): NeoDatabase {
  const db = openDatabase(path);
  migrate(db, 'storage', storageMigrations);
  return db;
}
