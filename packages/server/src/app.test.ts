import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INBOX_LIST_ID, NeoError, parsePairingLink, parsePairingUrl } from '@neo/protocol';
import type { Conversation, Message, MemoryNode, Note, PairingSession, PhoneAccessStatus, ProviderView, Reminder, Task, TaskList, UiActionResult } from '@neo/protocol';
import { createApp } from './app.js';
import { routeFixture, OWNER_TOKEN } from './route-fixture.test-utils.js';

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

describe('HTTP API with real SQLite stores and fake runtime/memory/providers', () => {
  let f: ReturnType<typeof routeFixture>;
  const directories: string[] = [];
  beforeEach(() => { f = routeFixture(); });
  afterEach(async () => {
    await f.services.close();
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('public health, auth, device tokens, revocation and owner-only pairing', async () => {
    const health = await json<{ time: number; onboarded: boolean }>(await f.request('/api/health', 'GET', undefined, null));
    expect(health).toMatchObject({ time: f.time.now, onboarded: false });
    const missing = await json<{ code: string }>(await f.request('/api/settings', 'GET', undefined, null), 401);
    expect(missing.code).toBe('unauthorized');
    expect((await f.request('/api/settings', 'GET', undefined, 'wrong')).status).toBe(401);
    const paired = await json<{ device: { id: string }; token: string; pairingUrl: string }>(await f.request('/api/devices', 'POST', { name: 'Phone', platform: 'ios' }), 201);
    expect(parsePairingUrl(paired.pairingUrl)).toEqual({ serverUrl: 'http://localhost', token: paired.token });
    expect((await f.request('/api/settings', 'GET', undefined, paired.token)).status).toBe(200);
    expect((await f.request('/api/devices', 'GET', undefined, paired.token)).status).toBe(200);
    expect((await f.request('/api/devices', 'POST', { name: 'Another' }, paired.token)).status).toBe(403);
    expect((await f.request(`/api/devices/${paired.device.id}`, 'DELETE')).status).toBe(204);
    expect((await f.request('/api/settings', 'GET', undefined, paired.token)).status).toBe(401);
    const owner = f.services.devices.list().find((d) => d.owner)!;
    expect((await f.request(`/api/devices/${owner.id}`, 'DELETE')).status).toBe(400);
    expect((await f.request('/api/devices/missing', 'DELETE')).status).toBe(404);
  });

  it('uses publicUrl for pairing and ignores a caller-controlled Origin', async () => {
    f.services.config.server.publicUrl = 'https://neo.example/base';
    const result = await json<{ pairingUrl: string }>(await f.request('/api/devices', 'POST', { name: 'Phone' }, OWNER_TOKEN, { Origin: 'https://attacker.example' }), 201);
    expect(parsePairingUrl(result.pairingUrl)?.serverUrl).toBe('https://neo.example/base');
  });

  it('allows any device to inspect phone access but only the owner to change it', async () => {
    const paired = f.services.devices.create({ name: 'Phone', platform: 'ios', owner: false });
    const initial = await json<PhoneAccessStatus>(await f.request('/api/phone-access', 'GET', undefined, paired.token));
    expect(initial).toMatchObject({ enabled: false, lan: { listening: false, port: null, addresses: [], error: null }, relay: { status: 'off' } });
    expect(initial.serverId).toMatch(/^[a-f0-9]{32}$/);
    expect(initial.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await f.request('/api/phone-access', 'GET', undefined, null)).status).toBe(401);
    expect((await f.request('/api/phone-access', 'PATCH', { enabled: true }, paired.token)).status).toBe(403);
    expect(f.services.settings.get().phoneAccess.enabled).toBe(false);
    expect(await json(await f.request('/api/phone-access', 'PATCH', { enabled: true, relayUrl: 'wss://relay.example' }))).toMatchObject({
      enabled: true, lan: { listening: false }, relay: { url: 'wss://relay.example', status: 'off', error: null },
    });
    expect(await json(await f.request('/api/phone-access', 'PATCH', { enabled: false }))).toMatchObject({ enabled: false });
  });

  it('accepts default, disabled and websocket relay URLs without starting the manager', async () => {
    f.services.config.tunnel.relayUrl = 'wss://default.example';
    for (const [relayUrl, expected] of [[null, 'wss://default.example'], ['', null], ['ws://relay.example/path', 'ws://relay.example/path']] as const) {
      expect(await json(await f.request('/api/phone-access', 'PATCH', { relayUrl }))).toMatchObject({ relay: { url: expected, status: 'off' } });
      expect(f.services.settings.get().phoneAccess.relayUrl).toBe(relayUrl);
    }
  });

  it.each(['https://relay.example', 'file:///tmp/relay', 'wss://user:secret@relay.example', 'wss://relay.example?token=secret', 'wss://relay.example#private', 'wss://relay.example?', 'wss://relay.example#', 'not a URL'])('rejects malformed or credential-bearing relay URL %s', async (relayUrl) => {
    expect(await json(await f.request('/api/phone-access', 'PATCH', { enabled: true, relayUrl }), 400)).toMatchObject({ code: 'bad_request' });
    expect(f.services.settings.get().phoneAccess).toMatchObject({ enabled: false, relayUrl: null });
  });

  it('rejects phone access on general settings patches even for the owner', async () => {
    const paired = f.services.devices.create({ name: 'Phone', platform: 'android', owner: false });
    for (const token of [OWNER_TOKEN, paired.token]) {
      expect(await json(await f.request('/api/settings', 'PATCH', { phoneAccess: { enabled: true }, onboarded: true }, token), 400)).toMatchObject({
        code: 'bad_request', message: 'Use PATCH /api/phone-access',
      });
    }
    expect(f.services.settings.get()).toMatchObject({ phoneAccess: { enabled: false }, onboarded: false });
  });

  it('pairing enables local phone access and never advertises a loopback or tunnel origin', async () => {
    const loopback = await json<{ code: string }>(await f.request('/api/pairing', 'POST'), 409);
    expect(loopback.code).toBe('conflict');
    expect(f.services.settings.get().phoneAccess.enabled).toBe(true);
    expect(await json(await f.request('/api/phone-access'))).toMatchObject({ enabled: true, lan: { listening: false } });
    expect((await f.request('http://0123456789abcdef0123456789abcdef.tunnel.invalid/api/pairing', 'POST')).status).toBe(409);
    const lan = await json<PairingSession>(await f.request('http://192.168.1.20:7777/api/pairing', 'POST'), 201);
    expect(parsePairingLink(lan.pairingUrl)).toMatchObject({ version: 2, serverUrl: 'http://192.168.1.20:7777', tunnel: null });
  });

  it('pairing through a public URL leaves phone access off', async () => {
    f.services.config.server.publicUrl = 'https://neo.example';
    const result = await json<PairingSession>(await f.request('/api/pairing', 'POST'), 201);
    expect(f.services.settings.get().phoneAccess.enabled).toBe(false);
    expect(parsePairingLink(result.pairingUrl)).toMatchObject({ version: 2, serverUrl: 'https://neo.example', tunnel: null });
  });

  it('limits failed auth to ten per IP per minute using the injected clock', async () => {
    f.services.config.server.trustProxy = true;
    const { app } = createApp(f.services);
    const request = (ip: string) => app.request('/api/settings', { headers: { Authorization: 'Bearer wrong', 'X-Forwarded-For': ip } });
    for (let i = 0; i < 10; i++) expect((await request('1.2.3.4')).status).toBe(401);
    const limited = await request('1.2.3.4');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(await limited.json()).toMatchObject({ code: 'rate_limited', retryable: true });
    expect((await request('1.2.3.5')).status).toBe(401);
    f.time.now += 60_001;
    expect((await request('1.2.3.4')).status).toBe(401);
  });

  it('ignores untrusted proxy headers and keeps limiter state per app', async () => {
    for (let i = 0; i < 10; i++) expect((await f.request('/api/settings', 'GET', undefined, null, { 'X-Forwarded-For': `spoof-${i}` })).status).toBe(401);
    expect((await f.request('/api/settings', 'GET', undefined, null)).status).toBe(429);
    expect((await f.request('/api/settings', 'GET', undefined, OWNER_TOKEN)).status).toBe(200);
    const { app } = createApp(f.services);
    expect((await app.request('/api/settings', { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).status).toBe(200);
  });

  it('lists the timeline in pages and closes an episode when a message is deleted', async () => {
    const episode = f.services.conversations.createEpisode();
    for (let i = 1; i <= 4; i++) f.services.conversations.appendMessage({ id: `message-${i}`, conversationId: episode.id, role: 'user', parts: [{ type: 'text', text: String(i) }], createdAt: f.time.now + i, status: 'complete' });
    const page = await json<import('@neo/protocol').TimelinePage>(await f.request('/api/timeline?limit=2'));
    expect(page.items.map(message => message.id)).toEqual(['message-3', 'message-4']);
    expect(page.nextCursor).toBeTruthy();
    const older = await json<import('@neo/protocol').TimelinePage>(await f.request(`/api/timeline?limit=2&before=${encodeURIComponent(page.nextCursor!)}`));
    expect(older.items.map(message => message.id)).toEqual(['message-1', 'message-2']);
    expect(older.nextCursor).toBeNull();
    expect(older.episodes).toMatchObject([{ episodeId: episode.id }]);
    expect(await json(await f.request('/api/timeline/messages/message-3', 'DELETE'))).toEqual({ deleted: 1, messageIds: ['message-3'], derivedMemories: 0 });
    expect(f.services.conversations.currentEpisode()).toBeNull();
    expect((await f.request('/api/timeline/messages/message-3', 'DELETE')).status).toBe(404);
  });

  it('sends 202 and SSE with episode ids and never forwards a disconnect signal', async () => {
    const conv = f.services.conversations.create({ model: { provider: 'conversation', model: 'chosen' } });
    f.services.settings.update({ defaultModel: { provider: 'default', model: 'fallback' } });
    const sent = await json<import('@neo/protocol').SendMessageResponse>(await f.request('/api/timeline/messages', 'POST', { text: 'Hello', parts: [] }), 202);
    expect(sent.episodeId).toBe(conv.id);
    expect(sent.userMessage.episodeId).toBe(conv.id);
    expect(sent.userMessage.parts).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(f.services.runtime.sendTimeline).toHaveBeenLastCalledWith({ parts: [{ type: 'text', text: 'Hello' }], offRecord: undefined });
    const stream = await f.request('/api/timeline/messages', 'POST', { parts: [{ type: 'text', text: 'Stream' }] }, OWNER_TOKEN, { Accept: 'text/event-stream' });
    expect(stream.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await stream.text();
    expect(text).toContain('event: turn.started\ndata: {');
    expect(text).toContain('event: text.delta\ndata: {');
    expect(text).toContain('event: turn.finished\ndata: {');
    expect(vi.mocked(f.services.runtime.sendTimeline).mock.calls.at(-1)?.[0]).not.toHaveProperty('signal');
  });

  it('F09: text+image parts — merges body.text into parts when no text part exists', async () => {
    const conv = f.services.conversations.create();
    const img = { type: 'image', mediaType: 'image/png', data: 'base64abc' };
    // Client sends text alongside image parts (the fixed composeBody format).
    const res = await json<{ userMessage: Message }>(
      await f.request('/api/timeline/messages', 'POST', {
        parts: [{ type: 'text', text: 'Describe this' }, img],
      }),
      202,
    );
    expect(res.userMessage.parts).toEqual([{ type: 'text', text: 'Describe this' }, img]);
    expect(f.services.runtime.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ parts: [{ type: 'text', text: 'Describe this' }, img] }),
    );
  });

  it('F09: legacy body.text + image parts — server prepends text part (backward compat)', async () => {
    const conv = f.services.conversations.create();
    const img = { type: 'image', mediaType: 'image/png', data: 'base64legacy' };
    // Old client sends text separately; server must merge them.
    const res = await json<{ userMessage: Message }>(
      await f.request('/api/timeline/messages', 'POST', {
        text: 'Describe this',
        parts: [img],
      }),
      202,
    );
    expect(res.userMessage.parts).toEqual([{ type: 'text', text: 'Describe this' }, img]);
  });

  it('F09: image-only parts — no body.text means no extra text part is prepended', async () => {
    const conv = f.services.conversations.create();
    const img = { type: 'image', mediaType: 'image/png', data: 'base64img' };
    const res = await json<{ userMessage: Message }>(
      await f.request('/api/timeline/messages', 'POST', { parts: [img] }),
      202,
    );
    expect(res.userMessage.parts).toEqual([img]);
  });

  it('cancels only a matching active turn', async () => {
    const conv = f.services.conversations.create();
    vi.mocked(f.services.runtime.activeTurns).mockReturnValue([{ conversationId: 'other', turnId: 'turn-other', startedAt: f.time.now }]);
    expect(await json(await f.request('/api/timeline/cancel', 'POST', { turnId: 'unknown' }))).toEqual({ cancelled: false });
    expect(f.services.runtime.cancel).not.toHaveBeenCalled();
    vi.mocked(f.services.runtime.activeTurns).mockReturnValue([{ conversationId: conv.id, turnId: 'turn-here', startedAt: f.time.now }]);
    expect(await json(await f.request('/api/timeline/cancel', 'POST', { turnId: 'turn-here' }))).toEqual({ cancelled: true });
  });

  it.each(['noop', 'tool', 'client', 'turn', 'confirm'] as const)('maps ui-action %s results to UiActionResponse', async (kind) => {
    const conv = f.services.conversations.create();
    let result: UiActionResult = { kind: 'noop' };
    if (kind === 'tool') result = { kind, result: { output: { reminder: 'snoozed' }, summary: 'Snoozed' } };
    if (kind === 'client') result = { kind, action: { kind: 'copy', id: 'copy', label: 'Copy', text: 'hello' } };
    if (kind === 'turn') result = { kind, turn: await f.services.runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Action' }] }) };
    if (kind === 'confirm') result = { kind, confirmation: { token: 'server-token', tool: 'forget', title: 'Forget memories', description: 'Forget “Hiking”', risk: 'dangerous', expiresAt: f.time.now + 10000 } };
    vi.mocked(f.services.runtime.handleTimelineUiAction).mockResolvedValue(result);
    const body = { messageId: 'message-1', uiId: 'ui-1', actionId: 'action-1', values: { name: 'Richard' } };
    const response = await json<Record<string, unknown>>(await f.request('/api/timeline/ui-action', 'POST', body));
    expect(response.kind).toBe(kind);
    if (kind === 'tool') expect(response).toMatchObject({ isError: false, output: { reminder: 'snoozed' } });
    if (kind === 'turn') expect(response).toHaveProperty('assistantMessageId');
    if (kind === 'confirm' && result.kind === 'confirm') expect(response).toEqual(result);
    expect(f.services.runtime.handleTimelineUiAction).toHaveBeenCalledWith(body);
  });

  it('round-trips a UI confirmation token and preserves runtime replay errors', async () => {
    const conv = f.services.conversations.create();
    const body = { messageId: 'message-1', uiId: 'ui-1', actionId: 'memory.forget:memory-1', values: { scope: 'one' } };
    const confirmation = { token: 'single-use-token', tool: 'forget', title: 'Forget memories', description: 'Forget “Hiking”', risk: 'dangerous' as const, expiresAt: f.time.now + 10000 };
    let consumed = false;
    vi.mocked(f.services.runtime.handleTimelineUiAction).mockImplementation(async (input) => {
      if (!input.confirmationToken) return { kind: 'confirm', confirmation };
      if (consumed || input.confirmationToken !== confirmation.token) throw new NeoError('conflict', 'UI confirmation token is invalid or already used');
      consumed = true;
      return { kind: 'tool', result: { output: { forgotten: ['Hiking'] }, summary: 'Forgot 1 memory' } };
    });
    const path = '/api/timeline/ui-action';
    expect(await json(await f.request(path, 'POST', body))).toEqual({ kind: 'confirm', confirmation });
    const approved = { ...body, confirmationToken: confirmation.token };
    expect(await json(await f.request(path, 'POST', approved))).toEqual({ kind: 'tool', output: { forgotten: ['Hiking'] }, summary: 'Forgot 1 memory', isError: false });
    expect(f.services.runtime.handleTimelineUiAction).toHaveBeenLastCalledWith(approved);
    expect(await json(await f.request(path, 'POST', approved), 409)).toMatchObject({ code: 'conflict', message: expect.stringContaining('already used') });
  });

  it('lists confirmation nonces and answers by nonce, with unknown and reused 404s', async () => {
    f.confirmations.set('cnf-server-1', { id: 'cnf-server-1', conversationId: 'conv', episodeId: 'conv', turnId: 'turn', messageId: 'message', toolCallId: 'provider-call-1', name: 'delete_task', title: 'Delete', input: {}, description: 'Delete task', risk: 'dangerous', requestedAt: f.time.now, expiresAt: f.time.now + 10000 });
    expect(await json(await f.request('/api/confirmations'))).toMatchObject({ items: [{ id: 'cnf-server-1', toolCallId: 'provider-call-1' }] });
    expect((await f.request('/api/confirmations/provider-call-1', 'POST', { approve: true })).status).toBe(404);
    expect(await json(await f.request('/api/confirmations/cnf-server-1', 'POST', { approve: true, always: true }))).toEqual({ ok: true });
    expect(f.services.runtime.confirm).toHaveBeenCalledWith('cnf-server-1', { approve: true, always: true });
    expect((await f.request('/api/confirmations/cnf-server-1', 'POST', { approve: true })).status).toBe(404);
    expect((await f.request('/api/confirmations/unknown', 'POST', { approve: true })).status).toBe(404);
  });

  it('covers every memory route, source attribution, query coercion and export/import', async () => {
    const node = await json<MemoryNode>(await f.request('/api/memory', 'POST', { content: 'Richard likes hiking', kind: 'preference', source: { by: 'tool' }, tags: ['outdoors'] }), 201);
    expect(node.source).toEqual({ by: 'user' });
    const found = await json<{ items: MemoryNode[]; total: number }>(await f.request('/api/memory?query=hiking&kinds=fact,preference&status=active,archived&tags=outdoors,fitness&pinned=0&limit=5&offset=0&sort=recent'));
    expect(found.total).toBe(1);
    expect(f.services.memory.search).toHaveBeenLastCalledWith({ query: 'hiking', kinds: ['fact', 'preference'], status: ['active', 'archived'], tags: ['outdoors', 'fitness'], pinned: false, limit: 5, offset: 0, sort: 'recent' });
    expect(await json(await f.request(`/api/memory/${node.id}`))).toMatchObject({ node: { id: node.id }, retention: 1 });
    expect(await json(await f.request(`/api/memory/${node.id}`, 'PATCH', { label: 'Outdoor interests', pinned: true }))).toMatchObject({ pinned: true });
    expect(await json(await f.request('/api/memory/stats'))).toMatchObject({ total: 1 });
    expect(await json(await f.request(`/api/memory/graph?centerId=${node.id}&depth=2&limit=5&kinds=preference&includeArchived=1`))).toMatchObject({ nodes: [{ id: node.id }], edges: [] });
    expect(f.services.memory.graph).toHaveBeenCalledWith({ centerId: node.id, depth: 2, limit: 5, kinds: ['preference'], includeArchived: true });
    expect(await json(await f.request('/api/memory/journal?limit=2'))).toMatchObject({ items: [{ id: 'cons_1' }] });
    expect(await json(await f.request('/api/memory/consolidate', 'POST'))).toMatchObject({ id: 'cons_1' });
    expect(f.services.memory.consolidate).toHaveBeenCalledWith({ force: true });
    const exported = await f.request('/api/memory/export?embeddings=1');
    expect(exported.headers.get('Content-Disposition')).toBe('attachment; filename=neo-memory-2026-10-10.json');
    expect(f.services.memory.export).toHaveBeenCalledWith({ includeEmbeddings: true });
    const data = await exported.json();
    expect(await json(await f.request('/api/memory/import', 'POST', { data, mode: 'merge' }))).toEqual({ nodes: 1, edges: 0, skipped: 0 });
    expect(await json(await f.request('/api/memory/find-for-forget', 'POST', { query: 'hiking', limit: 2 }))).toMatchObject({ items: [{ id: node.id }] });
    expect(await json(await f.request('/api/memory/links', 'POST', { from: node.id, to: 'mem-2', type: 'related', weight: .7 }))).toMatchObject({ id: 'edge_1', weight: .7 });
    expect(await json(await f.request('/api/memory/links/edge_1', 'DELETE'))).toEqual({ ok: true });
    expect(await json(await f.request('/api/memory/links/missing', 'DELETE'))).toEqual({ ok: false });
    expect(await json(await f.request(`/api/memory/${node.id}`, 'DELETE'))).toEqual({ deleted: 1 });
    expect(await json(await f.request('/api/memory/forget', 'POST', { ids: ['missing'] }))).toEqual({ deleted: 0 });
    expect((await f.request(`/api/memory/${node.id}`)).status).toBe(404);
  });

  it('reminder CRUD defaults timezone, handles status lists, snooze and complete, emits once', async () => {
    const reminder = await json<Reminder>(await f.request('/api/reminders', 'POST', { title: 'Water', dueAt: f.time.now + 1000 }), 201);
    expect(reminder.timezone).toBe('Asia/Singapore');
    expect(await json(await f.request(`/api/reminders/${reminder.id}`))).toMatchObject({ id: reminder.id });
    expect(await json(await f.request(`/api/reminders?status=scheduled,fired&from=${f.time.now}&to=${f.time.now + 10000}&limit=3`))).toMatchObject({ items: [{ id: reminder.id }] });
    expect(await json(await f.request(`/api/reminders/${reminder.id}`, 'PATCH', { title: 'Drink water', notes: 'One glass' }))).toMatchObject({ title: 'Drink water' });
    expect(await json(await f.request(`/api/reminders/${reminder.id}/snooze`, 'POST', { minutes: 10 }))).toMatchObject({ dueAt: f.time.now + 600000 });
    expect(await json(await f.request(`/api/reminders/${reminder.id}/complete`, 'POST'))).toMatchObject({ status: 'completed' });
    expect((await f.request(`/api/reminders/${reminder.id}`, 'DELETE')).status).toBe(204);
    expect(f.services.events.since(0).filter((e) => e.event.type === 'reminder.updated')).toHaveLength(4);
    expect(f.services.events.since(0).filter((e) => e.event.type === 'reminder.deleted')).toHaveLength(1);
    expect((await f.request(`/api/reminders/${reminder.id}`)).status).toBe(404);
  });

  it('task lists and task CRUD, boolean filtering and inbox protection', async () => {
    expect(await json(await f.request('/api/task-lists'))).toMatchObject({ items: [{ id: INBOX_LIST_ID }] });
    const list = await json<TaskList>(await f.request('/api/task-lists', 'POST', { name: 'Hiking', color: 'green' }), 201);
    expect(await json(await f.request(`/api/task-lists/${list.id}`, 'PATCH', { name: 'Weekend' }))).toMatchObject({ name: 'Weekend' });
    const task = await json<Task>(await f.request('/api/tasks', 'POST', { title: 'Pack water', listId: list.id }), 201);
    expect(await json(await f.request(`/api/tasks?listId=${list.id}&done=0&query=water&limit=1`))).toMatchObject({ items: [{ id: task.id }] });
    expect(await json(await f.request(`/api/tasks/${task.id}`, 'PATCH', { done: true, priority: 3 }))).toMatchObject({ done: true, priority: 3, doneAt: f.time.now });
    expect((await f.request(`/api/tasks/${task.id}`, 'PATCH', { listId: 'missing-list' })).status).toBe(404);
    const seq = f.services.events.seq;
    expect((await f.request(`/api/task-lists/${list.id}`, 'DELETE')).status).toBe(204);
    expect(f.services.stores.tasks.get(task.id)?.listId).toBe(INBOX_LIST_ID);
    expect(f.services.events.since(seq).filter((e) => e.event.type === 'task.updated')).toEqual([
      expect.objectContaining({ event: { type: 'task.updated', task: expect.objectContaining({ id: task.id, listId: INBOX_LIST_ID }) } }),
    ]);
    expect((await f.request(`/api/tasks/${task.id}`, 'DELETE')).status).toBe(204);
    expect((await f.request(`/api/tasks/${task.id}`, 'DELETE')).status).toBe(404);
    expect((await f.request(`/api/task-lists/${INBOX_LIST_ID}`, 'DELETE')).status).toBe(400);
    expect((await f.request(`/api/task-lists/${INBOX_LIST_ID}`, 'PATCH', { name: 'Rename' })).status).toBe(400);
  });

  // Upstream @neo/tools defects: route guards above cover HTTP callers, while
  // these expected-failure regressions preserve the broken direct-store paths.
  it('upstream TaskStore must throw NeoError for an unknown destination list', () => {
    const task = f.services.stores.tasks.create({ title: 'Pack' });
    expect(() => f.services.stores.tasks.update(task.id, { listId: 'missing-list' })).toThrowError(NeoError);
  });

  it('upstream TaskStore must emit moved tasks when deleting their list', () => {
    const list = f.services.stores.tasks.createList({ name: 'Trip' });
    const task = f.services.stores.tasks.create({ title: 'Pack', listId: list.id });
    const listener = vi.fn(); f.services.stores.tasks.onChange(listener);
    f.services.stores.tasks.deleteList(list.id);
    expect(listener).toHaveBeenCalledWith({ type: 'upsert', task: expect.objectContaining({ id: task.id, listId: INBOX_LIST_ID }) });
  });

  it('forwards every task move when deleting a list larger than the store list limit', async () => {
    const list = f.services.stores.tasks.createList({ name: 'Large list' });
    for (let i = 0; i < 1005; i++) f.services.stores.tasks.create({ title: `Task ${i}`, listId: list.id });
    expect(f.services.stores.tasks.list({ listId: list.id, limit: 1005 })).toHaveLength(1000);
    const delivered: Task[] = [];
    const unsubscribe = f.services.events.subscribe((envelope) => {
      if (envelope.event.type === 'task.updated') delivered.push(envelope.event.task);
    });
    try {
      expect((await f.request(`/api/task-lists/${list.id}`, 'DELETE')).status).toBe(204);
      expect(delivered).toHaveLength(1005);
      expect(new Set(delivered.map((task) => task.id)).size).toBe(1005);
      expect(delivered.every((task) => task.listId === INBOX_LIST_ID)).toBe(true);
    } finally { unsubscribe(); }
  });

  it('note CRUD supports query/tag filters and notifications mark-read ids/all', async () => {
    const note = await json<Note>(await f.request('/api/notes', 'POST', { title: 'Hiking kit', content: 'Pack water and boots', tags: ['outdoors'] }), 201);
    expect(await json(await f.request('/api/notes?query=water&tag=outdoors&limit=3'))).toMatchObject({ items: [{ id: note.id }] });
    expect(await json(await f.request(`/api/notes/${note.id}`))).toMatchObject({ content: 'Pack water and boots' });
    expect(await json(await f.request(`/api/notes/${note.id}`, 'PATCH', { pinned: true }))).toMatchObject({ pinned: true });
    expect((await f.request(`/api/notes/${note.id}`, 'DELETE')).status).toBe(204);
    expect((await f.request(`/api/notes/${note.id}`)).status).toBe(404);
    const one = f.services.stores.notifications.create({ kind: 'system', title: 'One', body: 'body', data: null });
    f.services.stores.notifications.create({ kind: 'system', title: 'Two', body: 'body', data: null });
    expect(await json(await f.request('/api/notifications?unread=1&limit=1'))).toMatchObject({ items: [expect.objectContaining({ readAt: null })] });
    expect(await json(await f.request('/api/notifications/read', 'POST', { ids: [one.id] }))).toEqual({ count: 1 });
    expect(await json(await f.request('/api/notifications/read', 'POST', { ids: 'all' }))).toEqual({ count: 1 });
    expect(await json(await f.request('/api/notifications?unread=true'))).toEqual({ items: [] });
  });

  it('provider CRUD redacts secrets, suffixes ids, syncs registry and models', async () => {
    const first = await json<ProviderView>(await f.request('/api/providers', 'POST', { kind: 'ollama', defaultModel: 'fixture-model', apiKey: 'top-secret' }), 201);
    expect(first).toMatchObject({ id: 'ollama', hasApiKey: true, isLocal: true });
    expect(first).not.toHaveProperty('apiKey'); expect(first).not.toHaveProperty('apiKeySecret');
    expect(f.services.secrets.get('provider:ollama')).toBe('top-secret');
    expect(f.services.providerConfigs.get('ollama')).toMatchObject({ apiKeySecret: 'provider:ollama' });
    expect(f.services.providerConfigs.get('ollama')).not.toHaveProperty('apiKey');
    expect(f.services.providers.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'ollama', apiKeySecret: 'provider:ollama' }));
    expect(f.services.settings.get().defaultModel).toEqual({ provider: 'ollama', model: 'fixture-model' });
    expect(await json(await f.request('/api/providers/ollama/models'))).toMatchObject({ items: [{ id: 'fixture-model' }] });
    expect(await json(await f.request('/api/providers/ollama/test', 'POST'))).toMatchObject({ ok: true });
    const second = await json<ProviderView>(await f.request('/api/providers', 'POST', { kind: 'ollama' }), 201);
    const third = await json<ProviderView>(await f.request('/api/providers', 'POST', { kind: 'ollama' }), 201);
    expect([second.id, third.id]).toEqual(['ollama-2', 'ollama-3']);
    expect((await f.request('/api/providers', 'POST', { id: 'ollama', kind: 'ollama' })).status).toBe(409);
    const updated = await json<ProviderView>(await f.request('/api/providers/ollama', 'PATCH', { label: 'Private', apiKey: 'new-secret' }));
    expect(updated).toMatchObject({ label: 'Private', hasApiKey: true });
    expect(f.services.secrets.get('provider:ollama')).toBe('new-secret');
    const listed = await f.request('/api/providers');
    expect(await listed.text()).not.toMatch(/top-secret|new-secret|apiKeySecret|"apiKey"/);
    expect(await json(await f.request('/api/providers/ollama', 'PATCH', { apiKey: '' }))).toMatchObject({ hasApiKey: false });
    expect(f.services.secrets.get('provider:ollama')).toBeUndefined();
    f.services.settings.update({ memoryModel: { provider: 'ollama', model: 'memory-model' } });
    expect((await f.request('/api/providers/ollama', 'DELETE')).status).toBe(204);
    expect(f.services.providers.remove).toHaveBeenCalledWith('ollama');
    expect(f.services.settings.get()).toMatchObject({ defaultModel: null, memoryModel: null });
    expect((await f.request('/api/providers/ollama', 'PATCH', {})).status).toBe(404);
    expect((await f.request('/api/providers/ollama', 'DELETE')).status).toBe(404);
  });

  it('keeps config-file providers immutable and draft tests isolated from all stores', async () => {
    f.services.config.providers.push({ id: 'configured', kind: 'ollama', enabled: true, apiKey: 'config-secret' });
    expect((await f.request('/api/providers/configured', 'PATCH', { label: 'Rename' })).status).toBe(409);
    expect((await f.request('/api/providers/configured', 'DELETE')).status).toBe(409);
    expect((await f.request('/api/providers', 'POST', { kind: 'ollama', id: 'configured' })).status).toBe(409);
    expect(await (await f.request('/api/providers')).text()).not.toContain('config-secret');
    const configs = f.services.providerConfigs.list(); const secretNames = f.services.secrets.list();
    vi.mocked(f.services.providers.upsert).mockClear(); vi.mocked(f.services.providers.remove).mockClear();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ models: [{ name: 'fixture-model' }] }));
    expect(await json(await f.request('/api/providers/test', 'POST', { kind: 'ollama', apiKey: 'draft-secret' }))).toMatchObject({ ok: true });
    expect(f.services.providerConfigs.list()).toEqual(configs); expect(f.services.secrets.list()).toEqual(secretNames);
    expect(f.services.providers.upsert).not.toHaveBeenCalled(); expect(f.services.providers.remove).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('does not retain an empty provider API key', async () => {
    expect(await json(await f.request('/api/providers', 'POST', { kind: 'ollama', apiKey: '' }), 201)).toMatchObject({ hasApiKey: false });
    expect(f.services.secrets.list()).toEqual([]);
    expect(f.services.providerConfigs.get('ollama')?.apiKeySecret).toBeUndefined();
  });

  it.each([
    [{ kind: 'ollama' }, true],
    [{ kind: 'openai-compatible', baseUrl: 'http://192.168.1.4:1234/v1' }, true],
    [{ kind: 'openai' }, false],
    [{ kind: 'ollama', local: false }, false],
  ])('returns accurate locality for provider %j', async (config, expected) => {
    expect(await json(await f.request('/api/providers', 'POST', config), 201)).toMatchObject({ isLocal: expected });
  });

  it('redacts credential headers from provider views while retaining benign headers', async () => {
    const view = await json<ProviderView>(await f.request('/api/providers', 'POST', {
      kind: 'ollama', headers: { Authorization: 'Bearer header-secret', 'X-API-Key': 'key-secret', 'X-Region': 'test' },
    }), 201);
    expect(view.headers).toEqual({ Authorization: '••••', 'X-API-Key': '••••', 'X-Region': 'test' });
    expect(f.services.providerConfigs.get('ollama')?.headers?.Authorization).toBe('neo-secret:provider:ollama:header:authorization');
    expect(await (await f.request('/api/providers')).text()).not.toMatch(/header-secret|key-secret/);
  });

  it('rolls back provider config and secret when registry construction throws', async () => {
    vi.mocked(f.services.providers.upsert).mockImplementationOnce(() => { throw new NeoError('config_error', 'Broken adapter'); });
    expect((await f.request('/api/providers', 'POST', { kind: 'ollama', apiKey: 'must-not-persist' })).status).toBe(500);
    expect(f.services.providerConfigs.list()).toEqual([]); expect(f.services.secrets.list()).toEqual([]);
    await f.request('/api/providers', 'POST', { kind: 'ollama', apiKey: 'original' });
    vi.mocked(f.services.providers.upsert).mockImplementationOnce(() => { throw new NeoError('config_error', 'Broken update'); });
    expect((await f.request('/api/providers/ollama', 'PATCH', { apiKey: 'replacement' })).status).toBe(500);
    expect(f.services.secrets.get('provider:ollama')).toBe('original');
  });

  it('deep settings patch immediately propagates memory and tool permissions, emits once', async () => {
    const current = await json<Record<string, unknown>>(await f.request('/api/settings'));
    expect(current).toHaveProperty('persona');
    const patched = await json(await f.request('/api/settings', 'PATCH', { persona: { avatar: '🌙' }, memory: { recall: false }, tools: { permissions: { read_test: 'deny' } }, onboarded: true }));
    expect(patched).toMatchObject({ persona: { avatar: '🌙' }, memory: { recall: false }, onboarded: true });
    expect(f.services.memory.getPolicy().recall).toBe(false);
    expect(f.services.tools.permissionFor('read_test')).toBe('deny');
    expect(f.services.events.since(0).filter((e) => e.event.type === 'settings.updated')).toHaveLength(1);
    expect(await json(await f.request('/api/tools'))).toMatchObject({ items: [expect.objectContaining({ name: 'read_test', permission: 'deny', enabled: false }), expect.objectContaining({ name: 'delete_test', source: 'plugin' })] });
    const tool = await json(await f.request('/api/tools/read_test/permission', 'PUT', { permission: 'confirm' }));
    expect(tool).toMatchObject({ name: 'read_test', permission: 'confirm', enabled: true });
    expect(tool).not.toHaveProperty('inputSchema'); expect(tool).not.toHaveProperty('execute');
    expect(f.services.settings.get().tools.permissions.read_test).toBe('confirm');
    expect((await f.request('/api/tools/missing/permission', 'PUT', { permission: 'auto' })).status).toBe(404);
  });

  it('push routes persist the authenticated device and validate unsubscribe', async () => {
    expect(await json(await f.request('/api/push/vapid-public-key'))).toEqual({ publicKey: null });
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1', keys: { p256dh: 'public', auth: 'private' } };
    expect(await json(await f.request('/api/push/subscribe', 'POST', { subscription }))).toEqual({ ok: true });
    expect(f.services.push.list()[0]).toMatchObject({ subscription, deviceId: f.services.devices.list()[0]!.id });
    expect(await json(await f.request('/api/push/unsubscribe', 'POST', { endpoint: subscription.endpoint }))).toEqual({ ok: true });
    expect(f.services.push.list()).toEqual([]);
  });

  it.each([
    ['POST', '/api/timeline/messages', { text: 'hello', offRecord: 'yes' }], ['POST', '/api/memory/forget-by-source', { messageIds: [] }],
    ['POST', '/api/timeline/messages', {}], ['POST', '/api/timeline/cancel', { turnId: 1 }],
    ['POST', '/api/timeline/ui-action', {}], ['POST', '/api/confirmations/id', { approve: 'yes' }],
    ['POST', '/api/memory', {}], ['PATCH', '/api/memory/id', { importance: 2 }],
    ['POST', '/api/memory/import', { data: {} }],
    ['POST', '/api/memory/forget', { ids: [] }],
    ['POST', '/api/memory/find-for-forget', { query: '' }], ['POST', '/api/memory/links', { from: 'a', to: 'b', type: 'bogus' }],
    ['POST', '/api/reminders', { title: 'Water', dueAt: 'soon' }], ['PATCH', '/api/reminders/id', { status: 'bogus' }],
    ['POST', '/api/reminders/id/snooze', { minutes: 0 }], ['POST', '/api/task-lists', { name: '' }],
    ['PATCH', '/api/task-lists/id', { color: 1 }], ['POST', '/api/tasks', { title: '' }],
    ['PATCH', '/api/tasks/id', { done: 'yes' }], ['POST', '/api/notes', { content: 1 }],
    ['PATCH', '/api/notes/id', { tags: [1] }], ['POST', '/api/notifications/read', { ids: 1 }],
    ['POST', '/api/providers', { kind: 'bogus' }], ['POST', '/api/providers/test', { kind: 'ollama', baseUrl: 'no' }],
    ['PATCH', '/api/settings', { persona: { avatar: 1 } }], ['PUT', '/api/tools/read_test/permission', { permission: 'bogus' }],
    ['PATCH', '/api/phone-access', { enabled: 'yes' }], ['PATCH', '/api/phone-access', { relayUrl: 1 }],
    ['POST', '/api/devices', { name: '' }], ['POST', '/api/push/subscribe', {}], ['POST', '/api/push/unsubscribe', { endpoint: 1 }],
  ])('validates %s %s with structured zod details', async (method, path, body) => {
    
    const response = await json<{ code: string; details: unknown }>(await f.request(path, method, body), 400);
    expect(response.code).toBe('bad_request'); expect(response.details).toHaveProperty('errors');
  });

  it.each([
    '/api/timeline?limit=0',
    '/api/memory?kinds=bogus', '/api/memory?status=bogus', '/api/memory?pinned=yes', '/api/memory?offset=-1', '/api/memory?sort=bad',
    '/api/memory/graph?depth=5', '/api/memory/graph?includeArchived=yes', '/api/memory/journal?limit=wat', '/api/memory/export?embeddings=yes',
    '/api/reminders?status=bad', '/api/reminders?from=NaN', '/api/tasks?done=yes', '/api/tasks?limit=-1',
    '/api/notes?limit=NaN', '/api/notifications?unread=yes',
  ])('validates query %s', async (path) => {
    expect(await json(await f.request(path), 400)).toMatchObject({ code: 'bad_request', details: { errors: [] } });
  });

  it('rejects malformed timeline cursors and returns not_found for missing jump targets', async () => {
    expect(await json(await f.request('/api/timeline?before=invalid'), 400)).toMatchObject({ code: 'bad_request', message: 'Invalid timeline cursor.' });
    expect(await json(await f.request('/api/timeline?around=missing-message'), 404)).toMatchObject({ code: 'not_found', message: 'Timeline message not found.' });
  });

  it('returns JSON for malformed bodies, mapped errors and unknown routes', async () => {
    const malformed = await f.app.request('/api/memory', { method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' }, body: '{' });
    expect(await json(malformed, 400)).toMatchObject({ code: 'bad_request' });
    vi.mocked(f.services.memory.stats).mockRejectedValueOnce(new NeoError('provider_error', 'Provider failed', { details: { request: 'offline' }, retryable: true }));
    expect(await json(await f.request('/api/memory/stats'), 502)).toMatchObject({ code: 'provider_error', details: { request: 'offline' }, retryable: true });
    vi.mocked(f.services.memory.stats).mockRejectedValueOnce(new Error('Unexpected failure'));
    expect(await json(await f.request('/api/memory/stats'), 500)).toMatchObject({ code: 'internal' });
    expect(await json(await f.request('/api/unknown'), 404)).toMatchObject({ code: 'not_found' });
    expect((await f.request('/api/unknown', 'GET', undefined, null)).status).toBe(401);
  });

  it('CORS allows local origins, configured and own origins; preflights include security headers', async () => {
    const localOrigins = ['http://localhost:5173', 'http://127.0.0.1:1234', 'capacitor://localhost', 'app://neo'];
    for (const origin of localOrigins) {
      const response = await f.request('/api/settings', 'OPTIONS', undefined, null, { Origin: origin, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' });
      expect(response.status).toBe(204); expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    }
    expect((await f.request('/api/health', 'GET', undefined, null, { Origin: 'https://evil.example' })).headers.get('Access-Control-Allow-Origin')).toBeNull();
    f.services.config.mode = 'server'; f.services.config.server.corsOrigins = ['https://frontend.example'];
    const { app } = createApp(f.services);
    for (const origin of ['http://localhost', 'https://frontend.example']) {
      const response = await app.request('http://localhost/api/health', { headers: { Origin: origin } });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    expect((await app.request('/api/health', { headers: { Origin: 'http://localhost:5173' } })).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('serves static content and SPA fallback with CSP/cache headers, protects API and symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neo-static-')); directories.push(dir);
    const web = join(dir, 'web'); await mkdir(web);
    await Promise.all([
      writeFile(join(web, 'index.html'), '<!doctype html><h1>NEO</h1>'), writeFile(join(web, 'sw.js'), 'self.addEventListener("install",()=>{});'),
      writeFile(join(web, 'manifest.webmanifest'), '{"name":"NEO"}'), writeFile(join(web, 'app.js'), 'export default "NEO";'),
      writeFile(join(dir, 'secret.txt'), 'must-not-serve'),
    ]);
    await symlink(join(dir, 'secret.txt'), join(web, 'leak.txt'));
    f.services.config.server.webDir = web;
    const { app } = createApp(f.services);
    for (const path of ['/', '/chat/new', '/index.html']) {
      const response = await app.request(path);
      expect(response.status).toBe(200); expect(await response.text()).toContain('<h1>NEO</h1>');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    }
    const worker = await app.request('/sw.js'); expect(worker.headers.get('Cache-Control')).toBe('no-cache'); expect(worker.headers.get('Content-Type')).toContain('javascript');
    expect((await app.request('/manifest.webmanifest')).headers.get('Content-Type')).toBe('application/manifest+json');
    expect((await app.request('/app.js')).headers.get('Cache-Control')).toContain('immutable');
    expect((await app.request('/leak.txt')).status).toBe(404);
    // A missing file is a 404, never the shell: caches would keep the HTML as that file.
    for (const path of ['/assets/dog-abc.webp', '/missing.js']) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).not.toContain('text/html');
    }
    expect((await app.request('/api/unknown', { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).status).toBe(404);
    expect((await app.request('/api', { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).status).toBe(404);
  });
});
