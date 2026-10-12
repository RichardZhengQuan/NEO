import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, silentLogger, type ListResponse, type Message, type OffRecordState, type TimelineDeleteResult, type TimelinePage, type TimelineSearchHit, type UiActionResponse } from '@neo/protocol';
import { createApp } from './app.js';
import { createServices } from './services.js';
import type { NeoServices } from './index.js';

const epoch = Date.UTC(2026, 9, 11, 12);
const resources: NeoServices[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const services of resources.splice(0)) await services.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

async function fixture(clock = () => epoch, dataDir?: string) {
  const services = await createServices(NeoConfigSchema.parse({
    ...(dataDir ? { dataDir } : {}), plugins: { enabled: false }, log: { level: 'silent' },
    settings: { memory: { consolidation: { enabled: false } } },
  }), {
    inMemory: !dataDir, logger: silentLogger, clock,
    mockProviders: [{ id: 'fixture', kind: 'mock', enabled: true, defaultModel: 'fixture-model' }],
    mockScript: () => ({ text: 'A timeline reply.' }),
  });
  resources.push(services);
  const { app } = createApp(services);
  const request = (path: string, method = 'GET', body?: unknown, accept?: string) => app.request(`/api${path}`, {
    method, headers: { Authorization: `Bearer ${services.ownerToken}`, 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { services, request };
}

function append(services: NeoServices, episodeId: string, id: string, createdAt: number, text: string): Message {
  return services.conversations.appendMessage({ id, conversationId: episodeId, role: 'user', status: 'complete', createdAt, parts: [{ type: 'text', text }] });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

describe('timeline HTTP API', () => {
  it('starts idempotently, restores state after reload, and only explicit end returns to normal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-timeline-privacy-'));
    directories.push(directory);
    const initial = await fixture(() => epoch, directory);
    const normal = initial.services.conversations.createEpisode();
    append(initial.services, normal.id, 'normal-source', epoch, 'Normal history');
    expect(await json(await initial.request('/timeline/off-record/end', 'POST', {}))).toEqual({ deleted: 0 });
    expect(await json(await initial.request('/timeline/off-record'))).toEqual({ active: false, episodeId: null, startedAt: null });
    const state = await json<OffRecordState>(await initial.request('/timeline/off-record/start', 'POST', {}));
    expect(state).toEqual({ active: true, episodeId: expect.any(String), startedAt: epoch });
    expect(initial.services.conversations.get(normal.id)?.closedAt).toBe(epoch);
    expect(await json(await initial.request('/timeline/off-record/start', 'POST'))).toEqual(state);
    expect(initial.services.events.since(0).filter(envelope => envelope.event.type === 'timeline.off_record')).toHaveLength(1);
    await initial.services.close();
    resources.splice(resources.indexOf(initial.services), 1);
    const restored = await fixture(() => epoch + 1, directory);
    expect(await json(await restored.request('/timeline/off-record'))).toEqual(state);
    const sent = await json<{ episodeId: string }>(await restored.request('/timeline/messages', 'POST', { text: 'A stale client sends', offRecord: false }), 202);
    expect(sent.episodeId).toBe(state.episodeId);
    await restored.services.runtime.waitForIdle();
    expect(await json(await restored.request('/timeline/off-record/end', 'POST', {}))).toEqual({ deleted: 1 });
    expect(await json(await restored.request('/timeline/off-record'))).toEqual({ active: false, episodeId: null, startedAt: null });
    expect(restored.services.conversations.getMessage('normal-source')).not.toBeNull();
    expect(restored.services.conversations.timeline().items).toHaveLength(1);
  });

  it.each(['message', 'event'] as const)('runs an older normal %s UI action in the active private episode', async kind => {
    const { services, request } = await fixture();
    const normal = services.conversations.createEpisode();
    services.conversations.appendMessage({
      id: 'old-ui', conversationId: normal.id, role: 'assistant', status: 'complete', createdAt: epoch,
      parts: [{ type: 'ui', id: 'controls', block: { type: 'buttons', actions: [
        kind === 'message' ? { id: 'run', label: 'Run', kind, text: 'A private UI request' } : { id: 'run', label: 'Run', kind },
      ] } }],
    });
    const remember = vi.spyOn(services.memory, 'remember');
    const observe = vi.spyOn(services.memory, 'observe');
    const recall = vi.spyOn(services.memory, 'recall');
    let step = 0;
    services.providers.get('fixture')!.chat = async function* () {
      if (step++ === 0) {
        yield { type: 'tool_call', id: 'private-memory', name: 'remember', input: { content: 'The user owns a private observatory.' } };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        yield { type: 'text', text: 'A private reply without a memory write.' };
        yield { type: 'done', stopReason: 'end' };
      }
    };
    const state = await json<OffRecordState>(await request('/timeline/off-record/start', 'POST', {}));
    const result = await json<UiActionResponse>(await request('/timeline/ui-action', 'POST', { messageId: 'old-ui', uiId: 'controls', actionId: 'run' }));
    expect(result).toMatchObject({ kind: 'turn', episodeId: state.episodeId });
    await services.runtime.waitForIdle();
    expect(remember).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ reinforce: false }));
    expect(services.conversations.messages(state.episodeId!)).toHaveLength(2);
    expect(await json(await request('/timeline/off-record/end', 'POST', {}))).toEqual({ deleted: 1 });
    expect(services.conversations.timeline().items.map(message => message.id)).toEqual(['old-ui']);
  });

  it('rechecks a normal UI memory confirmation after start and rejects memory writes', async () => {
    const { services, request } = await fixture();
    const normal = services.conversations.createEpisode();
    services.tools.setPermission('remember', 'confirm');
    services.conversations.appendMessage({
      id: 'old-confirmation', conversationId: normal.id, role: 'assistant', status: 'complete', createdAt: epoch,
      parts: [{ type: 'ui', id: 'controls', block: { type: 'buttons', actions: [
        { id: 'remember', label: 'Remember', kind: 'tool', tool: 'remember', input: { content: 'The user owns a private observatory.' } },
      ] } }],
    });
    const body = { messageId: 'old-confirmation', uiId: 'controls', actionId: 'remember' };
    const confirmation = await json<UiActionResponse>(await request('/timeline/ui-action', 'POST', body));
    if (confirmation.kind !== 'confirm') throw new Error('Expected a UI confirmation');
    await json(await request('/timeline/off-record/start', 'POST', {}));
    const remember = vi.spyOn(services.memory, 'remember');
    await json(await request('/timeline/ui-action', 'POST', { ...body, confirmationToken: confirmation.confirmation.token }), 403);
    await json(await request('/timeline/ui-action', 'POST', body), 403);
    expect(remember).not.toHaveBeenCalled();
    await json(await request('/timeline/off-record/end', 'POST', {}));
    expect(services.conversations.timeline().items.map(message => message.id)).toEqual(['old-confirmation']);
  });

  it('expires persisted private state at startup even before any private message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-timeline-empty-private-'));
    directories.push(directory);
    const initial = await fixture(() => epoch, directory);
    const state = await json<OffRecordState>(await initial.request('/timeline/off-record/start', 'POST', {}));
    await initial.services.close();
    resources.splice(resources.indexOf(initial.services), 1);
    const restored = await fixture(() => epoch + 12 * 60 * 60_000 + 1, directory);
    expect(await json(await restored.request('/timeline/off-record'))).toEqual({ active: false, episodeId: null, startedAt: null });
    expect(restored.services.conversations.get(state.episodeId!)).toBeNull();
  });

  it.each([
    ['GET', '/conversations'], ['POST', '/conversations'], ['GET', '/conversations/id'],
    ['PATCH', '/conversations/id'], ['DELETE', '/conversations/id'], ['POST', '/conversations/id/messages'],
    ['POST', '/conversations/id/cancel'], ['POST', '/conversations/id/ui-action'],
  ])('removed endpoint %s %s returns 404', async (method, path) => {
    const { request } = await fixture();
    await json(await request(path!, method!), 404);
  });

  it('paginates contiguous episode blocks, returns boundary markers and jumps by id or date', async () => {
    const { services, request } = await fixture();
    const first = services.conversations.createEpisode();
    append(services, first.id, 'a', epoch, 'First');
    append(services, first.id, 'b', epoch + 4000, 'Overlapping late reply');
    services.conversations.closeEpisode(first.id);
    const second = services.conversations.createEpisode();
    append(services, second.id, 'c', epoch + 1000, 'Second episode');
    append(services, second.id, 'd', epoch + 2000, 'Last');
    const latest = await json<TimelinePage>(await request('/timeline?limit=2'));
    expect(latest.items.map(message => message.id)).toEqual(['c', 'd']);
    expect(latest.items.every(message => message.episodeId === second.id)).toBe(true);
    expect(latest.episodes).toMatchObject([{ episodeId: second.id, offRecord: false }]);
    const older = await json<TimelinePage>(await request(`/timeline?limit=2&before=${encodeURIComponent(latest.nextCursor!)}`));
    expect(older.items.map(message => message.id)).toEqual(['a', 'b']);
    expect(older.nextCursor).toBeNull();
    const aroundMessage = await json<TimelinePage>(await request('/timeline?limit=3&around=b'));
    expect(aroundMessage.items.some(message => message.id === 'b')).toBe(true);
    const aroundDate = await json<TimelinePage>(await request(`/timeline?limit=2&around=${encodeURIComponent(new Date(epoch + 1000).toISOString())}`));
    expect(aroundDate.items.some(message => message.id === 'c')).toBe(true);
    await json(await request('/timeline?around=missing-message'), 404);
    await json(await request('/timeline?before=bad-cursor'), 400);
  });

  it('searches visible text, removes deleted FTS rows, counts source memories and forgets them separately', async () => {
    const { services, request } = await fixture();
    const episode = services.conversations.createEpisode();
    const searchText = '🔭 A telescope for observing Saturn beside [brackets]';
    append(services, episode.id, 'searchable', epoch, searchText);
    append(services, episode.id, 'retained', epoch + 1, 'A cup of coffee');
    const fact = await services.memory.remember({ kind: 'fact', label: 'Astronomy', content: 'The user observes Saturn.', source: { by: 'extraction', conversationId: episode.id, messageId: 'searchable' } });
    const derived = await services.memory.remember({ kind: 'summary', label: 'Night sky', content: 'The user studies the night sky.', source: { by: 'consolidation' } });
    await services.memory.link(derived.id, fact.id, 'derived_from');
    const result = await json<ListResponse<TimelineSearchHit>>(await request('/timeline/search?q=Saturn'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ messageId: 'searchable', episodeId: episode.id, createdAt: epoch });
    const matchStart = searchText.indexOf('Saturn');
    expect(result.items[0]?.snippet).toEqual({ text: searchText, highlights: [[matchStart, matchStart + 'Saturn'.length]] });
    const deleted = await json<TimelineDeleteResult>(await request('/timeline/messages/searchable', 'DELETE'));
    expect(deleted).toEqual({ deleted: 1, messageIds: ['searchable'], derivedMemories: 2 });
    expect(services.conversations.currentEpisode()).toBeNull();
    expect(await services.memory.get(fact.id)).not.toBeNull();
    expect(await json(await request('/timeline/search?q=Saturn'))).toEqual({ items: [] });
    expect(await json(await request('/memory/forget-by-source', 'POST', { messageIds: ['searchable'] }))).toEqual({ deleted: 2 });
    expect(await services.memory.get(fact.id)).toBeNull();
    expect(await services.memory.get(derived.id)).toBeNull();
    expect(services.conversations.getMessage('retained')).not.toBeNull();
  });

  it('deletes an inclusive timestamp range across episodes, retaining memories and everything outside it', async () => {
    const { services, request } = await fixture();
    const first = services.conversations.createEpisode();
    append(services, first.id, 'old', epoch - 1, 'Keep');
    append(services, first.id, 'start', epoch, 'Remove');
    services.conversations.closeEpisode(first.id);
    const last = services.conversations.createEpisode();
    append(services, last.id, 'end', epoch + 1000, 'Remove');
    append(services, last.id, 'new', epoch + 1001, 'Keep');
    const memory = await services.memory.remember({ content: 'The user has a bicycle.', source: { by: 'extraction', messageId: 'end' } });
    const result = await json<TimelineDeleteResult>(await request(`/timeline?from=${new Date(epoch).toISOString()}&to=${new Date(epoch + 1000).toISOString()}`, 'DELETE'));
    expect(result.deleted).toBe(2);
    expect(result.messageIds.sort()).toEqual(['end', 'start']);
    expect(result.derivedMemories).toBe(1);
    expect(services.conversations.timeline().items.map(message => message.id)).toEqual(['old', 'new']);
    expect(services.conversations.currentEpisode()).toBeNull();
    expect(await services.memory.get(memory.id)).not.toBeNull();
    await json(await request('/timeline', 'DELETE'), 400);
    await json(await request(`/timeline?from=${new Date(epoch + 1).toISOString()}&to=${new Date(epoch).toISOString()}`, 'DELETE'), 400);
  });

  it('returns episode ids through JSON, SSE and WebSocket events and explicitly ends an off-record session', async () => {
    const { services, request } = await fixture();
    const sent = await json<{ episodeId: string; turnId: string; userMessage: Message }>(await request('/timeline/messages', 'POST', { text: 'Private observatory visit', offRecord: true }), 202);
    expect(sent.userMessage).toMatchObject({ episodeId: sent.episodeId });
    await services.runtime.waitForIdle();
    const stream = await request('/timeline/messages', 'POST', { text: 'Another private note', offRecord: true }, 'text/event-stream');
    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).toContain('event: turn.finished');
    expect(text).toContain(`"episodeId":"${sent.episodeId}"`);
    expect(services.events.since(0).some(envelope => envelope.event.type === 'episode.started' && envelope.event.episodeId === sent.episodeId)).toBe(true);
    expect(await json(await request('/timeline/off-record/end', 'POST', {}))).toEqual({ deleted: 1 });
    expect(services.conversations.get(sent.episodeId)).toBeNull();
    expect(await json(await request('/timeline/search?q=observatory'))).toEqual({ items: [] });
    expect(await json(await request('/timeline/off-record/end', 'POST', {}))).toEqual({ deleted: 0 });
  });

  it('purges only new ephemeral off-record episodes at startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-timeline-startup-'));
    directories.push(directory);
    const initial = await fixture(() => epoch, directory);
    const ephemeral = initial.services.conversations.createEpisode({ offRecord: true });
    append(initial.services, ephemeral.id, 'ephemeral', epoch, 'Ephemeral secret');
    const legacy = initial.services.conversations.create({ incognito: true });
    append(initial.services, legacy.id, 'legacy', epoch, 'Historical private note');
    await initial.services.close();
    resources.splice(resources.indexOf(initial.services), 1);
    const restarted = await fixture(() => epoch + 12 * 60 * 60_000 + 1, directory);
    expect(restarted.services.conversations.get(ephemeral.id)).toBeNull();
    expect(restarted.services.conversations.getMessage('legacy')).not.toBeNull();
    expect(restarted.services.conversations.searchMessages('Ephemeral')).toEqual([]);
  });

  it('periodically purges expired off-record episodes without a restart', async () => {
    vi.useFakeTimers();
    let now = epoch;
    const { services, request } = await fixture(() => now);
    const state = await json<OffRecordState>(await request('/timeline/off-record/start', 'POST', {}));
    append(services, state.episodeId!, 'private', now, 'Periodic secret');
    now += 12 * 60 * 60_000 + 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(services.conversations.get(state.episodeId!)).toBeNull();
    expect(await json(await request('/timeline/off-record'))).toEqual({ active: false, episodeId: null, startedAt: null });
    expect(services.events.since(0).some(envelope => envelope.event.type === 'timeline.off_record' && !envelope.event.active)).toBe(true);
    expect(services.conversations.searchMessages('Periodic')).toEqual([]);
  });
});

