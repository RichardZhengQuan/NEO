import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ContentPart, type ToolDefinition } from '@neo/protocol';
import { collect, deferred, ev, harness, runTurn, ScriptedAdapter, ScriptedRegistry, settle, userText } from './fakes.test-utils.js';
import { AgentRuntime } from './runtime.js';

const source = { title: 'Weather', url: 'https://weather.example/today', snippet: 'Sunny' };
const searchTool: ToolDefinition = {
  name: 'web_search', title: 'Search the web', description: 'Search external content.',
  inputSchema: z.object({ query: z.string() }), risk: 'external', defaultPermission: 'auto', untrustedOutput: true,
  async execute() { return { output: { results: [source] }, sources: [source] }; },
};

describe('runtime search', () => {
  it('uses native search by default only on chat requests and stores sources as assistant parts', async () => {
    const adapter = new ScriptedAdapter({ caps: { nativeWebSearch: true } });
    const replay: ContentPart = { type: 'provider_part', provider: 'mock', model: 'fake-model', data: { server: 'search' } };
    const h = harness({ adapters: [adapter], tools: [searchTool] });
    adapter.script([
      ev.text('The web says it is sunny.'),
      { type: 'provider_part', part: replay },
      { type: 'sources', items: [source] },
      ev.done(),
    ]);
    const first = await runTurn(h, 'Look up today’s weather');
    expect(adapter.requests[0]!.webSearch).toEqual({});
    expect(adapter.requests[0]!.tools?.map(tool => tool.name) ?? []).not.toContain('web_search');
    expect(first.message.parts).toContainEqual({ type: 'sources', items: [source] });
    expect(first.message.parts).toContainEqual(replay);
    expect(first.events).toContainEqual(expect.objectContaining({ type: 'part.added', part: { type: 'sources', items: [source] } }));
    await settle();
    expect(h.memory.observeCalls[0]!.userMessage.parts).toContainEqual({ type: 'text', text: 'Look up today’s weather' });
    expect(h.memory.observeCalls[0]!.assistantMessage.parts.some(part => ['text', 'sources', 'provider_part'].includes(part.type))).toBe(false);
    expect(adapter.titleRequests).toEqual([]);

    h.settings.update({ ai: { search: { mode: 'off' } } });
    await runTurn(h, 'Thanks');
    expect(adapter.requests[1]).not.toHaveProperty('webSearch');
    expect(adapter.requests[1]!.system).toBe(adapter.requests[0]!.system);
    expect(adapter.requests[1]!.messages.slice(0, -1)).toEqual(expect.arrayContaining(adapter.requests[0]!.messages.filter(message => message.parts.length)));
    expect(h.conversations.getMessage(first.message.id)!.parts).toEqual(first.message.parts);
  });

  it('omits search when neither the model nor an engine supports it', async () => {
    const h = harness();
    await runTurn(h, 'Hello');
    expect(h.model.requests[0]).not.toHaveProperty('webSearch');
    expect(h.model.requests[0]!.tools?.some(tool => tool.name === 'web_search')).toBe(false);
  });

  it('force-engine overrides native search and off uses neither', async () => {
    const adapter = new ScriptedAdapter({ caps: { nativeWebSearch: true } });
    const h = harness({ adapters: [adapter], tools: [searchTool], settings: { ai: { search: { mode: 'engine' } } } });
    await runTurn(h, 'Look it up');
    expect(adapter.requests[0]).not.toHaveProperty('webSearch');
    expect(adapter.requests[0]!.tools?.map(tool => tool.name)).toContain('web_search');
    h.settings.update({ ai: { search: { mode: 'off' } } });
    const handle = await h.runtime.sendTimeline({ parts: userText('No search') });
    await handle.done;
    expect(adapter.requests[1]).not.toHaveProperty('webSearch');
    expect(adapter.requests[1]!.tools?.map(tool => tool.name) ?? []).not.toContain('web_search');
  });

  it('keeps the registry aligned with native availability and falls back after native search becomes unavailable', async () => {
    const adapter = new ScriptedAdapter({ caps: { nativeWebSearch: true } });
    const h = harness({ adapters: [adapter], tools: [], resolveSearchTool: () => searchTool });
    expect(h.tools.get('web_search')).toBeUndefined();
    const first = await h.runtime.sendTimeline({ parts: userText('Use my AI') });
    await first.done;
    expect(adapter.requests[0]!.webSearch).toEqual({});
    adapter.caps = { ...adapter.caps, nativeWebSearch: false };
    const second = await h.runtime.sendTimeline({ parts: userText('Try again') });
    await second.done;
    expect(second.episodeId).not.toBe(first.episodeId);
    expect(h.tools.get('web_search')).toBe(searchTool);
    expect(adapter.requests[1]).not.toHaveProperty('webSearch');
    expect(adapter.requests[1]!.tools?.map(tool => tool.name)).toContain('web_search');
  });

  it('registers an engine from settings before chatting and appends its sources', async () => {
    const h = harness({ tools: [], resolveSearchTool: settings => settings.ai.search.engine ? searchTool : undefined });
    expect(h.tools.get('web_search')).toBeUndefined();
    h.settings.update({ ai: { search: { engine: { provider: 'searxng', baseUrl: 'http://127.0.0.1:8080' } } } });
    expect(h.tools.get('web_search')).toBe(searchTool);
    h.model.script([ev.call('search', 'web_search', { query: 'weather' }), ev.done('tool_use')], [ev.text('Sunny.'), ev.done()]);
    const { message, events } = await runTurn(h, 'Look up weather');
    expect(h.tools.executed).toHaveLength(1);
    expect(message.parts).toContainEqual({ type: 'sources', items: [source] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'part.added', part: { type: 'sources', items: [source] } }));
    const result = message.parts.find(part => part.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.output).toContain('<untrusted_content source="web_search">');
    await settle();
    expect(h.memory.observeCalls[0]!.assistantMessage.parts.some(part => part.type === 'text' || part.type === 'sources')).toBe(false);
    h.settings.update({ ai: { search: { mode: 'off' } } });
    expect(h.tools.get('web_search')).toBeUndefined();
  });

  it('starts a new episode when search availability changes without rewriting the old prompt or transcript', async () => {
    const h = harness({ tools: [], resolveSearchTool: settings => settings.ai.search.engine ? searchTool : undefined });
    const first = await h.runtime.sendTimeline({ parts: userText('Hello') });
    await first.done;
    const previous = h.conversations.get(first.episodeId)!;
    const transcript = h.conversations.messages(first.episodeId);
    h.settings.update({ ai: { search: { engine: { provider: 'brave', apiKeySecret: 'search-key' } } } });
    const second = await h.runtime.sendTimeline({ parts: userText('Search now') });
    await second.done;
    expect(second.episodeId).not.toBe(first.episodeId);
    expect(h.conversations.get(second.episodeId)!.toolset).toContain('web_search');
    expect(h.conversations.get(first.episodeId)!.systemPrompt).toBe(previous.systemPrompt);
    expect(h.conversations.messages(first.episodeId)).toEqual(transcript);
    h.settings.update({ ai: { search: { mode: 'off' } } });
    const third = await h.runtime.sendTimeline({ parts: userText('Stop searching') });
    await third.done;
    expect(third.episodeId).not.toBe(second.episodeId);
    expect(h.conversations.get(third.episodeId)!.toolset).not.toContain('web_search');
  });

  it('refuses stale engine calls after search is turned off', async () => {
    const h = harness({ tools: [searchTool], settings: { ai: { search: { mode: 'engine' } } } });
    h.model.script(async function* () {
      yield ev.call('stale', 'web_search', { query: 'q' });
      h.settings.update({ ai: { search: { mode: 'off' } } });
      yield ev.done('tool_use');
    }, [ev.done()]);
    const { message } = await runTurn(h, 'Search');
    expect(h.tools.executed).toEqual([]);
    expect(message.parts).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true, summary: 'Not available' }));
    expect(h.model.requests[1]!.tools).toEqual(h.model.requests[0]!.tools);
  });

  it('retains a frozen search declaration in legacy episodes after the engine is removed', async () => {
    const h = harness({ tools: [], resolveSearchTool: settings => settings.ai.search.engine ? searchTool : undefined,
      settings: { ai: { search: { engine: { provider: 'searxng' } } } } });
    await runTurn(h, 'Search is available');
    h.settings.update({ ai: { search: { mode: 'off', engine: null } } });
    expect(h.tools.get('web_search')).toBeUndefined();
    h.model.script([ev.call('removed', 'web_search', { query: 'q' }), ev.done('tool_use')], [ev.done()]);
    const { message } = await runTurn(h, 'Continue');
    expect(h.model.requests[1]!.tools).toEqual(h.model.requests[0]!.tools);
    expect(h.tools.executed).toEqual([]);
    expect(message.parts).toContainEqual(expect.objectContaining({ type: 'tool_result', summary: 'Not available', isError: true }));
  });

  it('cancels an engine operation when search is revoked during execution', async () => {
    const entered = deferred();
    const finish = deferred();
    const tool: ToolDefinition = { ...searchTool, async execute(_input, ctx) {
      entered.resolve();
      await finish.promise;
      expect(ctx.signal?.aborted).toBe(true);
      return { output: 'too late', sources: [source] };
    } };
    const h = harness({ tools: [tool] });
    h.model.script([ev.call('running', 'web_search', { query: 'q' }), ev.done('tool_use')], [ev.done()]);
    const handle = await h.runtime.send({ conversationId: h.conv.id, parts: userText('Search') });
    await entered.promise;
    h.settings.update({ ai: { search: { mode: 'off' } } });
    const message = await handle.done;
    finish.resolve();
    await collect(handle);
    expect(message.parts.some(part => part.type === 'sources')).toBe(false);
    expect(message.parts).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true }));
  });

  it('keeps source parts bounded, safe and deduplicated without rewriting earlier parts', async () => {
    const h = harness({ adapters: [new ScriptedAdapter({ caps: { nativeWebSearch: true } })] });
    h.model.script([
      ev.text('First'), { type: 'sources', items: [source, { title: 'Unsafe', url: 'javascript:alert(1)' }] },
      ev.text('Then'), { type: 'sources', items: [source, { title: 'More', url: 'https://more.example/' }] }, ev.done(),
    ]);
    const { message } = await runTurn(h, 'Search');
    expect(message.parts.filter(part => part.type === 'sources')).toEqual([
      { type: 'sources', items: [source] }, { type: 'sources', items: [{ title: 'More', url: 'https://more.example/' }] },
    ]);
  });
});

