/**
 * The self node (SELF_MEMORY_ID): the user's place at the centre of the net.
 * It holds memories about the user together, and stays out of recall, forget
 * search, consolidation, stats and embedding.
 */
import { describe, expect, it } from 'vitest';
import type { ChatModel, ChatRequest, ChatStreamEvent, MemoryNode, ObservedTurn } from '@neo/protocol';
import { DEFAULT_MEMORY_POLICY, newId, SELF_MEMORY_ID, silentLogger } from '@neo/protocol';
import { migrate, openNeoDatabase, type NeoDatabase } from '@neo/storage';
import { addEdge, insertNode } from './db-helpers.js';
import { createMemoryService, HashingEmbedder, MEMORY_CONSTANTS } from './index.js';
import { memoryMigrations } from './schema.js';
import { isAboutSelf } from './self.js';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function turn(userText: string, now = T0): ObservedTurn {
  const conversationId = 'conv_self';
  return {
    conversationId,
    userMessage: { id: newId('msg', now), conversationId, role: 'user', parts: [{ type: 'text', text: userText }], createdAt: now, status: 'complete' },
    assistantMessage: { id: newId('msg', now + 1), conversationId, role: 'assistant', parts: [{ type: 'text', text: 'Okay.' }], createdAt: now + 1, status: 'complete' },
    now,
  };
}

/** A fake extraction model that returns `memories` for every turn. */
function extractor(memories: unknown[]): ChatModel {
  return {
    async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
      const text = req.metadata?.['purpose'] === 'memory-consolidate' ? '{"summary":null,"facts":[]}' : JSON.stringify({ episode: { label: 'Talked about life', summary: 'The user talked about their life', importance: 0.4 }, memories, links: [] });
      yield { type: 'text', text };
      yield { type: 'done', stopReason: 'end' };
    },
  };
}

/** A fake model answering each extraction call with the next reply, and consolidation with `consolidate`. */
function scripted(replies: string[], consolidate: (req: ChatRequest) => string = () => '{"summary":null,"facts":[]}') {
  const consolidations: ChatRequest[] = [];
  const model: ChatModel = {
    async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
      let text: string;
      if (req.metadata?.['purpose'] === 'memory-consolidate') {
        consolidations.push(req);
        text = consolidate(req);
      } else text = replies.shift() ?? '{}';
      yield { type: 'text', text };
      yield { type: 'done', stopReason: 'end' };
    },
  };
  return { model, consolidations };
}

const extraction = (label: string, memories: unknown[] = []) => JSON.stringify({ episode: { label, summary: `User: ${label}`, importance: 0.4 }, memories, links: [] });
const userText = (req: ChatRequest) => req.messages.map((m) => m.parts.map((p) => ('text' in p ? p.text : '')).join('')).join('\n');

function setup(opts: { llm?: ChatModel; db?: NeoDatabase } = {}) {
  const db = opts.db ?? openNeoDatabase(':memory:');
  let now = T0;
  const svc = createMemoryService({
    db,
    embedder: new HashingEmbedder(256),
    llm: opts.llm ? () => ({ model: opts.llm!, name: 'fake', isLocal: true }) : () => null,
    policy: { ...DEFAULT_MEMORY_POLICY },
    clock: () => now,
    logger: silentLogger,
  });
  return { svc, db, tickDays: (d: number) => { now += d * DAY; } };
}