it('deletion cancels a pending preflight and excludes new sends until its transcript mutation completes', async () => {
  const { services, request } = await fixture();
  const episode = services.conversations.createEpisode();
  append(services, episode.id, 'original', epoch, 'The existing message');
  let recallStarted!: () => void;
  let releaseRecall!: () => void;
  const started = new Promise<void>(resolve => { recallStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseRecall = resolve; });
  const recall = services.memory.recall.bind(services.memory);
  vi.spyOn(services.memory, 'recall').mockImplementation(async query => {
    recallStarted();
    await gate;
    return recall(query);
  });
  const pending = services.runtime.sendTimeline({ parts: [{ type: 'text', text: 'Racing send' }] });
  const outcome = pending.catch(error => error);
  await started;
  const deletion = request('/timeline/messages/original', 'DELETE');
  await Promise.resolve();
  await expect(services.runtime.sendTimeline({ parts: [{ type: 'text', text: 'Another send' }] })).rejects.toMatchObject({ code: 'conflict' });
  releaseRecall();
  expect(await outcome).toMatchObject({ code: 'cancelled' });
  expect(await json(await deletion)).toEqual({ deleted: 1, messageIds: ['original'], derivedMemories: 0 });
  expect(services.conversations.timeline().items).toEqual([]);
});

