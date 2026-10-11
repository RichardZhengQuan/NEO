/**
 * Guarded localStorage/sessionStorage access. Storage can be unavailable
 * (private mode, sandboxed webviews, quota) — callers always get a value.
 */

function store(kind: 'local' | 'session'): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readString(key: string, kind: 'local' | 'session' = 'local'): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null, kind: 'local' | 'session' = 'local'): void {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage full or blocked: the app keeps working without persistence.
  }
}

export function readJson<T>(key: string, kind: 'local' | 'session' = 'local'): T | null {
  const raw = readString(key, kind);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown, kind: 'local' | 'session' = 'local'): void {
  writeString(key, value === null || value === undefined ? null : JSON.stringify(value), kind);
}

/** Keys used across the app (one place, so they never collide). */
export const STORAGE_KEYS = {
  connection: 'neo.connection',
  theme: 'neo.theme',
  locale: 'neo.locale',
  onboardingStep: 'neo.onboarding.step',
  localNotifications: 'neo.localNotifications',
  sidebarCollapsed: 'neo.sidebar',
  memoryFilters: 'neo.memory.filters',
  remoteImages: 'neo.remote-images',
} as const;
