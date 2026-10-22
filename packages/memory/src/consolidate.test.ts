import { describe, expect, it, vi } from 'vitest';
import type { ChatModel, ChatRequest, ChatStreamEvent, MemoryKind } from '@neo/protocol';
import { DEFAULT_MEMORY_POLICY, silentLogger } from '@neo/protocol';
import { openNeoDatabase } from '@neo/storage';
import { parseAbstraction } from './consolidate.js';
import { createMemoryService, HashingEmbedder } from './index.js';

const T0 = 1_700_000_000_000;
const DERIVED_KINDS: MemoryKind[] = ['summary', 'fact', 'preference', 'skill', 'goal'];

function scriptedLLM(script: { consolidate: (req: ChatRequest) => string | Promise<string> }) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
      requests.push(req);
      const text = req.metadata?.['purpose'] === 'memory-consolidate' ? await script.consolidate(req) : '{}';
      yield { type: 'text', text };
      yield { type: 'done', stopReason: 'end' };
    },
  };
  return { model, requests };
}

function setup(opts: { llm: ChatModel }) {
  const db = openNeoDatabase(':memory:');
  const logger = { ...silentLogger, warn: vi.fn() };
  const svc = createMemoryService({
    db,
    embedder: new HashingEmbedder(256),
    llm: () => ({ model: opts.llm, name: 'fake', isLocal: true }),
    policy: DEFAULT_MEMORY_POLICY,
    clock: () => T0,
    logger,
  });
  return { svc, db, logger };
}

async function twoHikingEpisodes(svc: ReturnType<typeof setup>['svc']) {
  const ep1 = await svc.remember({
    kind: 'episode', label: 'Hike day 1', content: 'Hiked the mountains today outdoors nature', importance: 0.5,
    source: { by: 'extraction', messageId: 'msg_hike_1' },
  });
  const ep2 = await svc.remember({
    kind: 'episode', label: 'Hike day 2', content: 'Hiked the mountains again outdoors nature', importance: 0.5,
    source: { by: 'extraction', messageId: 'msg_hike_2' },
  });
  return [ep1, ep2] as const;
}

const abstraction = JSON.stringify({
  summary: { label: 'Hiking', content: 'The user hikes most weekends', importance: 0.6 },
  facts: [
    { kind: 'fact', label: 'Hiking boots', content: 'The user owns hiking boots', importance: 0.6 },
    { kind: 'preference', label: 'Mountain hikes', content: 'The user prefers mountain hiking trails', importance: 0.6 },
    { kind: 'skill', label: 'Trail navigation', content: 'The user can navigate hiking trails', importance: 0.6 },
    { kind: 'goal', label: 'Weekend hikes', content: 'The user plans to hike every weekend', importance: 0.6 },
  ],
});

describe('parseAbstraction', () => {
  it('rejects a reply when facts is an object', () => {
    expect(parseAbstraction('{"summary":null,"facts":{"kind":"fact","label":"X","content":"Y"}}')).toBeNull();
  });
});

describe('consolidation provenance', () => {
  it.each(['forget', 'forgetBySource'] as const)('skips the whole cluster when %s removes a source episode while the LLM reply is pending', async (method) => {
    let resolveLlm!: (s: string) => void;
    const llmPending = new Promise<string>((resolve) => { resolveLlm = resolve; });
    let llmStarted!: () => void;
    const llmWaiting = new Promise<void>((resolve) => { llmStarted = resolve; });
    const { model, requests } = scriptedLLM({
      consolidate: () => {
        llmStarted();
        return llmPending;
      },
    });
    const { svc, db, logger } = setup({ llm: model });
    try {
      const [ep1, ep2] = await twoHikingEpisodes(svc);
      expect(ep1.id).not.toBe(ep2.id);
      const consolidationDone = svc.consolidate({ force: true });
      await llmWaiting;

      const forgotten = method === 'forget' ? await svc.forget([ep1.id]) : await svc.forgetBySource(['msg_hike_1']);
      resolveLlm(abstraction);
      const report = await consolidationDone;

      expect(forgotten).toBe(1);
      expect(requests).toHaveLength(1);
      const derived = (await svc.search({ kinds: DERIVED_KINDS })).items;
      const recalled = await svc.recall({ text: 'Hiking', kinds: DERIVED_KINDS, reinforce: false });
      expect.soft(derived).toHaveLength(0);
      expect.soft(recalled.items).toHaveLength(0);
      expect(await svc.get(ep1.id)).toBeNull();
      expect((await svc.get(ep2.id))!.node.consolidatedAt ?? null).toBeNull();
      expect(report.episodesConsolidated).toBe(0);
      expect(report.factsCreated).toBe(0);
      expect(logger.warn).toHaveBeenCalledOnce();
    } finally { db.close(); }
  });

  it('keeps provenance to every source episode when all sources still exist', async () => {
    const { model } = scriptedLLM({ consolidate: () => abstraction });
    const { svc, db, logger } = setup({ llm: model });
    try {
      const [ep1, ep2] = await twoHikingEpisodes(svc);
      const report = await svc.consolidate({ force: true });
      const derived = (await svc.search({ kinds: DERIVED_KINDS })).items;
      expect(derived.map((node) => node.kind).sort()).toEqual([...DERIVED_KINDS].sort());
      for (const node of derived) {
        const provenance = (await svc.get(node.id))!.edges.filter((edge) => edge.type === 'derived_from');
        expect(provenance.map((edge) => edge.to).sort()).toEqual([ep1.id, ep2.id].sort());
        expect(provenance.every((edge) => edge.weight === (node.kind === 'summary' ? 0.7 : 0.5))).toBe(true);
      }
      expect((await svc.get(ep1.id))!.node.consolidatedAt).toBe(T0);
      expect((await svc.get(ep2.id))!.node.consolidatedAt).toBe(T0);
      expect(report.episodesConsolidated).toBe(2);
      expect(report.factsCreated).toBe(4);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