it('range deletion cancels and settles a running assistant before deleting exactly the reported rows', async () => {
  const { services, request } = await fixture();
  const adapter = services.providers.get('fixture')!;
  let modelStarted!: () => void;
  let releaseModel!: () => void;
  const started = new Promise<void>(resolve => { modelStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseModel = resolve; });
  adapter.chat = async function* () {
    modelStarted();
    await gate;
    yield { type: 'text', text: 'Late provider output' };
    yield { type: 'done', stopReason: 'end' };
  };
  const turn = await services.runtime.sendTimeline({ parts: [{ type: 'text', text: 'Wait for output' }], offRecord: true });
  await started;
  const deletion = request(`/timeline?from=${new Date(epoch).toISOString()}&to=${new Date(epoch + 1).toISOString()}`, 'DELETE');
  await Promise.resolve();
  expect(services.conversations.getMessage(turn.userMessage.id)).not.toBeNull();
  releaseModel();
  const result = await json<TimelineDeleteResult>(await deletion);
  expect(result.deleted).toBe(2);
  expect(result.messageIds.sort()).toEqual([turn.userMessage.id, turn.assistantMessageId].sort());
  expect((await turn.done).status).toBe('cancelled');
  expect(services.conversations.timeline().items).toEqual([]);
  expect(services.runtime.activeTurns()).toEqual([]);
});
