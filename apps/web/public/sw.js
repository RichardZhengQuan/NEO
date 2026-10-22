/* NEO service worker
 *
 * Caching is an explicit allow-list (security: nothing authenticated is ever
 * stored, so a revoked token can't be "replayed" from the cache):
 * - Only same-origin GETs inside this worker's scope are considered.
 * - Never cached: requests with an Authorization header, any path with an
 *   `/api` segment at any depth (the API may live behind a prefix such as
 *   /neo/api/…), non-GET requests, and responses marked
 *   Cache-Control: no-store / private.
 * - Cached: the app shell (scope root / index.html, network-first with the
 *   cached copy as the offline fallback), hashed build output under
 *   `assets/` (cache-first) and the icons + manifest (stale-while-revalidate).
 *   Everything else goes straight to the network untouched.
 * - Web Push: the server sends { title, body, tag?, data: { url?: 'neo://…',
 *   reminderId?, notificationId? } }. Reminder notifications get
 *   "Snooze 10 min" / "Done" buttons.
 * - Clicks: focus an open NEO window and ask it to navigate (or perform the
 *   reminder action); with no window open, open the app at the right route.
 */
// v4 drops v3 caches that may hold the app's HTML under an asset URL.
const SHELL_CACHE = 'neo-shell-v4';
const META_CACHE = 'neo-meta';
const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname;
const LOCALE_KEY = new URL('__neo/locale', SCOPE).href;
const INDEX_URL = new URL('./index.html', SCOPE).href;

const STRINGS = {
  en: { snooze: 'Snooze 10 min', done: 'Done', fallbackTitle: 'NEO' },
  zh: { snooze: '10 分钟后提醒', done: '完成', fallbackTitle: 'NEO' },
};

/** Static files (relative to the scope) that may be cached besides assets/. */
const STATIC_FILES = ['manifest.webmanifest', 'icon-192.svg', 'icon-512.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon.svg', 'favicon.ico'];
const SHELL = [INDEX_URL, ...['manifest.webmanifest', 'icon-192.svg', 'icon-512.svg'].map((p) => new URL(p, SCOPE).href)];

/** Path inside the scope ("" for the scope root), or null when outside it. */
function scopedPath(url) {
  if (url.origin !== self.location.origin) return null;
  if (!url.pathname.startsWith(SCOPE_PATH)) return null;
  return url.pathname.slice(SCOPE_PATH.length);
}

function isApiPath(pathname) {
  return /(^|\/)api(\/|$)/i.test(pathname);
}

/** Which caching rule applies to a request, or null to leave it alone. */
function cacheRule(request) {
  if (request.method !== 'GET') return null;
  if (request.headers.has('authorization')) return null;
  const url = new URL(request.url);
  const path = scopedPath(url);
  if (path === null || isApiPath(url.pathname)) return null;
  if (url.search && request.mode !== 'navigate') return null;
  if (request.mode === 'navigate') return path === '' || path === 'index.html' ? 'shell' : null;
  if (/^assets\/[^/]+$/.test(path)) return 'immutable';
  if (STATIC_FILES.includes(path)) return 'static';
  return null;
}

function cacheableResponse(response, rule) {
  if (!response || !response.ok || response.type !== 'basic' || response.redirected) return false;
  // Only the shell is HTML. HTML at any other path is a server fallback page;
  // cached cache-first under an asset URL, it would break that asset for good.
  if (rule !== 'shell' && /^text\/html/i.test(response.headers.get('content-type') || '')) return false;
  const cc = (response.headers.get('cache-control') || '').toLowerCase();
  if (/(^|[,\s])(no-store|private)([,\s=]|$)/.test(cc)) return false;
  const vary = (response.headers.get('vary') || '').toLowerCase();
  return !vary.includes('authorization') && !vary.includes('cookie') && vary.trim() !== '*';
}

/** Clones synchronously (before the page consumes the body), then stores. */
function putIfCacheable(cacheKey, response, rule) {
  if (!cacheableResponse(response, rule)) return Promise.resolve();
  const copy = response.clone();
  return caches.open(SHELL_CACHE).then((cache) => cache.put(cacheKey, copy));
}

