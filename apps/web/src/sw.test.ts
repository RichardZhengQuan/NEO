// @vitest-environment node
/**
 * The service worker runs in a fake worker global: its caching rules must
 * never store anything authenticated (security audit NEO-20), and push /
 * notification clicks must follow the payload contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import swSource from '../public/sw.js?raw';
import manifestSource from '../public/manifest.webmanifest?raw';

it('installs and opens the PWA at the timeline without a new-chat shortcut', () => {
  const manifest: { start_url: string; shortcuts: { name: string; url: string; description: string }[] } = JSON.parse(manifestSource);
  expect(manifest.start_url).toBe('./#/');
  expect(manifest.shortcuts[0]).toEqual({ name: 'NEO', url: './#/', description: 'Open your timeline' });
  expect(manifest.shortcuts.some((shortcut) => /New chat|new conversation|#\/chat/i.test(`${shortcut.name} ${shortcut.description} ${shortcut.url}`))).toBe(false);
});

const ORIGIN = 'https://neo.example';
const SCOPE = `${ORIGIN}/neo/`;

type Listener = (event: unknown) => void;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  private key(req: string | FakeRequest): string {
    return typeof req === 'string' ? req : req.url;
  }
  async match(req: string | FakeRequest): Promise<Response | undefined> {
    return this.entries.get(this.key(req))?.clone();
  }
  async put(req: string | FakeRequest, res: Response): Promise<void> {
    this.entries.set(this.key(req), res);
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) this.stores.set(name, (cache = new FakeCache()));
    return cache;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
  async match(req: string | FakeRequest, opts?: { cacheName?: string }): Promise<Response | undefined> {
    const names = opts?.cacheName ? [opts.cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
  allUrls(): string[] {
    return [...this.stores.values()].flatMap((c) => [...c.entries.keys()]);
  }
}

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const res = new Response(body, { status: init.status ?? 200, headers: init.headers });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

function request(path: string, init: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {}): FakeRequest {
  return {
    url: new URL(path, init.origin ?? ORIGIN).href,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
    headers: new Headers(init.headers),
  };
}

interface Harness {
  caches: FakeCacheStorage;
  fetch: ReturnType<typeof vi.fn>;
  showNotification: ReturnType<typeof vi.fn>;
  clients: { matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn> };
  dispatch(type: string, event: Record<string, unknown>): { responded: Promise<Response> | null; pending: Promise<unknown>[] };
  fetchEvent(req: FakeRequest): Promise<Response | null>;
}

function loadWorker(): Harness {
  const listeners = new Map<string, Listener[]>();
  const caches = new FakeCacheStorage();
  const fetchMock = vi.fn(async (input: string | FakeRequest) => response(`network:${typeof input === 'string' ? input : input.url}`));
  const showNotification = vi.fn(async () => undefined);
  const clients = { matchAll: vi.fn(async () => [] as unknown[]), openWindow: vi.fn(async () => null), claim: vi.fn(async () => undefined) };
  const self = {
    registration: { scope: SCOPE, showNotification },
    location: { origin: ORIGIN, href: `${SCOPE}sw.js` },
    clients,
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  };
  new Function('self', 'caches', 'fetch', swSource)(self, caches, fetchMock);

  const dispatch: Harness['dispatch'] = (type, extra) => {
    let responded: Promise<Response> | null = null;
    const pending: Promise<unknown>[] = [];
    const event = {
      ...extra,
      respondWith: (p: Promise<Response>) => {
        responded = Promise.resolve(p);
      },
      waitUntil: (p: Promise<unknown>) => {
        pending.push(Promise.resolve(p));
      },
    };
    for (const fn of listeners.get(type) ?? []) fn(event);
    return { responded, pending };
  };

  return {
    caches,
    fetch: fetchMock,
    showNotification,
    clients,
    dispatch,
    async fetchEvent(req) {
      const { responded, pending } = dispatch('fetch', { request: req });
      const res = responded ? await responded : null;
      await Promise.all(pending);
      // Background cache writes chain a couple of microtasks.
      await new Promise((r) => setTimeout(r, 0));
      return res;
    },
  };
}

describe('service worker caching (allow-list only)', () => {
  let sw: Harness;
  beforeEach(() => {
    sw = loadWorker();
  });

  it('never intercepts API requests, at the root or behind a prefix', async () => {
    for (const path of ['/api/health', '/api', '/neo/api/timeline', '/neo/api', '/neo/v2/api/memory/export', '/neo/API/settings']) {
      expect(await sw.fetchEvent(request(path)), path).toBeNull();
    }
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('never intercepts requests that carry an Authorization header, even for static paths', async () => {
    expect(await sw.fetchEvent(request('/neo/assets/index-abc.js', { headers: { Authorization: 'Bearer secret' } }))).toBeNull();
    expect(await sw.fetchEvent(request('/neo/', { mode: 'navigate', headers: { authorization: 'Bearer secret' } }))).toBeNull();
    expect(sw.caches.allUrls()).toEqual([]);
  });

  it('ignores non-GET, cross-origin, out-of-scope and unknown same-origin paths', async () => {
    expect(await sw.fetchEvent(request('/neo/assets/a.js', { method: 'POST' }))).toBeNull();
    expect(await sw.fetchEvent(request('/neo/assets/a.js', { origin: 'https://cdn.example' }))).toBeNull();
    expect(await sw.fetchEvent(request('/other/assets/a.js'))).toBeNull();
    expect(await sw.fetchEvent(request('/neo/data/export.json'))).toBeNull();
    expect(await sw.fetchEvent(request('/neo/assets/a.js?token=abc'))).toBeNull();
    expect(await sw.fetchEvent(request('/neo/reminders', { mode: 'navigate' }))).toBeNull();
    expect(sw.caches.allUrls()).toEqual([]);
  });

  it('caches hashed assets cache-first', async () => {
    const req = request('/neo/assets/index-abc.js');
    expect(await (await sw.fetchEvent(req))?.text()).toBe(`network:${req.url}`);
    expect(sw.caches.allUrls()).toEqual([req.url]);
    sw.fetch.mockClear();
    expect(await (await sw.fetchEvent(req))?.text()).toBe(`network:${req.url}`);
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('never caches an HTML fallback page under an asset URL', async () => {
    const asset = request('/neo/assets/dog-abc.webp');
    const html = { 'Content-Type': 'text/html; charset=utf-8' };
    sw.fetch.mockResolvedValueOnce(response('<!doctype html>', { headers: html }));
    expect(await (await sw.fetchEvent(asset))?.text()).toBe('<!doctype html>');
    sw.fetch.mockResolvedValueOnce(response('<!doctype html>', { headers: html }));
    await sw.fetchEvent(request('/neo/manifest.webmanifest'));
    expect(sw.caches.allUrls()).toEqual([]);
    // Once the file is back, the next request reaches the network and caches it.
    sw.fetch.mockResolvedValueOnce(response('webp', { headers: { 'Content-Type': 'image/webp' } }));
    expect(await (await sw.fetchEvent(asset))?.text()).toBe('webp');
    expect(sw.caches.allUrls()).toEqual([asset.url]);
    // The shell itself is still HTML and still cached.
    sw.fetch.mockResolvedValueOnce(response('<!doctype html>', { headers: html }));
    await sw.fetchEvent(request('/neo/', { mode: 'navigate' }));
    expect(sw.caches.allUrls()).toContain(`${SCOPE}index.html`);
  });

  it('does not store responses marked no-store or private, or that vary on credentials', async () => {
    const cases: Record<string, string>[] = [{ 'Cache-Control': 'no-store' }, { 'Cache-Control': 'private, max-age=60' }, { Vary: 'Authorization' }];
    for (const headers of cases) {
      sw.fetch.mockResolvedValueOnce(response('secret', { headers }));
      const res = await sw.fetchEvent(request('/neo/manifest.webmanifest'));
      expect(await res?.text()).toBe('secret');
    }
    sw.fetch.mockResolvedValueOnce(response('nope', { status: 401 }));
    await sw.fetchEvent(request('/neo/icon-192.svg'));
    expect(sw.caches.allUrls()).toEqual([]);
  });

  it('serves the app shell network-first with the cached copy offline', async () => {
    const nav = request('/neo/?r=1', { mode: 'navigate' });
    expect(await (await sw.fetchEvent(nav))?.text()).toBe(`network:${nav.url}`);
    expect(sw.caches.allUrls()).toEqual([`${SCOPE}index.html`]);
    sw.fetch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await (await sw.fetchEvent(nav))?.text()).toBe(`network:${nav.url}`);
  });

  it('precaches only the static shell on install, and purges old NEO caches on activate', async () => {
    await sw.caches.open('neo-shell-v3');
    await sw.caches.open('neo-shell-v2');
    await sw.caches.open('neo-shell-v1');
    await sw.caches.open('neo-meta');
    const install = sw.dispatch('install', {});
    await Promise.all(install.pending);
    const urls = sw.caches.allUrls();
    expect(urls).toContain(`${SCOPE}index.html`);
    expect(urls.every((u) => u.startsWith(SCOPE) && !/\/api(\/|$)/.test(u))).toBe(true);
    const activate = sw.dispatch('activate', {});
    await Promise.all(activate.pending);
    const names = await sw.caches.keys();
    expect(names).not.toContain('neo-shell-v1');
    expect(names).not.toContain('neo-shell-v2');
    expect(names).not.toContain('neo-shell-v3');
    expect(names).toContain('neo-meta');
    expect(names.some((n) => /^neo-shell-v\d+$/.test(n))).toBe(true);
    expect(sw.clients.claim).toHaveBeenCalled();
  });
});

describe('service worker push + clicks', () => {
  it('shows reminder pushes with Snooze / Done actions', async () => {
    const sw = loadWorker();
    const payload = { title: 'Stretch', body: 'Time to stretch', data: { url: 'neo://reminders/rem_1', reminderId: 'rem_1' } };
    const { pending } = sw.dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
    await Promise.all(pending);
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sw.showNotification.mock.calls[0] as unknown as [string, { body: string; tag: string; actions: { action: string }[]; data: unknown }];
    expect(title).toBe('Stretch');
    expect(options.body).toBe('Time to stretch');
    expect(options.tag).toBe('reminder-rem_1');
    expect(options.actions.map((a) => a.action)).toEqual(['snooze', 'done']);
    expect(options.data).toEqual(payload.data);
  });

  it('plain pushes have no actions and fall back to the app name', async () => {
    const sw = loadWorker();
    const { pending } = sw.dispatch('push', { data: { json: () => ({ body: 'Hello' }), text: () => '' } });
    await Promise.all(pending);
    const [title, options] = sw.showNotification.mock.calls[0] as unknown as [string, { actions: unknown[] }];
    expect(title).toBe('NEO');
    expect(options.actions).toEqual([]);
  });

  it('routes a Snooze click to an open window, or opens the reminder', async () => {
    const sw = loadWorker();
    const client = { url: `${SCOPE}#/`, focused: true, visibilityState: 'visible', postMessage: vi.fn(), focus: vi.fn(async () => undefined) };
    sw.clients.matchAll.mockResolvedValueOnce([client]);
    const close = vi.fn();
    let run = sw.dispatch('notificationclick', { action: 'snooze', notification: { data: { reminderId: 'rem_1' }, close } });
    await Promise.all(run.pending);
    expect(close).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'neo:reminder-action', reminderId: 'rem_1', action: 'snooze' });

    run = sw.dispatch('notificationclick', { action: '', notification: { data: { url: 'neo://reminders/rem_2' }, close } });
    await Promise.all(run.pending);
    expect(sw.clients.openWindow).toHaveBeenCalledWith(`${SCOPE}#/reminders/rem_2`);
  });

  it.each([
    [{ url: 'neo://timeline/msg_1', reminderId: 'rem_1' }, '#/timeline?messageId=msg_1'],
    [{ url: 'neo://timeline?messageId=msg_1' }, '#/timeline?messageId=msg_1'],
    [{ messageId: 'msg_1', reminderId: 'rem_1' }, '#/timeline?messageId=msg_1'],
    [{ url: 'neo://chat/conv_1?messageId=msg_1' }, '#/timeline?messageId=msg_1'],
    [{ url: 'neo://chat/conv_1' }, '#/'],
    [{ url: 'neo://elsewhere' }, '#/'],
  ])('opens notification target %j at %s', async (data, hash) => {
    const sw = loadWorker();
    const { pending } = sw.dispatch('notificationclick', { action: '', notification: { data, close: vi.fn() } });
    await Promise.all(pending);
    expect(sw.clients.openWindow).toHaveBeenCalledWith(`${SCOPE}${hash}`);
  });

  it('sends a timeline jump to the focused open window', async () => {
    const sw = loadWorker();
    const client = { url: `${SCOPE}#/memory`, focused: true, visibilityState: 'visible', postMessage: vi.fn(), focus: vi.fn(async () => undefined) };
    sw.clients.matchAll.mockResolvedValueOnce([client]);
    const { pending } = sw.dispatch('notificationclick', { action: '', notification: { data: { url: 'neo://timeline/msg_1' }, close: vi.fn() } });
    await Promise.all(pending);
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'neo:navigate', url: '#/timeline?messageId=msg_1' });
  });
});
