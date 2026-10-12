import { afterEach, describe, expect, it } from 'vitest';
import type { ContentPart, ToolUseEvent } from '@neo/protocol';
import { routeFixture } from '../route-fixture.test-utils.js';

const fixtures: ReturnType<typeof routeFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.services.close();
});

function fixture() {
  const f = routeFixture();
  fixtures.push(f);
  const normal = f.services.conversations.createEpisode();
  const append = (id: string, at: number, name: string, input: unknown, output: unknown, options: { episodeId?: string; sensitive?: boolean } = {}) => {
    const parts: ContentPart[] = [
      { type: 'tool_call', id: 'call', name, input },
      { type: 'tool_result', toolCallId: 'call', name, output, ...(options.sensitive ? { sensitive: true } : {}) },
    ];
    f.services.conversations.appendMessage({ id, conversationId: options.episodeId ?? normal.id, role: 'assistant', createdAt: at, status: 'complete', parts });
  };
  return { ...f, append };
}

async function items(response: Response): Promise<ToolUseEvent[]> {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { items: ToolUseEvent[] }).items;
}

describe('GET /api/memory/tool-uses', () => {
  it('exposes safe completed events to both owner and paired device with existing auth', async () => {
    const f = fixture();
    expect(f.services.conversations.toolUses).toBeTypeOf('function');
    f.append('normal', 100, 'create_note', { title: 'Kyoto itinerary', content: 'PRIVATE BODY' }, { note: { id: 'note_1', title: 'Kyoto itinerary' } });
    f.append('search', 101, 'web_search', { query: 'Kyoto ryokan' }, [{ title: 'UNTRUSTED TITLE', snippet: 'UNTRUSTED CONTENT', url: 'javascript:alert(1)' }]);
    const privateEpisode = f.services.conversations.createEpisode({ offRecord: true });
    f.append('private', 102, 'create_note', { title: 'SECRET' }, {}, { episodeId: privateEpisode.id });
    const expected = [
      { id: 'tool-use:normal:0', at: 100, tool: 'create_note', category: 'note', title: 'Wrote note “Kyoto itinerary”', messageId: 'normal', target: { kind: 'note', id: 'note_1' } },
      { id: 'tool-use:search:0', at: 101, tool: 'web_search', category: 'search', title: 'Searched “Kyoto ryokan”', messageId: 'search' },
    ];
    expect(await items(await f.request('/api/memory/tool-uses'))).toEqual(expected);
    const device = f.services.devices.create({ name: 'Phone', platform: 'ios', owner: false });
    expect(await items(await f.request('/api/memory/tool-uses', 'GET', undefined, device.token))).toEqual(expected);
    expect((await f.request('/api/memory/tool-uses', 'GET', undefined, null)).status).toBe(401);
    expect((await f.request('/api/memory/tool-uses', 'GET', undefined, 'invalid')).status).toBe(401);
    f.services.devices.revoke(device.device.id);
    expect((await f.request('/api/memory/tool-uses', 'GET', undefined, device.token)).status).toBe(401);
  });

  it('hides titles of historical memories now marked sensitive or no longer verifiable', async () => {
    const f = fixture();
    const normal = await f.services.memory.remember({ content: 'Likes tea', label: 'Tea' });
    const privateNow = await f.services.memory.remember({ content: 'Private condition', label: 'SECRET CONDITION' });
    await f.services.memory.update(privateNow.id, { sensitivity: 'sensitive' });
    f.append('normal', 100, 'remember', { label: 'Tea' }, { id: normal.id, label: 'Tea' });
    f.append('private-now', 101, 'remember', { label: 'SECRET CONDITION' }, { id: privateNow.id, label: 'SECRET CONDITION' });
    f.append('private-result', 102, 'remember', { label: 'SECRET RESULT' }, { id: normal.id, label: 'SECRET RESULT' }, { sensitive: true });
    f.append('private-argument', 103, 'remember', { label: 'SECRET ARGUMENT', sensitivity: 'sensitive' }, { id: normal.id, label: 'SECRET ARGUMENT' });
    f.append('deleted', 104, 'remember', { label: 'SECRET DELETED' }, { id: 'mem_deleted', label: 'SECRET DELETED' });
    f.append('unknown', 105, 'remember', { label: 'SECRET UNKNOWN' }, { label: 'SECRET UNKNOWN' });
    f.append('forget', 106, 'forget', { query: 'SECRET QUERY' }, { forgotten: ['SECRET FORGOTTEN'] });
    const result = await items(await f.request('/api/memory/tool-uses'));
    expect(result[0]?.title).toBe('Remembered “Tea”');
    expect(result.slice(1, 6).map((event) => event.title)).toEqual(Array(5).fill('Remembered something private'));
    expect(result[6]?.title).toBe('Forgot 1 memory');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result[1]?.target).toEqual({ kind: 'memory', id: privateNow.id });
  });

  it('honours inclusive bounds, newest limit and caps overlarge limits at 500', async () => {
    const f = fixture();
    for (let i = 0; i < 510; i++) f.append(`msg_${i.toString().padStart(3, '0')}`, i, 'calculate', {}, {});
    expect((await items(await f.request('/api/memory/tool-uses?from=10&to=12&limit=2'))).map((event) => event.at)).toEqual([11, 12]);
    expect((await items(await f.request('/api/memory/tool-uses?from=10&to=10'))).map((event) => event.at)).toEqual([10]);
    expect(await items(await f.request('/api/memory/tool-uses?from=600'))).toEqual([]);
    const capped = await items(await f.request('/api/memory/tool-uses?limit=501'));
    expect(capped).toHaveLength(500);
    expect(capped[0]?.at).toBe(10);
  });

  it.each(['from=NaN', 'to=Infinity', 'from=', 'from=20&to=10', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=nope'])('rejects invalid query %s', async (query) => {
    const f = fixture();
    expect((await f.request(`/api/memory/tool-uses?${query}`)).status).toBe(400);
  });

  it('allows older custom conversation stores without the optional projection capability', async () => {
    const f = fixture();
    f.services.conversations.toolUses = undefined;
    expect(await items(await f.request('/api/memory/tool-uses'))).toEqual([]);
  });
});