describe('runtime restart — episode continuity', () => {
  it('continues the same episode after a restart when search mode is unchanged (native)', async () => {
    const adapter = new ScriptedAdapter({ caps: { nativeWebSearch: true } });
    const h = harness({ adapters: [adapter] });
    const first = await h.runtime.sendTimeline({ parts: userText('Before restart') });
    await first.done;
    // Simulate a restart: new runtime on the same stores, clock continues.
    const runtime2 = new AgentRuntime({
      conversations: h.conversations,
      settings: h.settings,
      providers: new ScriptedRegistry([new ScriptedAdapter({ caps: { nativeWebSearch: true } })]),
      memory: h.memory,
      tools: h.tools,
      clock: h.clock,
    });
    const second = await runtime2.sendTimeline({ parts: userText('After restart') });
    await second.done;
    expect(second.episodeId).toBe(first.episodeId);
  });

  it('continues the same episode after a restart when search mode is unchanged (engine)', async () => {
    const h = harness({
      tools: [],
      resolveSearchTool: settings => settings.ai.search.engine ? searchTool : undefined,
      settings: { ai: { search: { engine: { provider: 'searxng', baseUrl: 'http://127.0.0.1:8080' } } } },
    });
    const first = await h.runtime.sendTimeline({ parts: userText('Before restart') });
    await first.done;
    const runtime2 = new AgentRuntime({
      conversations: h.conversations,
      settings: h.settings,
      providers: h.providers,
      memory: h.memory,
      tools: h.tools,
      resolveSearchTool: settings => settings.ai.search.engine ? searchTool : undefined,
      clock: h.clock,
    });
    const second = await runtime2.sendTimeline({ parts: userText('After restart') });
    await second.done;
    expect(second.episodeId).toBe(first.episodeId);
  });

  it('continues the same episode after a restart when search mode is unchanged (off)', async () => {
    const h = harness({ settings: { ai: { search: { mode: 'off' } } } });
    const first = await h.runtime.sendTimeline({ parts: userText('Before restart') });
    await first.done;
    const runtime2 = new AgentRuntime({
      conversations: h.conversations,
      settings: h.settings,
      providers: h.providers,
      memory: h.memory,
      tools: h.tools,
      clock: h.clock,
    });
    const second = await runtime2.sendTimeline({ parts: userText('After restart') });
    await second.done;
    expect(second.episodeId).toBe(first.episodeId);
  });

  it('closes the episode after a restart when search mode actually changes (off -> native)', async () => {
    const h = harness({ settings: { ai: { search: { mode: 'off' } } } });
    const first = await h.runtime.sendTimeline({ parts: userText('Before restart') });
    await first.done;
    // Settings now expose native search; update before building the new runtime.
    h.settings.update({ ai: { search: { mode: 'auto' } } });
    const runtime2 = new AgentRuntime({
      conversations: h.conversations,
      settings: h.settings,
      providers: new ScriptedRegistry([new ScriptedAdapter({ caps: { nativeWebSearch: true } })]),
      memory: h.memory,
      tools: h.tools,
      clock: h.clock,
    });
    const second = await runtime2.sendTimeline({ parts: userText('After restart') });
    await second.done;
    expect(second.episodeId).not.toBe(first.episodeId);
  });
});