const selfEdges = (db: NeoDatabase) => db.prepare(`SELECT src, type, weight FROM memory_edges WHERE dst = ? OR src = ? ORDER BY src`).all(SELF_MEMORY_ID, SELF_MEMORY_ID) as { src: string; type: string; weight: number }[];
const hasSelf = (db: NeoDatabase) => !!db.prepare('SELECT 1 AS x FROM memory_nodes WHERE id = ?').get(SELF_MEMORY_ID);

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('the self node', () => {
  it('appears with the first memory about the user and holds it, its episode and nothing else', async () => {
    const llm = extractor([
      { op: 'create', kind: 'preference', label: 'Likes green tea', content: 'The user likes green tea', importance: 0.6, entities: ['the user'] },
      { op: 'create', kind: 'fact', label: 'Mia is a nurse', content: 'Mia is a nurse in Berlin', importance: 0.5, entities: ['Mia', 'Berlin'] },
    ]);
    const { svc, db } = setup({ llm });
    expect(hasSelf(db)).toBe(false);
    const result = await svc.observe(turn('I like green tea. Mia is a nurse in Berlin.'));

    // It is the net's centre, not a new memory: never reported as created.
    expect(result.created.map((n) => n.id)).not.toContain(SELF_MEMORY_ID);
    const self = (await svc.get(SELF_MEMORY_ID))!;
    expect(self.node).toMatchObject({ kind: 'entity', pinned: true, status: 'active' });
    const tea = result.created.find((n) => n.label === 'Likes green tea')!;
    const episode = result.created.find((n) => n.kind === 'episode')!;
    const mia = result.created.find((n) => n.label === 'Mia is a nurse')!;
    expect(selfEdges(db)).toEqual([{ src: episode.id, type: 'about', weight: 0.3 }, { src: tea.id, type: 'about', weight: 0.3 }].sort((a, b) => (a.src < b.src ? -1 : 1)));
    // "the user" in the entity list is the self node, never an entity of its own.
    expect((await svc.search({ kinds: ['entity'] })).items.map((n) => n.label).sort()).toEqual(['Berlin', 'Mia', 'You']);
    expect(selfEdges(db).some((e) => e.src === mia.id)).toBe(false);
  });

  it('links memories the user wrote in the first person, but not entities or facts about the world', () => {
    const base = { id: 'mem_x', label: 'x', source: { by: 'user' as const } };
    expect(isAboutSelf({ ...base, kind: 'fact', content: 'I love hiking' })).toBe(true);
    expect(isAboutSelf({ ...base, kind: 'fact', content: 'I love hiking', source: { by: 'tool' } })).toBe(false);
    expect(isAboutSelf({ ...base, kind: 'fact', content: '用户喜欢爬山', source: { by: 'extraction' } })).toBe(true);
    expect(isAboutSelf({ ...base, kind: 'fact', content: 'The Eiffel Tower is in Paris' })).toBe(false);
    expect(isAboutSelf({ ...base, kind: 'fact', content: 'Usernames must be unique', source: { by: 'extraction' } })).toBe(false);
    expect(isAboutSelf({ ...base, kind: 'entity', content: 'The user’s sister' })).toBe(false);
    expect(isAboutSelf({ ...base, kind: 'episode', content: 'Small talk' })).toBe(true);
    expect(isAboutSelf({ ...base, id: SELF_MEMORY_ID, kind: 'episode', content: 'The user' })).toBe(false);
  });

  it('is never recalled and never carries activation from one memory about the user to another', async () => {
    const { svc } = setup();
    const tea = await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    const nurse = await svc.remember({ kind: 'fact', label: 'Works as a nurse', content: 'The user works as a nurse', source: { by: 'user' } });
    const r = await svc.recall({ text: 'green tea', reinforce: true });
    const ids = r.items.map((i) => i.node.id);
    expect(ids).toContain(tea.id);
    expect(ids).not.toContain(SELF_MEMORY_ID);
    expect(ids).not.toContain(nurse.id);
  });

  it('is not a way for "forget everything about me" to reach every memory', async () => {
    const { svc } = setup();
    await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    await svc.remember({ kind: 'fact', label: 'Works as a nurse', content: 'The user works as a nurse', source: { by: 'user' } });
    // "you" names the self node's label: matching it would select everything hanging on it.
    for (const request of ['forget everything about me', 'forget what you know about me']) {
      const found = await svc.findForForget(request);
      expect(found.map((n) => n.id)).not.toContain(SELF_MEMORY_ID);
      expect(found).toHaveLength(0);
    }
  });

  it('shows in the graph, ends focus paths unless it is the centre, and is not counted in stats', async () => {
    const { svc } = setup();
    const tea = await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    const nurse = await svc.remember({ kind: 'fact', label: 'Works as a nurse', content: 'The user works as a nurse', source: { by: 'user' } });
    const graph = await svc.graph({ limit: 50 });
    expect(graph.nodes.map((n) => n.id)).toContain(SELF_MEMORY_ID);
    expect(graph.edges.filter((e) => e.to === SELF_MEMORY_ID).map((e) => e.from).sort()).toEqual([nurse.id, tea.id].sort());

    const focused = await svc.graph({ centerId: tea.id, depth: 2 });
    expect(focused.nodes.map((n) => n.id).sort()).toEqual([SELF_MEMORY_ID, tea.id].sort());
    const centred = await svc.graph({ centerId: SELF_MEMORY_ID, depth: 2 });
    expect(centred.nodes.map((n) => n.id).sort()).toEqual([SELF_MEMORY_ID, nurse.id, tea.id].sort());

    const stats = await svc.stats();
    expect(stats.total).toBe(2);
    expect(stats.byKind.entity).toBe(0);
    expect(stats.byStatus.active).toBe(2);
  });

  it('goes with the last memory about the user, without counting as forgotten', async () => {
    const { svc, db } = setup();
    const tea = await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    const nurse = await svc.remember({ kind: 'fact', label: 'Works as a nurse', content: 'The user works as a nurse', source: { by: 'user' } });
    expect(await svc.forget([tea.id])).toBe(1);
    expect(hasSelf(db)).toBe(true);
    expect(await svc.forget([nurse.id])).toBe(1);
    expect(hasSelf(db)).toBe(false);
    // And comes back with the next one.
    await svc.remember({ kind: 'goal', label: 'Run a marathon', content: 'The user wants to run a marathon', source: { by: 'user' } });
    expect(hasSelf(db)).toBe(true);
  });

  it('is never embedded, faded, or merged with an entity that shares its label', async () => {
    const { svc, db, tickDays } = setup();
    await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    const song = await svc.remember({ kind: 'entity', label: 'You', content: 'A song by a band the user likes', source: { by: 'user' } });
    expect(song.id).not.toBe(SELF_MEMORY_ID);
    tickDays(400);
    // Consolidation also re-embeds every node without a current vector.
    await svc.consolidate({ force: true });
    await settle();
    const exported = await svc.export({ includeEmbeddings: true });
    expect(Object.keys(exported.embeddings ?? {})).toContain(song.id);
    expect(Object.keys(exported.embeddings ?? {})).not.toContain(SELF_MEMORY_ID);
    expect(db.prepare('SELECT embedding_model FROM memory_nodes WHERE id = ?').get(SELF_MEMORY_ID)).toEqual({ embedding_model: null });
    const self = (await svc.get(SELF_MEMORY_ID))!.node;
    expect(self.status).toBe('active');
    expect((await svc.get(song.id))?.node.id).toBe(song.id);
  });
});

