/**
 * Hash routing. Hashes work everywhere the app runs (served by the NEO
 * server, file:// in Electron, capacitor:// on phones) without server rewrites.
 *
 *   #/ · #/timeline?messageId=<messageId>
 *   #/memory · #/memory/<tab> · #/memory/<memoryId> · #/memory/<tab>?node=<memoryId>
 *   #/reminders · #/reminders/<reminderId>
 *   #/tasks · #/tasks/<listId> · #/tasks/<taskId>
 *   #/notes · #/notes/<noteId>
 *   #/settings · #/settings/<section>
 *   #/connect · #/onboarding · #/pair?token=…&server=… (v1)
 *   #/pair?v=2&code=…&server=… (single-use pairing code)
 *
 * `neo://` links (notifications, generative UI) map onto the same routes.
 */
import { useEffect, useSyncExternalStore } from 'react';

export const MEMORY_TABS = ['net', 'list', 'journal', 'stats', 'data'] as const;
export type MemoryTab = (typeof MEMORY_TABS)[number];

export const SETTINGS_SECTIONS = ['ai', 'avatar', 'memory', 'tools', 'devices', 'notifications', 'appearance', 'data'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { name: 'timeline'; messageId?: string }
  | { name: 'memory'; tab: MemoryTab; nodeId?: string }
  | { name: 'reminders'; reminderId?: string }
  | { name: 'tasks'; listId?: string; taskId?: string }
  | { name: 'notes'; noteId?: string }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'connect' }
  | { name: 'onboarding' }
  | { name: 'pair'; token?: string; serverUrl?: string; code?: string; version?: string };

export type RouteName = Route['name'];

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeId = (s: string | undefined): string | undefined => (s && SAFE_ID.test(s) ? s : undefined);

function isMemoryTab(s: string | undefined): s is MemoryTab {
  return MEMORY_TABS.includes(s as MemoryTab);
}
function isSection(s: string | undefined): s is SettingsSection {
  return SETTINGS_SECTIONS.includes(s as SettingsSection);
}

/** Route from path segments + query (shared by hash and neo:// parsing). */
function routeFrom(segments: string[], query: URLSearchParams): Route {
  const [first = 'timeline', second, third, fourth] = segments;
  switch (first) {
    case 'chat': {
      const messageId = safeId(query.get('messageId') ?? ((third === 'message' || third === 'messages') ? fourth : third));
      return messageId ? { name: 'timeline', messageId } : { name: 'timeline' };
    }
    case 'timeline': {
      const messageId = safeId(query.get('messageId') ?? second);
      return messageId ? { name: 'timeline', messageId } : { name: 'timeline' };
    }
    case 'memory': {
      const node = safeId(query.get('node') ?? undefined);
      if (isMemoryTab(second)) return node ? { name: 'memory', tab: second, nodeId: node } : { name: 'memory', tab: second };
      const id = safeId(second);
      if (id) return { name: 'memory', tab: 'net', nodeId: id };
      return { name: 'memory', tab: 'net' };
    }
    case 'reminders':
      return { name: 'reminders', reminderId: safeId(second) };
    case 'tasks': {
      const id = safeId(second);
      if (id?.startsWith('task_')) return { name: 'tasks', taskId: id };
      return { name: 'tasks', listId: id };
    }
    case 'notes':
      return { name: 'notes', noteId: safeId(second) };
    case 'settings':
      return { name: 'settings', section: second === 'persona' ? 'avatar' : isSection(second) ? second : undefined };
    case 'connect':
      return { name: 'connect' };
    case 'onboarding':
      return { name: 'onboarding' };
    case 'pair':
      return { name: 'pair', token: query.get('token') ?? undefined, serverUrl: query.get('server') ?? query.get('url') ?? undefined, code: query.get('code') ?? undefined, version: query.get('v') ?? undefined };
    default:
      return { name: 'timeline' };
  }
}

/** Parse `#/memory/list?node=mem_1` (a leading `#` and `/` are optional). */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
  let segments: string[];
  try {
    segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    segments = [];
  }
  return routeFrom(segments, query);
}

/** Canonical hash for a route. */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'timeline':
      if (route.messageId) return `#/timeline?messageId=${encodeURIComponent(route.messageId)}`;
      return '#/';
    case 'memory':
      if (route.nodeId) return route.tab === 'net' ? `#/memory/${route.nodeId}` : `#/memory/${route.tab}?node=${route.nodeId}`;
      return route.tab === 'net' ? '#/memory' : `#/memory/${route.tab}`;
    case 'reminders':
      return route.reminderId ? `#/reminders/${route.reminderId}` : '#/reminders';
    case 'tasks':
      if (route.taskId) return `#/tasks/${route.taskId}`;
      return route.listId ? `#/tasks/${route.listId}` : '#/tasks';
    case 'notes':
      return route.noteId ? `#/notes/${route.noteId}` : '#/notes';
    case 'settings':
      return route.section ? `#/settings/${route.section}` : '#/settings';
    case 'connect':
      return '#/connect';
    case 'onboarding':
      return '#/onboarding';
    case 'pair': {
      const q = new URLSearchParams();
      if (route.version) q.set('v', route.version);
      if (route.code) q.set('code', route.code);
      if (route.token) q.set('token', route.token);
      if (route.serverUrl) q.set('server', route.serverUrl);
      const s = q.toString();
      return s ? `#/pair?${s}` : '#/pair';
    }
  }
}

/**
 * Map a `neo://` link to a route. Parsed by hand: non-special URL schemes are
 * handled inconsistently by older WebViews.
 */
export function neoUrlToRoute(url: string): Route | null {
  const m = /^neo:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/i.exec(url.trim());
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const known = ['chat', 'timeline', 'memory', 'reminders', 'tasks', 'notes', 'settings', 'pair'];
  if (!known.includes(host)) return null;
  let rest: string[];
  try {
    rest = (m[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    rest = [];
  }
  return routeFrom([host, ...rest], new URLSearchParams((m[3] ?? '').slice(1)));
}

/** Navigate by changing the hash (adds a history entry unless `replace`). */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const hash = routeToHash(route);
  if (window.location.hash === hash) return;
  if (options.replace) {
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function getHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

/** Current route, re-rendering on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  useEffect(() => {
    if (/^#?\/+chat(?:\/|\?|$)/i.test(hash)) navigate(parseRoute(hash), { replace: true });
  }, [hash]);
  return parseRoute(hash);
}
