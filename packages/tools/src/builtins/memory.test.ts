import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_POLICY, SELF_MEMORY_ID, silentLogger, validateUIBlocks, type MemoryNode, type MemoryService, type RecallQuery, type ToolContext } from '@neo/protocol';
import { createToolRegistry } from '../registry.js';
import { createMemoryTools } from './memory.js';

const context: ToolContext = {
  toolCallId: 'tc_memory', signal: new AbortController().signal, now: () => 0,
  timezone: 'UTC', locale: 'en-US', origin: 'model', allowSensitive: false, logger: silentLogger,
};
function node(id: string, extra: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id, label: 'Window seats', content: 'The user prefers window seats.', kind: 'preference', aliases: [], tags: [],
    importance: 0.5, confidence: 1, stability: 30, accessCount: 0, lastAccessedAt: null, createdAt: 0, updatedAt: 0,
    status: 'active', pinned: false, sensitivity: 'normal', source: { by: 'tool' }, ...extra,
  };
}
function setup(nodes: MemoryNode[], enabled = true) {
  const recall = vi.fn(async (query: RecallQuery) => ({
    items: nodes.filter(n => query.allowSensitive || n.sensitivity !== 'sensitive').slice(0, query.limit).map(n => ({
      node: n, score: 0.9, activation: 1, similarity: 0.9, retention: 1, via: [], reason: 'Matches your message',
    })),
    tookMs: 0, seeds: nodes.length, considered: nodes.length,
  }));
  const memory = {
    getPolicy: () => ({ ...DEFAULT_MEMORY_POLICY, recall: enabled }),
    recall,
    get: async (id: string) => nodes.find(n => n.id === id) ? { node: nodes.find(n => n.id === id)! } : null,
    findForForget: async () => nodes,
    forget: vi.fn(async (ids: string[]) => ids.filter(id => nodes.some(n => n.id === id)).length),
  };
  const registry = createToolRegistry();
  for (const tool of createMemoryTools(memory as unknown as MemoryService)) registry.register(tool, 'builtin');
  const run = (name: string, input: unknown, overrides: Partial<ToolContext> = {}) => registry.execute({ id: context.toolCallId, name, input }, { ...context, ...overrides });
  return { run, recall, registry, memory };
}

describe('recall presentation', () => {
  it.each([undefined, false])('keeps UI absent for NEO lookups (show=%s)', async show => {
    const t = setup([node('mem_window')]);
    const result = await t.run('recall', { query: 'travel', ...(show !== undefined ? { show } : {}) });
    expect(result.ui).toBeUndefined();
    expect(result.output).toEqual({ memories: [{ id: 'mem_window', kind: 'preference', label: 'Window seats', content: 'The user prefers window seats.', reason: 'Matches your message' }] });
    expect(t.recall).toHaveBeenCalledWith(expect.objectContaining({ text: 'travel', limit: 8, allowSensitive: false }));
    expect(t.recall.mock.calls[0]?.[0]).not.toHaveProperty('show');
  });

  it('maps shown results to the memory schema, keeping statuses and bounded content', async () => {
    const t = setup([node('mem_long', { label: 't'.repeat(300), content: 'c'.repeat(10_000), status: 'archived' })]);
    const result = await t.run('recall', { query: 'travel', show: true });
    expect(result.ui).toEqual([{ type: 'memory', title: 'Recalled memories', nodes: [{
      id: 'mem_long', kind: 'preference', label: 't'.repeat(300), content: 'c'.repeat(1999) + '…', status: 'archived',
    }] }]);
    expect(result.output).toMatchObject({ memories: [{ content: 'c'.repeat(10_000), reason: 'Matches your message' }] });
    expect(validateUIBlocks(result.ui).ok).toBe(true);
  });

  it.each([false, true])('shares exactly the permitted recall results with UI (sensitive allowed=%s)', async allowSensitive => {
    const normal = node('mem_window');
    const sensitive = node('mem_health', { label: 'Private allergy', content: 'The user has a private allergy.', sensitivity: 'sensitive' });
    const t = setup([normal, sensitive]);
    const result = await t.run('recall', { query: 'personal', show: true }, { allowSensitive });
    const output = (result.output as { memories: { id: string; label: string; content: string }[] }).memories;
    const block = result.ui?.[0];
    expect(block?.type).toBe('memory');
    if (block?.type !== 'memory') throw new Error('Expected memory block');
    expect(block.nodes.map(({ id, label, content }) => ({ id, label, content }))).toEqual(output.map(({ id, label, content }) => ({ id, label, content })));
    expect(block.nodes).toHaveLength(allowSensitive ? 2 : 1);
    expect(result.sensitive === true).toBe(allowSensitive);
    expect(t.recall).toHaveBeenCalledWith(expect.objectContaining({ allowSensitive }));
  });

  it('does not show an empty memory block or bypass disabled recall', async () => {
    const empty = setup([]);
    expect((await empty.run('recall', { query: 'travel', show: true })).ui).toBeUndefined();
    const disabled = setup([node('mem_window')], false);
    const result = await disabled.run('recall', { query: 'travel', show: true });
    expect(result.ui).toBeUndefined();
    expect(result.output).toMatchObject({ memories: [] });
    expect(disabled.recall).not.toHaveBeenCalled();
  });
});

describe('forget widget targets', () => {
  it.each([true, false])('returns resolved ids alongside existing labels (by ids=%s)', async byIds => {
    const t = setup([node('mem_window'), node('mem_duplicate')]);
    const result = await t.run('forget', byIds ? { ids: ['mem_window', 'mem_window', 'mem_duplicate'] } : { query: 'window seats' });
    expect(result.output).toEqual({ forgotten: ['Window seats', 'Window seats'], ids: ['mem_window', 'mem_duplicate'] });
    expect(t.memory.forget).toHaveBeenCalledWith(['mem_window', 'mem_duplicate']);
    expect(t.registry.get('forget')).toMatchObject({ risk: 'dangerous', defaultPermission: 'confirm' });
  });

  it('does not mark the protected self node forgotten after a partially successful request', async () => {
    const nodes = [node(SELF_MEMORY_ID, { label: 'You', kind: 'entity' }), node('mem_window'), node('mem_other')];
    const t = setup(nodes);
    t.memory.forget.mockImplementation(async ids => {
      let deleted = 0;
      for (const id of ids) {
        if (id === SELF_MEMORY_ID) continue;
        const index = nodes.findIndex(n => n.id === id);
        if (index >= 0) {
          nodes.splice(index, 1);
          deleted++;
        }
      }
      return deleted;
    });
    const result = await t.run('forget', { ids: [SELF_MEMORY_ID, 'mem_window'] });
    expect(result.output).toEqual({ forgotten: ['You', 'Window seats'], ids: ['mem_window'] });
    expect(result.summary).toBe('Forgot 1 memory');
    expect(result.sensitive).toBeUndefined();
    expect(await t.memory.get(SELF_MEMORY_ID)).toMatchObject({ node: { id: SELF_MEMORY_ID, status: 'active' } });
    expect(await t.memory.get('mem_window')).toBeNull();
    expect(await t.memory.get('mem_other')).not.toBeNull();
  });
});