/** Keep the worker alive for a background cache write when the browser allows it. */
function extend(event, promise) {
  const safe = promise.catch(() => undefined);
  try {
    event.waitUntil(safe);
  } catch {
    // The event already finished; the write still completes on its own.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.allSettled(SHELL.map((url) => fetch(url, { cache: 'no-cache', credentials: 'omit' }).then((res) => putIfCacheable(url, res, url === INDEX_URL ? 'shell' : 'static')))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('neo') && k !== SHELL_CACHE && k !== META_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const rule = cacheRule(request);
  if (!rule) return;

  if (rule === 'shell') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          extend(event, putIfCacheable(INDEX_URL, response, rule));
          return response;
        })
        .catch(async () => (await caches.match(INDEX_URL, { cacheName: SHELL_CACHE })) || Response.error()),
    );
    return;
  }

  // Hashed build output never changes: cache-first. Icons/manifest: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { cacheName: SHELL_CACHE });
      if (cached && rule === 'immutable') return cached;
      const network = fetch(request).then(
        (response) => {
          extend(event, putIfCacheable(request, response, rule));
          return response;
        },
        (err) => {
          if (cached) return cached;
          throw err;
        },
      );
      return cached || network;
    })(),
  );
});

// ───────────────────────────── locale (for notification buttons) ─────────────────────────────

async function readLocale() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(LOCALE_KEY);
    if (!res) return 'en';
    const { locale } = await res.json();
    return typeof locale === 'string' ? locale : 'en';
  } catch {
    return 'en';
  }
}

function stringsFor(locale) {
  return locale.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'neo:locale' || typeof data.locale !== 'string') return;
  event.waitUntil(
    caches.open(META_CACHE).then((cache) => cache.put(LOCALE_KEY, new Response(JSON.stringify({ locale: data.locale }), { headers: { 'Content-Type': 'application/json' } }))),
  );
});

// ───────────────────────────── push ─────────────────────────────

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = { body: event.data ? event.data.text() : '' };
      }
      const s = stringsFor(await readLocale());
      const data = payload && typeof payload.data === 'object' && payload.data ? payload.data : {};
      const reminderId = typeof data.reminderId === 'string' ? data.reminderId : null;
      const tag = typeof payload.tag === 'string' ? payload.tag : reminderId ? `reminder-${reminderId}` : undefined;
      await self.registration.showNotification(typeof payload.title === 'string' && payload.title ? payload.title : s.fallbackTitle, {
        body: typeof payload.body === 'string' ? payload.body : '',
        icon: new URL('./icon-192.svg', SCOPE).href,
        badge: new URL('./icon-192.svg', SCOPE).href,
        tag,
        renotify: Boolean(tag),
        requireInteraction: Boolean(reminderId),
        timestamp: Date.now(),
        data,
        actions: reminderId
          ? [
              { action: 'snooze', title: s.snooze },
              { action: 'done', title: s.done },
            ]
          : [],
      });
    })(),
  );
});

// ───────────────────────────── clicks ─────────────────────────────

const ROUTES = new Set(['memory', 'reminders', 'tasks', 'notes', 'settings']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Notification targets share the app's timeline and secondary routes. */
function hashFor(data) {
  if (typeof data.messageId === 'string' && SAFE_ID.test(data.messageId)) return `#/timeline?messageId=${encodeURIComponent(data.messageId)}`;
  const url = typeof data.url === 'string' ? data.url : '';
  const m = /^neo:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/i.exec(url);
  if (m) {
    const route = m[1].toLowerCase();
    if (route === 'timeline' || route === 'chat') {
      let segments = [];
      try {
        segments = (m[2] || '').split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        return '#/';
      }
      const query = new URLSearchParams((m[3] || '').slice(1));
      const id = query.get('messageId') || (route === 'timeline' ? segments[0] : segments[1] === 'message' || segments[1] === 'messages' ? segments[2] : segments[1]);
      return typeof id === 'string' && SAFE_ID.test(id) ? `#/timeline?messageId=${encodeURIComponent(id)}` : '#/';
    }
    if (ROUTES.has(route)) return `#/${route}${m[2] || ''}${m[3] || ''}`;
  }
  if (typeof data.reminderId === 'string') return `#/reminders/${data.reminderId}`;
  return '#/';
}

async function windowClients() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const inScope = all.filter((c) => c.url.startsWith(SCOPE));
  // Prefer the window the user last looked at.
  return inScope.sort((a, b) => Number(b.focused) - Number(a.focused) || Number(b.visibilityState === 'visible') - Number(a.visibilityState === 'visible'));
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  const action = event.action;
  notification.close();

  event.waitUntil(
    (async () => {
      const clients = await windowClients();
      if ((action === 'snooze' || action === 'done') && typeof data.reminderId === 'string') {
        if (clients.length) {
          clients[0].postMessage({ type: 'neo:reminder-action', reminderId: data.reminderId, action });
          return;
        }
        await self.clients.openWindow(new URL(`./#/reminders/${data.reminderId}`, SCOPE).href);
        return;
      }
      const hash = hashFor(data);
      if (clients.length) {
        const client = clients[0];
        await client.focus().catch(() => undefined);
        client.postMessage({ type: 'neo:navigate', url: hash });
        return;
      }
      await self.clients.openWindow(new URL(`./${hash}`, SCOPE).href);
    })(),
  );
});
