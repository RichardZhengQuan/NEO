/**
 * Tests for NeoClient, NeoApiError, readEventStream, and connect().
 *
 * Covers:
 * - HTTP method/path/query/body/headers for each route group
 * - Error mapping: JSON ErrorShape, non-JSON 502, network failure, timeout
 * - SSE parsing across chunk boundaries
 * - WebSocket auth handshake, event delivery, subscribe, reconnect with backoff,
 *   no reconnect after close() or 4401
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NeoClient, NeoApiError, readEventStream } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function makeFetch(responses: FakeResponse[]) {
  let idx = 0;
  const requests: FakeRequest[] = [];

  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req: FakeRequest = {
      method: init?.method ?? 'GET',
      url: typeof input === 'string' ? input : input.toString(),
      headers: {},
      body: undefined,
    };

    // Extract headers.
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        req.headers[k.toLowerCase()] = v;
      }
    }

    // Extract body.
    if (init?.body && typeof init.body === 'string') {
      try {
        req.body = JSON.parse(init.body);
      } catch {
        req.body = init.body;
      }
    }

    requests.push(req);

    const resp = responses[idx++] ?? { status: 200, body: {} };

    // Build Headers object.
    const respHeaders: Record<string, string> = { 'content-type': 'application/json', ...resp.headers };
    const headers = new Headers(respHeaders);

    if (resp.status === 204) {
      return new Response(null, { status: 204, headers });
    }

    const bodyStr = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    return new Response(bodyStr, { status: resp.status, headers });
  };

  return { fetchFn, requests };
}

function makeClient(responses: FakeResponse[]) {
  const { fetchFn, requests } = makeFetch(responses);
  const client = new NeoClient({
    baseUrl: 'http://localhost:7777',
    token: 'test-token',
    fetch: fetchFn as typeof fetch,
  });
  return { client, requests };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers & query encoding
// ─────────────────────────────────────────────────────────────────────────────

describe('buildQuery', () => {
  it('encodes arrays as comma-separated values', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], total: 0 } }]);
    await client.memory.search({ kinds: ['fact', 'preference'], limit: 10 });
    const req = requests[0]!;
    expect(req.url).toContain('kinds=fact%2Cpreference');
    expect(req.url).toContain('limit=10');
  });

  it('encodes booleans as true/false', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], total: 0 } }]);
    await client.conversations.list({ archived: false });
    const req = requests[0]!;
    expect(req.url).toContain('archived=false');
  });

  it('skips undefined values', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.notes.list({ query: undefined });
    expect(requests[0]!.url).not.toContain('query=');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth header
// ─────────────────────────────────────────────────────────────────────────────

describe('Authorization header', () => {
  it('sends Bearer token', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true, name: 'neo', version: '0.1.0', apiVersion: '1', mode: 'local', onboarded: true, time: 0 } }]);
    await client.health();
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
  });

  it('setToken updates subsequent requests', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
    ]);
    await client.notifications.list();
    client.setToken('new-token');
    await client.notifications.list();
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
    expect(requests[1]!.headers['authorization']).toBe('Bearer new-token');
  });

  it('omits Authorization when token is undefined', async () => {
    const { fetchFn, requests } = makeFetch([{ status: 200, body: { ok: true, name: 'neo', version: '0.1.0', apiVersion: '1', mode: 'local', onboarded: true, time: 0 } }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', fetch: fetchFn as typeof fetch });
    await client.health();
    expect(requests[0]!.headers['authorization']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('NeoApiError mapping', () => {
  it('parses a JSON ErrorShape body', async () => {
    const { client } = makeClient([{
      status: 404,
      body: { code: 'not_found', message: 'Conversation not found', retryable: false },
    }]);
    const err = await client.conversations.get('bad-id').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('not_found');
    expect(apiErr.message).toBe('Conversation not found');
    expect(apiErr.httpStatus).toBe(404);
  });

  it('falls back to internal for non-JSON 502', async () => {
    const { fetchFn } = makeFetch([]);
    let idx = 0;
    const fetchWith502 = async (): Promise<Response> => {
      idx++;
      return new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchWith502 as typeof fetch });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('internal');
    expect(apiErr.httpStatus).toBe(502);
  });

  it('maps network failure to internal retryable', async () => {
    const failFetch = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: failFetch as typeof fetch });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('internal');
    expect(apiErr.retryable).toBe(true);
  });

  it('maps timeout to timeout code', async () => {
    const timeoutFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
      // Simulate timeout by throwing a TimeoutError.
      const err = new DOMException('Timeout', 'TimeoutError');
      throw err;
    };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: timeoutFetch as typeof fetch, timeoutMs: 1 });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route groups
// ─────────────────────────────────────────────────────────────────────────────

describe('conversations routes', () => {
  it('list: GET /api/conversations', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.conversations.list({ limit: 20, archived: true });
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toContain('/api/conversations');
    expect(requests[0]!.url).toContain('limit=20');
    expect(requests[0]!.url).toContain('archived=true');
  });

  it('get: GET /api/conversations/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { conversation: {}, messages: [], hasMore: false } }]);
    await client.conversations.get('conv-1', { limit: 50 });
    expect(requests[0]!.url).toContain('/api/conversations/conv-1');
    expect(requests[0]!.url).toContain('limit=50');
  });

  it('create: POST /api/conversations', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'c1', title: 'New' } }]);
    await client.conversations.create({ title: 'New' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/conversations');
    expect((requests[0]!.body as { title: string }).title).toBe('New');
  });

  it('update: PATCH /api/conversations/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'c1' } }]);
    await client.conversations.update('c1', { pinned: true });
    expect(requests[0]!.method).toBe('PATCH');
    expect(requests[0]!.url).toContain('/api/conversations/c1');
    expect((requests[0]!.body as { pinned: boolean }).pinned).toBe(true);
  });

  it('delete: DELETE /api/conversations/:id returns void on 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    const result = await client.conversations.delete('c1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(result).toBeUndefined();
  });

  it('send: POST /api/conversations/:id/messages → 202', async () => {
    const { client, requests } = makeClient([{ status: 202, body: { turnId: 't1', assistantMessageId: 'm1', userMessage: {} } }]);
    await client.conversations.send('c1', { text: 'hello' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/conversations/c1/messages');
    expect((requests[0]!.body as { text: string }).text).toBe('hello');
  });

  it('cancel: POST /api/conversations/:id/cancel', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { cancelled: true } }]);
    await client.conversations.cancel('c1', 'turn-1');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/conversations/c1/cancel');
    expect((requests[0]!.body as { turnId: string }).turnId).toBe('turn-1');
  });

  it('uiAction: POST /api/conversations/:id/ui-action', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { kind: 'noop' } }]);
    await client.conversations.uiAction('c1', { messageId: 'm1', uiId: 'u1', actionId: 'a1' });
    expect(requests[0]!.url).toContain('/api/conversations/c1/ui-action');
  });
});

describe('confirmations routes', () => {
  it('list: GET /api/confirmations', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.confirmations.list();
    expect(requests[0]!.url).toContain('/api/confirmations');
  });

  it('respond: POST /api/confirmations/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.confirmations.respond('tc-1', { approve: true });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/confirmations/tc-1');
    expect((requests[0]!.body as { approve: boolean }).approve).toBe(true);
  });
});

describe('memory routes', () => {
  it('search: GET /api/memory with comma-separated kinds', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], total: 0 } }]);
    await client.memory.search({ kinds: ['fact', 'preference'], limit: 5 });
    expect(requests[0]!.url).toContain('/api/memory');
    expect(requests[0]!.url).toContain('kinds=fact%2Cpreference');
    expect(requests[0]!.url).toContain('limit=5');
  });

  it('get: GET /api/memory/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'm1' } }]);
    await client.memory.get('m1');
    expect(requests[0]!.url).toContain('/api/memory/m1');
  });

  it('create: POST /api/memory', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'm1' } }]);
    await client.memory.create({ content: 'I like cats', kind: 'preference' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toMatch(/\/api\/memory$/);
  });

  it('forget: POST /api/memory/forget', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { deleted: 2 } }]);
    await client.memory.forget(['m1', 'm2']);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/memory/forget');
    expect((requests[0]!.body as { ids: string[] }).ids).toEqual(['m1', 'm2']);
  });

  it('approve: POST /api/memory/approve', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { count: 1 } }]);
    await client.memory.approve(['m1']);
    expect(requests[0]!.url).toContain('/api/memory/approve');
  });

  it('reject: POST /api/memory/reject', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { count: 1 } }]);
    await client.memory.reject(['m1']);
    expect(requests[0]!.url).toContain('/api/memory/reject');
  });

  it('link: POST /api/memory/links', async () => {
    const { client, requests } = makeClient([{ status: 201, body: {} }]);
    await client.memory.link({ from: 'a', to: 'b', type: 'related' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/memory/links');
  });

  it('unlink: DELETE /api/memory/links/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.memory.unlink('edge-1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toContain('/api/memory/links/edge-1');
  });

  it('export: GET /api/memory/export?embeddings=1', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { nodes: [], edges: [], exportedAt: 0 } }]);
    await client.memory.export(true);
    expect(requests[0]!.url).toContain('embeddings=1');
  });

  it('stats: GET /api/memory/stats', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.memory.stats();
    expect(requests[0]!.url).toContain('/api/memory/stats');
  });

  it('consolidate: POST /api/memory/consolidate', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.memory.consolidate();
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/memory/consolidate');
  });

  it('journal: GET /api/memory/journal', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.memory.journal(5);
    expect(requests[0]!.url).toContain('/api/memory/journal');
    expect(requests[0]!.url).toContain('limit=5');
  });
});

describe('reminders routes', () => {
  it('list: GET /api/reminders', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.reminders.list({ status: ['scheduled', 'fired'], limit: 10 });
    expect(requests[0]!.url).toContain('/api/reminders');
    expect(requests[0]!.url).toContain('status=scheduled%2Cfired');
  });

  it('create: POST /api/reminders', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'r1' } }]);
    await client.reminders.create({ title: 'Call mom', dueAt: Date.now() + 60000 });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/reminders');
  });

  it('snooze: POST /api/reminders/:id/snooze', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'r1' } }]);
    await client.reminders.snooze('r1', 15);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/reminders/r1/snooze');
    expect((requests[0]!.body as { minutes: number }).minutes).toBe(15);
  });

  it('complete: POST /api/reminders/:id/complete', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'r1' } }]);
    await client.reminders.complete('r1');
    expect(requests[0]!.url).toContain('/api/reminders/r1/complete');
  });
});

describe('tasks routes', () => {
  it('lists: GET /api/task-lists', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.tasks.lists();
    expect(requests[0]!.url).toContain('/api/task-lists');
  });

  it('createList: POST /api/task-lists', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'tl1' } }]);
    await client.tasks.createList({ name: 'Work' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/task-lists');
  });

  it('deleteList: DELETE /api/task-lists/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.tasks.deleteList('tl1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toContain('/api/task-lists/tl1');
  });

  it('list: GET /api/tasks', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.tasks.list({ done: false, query: 'groceries' });
    expect(requests[0]!.url).toContain('/api/tasks');
    expect(requests[0]!.url).toContain('done=false');
    expect(requests[0]!.url).toContain('query=groceries');
  });

  it('create: POST /api/tasks', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'task1' } }]);
    await client.tasks.create({ title: 'Buy milk', listId: 'tl1' });
    expect(requests[0]!.method).toBe('POST');
  });

  it('delete: DELETE /api/tasks/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.tasks.delete('task1');
    expect(requests[0]!.method).toBe('DELETE');
  });
});

describe('notes routes', () => {
  it('list: GET /api/notes', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.notes.list({ tag: 'work' });
    expect(requests[0]!.url).toContain('/api/notes');
    expect(requests[0]!.url).toContain('tag=work');
  });

  it('get: GET /api/notes/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'n1' } }]);
    await client.notes.get('n1');
    expect(requests[0]!.url).toContain('/api/notes/n1');
  });

  it('delete: DELETE /api/notes/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.notes.delete('n1');
    expect(requests[0]!.method).toBe('DELETE');
  });
});

describe('notifications routes', () => {
  it('list: GET /api/notifications', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.notifications.list({ unread: true, limit: 50 });
    expect(requests[0]!.url).toContain('/api/notifications');
    expect(requests[0]!.url).toContain('unread=true');
  });

  it('markRead: POST /api/notifications/read', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { count: 3 } }]);
    await client.notifications.markRead(['n1', 'n2', 'n3']);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/notifications/read');
  });
});

describe('providers routes', () => {
  it('list: GET /api/providers', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], defaultModel: null } }]);
    await client.providers.list();
    expect(requests[0]!.url).toContain('/api/providers');
  });

  it('create: POST /api/providers', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'openai' } }]);
    await client.providers.create({ kind: 'openai', apiKey: 'sk-xxx', enabled: true });
    expect(requests[0]!.method).toBe('POST');
  });

  it('test: POST /api/providers/:id/test', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.providers.test('openai');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/providers/openai/test');
  });

  it('testDraft: POST /api/providers/test', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.providers.testDraft({ kind: 'openai', apiKey: 'sk-xxx' });
    expect(requests[0]!.url).toContain('/api/providers/test');
    expect((requests[0]!.body as { kind: string }).kind).toBe('openai');
  });
});

describe('settings routes', () => {
  it('get: GET /api/settings', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.settings.get();
    expect(requests[0]!.url).toContain('/api/settings');
  });

  it('update: PATCH /api/settings', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.settings.update({ userName: 'Alice' } as never);
    expect(requests[0]!.method).toBe('PATCH');
  });
});

describe('tools routes', () => {
  it('list: GET /api/tools', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.tools.list();
    expect(requests[0]!.url).toContain('/api/tools');
  });

  it('setPermission: PUT /api/tools/:name/permission', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { name: 'web_fetch' } }]);
    await client.tools.setPermission('web_fetch', 'auto');
    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.url).toContain('/api/tools/web_fetch/permission');
    expect((requests[0]!.body as { permission: string }).permission).toBe('auto');
  });
});

describe('devices routes', () => {
  it('list: GET /api/devices', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.devices.list();
    expect(requests[0]!.url).toContain('/api/devices');
  });

  it('create: POST /api/devices', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { device: {}, token: 'tok', pairingUrl: 'neo://...' } }]);
    await client.devices.create('My Phone', 'ios');
    expect(requests[0]!.method).toBe('POST');
    expect((requests[0]!.body as { name: string; platform: string }).name).toBe('My Phone');
    expect((requests[0]!.body as { name: string; platform: string }).platform).toBe('ios');
  });

  it('revoke: DELETE /api/devices/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.devices.revoke('dev-1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toContain('/api/devices/dev-1');
  });
});

describe('push routes', () => {
  it('vapidPublicKey: GET /api/push/vapid-public-key', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { publicKey: 'BLR...' } }]);
    const key = await client.push.vapidPublicKey();
    expect(key).toBe('BLR...');
    expect(requests[0]!.url).toContain('/api/push/vapid-public-key');
  });

  it('vapidPublicKey returns null', async () => {
    const { client } = makeClient([{ status: 200, body: { publicKey: null } }]);
    const key = await client.push.vapidPublicKey();
    expect(key).toBeNull();
  });

  it('subscribe: POST /api/push/subscribe', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    const sub = { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'abc', auth: 'def' } };
    await client.push.subscribe(sub as never);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/push/subscribe');
  });

  it('unsubscribe: POST /api/push/unsubscribe', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.push.unsubscribe('https://push.example.com/sub');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/push/unsubscribe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE / readEventStream
// ─────────────────────────────────────────────────────────────────────────────

function sseChunks(lines: string[]): Uint8Array[] {
  return [new TextEncoder().encode(lines.join(''))];
}

function makeStreamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectEvents(response: Response, signal?: AbortSignal): Promise<import('@neo/protocol').AgentEvent[]> {
  const events: import('@neo/protocol').AgentEvent[] = [];
  for await (const ev of readEventStream(response, signal)) {
    events.push(ev);
  }
  return events;
}

describe('readEventStream SSE parsing', () => {
  it('parses a simple SSE stream', async () => {
    const event = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'hello' };
    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(event)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('handles CRLF line endings', async () => {
    const event = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'world' };
    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(event)}\r\n\r\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('handles chunks split at line boundaries', async () => {
    const event = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'split' };
    const full = `data: ${JSON.stringify(event)}\n\n`;
    // Split at various points.
    const mid = Math.floor(full.length / 2);
    const chunks = [
      new TextEncoder().encode(full.slice(0, mid)),
      new TextEncoder().encode(full.slice(mid)),
    ];
    const response = makeStreamResponse(chunks);
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('handles chunks split within the data field value', async () => {
    const event = { type: 'turn.finished', conversationId: 'c1', turnId: 't1', stopReason: 'end_turn', usage: null };
    const full = `data: ${JSON.stringify(event)}\n\n`;
    // Split at multiple points.
    const chunks = [
      new TextEncoder().encode(full.slice(0, 5)),
      new TextEncoder().encode(full.slice(5, 20)),
      new TextEncoder().encode(full.slice(20)),
    ];
    const response = makeStreamResponse(chunks);
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
  });

  it('ignores comment lines', async () => {
    const event = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'hi' };
    const response = makeStreamResponse(
      sseChunks([`: keepalive\ndata: ${JSON.stringify(event)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
  });

  it('handles multiple events in one chunk', async () => {
    const e1 = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'a' };
    const e2 = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'b' };
    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(e1)}\n\ndata: ${JSON.stringify(e2)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(2);
    expect((events[0] as { text: string }).text).toBe('a');
    expect((events[1] as { text: string }).text).toBe('b');
  });

  it('ignores malformed JSON data', async () => {
    const valid = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'ok' };
    const response = makeStreamResponse(
      sseChunks([`data: not-json\n\ndata: ${JSON.stringify(valid)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
  });

  it('respects abort signal', async () => {
    const event = { type: 'text.delta', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'x' };
    const ac = new AbortController();
    ac.abort(); // Pre-aborted.

    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(event)}\n\n`])
    );
    const events = await collectEvents(response, ac.signal);
    expect(events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fake WebSocket
// ─────────────────────────────────────────────────────────────────────────────

type WsHandler = (data: string) => void;

/** Minimal fake WebSocket for connect() tests. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  private sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = FakeWebSocket.CLOSED;
  }

  getSentMessages(): string[] {
    return this.sentMessages;
  }

  // Test helpers: simulate server actions.
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    // Use a plain object instead of CloseEvent (not available in Node test env).
    const ev = { type: 'close', code, reason, wasClean: code === 1000 } as CloseEvent;
    this.onclose?.(ev);
  }
}

type FakeWsCtor = new (url: string) => FakeWebSocket;

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket connect() tests
// ─────────────────────────────────────────────────────────────────────────────

describe('connect() WebSocket', () => {
  let instances: FakeWebSocket[];
  let WsCtor: FakeWsCtor;

  beforeEach(() => {
    instances = [];
    WsCtor = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    } as unknown as FakeWsCtor;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeWsClient() {
    return new NeoClient({
      baseUrl: 'http://localhost:7777',
      token: 'ws-token',
      fetch: (() => Promise.reject(new Error('no fetch'))) as unknown as typeof fetch,
      WebSocket: WsCtor as unknown as typeof WebSocket,
    });
  }

  it('sends auth message after open', () => {
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {} });
    expect(instances).toHaveLength(1);
    const ws = instances[0]!;

    ws.simulateOpen();
    const sent = ws.getSentMessages();
    expect(sent).toHaveLength(1);
    const authMsg = JSON.parse(sent[0]!) as { type: string; token: string };
    expect(authMsg.type).toBe('auth');
    expect(authMsg.token).toBe('ws-token');
    conn.close();
  });

  it('transitions to open after ready message', () => {
    const statuses: string[] = [];
    const client = makeWsClient();
    const conn = client.connect({
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 42 });

    expect(conn.status).toBe('open');
    expect(conn.lastSeq).toBe(42);
    expect(statuses).toContain('open');
    conn.close();
  });

  it('delivers event envelopes to onEvent', () => {
    const events: unknown[] = [];
    const client = makeWsClient();
    const conn = client.connect({ onEvent: (env) => events.push(env) });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    const envelope = { seq: 1, at: Date.now(), event: { type: 'settings.updated', settings: {} } };
    ws.simulateMessage({ type: 'event', envelope });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(envelope);
    expect(conn.lastSeq).toBe(1);
    conn.close();
  });

  it('subscribe sends subscribe message', () => {
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {} });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    conn.subscribe(['conv-1', 'conv-2']);
    const msgs = ws.getSentMessages().map((m: string) => JSON.parse(m) as { type: string; conversations?: unknown });
    // The ready handler sends a subscribe with 'all'; conn.subscribe() sends another — check the last one.
    const subMsgs = msgs.filter((m) => m.type === 'subscribe');
    const subMsg = subMsgs[subMsgs.length - 1];
    expect(subMsg).toBeDefined();
    expect(subMsg!.conversations).toEqual(['conv-1', 'conv-2']);
    conn.close();
  });

  it('close() sets status to closed and does not reconnect', () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = makeWsClient();
    const conn = client.connect({
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    conn.close();
    expect(conn.status).toBe('closed');

    // Advance timers; no reconnect should happen.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1); // No new WebSocket created.
  });

  it('no reconnect after 4401 auth failure', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {} });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'error', error: { code: 'unauthorized', message: 'Bad token' } });
    ws.simulateClose(4401, 'auth failure');

    // Advance timers; no reconnect should happen.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
    expect(conn.status).toBe('closed');
  });

  it('reconnects with backoff on unexpected close', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {}, reconnect: true });
    const ws1 = instances[0]!;

    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    // Unexpected close.
    ws1.simulateClose(1001, 'Going away');
    expect(instances).toHaveLength(1); // Still just 1.

    // Advance by 1.5s (within backoff range for first attempt).
    vi.advanceTimersByTime(1500);
    expect(instances).toHaveLength(2); // New socket created.

    conn.close();
  });

  it('reconnects again after a second failure (backoff increases)', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {}, reconnect: true });

    // First connection, fail immediately.
    instances[0]!.simulateOpen();
    instances[0]!.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    instances[0]!.simulateClose(1001, 'gone');

    vi.advanceTimersByTime(2000);
    expect(instances.length).toBeGreaterThanOrEqual(2);

    // Second connection, also fail.
    const ws2 = instances[instances.length - 1]!;
    ws2.simulateOpen();
    ws2.simulateClose(1001, 'gone again');

    // The backoff delay for attempt 2 is ~2s, so advance more.
    vi.advanceTimersByTime(5000);
    expect(instances.length).toBeGreaterThanOrEqual(3);

    conn.close();
  });

  it('no reconnect when reconnect: false', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {}, reconnect: false });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    ws.simulateClose(1006, 'network error');

    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1); // No reconnect.
    conn.close();
  });

  it('resubscribes after reconnect', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({
      onEvent: () => {},
      conversations: ['c1'],
      reconnect: true,
    });

    // First connection.
    const ws1 = instances[0]!;
    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    ws1.simulateClose(1001, 'gone');

    // Reconnect.
    vi.advanceTimersByTime(2000);
    const ws2 = instances[instances.length - 1]!;
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 1 });

    const msgs2 = ws2.getSentMessages().map((m: string) => JSON.parse(m) as { type: string; conversations?: string[] });
    const sub = msgs2.find((m) => m.type === 'subscribe');
    expect(sub).toBeDefined();
    expect(sub!.conversations).toEqual(['c1']);

    conn.close();
  });

  it('uses ws:// for http:// base URL', () => {
    const client = makeWsClient();
    client.connect({ onEvent: () => {} }).close();
    expect(instances[0]!.url).toContain('ws://localhost:7777/api/ws');
  });

  it('uses wss:// for https:// base URL', () => {
    const secureClient = new NeoClient({
      baseUrl: 'https://neo.example.com',
      token: 'tok',
      fetch: (() => Promise.reject(new Error('no'))) as unknown as typeof fetch,
      WebSocket: WsCtor as unknown as typeof WebSocket,
    });
    secureClient.connect({ onEvent: () => {} }).close();
    expect(instances[0]!.url).toContain('wss://neo.example.com/api/ws');
  });
});