describe('the self node and the other write paths', () => {
  it('cannot be edited or forgotten directly', async () => {
    const { svc, db } = setup();
    await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    await expect(svc.update(SELF_MEMORY_ID, { status: 'archived' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.update(SELF_MEMORY_ID, { pinned: false })).rejects.toMatchObject({ code: 'bad_request' });
    expect(await svc.forget([SELF_MEMORY_ID])).toBe(0);
    expect((await svc.get(SELF_MEMORY_ID))!.node).toMatchObject({ status: 'active', pinned: true });
    expect(selfEdges(db)).toHaveLength(1);
  });

  it('survives extracted updates, supersessions and forgetting their resulting nodes unchanged', async () => {
    const replies = [
      extraction('Attempted self update', [{ op: 'update', id: SELF_MEMORY_ID, label: 'HACKED', content: 'HACKED', sensitivity: 'sensitive' }]),
      extraction('Attempted self supersession', [{ op: 'supersede', id: SELF_MEMORY_ID, kind: 'fact', label: 'Replaced you', content: 'You have been replaced', sensitivity: 'sensitive' }]),
    ];
    const { model } = scripted(replies);
    const { svc, db } = setup({ llm: model });
    const tea = await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    expect(selfEdges(db).some((e) => e.src === tea.id && e.type === 'about')).toBe(true);
    const original = (await svc.get(SELF_MEMORY_ID))!.node;
    expect(original).toMatchObject({ label: 'You', content: '', sensitivity: 'normal', status: 'active' });
    const expectUnchangedSelf = async () => {
      const self = await svc.get(SELF_MEMORY_ID);
      expect.soft(self?.node).toEqual(original);
      expect.soft(self?.history).toEqual([]);
    };

    const updated = await svc.observe(turn('Keep the centre of my memory unchanged'));
    expect(replies).toHaveLength(1);
    expect(updated.created.some((n) => n.label === 'Attempted self update')).toBe(true);
    expect.soft(updated.updated.map((n) => n.id)).not.toContain(SELF_MEMORY_ID);
    await expectUnchangedSelf();

    const result = await svc.observe(turn('Keep my identity unchanged too'));
    expect(replies).toHaveLength(0);
    expect(result.created.some((n) => n.label === 'Attempted self supersession')).toBe(true);
    expect.soft(result.superseded.map((n) => n.id)).not.toContain(SELF_MEMORY_ID);
    await expectUnchangedSelf();
    for (const node of result.created) {
      expect.soft((await svc.get(node.id))!.history.map((n) => n.id)).not.toContain(SELF_MEMORY_ID);
    }

    const nodeIds = result.created.map((n) => n.id);
    expect.soft(await svc.forget(nodeIds)).toBe(nodeIds.length);
    for (const id of nodeIds) expect(await svc.get(id)).toBeNull();
    await expectUnchangedSelf();
    expect((await svc.get(tea.id))!.node.status).toBe('active');
  });

  it('never recursively forgets the self node through legacy superseded history', async () => {
    const { svc, db } = setup();
    const tea = await svc.remember({ kind: 'preference', label: 'Green tea', content: 'The user likes green tea', source: { by: 'user' } });
    const original = (await svc.get(SELF_MEMORY_ID))!.node;
    const older = await svc.remember({ kind: 'fact', label: 'Old capital', content: 'The old capital was Kyoto', source: { by: 'tool' } });
    const current = await svc.remember({ kind: 'fact', label: 'Current capital', content: 'The current capital is Tokyo', source: { by: 'tool' } });
    // Reproduce history left by the old extraction bug, including a second recursive hop.
    addEdge(db, current.id, older.id, 'supersedes', 1, T0);
    addEdge(db, older.id, SELF_MEMORY_ID, 'supersedes', 1, T0);
    db.prepare("UPDATE memory_nodes SET status = 'superseded' WHERE id IN (?, ?)").run(older.id, SELF_MEMORY_ID);
    expect((await svc.get(current.id))!.history.map((n) => n.id)).toEqual([older.id, SELF_MEMORY_ID]);
    const legacySelf = { ...original, status: 'superseded' };
    expect((await svc.get(SELF_MEMORY_ID))!.node).toEqual(legacySelf);

    expect.soft(await svc.forget([current.id])).toBe(2);
    expect(await svc.get(current.id)).toBeNull();
    expect(await svc.get(older.id)).toBeNull();
    expect((await svc.get(SELF_MEMORY_ID))?.node).toEqual(legacySelf);
    expect(selfEdges(db)).toEqual([{ src: tea.id, type: 'about', weight: 0.3 }]);
  });

  it('links a memory once an update (from extraction or the user) makes it about the user', async () => {
    const { model } = scripted([]);
    const { svc, db } = setup({ llm: model });
    const ts = await svc.remember({ kind: 'preference', label: 'TypeScript', content: 'TypeScript is preferred for tools', source: { by: 'tool' } });
    expect(selfEdges(db).some((e) => e.src === ts.id)).toBe(false);
    const { model: updater } = scripted([extraction('Talked about TypeScript', [{ op: 'update', id: ts.id, content: 'The user now prefers TypeScript for every project' }])]);
    const viaObserve = setup({ llm: updater, db });
    await viaObserve.svc.observe(turn('I now prefer TypeScript for everything'));
    expect(selfEdges(db).some((e) => e.src === ts.id)).toBe(true);

    const garden = await svc.remember({ kind: 'fact', label: 'Garden', content: 'Tomatoes need full sun', source: { by: 'tool' } });
    await svc.update(garden.id, { content: 'The user grows tomatoes in full sun' });
    expect(selfEdges(db).some((e) => e.src === garden.id)).toBe(true);
  });

  it('links revisions and the knowledge consolidation learns about the user', async () => {
    const { model } = scripted(
      [extraction('Talked about tennis'), extraction('Talked about the garden')],
      () => JSON.stringify({ summary: null, facts: [{ kind: 'fact', label: 'Plays tennis', content: 'The user plays tennis on Sundays', importance: 0.6 }, { kind: 'fact', label: 'Clay courts', content: 'Clay courts are slow', importance: 0.4 }] }),
    );
    const { svc, db, tickDays } = setup({ llm: model });
    // The older version is not about the user (so it has no self link to copy); the revision is.
    const short = await svc.remember({ kind: 'preference', label: 'Short answers', content: 'Keep answers short', source: { by: 'tool' } });
    expect(selfEdges(db).some((e) => e.src === short.id)).toBe(false);
    const long = await svc.remember({ kind: 'preference', label: 'Detailed answers', content: 'The user wants long, detailed answers', source: { by: 'user' } });
    expect((await svc.get(short.id))!.node.status).toBe('superseded');
    expect(selfEdges(db).some((e) => e.src === long.id)).toBe(true);

    await svc.observe(turn('I played tennis today'));
    tickDays(MEMORY_CONSTANTS.singleEpisodeAbstractDays + 1);
    await svc.consolidate({ force: true });
    const learned = (await svc.search({ query: 'tennis Sundays' })).items.find((n) => n.label === 'Plays tennis');
    const clay = (await svc.search({ query: 'clay courts' })).items.find((n) => n.label === 'Clay courts');
    expect(learned && selfEdges(db).some((e) => e.src === learned.id)).toBe(true);
    expect(clay && selfEdges(db).some((e) => e.src === clay.id)).toBe(false);
  });

  it('does not make every episode one consolidation cluster', async () => {
    const topics = ['Practised the cello for an hour', 'Repaired a bicycle chain', 'Read about volcanoes in Iceland'];
    const { model, consolidations } = scripted(topics.map((t) => extraction(t)));
    const { svc, tickDays } = setup({ llm: model });
    for (const [i, t] of topics.entries()) await svc.observe({ ...turn(t, T0 + i * 1000), conversationId: `conv_${i}` });
    tickDays(MEMORY_CONSTANTS.singleEpisodeAbstractDays + 1);
    await svc.consolidate({ force: true });
    // Each topic is its own cluster: no request carries more than one episode.
    expect(consolidations.length).toBeGreaterThan(1);
    for (const req of consolidations) expect(userText(req).split('\n').filter((l) => l.startsWith('- [')).length).toBe(1);
  });
});

describe('importing an export made before the self node', () => {
  it('hangs the imported memories about the user on the self node', async () => {
    const { svc, db } = setup();
    const at = { accessCount: 0, lastAccessedAt: null, createdAt: T0, updatedAt: T0, status: 'active' as const, pinned: false, sensitivity: 'normal' as const, source: { by: 'extraction' as const } };
    const report = await svc.import({
      format: 'neo-memory', version: 1, exportedAt: T0, embeddingModel: 'other',
      nodes: [
        { id: 'mem_tea', kind: 'preference', label: 'Green tea', content: 'The user likes green tea', aliases: [], tags: [], importance: 0.6, confidence: 0.9, stability: 30, ...at },
        { id: 'mem_tower', kind: 'fact', label: 'Eiffel Tower', content: 'The Eiffel Tower is in Paris', aliases: [], tags: [], importance: 0.4, confidence: 0.9, stability: 30, ...at },
      ],
      edges: [],
    });
    expect(report).toEqual({ nodes: 2, edges: 0, skipped: 0 });
    expect(selfEdges(db).map((e) => e.src)).toEqual(['mem_tea']);
  });
});

describe('memory migration v3 (self node)', () => {
  const node = (id: string, kind: MemoryNode['kind'], content: string, status: MemoryNode['status'] = 'active'): MemoryNode => ({
    id, kind, label: id, content, aliases: [], tags: [], importance: 0.6, confidence: 0.9, stability: 30,
    accessCount: 0, lastAccessedAt: null, createdAt: T0, updatedAt: T0, status, pinned: false, sensitivity: 'normal', source: { by: 'extraction' },
  });

  it('hangs existing memories about the user on a new self node, once', () => {
    const db = openNeoDatabase(':memory:');
    migrate(db, 'memory', memoryMigrations.slice(0, 2));
    insertNode(db, node('mem_tea', 'preference', 'The user likes green tea'));
    insertNode(db, node('mem_old', 'fact', 'The user lived in Rome', 'archived'));
    insertNode(db, node('mem_gone', 'fact', 'The user lived in Oslo', 'superseded'));
    insertNode(db, node('mem_ep', 'episode', 'User: hello there'));
    insertNode(db, node('mem_mia', 'entity', 'Entity: Mia'));
    insertNode(db, node('mem_tower', 'fact', 'The Eiffel Tower is in Paris'));
    addEdge(db, 'mem_tea', 'mem_mia', 'about', 0.8, T0);

    expect(migrate(db, 'memory', memoryMigrations).applied).toEqual([3]);
    expect(hasSelf(db)).toBe(true);
    expect(selfEdges(db).map((e) => e.src)).toEqual(['mem_ep', 'mem_old', 'mem_tea']);
    expect(migrate(db, 'memory', memoryMigrations).applied).toEqual([]);
  });

  it('leaves a net without memories about the user without a self node', () => {
    const db = openNeoDatabase(':memory:');
    migrate(db, 'memory', memoryMigrations.slice(0, 2));
    insertNode(db, node('mem_tower', 'fact', 'The Eiffel Tower is in Paris'));
    migrate(db, 'memory', memoryMigrations);
    expect(hasSelf(db)).toBe(false);
  });
});
