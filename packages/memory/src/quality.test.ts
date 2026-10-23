/**
 * Memory quality and privacy regressions from a scripted test run and a
 * security audit. Each block names the defect it pins down. Offline and
 * deterministic: in-memory SQLite, injected clock, HashingEmbedder (or a
 * recording "cloud" embedder), scripted fake LLMs.
 */
import { describe, expect, it } from 'vitest';
import type { ChatModel, ChatRequest, ChatStreamEvent, ContentPart, Embedder, MemoryPolicy, ObservedTurn, ProviderAdapter } from '@neo/protocol';
import { DEFAULT_MEMORY_POLICY, newId, silentLogger } from '@neo/protocol';
import { openNeoDatabase, type NeoDatabase } from '@neo/storage';
import { createMemoryService, createProviderEmbedder, HashingEmbedder, heuristicExtract, MEMORY_CONSTANTS } from './index.js';
import { hashingTokens } from './embedder.js';
import { buildExtractionInput } from './extract.js';
import { heuristicEpisode } from './heuristic.js';
import { cleanLabel, isBroadSelfQuery, recallTerms } from './text.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function turn(userText: string, assistantText = 'Okay.', opts: { now?: number; conversationId?: string; assistantParts?: ContentPart[]; userParts?: ContentPart[] } = {}): ObservedTurn {
  const now = opts.now ?? T0;
  const conversationId = opts.conversationId ?? 'conv_q';
  return {
    conversationId,
    userMessage: { id: newId('msg', now), conversationId, role: 'user', parts: opts.userParts ?? [{ type: 'text', text: userText }], createdAt: now, status: 'complete' },
    assistantMessage: {
      id: newId('msg', now + 1),
      conversationId,
      role: 'assistant',
      parts: [...(opts.assistantParts ?? []), { type: 'text', text: assistantText }],
      createdAt: now + 1,
      status: 'complete',
    },
    now,
  };
}

/** The parts core stores when the model called `remember` and the tool answered. */
function rememberCall(node: { id: string; label: string; kind: string; status: string }): ContentPart[] {
  return [
    { type: 'tool_call', id: 'call_r', name: 'remember', input: { content: 'x' } },
    { type: 'tool_result', toolCallId: 'call_r', name: 'remember', output: { id: node.id, label: node.label, kind: node.kind, status: node.status } },
  ];
}

function scriptedLLM(script: { extract?: (req: ChatRequest) => string; consolidate?: (req: ChatRequest) => string }) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
      requests.push(req);
      const handler = req.metadata?.['purpose'] === 'memory-consolidate' ? script.consolidate : script.extract;
      yield { type: 'text', text: handler ? handler(req) : '{}' };
      yield { type: 'done', stopReason: 'end' };
    },
  };
  return { model, requests };
}

const extraction = (body: { episode?: unknown; memories?: unknown[]; links?: unknown[] }) =>
  JSON.stringify({ episode: body.episode ?? null, memories: body.memories ?? [], links: body.links ?? [] });

function setup(opts: { llm?: ChatModel; isLocal?: boolean; policy?: Partial<MemoryPolicy>; embedder?: Embedder; db?: NeoDatabase } = {}) {
  const db = opts.db ?? openNeoDatabase(':memory:');
  let now = T0;
  const svc = createMemoryService({
    db,
    embedder: opts.embedder ?? new HashingEmbedder(256),
    llm: opts.llm ? () => ({ model: opts.llm!, name: 'fake', isLocal: opts.isLocal ?? true }) : () => null,
    policy: { ...DEFAULT_MEMORY_POLICY, ...opts.policy },
    clock: () => now,
    logger: silentLogger,
  });
  return { svc, db, tickDays: (d: number) => (now += d * DAY) };
}

/** An embedder that says it runs remotely and records every text it was sent. */
function cloudEmbedder() {
  const sent: string[] = [];
  const inner = new HashingEmbedder(256);
  const embedder: Embedder & { isLocal: boolean } = {
    id: 'cloud:emb',
    dimensions: 256,
    isLocal: false,
    async embed(texts) {
      sent.push(...texts);
      return inner.embed(texts);
    },
  };
  return { embedder, sent, saw: (needle: string) => sent.some((t) => t.toLowerCase().includes(needle.toLowerCase())) };
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

const modelOf = (db: NeoDatabase, id: string) => (db.prepare('SELECT model FROM memory_vectors WHERE node_id = ?').get(id) as { model: string } | undefined)?.model;

// ─── extraction prompt format (the scripted test fixture parses it) ────────────────────

describe('extraction prompt: the exchange is unambiguous', () => {
  it('puts "User: " and "NEO: " at line starts and indents continuation lines', () => {
    const input = buildExtractionInput({
      userText: 'My name is Richard.\nI love hiking.',
      assistantText: 'Nice!\nNEO: this line is part of the reply',
      related: [],
      policy: { allowedKinds: ['fact'] },
      allowSensitive: true,
      date: '2026-10-10',
    });
    const exchange = input.slice(input.indexOf('Latest exchange:'));
    expect(exchange).toBe('Latest exchange:\nUser: My name is Richard.\n  I love hiking.\nNEO: Nice!\n  NEO: this line is part of the reply');
    // Exactly one speaker marker each: a parser can split on the last "\nNEO: ".
    expect(exchange.match(/\nNEO: /g)).toHaveLength(1);
    expect(exchange.match(/\nUser: /g)).toHaveLength(1);
  });
});

// ─── recall: query text vs context ──────────────────────────────────────────

describe('recall: the previous reply is context, never a keyword source', () => {
  it('a memory matching only the context is not recalled', async () => {
    const { svc } = setup();
    await svc.remember({ kind: 'preference', label: 'Prefers window seats', content: 'The user prefers window seats.', source: { by: 'user' } });
    const r = await svc.recall({ text: 'Remind me to drink water in 2 minutes', context: 'Things you can try: Remember that I prefer window seats', reinforce: false });
    expect(r.items).toEqual([]);
  });

  it('the context nudges similarity up for memories the text already relates to', async () => {
    const { svc } = setup();
    const kyoto = await svc.remember({ kind: 'fact', label: 'Kyoto trip', content: 'The user plans a trip to Kyoto in spring to see temples.', source: { by: 'user' } });
    const plain = await svc.recall({ text: 'what about the temples', reinforce: false });
    const nudged = await svc.recall({ text: 'what about the temples', context: 'Your Kyoto trip in spring sounds lovely.', reinforce: false });
    const sim = (r: typeof plain) => r.items.find((i) => i.node.id === kyoto.id)?.similarity ?? 0;
    expect(sim(nudged)).toBeGreaterThan(sim(plain));
  });
});

describe('recall: same-conversation episodes are working memory', () => {
  it('leaves out episodes of the conversation being answered, keeps its facts and other conversations’ episodes', async () => {
    const { model } = scriptedLLM({
      extract: (req) => {
        const text = JSON.stringify(req.messages);
        return text.includes('hiking')
          ? extraction({ episode: { label: 'Talked about hiking', summary: 'The user talked about hiking trips.' }, memories: [{ op: 'create', kind: 'preference', label: 'Loves hiking', content: 'The user loves hiking trips.', importance: 0.7 }] })
          : extraction({ episode: { label: 'Planned hiking gear', summary: 'The user planned hiking gear for trips.' } });
      },
    });
    const { svc } = setup({ llm: model });
    await svc.observe(turn('I love hiking trips', 'Nice', { conversationId: 'conv_a' }));
    await svc.observe(turn('Let us plan gear', 'Sure', { conversationId: 'conv_b' }));
    const inA = await svc.recall({ text: 'hiking trips', conversationId: 'conv_a', reinforce: false });
    const kinds = inA.items.map((i) => [i.node.kind, i.node.source.conversationId]);
    expect(kinds).toContainEqual(['preference', 'conv_a']);
    expect(kinds).toContainEqual(['episode', 'conv_b']);
    expect(kinds).not.toContainEqual(['episode', 'conv_a']);
    const anywhere = await svc.recall({ text: 'hiking trips', reinforce: false });
    expect(anywhere.items.map((i) => [i.node.kind, i.node.source.conversationId])).toContainEqual(['episode', 'conv_a']);
  });
});

describe('recall: keyword seeds need meaningful overlap', () => {
  it('extracts words, acronyms and CJK bigrams, without stopwords or fragments', () => {
    expect(recallTerms("I don't like the tea at Mia's café in 2 minutes").words).toEqual(['tea', 'mia', 'café']);
    expect(recallTerms('Is AI good at Go in 2026?').words).toEqual(['ai', '2026']);
    expect(recallTerms('你好，我喜欢喝茶').cjk).toEqual(['喝茶']);
    expect(recallTerms('我今天想喝茶').cjk).toEqual(['想喝', '喝茶']);
    expect(recallTerms('我的猫叫小白').cjk).toEqual(['猫叫', '叫小', '小白']);
    expect(recallTerms('我的猫').cjk).toEqual(['猫']);
    // 好 is a stop character (你好, 好的); hiragana is grammar.
    expect(recallTerms('お茶が好きです').cjk).toEqual(['茶']);
  });

  it('“你好，我喜欢喝茶” does not seed every Chinese “喜欢 …” memory; a tea memory is found', async () => {
    const { svc } = setup();
    for (const [label, content] of [['喜欢爬山', '用户喜欢爬山。'], ['喜欢喝咖啡', '用户喜欢喝咖啡。'], ['名字：小明', '用户的名字是小明。'], ['喜欢靠窗的座位', '用户喜欢靠窗的座位。']]) {
      await svc.remember({ kind: 'preference', label: label!, content: content!, source: { by: 'user' } });
    }
    const greet = await svc.recall({ text: '你好，我喜欢喝茶', reinforce: false });
    // No keyword seeds at all (喜欢/我/你好 are not keywords). The coffee preference may still come
    // by meaning (another drink); hiking, window seats and the name never do.
    expect(greet.items.filter((i) => i.reason === 'shares keywords')).toEqual([]);
    expect(greet.items.map((i) => i.node.label).filter((l) => l !== '喜欢喝咖啡')).toEqual([]);
    const tea = await svc.remember({ kind: 'preference', label: '喜欢喝茶', content: '用户喜欢喝茶。', source: { by: 'user' } });
    const later = await svc.recall({ text: '我今天想喝茶', reinforce: false });
    expect(later.items.map((i) => i.node.id)).toEqual([tea.id]);
    expect(later.items[0]!.reason).toBe('shares keywords');
  });

  it('“I like tea” does not pull in every “Likes …” preference', async () => {
    const { svc } = setup();
    for (const what of ['jazz', 'hiking', 'cats', 'chess']) {
      await svc.remember({ kind: 'preference', label: `Likes ${what}`, content: `The user likes ${what}.`, source: { by: 'user' } });
    }
    const r = await svc.recall({ text: 'I like tea', reinforce: false });
    expect(r.items.filter((i) => i.reason === 'shares keywords')).toEqual([]);
  });

  it('a word most of a large net shares is not a keyword seed; a rare one is', async () => {
    const { svc } = setup();
    for (let i = 0; i < 24; i++) await svc.remember({ kind: 'fact', label: `Project note ${i}`, content: `Project status ${i}: on track with milestone ${i}`, source: { by: 'user' } });
    const kickoff = await svc.remember({ kind: 'fact', label: 'Kickoff', content: 'The project kickoff is on Monday', source: { by: 'user' } });
    const r = await svc.recall({ text: 'project kickoff', reinforce: false });
    const keyword = r.items.filter((i) => i.reason === 'shares keywords').map((i) => i.node.id);
    expect(keyword).toEqual([kickoff.id]);
  });

  it('a small net still matches its own topic word', async () => {
    const { svc } = setup();
    const a = await svc.remember({ kind: 'fact', label: 'Kyoto temples', content: 'The user loves Kyoto temples', source: { by: 'user' } });
    const b = await svc.remember({ kind: 'fact', label: 'Kyoto trip', content: 'Kyoto trip planned for spring', source: { by: 'user' } });
    const r = await svc.recall({ text: 'kyoto', reinforce: false });
    expect(r.items.map((i) => i.node.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('"the user" (how models query the recall tool) is a broad question about the user', async () => {
    expect(isBroadSelfQuery('the user')).toBe(true);
    expect(isBroadSelfQuery('user preferences')).toBe(true);
    expect(isBroadSelfQuery('What does the user like?')).toBe(true);
    expect(isBroadSelfQuery('用户')).toBe(true);
    expect(isBroadSelfQuery('user interface bugs')).toBe(false);
    const { svc } = setup();
    const name = await svc.remember({ kind: 'fact', label: 'Name: Richard', content: "The user's name is Richard.", importance: 0.95, source: { by: 'user' } });
    expect((await svc.recall({ text: 'the user', reinforce: false })).items.map((i) => i.node.id)).toContain(name.id);
  });
});

// ─── write path: remember tool + extraction in one turn ─────────────────────

describe('observe: what the remember tool wrote this turn is not written again', () => {
  it('an LLM paraphrase of the remembered fact is not a second memory; the model sees the tool memory as related', async () => {
    const { model, requests } = scriptedLLM({
      extract: () =>
        extraction({
          memories: [
            { op: 'create', kind: 'preference', label: 'Vegetarian diet', content: 'The user follows a vegetarian diet.', importance: 0.8 },
            { op: 'create', kind: 'fact', label: 'Vegetarian', content: 'The user is vegetarian', importance: 0.8 },
          ],
        }),
    });
    const { svc } = setup({ llm: model });
    const node = await svc.remember({ content: 'The user is vegetarian.', label: 'Vegetarian', source: { by: 'tool', conversationId: 'conv_q' } });
    const res = await svc.observe(turn('Remember that I am vegetarian', "Got it — I'll remember that.", { assistantParts: rememberCall(node) }));
    expect(res.created).toEqual([]);
    expect(JSON.stringify(requests[0]!.messages)).toContain(node.id);
    const all = (await svc.search({ query: 'vegetarian' })).items.filter((n) => n.kind !== 'episode');
    expect(all.map((n) => n.id)).toEqual([node.id]);
  });

  it('a reinforce op on the tool memory is dropped (it was just written)', async () => {
    let id = '';
    const { model } = scriptedLLM({ extract: () => extraction({ memories: [{ op: 'reinforce', id }] }) });
    const { svc } = setup({ llm: model });
    const node = await svc.remember({ content: 'The user is vegetarian.', label: 'Vegetarian', source: { by: 'tool' } });
    id = node.id;
    await svc.observe(turn('Remember that I am vegetarian', 'Got it.', { assistantParts: rememberCall(node) }));
    expect((await svc.get(node.id))!.node.accessCount).toBe(node.accessCount);
  });

  it('the offline extractor does not duplicate it either', async () => {
    const { svc } = setup();
    const node = await svc.remember({ content: 'The user is vegetarian.', label: 'Vegetarian', source: { by: 'tool' } });
    const res = await svc.observe(turn('Remember that I am vegetarian', 'Got it.', { assistantParts: rememberCall(node) }));
    expect(res.created.filter((n) => n.kind !== 'episode')).toEqual([]);
    expect((await svc.stats()).byKind.fact).toBe(1);
  });

  it('labels from a model are cleaned (quotes, trailing punctuation)', async () => {
    const { model } = scriptedLLM({ extract: () => extraction({ episode: { label: '“Window seats.”', summary: 'x' }, memories: [{ op: 'create', kind: 'preference', label: 'Prefers window seats”.', content: 'The user prefers window seats.', importance: 0.6 }] }) });
    const { svc } = setup({ llm: model });
    const res = await svc.observe(turn('I prefer window seats'));
    expect(res.created.map((n) => n.label).sort()).toEqual(['Prefers window seats', 'Window seats']);
    expect(cleanLabel('  — “Vegetarian”. ')).toBe('Vegetarian');
  });
});

describe('heuristic extraction (no model)', () => {
  it('learns clean, third-person memories from statements', () => {
    const intro = heuristicExtract('Hi! My name is Richard and I love hiking in the mountains.');
    expect(intro.map((m) => [m.kind, m.label, m.content])).toEqual([
      ['entity', 'Richard', "The user's name is Richard."],
      ['preference', 'Loves hiking in the mountains', 'The user loves hiking in the mountains.'],
    ]);
    expect(heuristicExtract('Remember that I am vegetarian').map((m) => [m.label, m.content])).toEqual([['Vegetarian', 'The user is vegetarian.']]);
    expect(heuristicExtract('Please remember that I prefer window seats.').map((m) => [m.label, m.content])).toContainEqual(['Prefers window seats', 'The user prefers window seats.']);
    expect(heuristicExtract('记住我对花生过敏').map((m) => [m.label, m.content])).toContainEqual(['对花生过敏', '用户对花生过敏。']);
  });

  it('questions never create memories or episodes', () => {
    for (const q of ['What do you remember about me?', 'Do you remember that I like jazz?', 'do you know my name is Bob', '你记得我叫什么吗？']) {
      expect(heuristicExtract(q), q).toEqual([]);
      expect(heuristicEpisode(q, []), q).toBeNull();
    }
  });

  it('labels episodes with what the user did', () => {
    expect(heuristicEpisode('Hi! My name is Richard and I love hiking in the mountains.', heuristicExtract('Hi! My name is Richard and I love hiking in the mountains.'))).toBe('Introduced themselves');
    expect(heuristicEpisode('Remember that I am vegetarian', heuristicExtract('Remember that I am vegetarian'))).toBe('Said they are vegetarian');
    expect(heuristicEpisode('Remind me to drink water in 2 minutes', [])).toBe('Asked for a reminder to drink water');
    expect(heuristicEpisode('Hi there!', [])).toBeNull();
    expect(heuristicEpisode('thanks', [])).toBeNull();
  });

  it('an offline episode keeps the user’s words, not NEO’s reply', async () => {
    const { svc } = setup();
    await svc.observe(turn('We planned the Kyoto trip for next spring together', 'Things you can try: Remember that I prefer window seats'));
    const [ep] = (await svc.search({ kinds: ['episode'] })).items;
    expect(ep!.content).not.toContain('window');
    expect(ep!.content).not.toContain('NEO:');
  });
});

// ─── privacy (security audit) ───────────────────────────────────────────────

describe('NEO-06: text that must stay on the device never reaches a cloud embedder', () => {
  it('sensitive memories are embedded locally under their own model id, and still recalled by meaning', async () => {
    const cloud = cloudEmbedder();
    const { svc, db } = setup({ embedder: cloud.embedder });
    const lupus = await svc.remember({ kind: 'fact', label: 'Lupus', content: 'The user has lupus and sees a rheumatologist.', sensitivity: 'sensitive', source: { by: 'user' } });
    const jazz = await svc.remember({ kind: 'preference', label: 'Jazz', content: 'The user likes jazz.', source: { by: 'user' } });
    await settle();
    expect(cloud.saw('lupus')).toBe(false);
    expect(cloud.saw('jazz')).toBe(true);
    expect(modelOf(db, lupus.id)).toBe('local-hash2-512');
    expect(modelOf(db, jazz.id)).toBe('cloud:emb');
    const r = await svc.recall({ text: 'rheumatologist appointment lupus', allowSensitive: true, reinforce: false });
    const hit = r.items.find((i) => i.node.id === lupus.id);
    expect(hit?.similarity ?? 0).toBeGreaterThan(0);
  });

  it('background re-embedding follows the same rule', async () => {
    const cloud = cloudEmbedder();
    const { svc, db } = setup({ embedder: cloud.embedder });
    await svc.import({
      format: 'neo-memory',
      version: 1,
      exportedAt: T0,
      nodes: [
        { id: 'mem_s', kind: 'fact', label: 'Diagnosis', content: 'The user was diagnosed with epilepsy', aliases: [], tags: [], importance: 0.9, confidence: 0.9, stability: 30, accessCount: 0, lastAccessedAt: null, createdAt: T0, updatedAt: T0, status: 'active', pinned: false, sensitivity: 'sensitive', source: { by: 'import' } },
        { id: 'mem_n', kind: 'fact', label: 'Chess', content: 'The user plays chess', aliases: [], tags: [], importance: 0.5, confidence: 0.9, stability: 30, accessCount: 0, lastAccessedAt: null, createdAt: T0, updatedAt: T0, status: 'active', pinned: false, sensitivity: 'normal', source: { by: 'import' } },
      ],
      edges: [],
    });
    await settle(50);
    expect(cloud.saw('epilepsy')).toBe(false);
    expect(cloud.saw('chess')).toBe(true);
    expect(modelOf(db, 'mem_s')).toBe('local-hash2-512');
    expect(modelOf(db, 'mem_n')).toBe('cloud:emb');
  });

  it('sendSensitiveToCloud lets sensitive text go to the main embedder', async () => {
    const allowed = cloudEmbedder();
    const s2 = setup({ embedder: allowed.embedder, policy: { sendSensitiveToCloud: true } });
    await s2.svc.remember({ kind: 'fact', label: 'Asthma', content: 'The user has asthma.', sensitivity: 'sensitive', source: { by: 'user' } });
    expect(allowed.saw('asthma')).toBe(true);
  });

  it('the recall context (a local model’s reply, maybe quoting sensitive memories) stays off a cloud embedder', async () => {
    const cloud = cloudEmbedder();
    const { svc } = setup({ embedder: cloud.embedder });
    await svc.remember({ kind: 'preference', label: 'Morning walks', content: 'The user walks every morning.', source: { by: 'user' } });
    await svc.recall({ text: 'and tomorrow?', context: 'Remember your methotrexate dose', allowSensitive: true, reinforce: false });
    expect(cloud.saw('and tomorrow?')).toBe(true);
    expect(cloud.saw('methotrexate')).toBe(false);
    // Without sensitive memories in play, the context may nudge the main (cloud) query.
    await svc.recall({ text: 'and tomorrow?', context: 'You wanted to buy flour', allowSensitive: false, reinforce: false });
    expect(cloud.saw('flour')).toBe(true);
  });

  it('provider embedders report the provider’s locality', () => {
    const adapter = (isLocal: boolean) => ({ id: 'p', isLocal, embed: async () => [[1, 0]] }) as unknown as ProviderAdapter;
    expect((createProviderEmbedder(adapter(true), 'm') as { isLocal?: boolean }).isLocal).toBe(true);
    expect((createProviderEmbedder(adapter(false), 'm') as { isLocal?: boolean }).isLocal).toBe(false);
  });
});

describe('NEO-07: a cloud extraction model never sees a sensitive turn', () => {
  const sensitiveContext: ContentPart = { type: 'context', text: '<neo_context>memories: - [fact] The user has lupus</neo_context>', sensitive: true };

  it('skips the cloud model when sensitive memories were recalled into the turn (context part flag)', async () => {
    const { model, requests } = scriptedLLM({ extract: () => extraction({}) });
    const { svc } = setup({ llm: model, isLocal: false });
    const text = 'I am cooking dinner for my parents tonight';
    const res = await svc.observe(turn(text, 'Something gentle on your joints.', { userParts: [sensitiveContext, { type: 'text', text }] }));
    expect(requests).toHaveLength(0);
    // Extracted on the device instead.
    expect(res.created.map((n) => n.label)).toEqual(['Cooking dinner for my parents tonight']);
  });

  it('skips it when the recall tool returned a sensitive memory', async () => {
    const { model, requests } = scriptedLLM({ extract: () => extraction({}) });
    const { svc } = setup({ llm: model, isLocal: false });
    const secret = await svc.remember({ kind: 'fact', label: 'Condition', content: 'The user has lupus', sensitivity: 'sensitive', source: { by: 'user' } });
    const parts: ContentPart[] = [
      { type: 'tool_call', id: 'c1', name: 'recall', input: { query: 'health' } },
      { type: 'tool_result', toolCallId: 'c1', name: 'recall', output: { memories: [{ id: secret.id, kind: 'fact', label: 'Condition', content: 'The user has lupus' }] } },
    ];
    await svc.observe(turn('What should I cook tonight?', 'Something gentle.', { assistantParts: parts }));
    expect(requests).toHaveLength(0);
  });

  it('a local model, or the user’s permission, still gets the turn', async () => {
    const local = scriptedLLM({ extract: () => extraction({}) });
    await setup({ llm: local.model, isLocal: true }).svc.observe(turn('x', 'y', { userParts: [sensitiveContext, { type: 'text', text: 'What should I cook tonight?' }] }));
    expect(local.requests).toHaveLength(1);
    const allowed = scriptedLLM({ extract: () => extraction({}) });
    await setup({ llm: allowed.model, isLocal: false, policy: { sendSensitiveToCloud: true } }).svc.observe(turn('I was diagnosed with asthma'));
    expect(allowed.requests).toHaveLength(1);
    const plain = scriptedLLM({ extract: () => extraction({}) });
    await setup({ llm: plain.model, isLocal: false }).svc.observe(turn('I like jazz'));
    expect(plain.requests).toHaveLength(1);
  });
});

describe('NEO-13: update and supersede can raise sensitivity', () => {
  it('an update that adds a diagnosis makes the memory and the episode sensitive', async () => {
    let target = '';
    const { model } = scriptedLLM({
      extract: () =>
        extraction({
          episode: { label: 'Health update', summary: 'The user shared a diagnosis.' },
          memories: [{ op: 'update', id: target, content: 'The user has a cough caused by asthma.', reason: 'diagnosis', sensitivity: 'sensitive' }],
        }),
    });
    const { svc } = setup({ llm: model });
    const cough = await svc.remember({ kind: 'fact', label: 'Cough', content: 'The user has a cough.', source: { by: 'user' } });
    target = cough.id;
    const res = await svc.observe(turn('The doctor said my cough is asthma'));
    expect((await svc.get(cough.id))!.node.sensitivity).toBe('sensitive');
    expect(res.created.find((n) => n.kind === 'episode')?.sensitivity).toBe('sensitive');
  });

  it('a supersede revision is at least as sensitive as the model says; an update never lowers it', async () => {
    let target = '';
    let op: Record<string, unknown> = {};
    const { model } = scriptedLLM({ extract: () => extraction({ memories: [{ ...op, id: target }] }) });
    const { svc } = setup({ llm: model });
    const job = await svc.remember({ kind: 'fact', label: 'Income', content: 'The user earns a salary.', source: { by: 'user' } });
    target = job.id;
    op = { op: 'supersede', kind: 'fact', label: 'Income', content: 'The user earns 90k a year.', reason: 'new', sensitivity: 'sensitive' };
    const res = await svc.observe(turn('I now earn 90k a year'));
    const revision = res.created.find((n) => n.kind === 'fact')!;
    expect(revision.sensitivity).toBe('sensitive');
    target = revision.id;
    op = { op: 'update', content: 'The user earns 95k a year.', reason: 'raise', sensitivity: 'normal' };
    await svc.observe(turn('Got a raise to 95k', 'Congrats', { now: T0 + 1000 }));
    expect((await svc.get(revision.id))!.node.sensitivity).toBe('sensitive');
  });
});

describe('NEO-17: forgetting a memory removes its text from the consolidation journal', () => {
  it('rewrites journal lines that name it, keeping the counts', async () => {
    const { model } = scriptedLLM({
      consolidate: () => JSON.stringify({ summary: null, facts: [{ kind: 'fact', label: 'The user has lupus', content: 'The user has lupus and flares in winter.', importance: 0.8 }] }),
    });
    const { svc, tickDays } = setup({ llm: model, isLocal: true });
    await svc.remember({ kind: 'episode', label: 'Doctor visit', content: 'Talked about lupus flares', importance: 0.5 });
    await svc.remember({ kind: 'episode', label: 'Doctor visit again', content: 'Talked about lupus flares again', importance: 0.5 });
    tickDays(10);
    const report = await svc.consolidate({ force: true });
    expect(report.notes.join('\n')).toContain('Learned: The user has lupus');
    const learned = (await svc.search({ query: 'lupus winter', kinds: ['fact'] })).items[0]!;
    await svc.forget([learned.id]);
    const [stored] = await svc.journal(1);
    expect(JSON.stringify(stored)).not.toContain('lupus');
    expect(stored!.factsCreated).toBe(report.factsCreated);
    expect(stored!.notes).toContain('Learned something you later asked me to forget (from 2 conversations)');
    expect(stored).not.toHaveProperty('noteRefs');
  });

  it('older reports without line references are redacted by label', async () => {
    const { svc, db } = setup();
    const node = await svc.remember({ kind: 'fact', label: 'Owes money to Sam', content: 'The user owes Sam 500 dollars', source: { by: 'user' } });
    const legacy = { id: 'cons_legacy', startedAt: T0, finishedAt: T0, archived: 0, edgesDecayed: 0, edgesPruned: 0, episodesConsolidated: 1, factsCreated: 1, linksCreated: 0, entitiesMerged: 0, notes: ['Learned: Owes money to Sam (from 1 conversation)', 'Let go of 2 faded links between memories'] };
    db.prepare('INSERT INTO memory_journal (id, started_at, finished_at, report) VALUES (?, ?, ?, ?)').run(legacy.id, T0, T0, JSON.stringify(legacy));
    await svc.forget([node.id]);
    const [stored] = await svc.journal(1);
    expect(stored!.notes).toEqual(['Learned something you later asked me to forget (from 1 conversation)', 'Let go of 2 faded links between memories']);
  });
});

// ─── documentation pass: remaining privacy and correctness gaps ─────────────

/** The on-device fallback's model id (follows the hashing embedder's id). */
const LOCAL_MODEL = `local-${new HashingEmbedder(512).id}`;
const countRows = (db: NeoDatabase, sql: string, ...params: (string | number)[]) => Number((db.prepare(sql).get(...params) as { n: number | bigint }).n);
const sensitiveContextPart: ContentPart = { type: 'context', text: '<neo_context>memories: - [fact] The user has lupus</neo_context>', sensitive: true };

describe('doc pass: an episode is as sensitive as the turn it records', () => {
  it('a sensitive-looking turn gives a sensitive episode, kept off cloud embedders and out of normal recall (no model)', async () => {
    const cloud = cloudEmbedder();
    const { svc } = setup({ embedder: cloud.embedder });
    const res = await svc.observe(turn("I've been seeing a therapist for my depression since March."));
    const ep = res.created.find((n) => n.kind === 'episode');
    expect(ep?.sensitivity).toBe('sensitive');
    await settle();
    expect(cloud.saw('therapist')).toBe(false);
    const r = await svc.recall({ text: 'therapist depression March', allowSensitive: false, reinforce: false });
    expect(r.items.map((i) => i.node.id)).not.toContain(ep!.id);
  });

  it('a turn that touched a sensitive memory (context part, recall tool, a merge into one) gives a sensitive episode', async () => {
    const { svc } = setup();
    const text = 'I am cooking dinner for my parents tonight';
    const viaContext = await svc.observe(turn(text, 'Enjoy.', { userParts: [sensitiveContextPart, { type: 'text', text }] }));
    expect(viaContext.created.find((n) => n.kind === 'episode')?.sensitivity).toBe('sensitive');

    const secret = await svc.remember({ kind: 'fact', label: 'Sister in Lyon', content: "The user's sister lives in Lyon.", sensitivity: 'sensitive', source: { by: 'user' } });
    const parts: ContentPart[] = [
      { type: 'tool_call', id: 'c1', name: 'recall', input: { query: 'sister' } },
      { type: 'tool_result', toolCallId: 'c1', name: 'recall', output: { memories: [{ id: secret.id, kind: 'fact', label: 'Sister in Lyon', content: 'x' }] } },
    ];
    const viaTool = await svc.observe(turn('We are planning a family weekend trip in the spring', 'Sounds fun.', { now: T0 + 1000, assistantParts: parts }));
    expect(viaTool.created.find((n) => n.kind === 'episode')?.sensitivity).toBe('sensitive');

    const { model } = scriptedLLM({
      extract: () =>
        extraction({
          episode: { label: 'Talked about their sister', summary: 'The user mentioned where their sister lives.' },
          memories: [{ op: 'create', kind: 'fact', label: 'Sister in Lyon', content: "The user's sister lives in Lyon.", importance: 0.6 }],
        }),
    });
    const s2 = setup({ llm: model });
    const known = await s2.svc.remember({ kind: 'fact', label: 'Sister in Lyon', content: "The user's sister lives in Lyon.", sensitivity: 'sensitive', source: { by: 'user' } });
    const viaMerge = await s2.svc.observe(turn('My sister lives in Lyon'));
    expect(viaMerge.updated.map((n) => n.id)).toContain(known.id);
    expect(viaMerge.created.find((n) => n.kind === 'episode')?.sensitivity).toBe('sensitive');
  });
});

describe('doc pass: same-turn dedupe never lowers sensitivity', () => {
  it('a sensitive restatement of a remember-tool memory makes it sensitive and moves its vector on the device', async () => {
    const { model } = scriptedLLM({
      extract: () =>
        extraction({ memories: [{ op: 'create', kind: 'fact', label: 'Meets Sam', content: 'The user meets Sam every Tuesday for counselling.', importance: 0.7, sensitivity: 'sensitive' }] }),
    });
    const cloud = cloudEmbedder();
    const { svc, db } = setup({ llm: model, isLocal: true, embedder: cloud.embedder });
    const node = await svc.remember({ content: 'The user meets Sam every Tuesday.', label: 'Meets Sam', source: { by: 'tool' } });
    expect(node.sensitivity).toBe('normal');
    expect(modelOf(db, node.id)).toBe('cloud:emb');
    const res = await svc.observe(turn('Remember that I meet Sam every Tuesday', 'Got it.', { assistantParts: rememberCall(node) }));
    expect(res.created.filter((n) => n.kind !== 'episode')).toEqual([]);
    expect((await svc.get(node.id))!.node.sensitivity).toBe('sensitive');
    await settle(50);
    expect(modelOf(db, node.id)).toBe(LOCAL_MODEL);
  });

  it('compares vectors only within one embedding space, even when both are 512-dimensional', async () => {
    // A "cloud" embedder whose every vector equals the local hashing vector of the extracted fact.
    const [same] = await new HashingEmbedder(512).embed(['fact: Therapy. The user sees a therapist weekly']);
    const embedder: Embedder & { isLocal: boolean } = { id: 'cloud:const', dimensions: 512, isLocal: false, embed: async (texts) => texts.map(() => Float32Array.from(same!)) };
    const { model } = scriptedLLM({
      extract: () =>
        extraction({ memories: [{ op: 'create', kind: 'fact', label: 'Therapy', content: 'The user sees a therapist weekly', importance: 0.7, sensitivity: 'sensitive' }] }),
    });
    const { svc } = setup({ llm: model, isLocal: true, embedder });
    const veg = await svc.remember({ content: 'The user is vegetarian.', label: 'Vegetarian', source: { by: 'tool' } });
    const res = await svc.observe(turn('Remember that I am vegetarian', 'Noted.', { assistantParts: rememberCall(veg) }));
    expect(res.created.find((n) => n.label === 'Therapy')?.sensitivity).toBe('sensitive');
    expect((await svc.get(veg.id))!.node.sensitivity).toBe('normal');
  });
});

describe('doc pass: vectors follow sensitivity', () => {
  it('a merge that replaces a sensitive memory’s content stores its vector on the device', async () => {
    const cloud = cloudEmbedder();
    const { svc, db } = setup({ embedder: cloud.embedder });
    const mia = await svc.remember({ kind: 'entity', label: 'Mia', content: "Mia is the user's therapist.", sensitivity: 'sensitive', source: { by: 'user' } });
    expect(modelOf(db, mia.id)).toBe(LOCAL_MODEL);
    const merged = await svc.remember({ kind: 'entity', label: 'Mia', content: 'Mia lives in Lyon.', source: { by: 'user' } });
    expect(merged).toMatchObject({ id: mia.id, sensitivity: 'sensitive', content: 'Mia lives in Lyon.' });
    await settle(50);
    expect(modelOf(db, mia.id)).toBe(LOCAL_MODEL);
  });

  it('switching sendSensitiveToCloud off moves sensitive vectors back on the device', async () => {
    const cloud = cloudEmbedder();
    const { svc, db } = setup({ embedder: cloud.embedder, policy: { sendSensitiveToCloud: true } });
    const asthma = await svc.remember({ kind: 'fact', label: 'Asthma', content: 'The user has asthma.', sensitivity: 'sensitive', source: { by: 'user' } });
    const jazz = await svc.remember({ kind: 'preference', label: 'Jazz', content: 'The user likes jazz.', source: { by: 'user' } });
    expect(modelOf(db, asthma.id)).toBe('cloud:emb');
    const sent = cloud.sent.length;
    svc.setPolicy({ ...svc.getPolicy(), sendSensitiveToCloud: false });
    await settle(50);
    expect(modelOf(db, asthma.id)).toBe(LOCAL_MODEL);
    expect(modelOf(db, jazz.id)).toBe('cloud:emb');
    expect(cloud.sent.length).toBe(sent);
    const r = await svc.recall({ text: 'asthma', allowSensitive: true, reinforce: false });
    expect(r.items.find((i) => i.node.id === asthma.id)?.similarity ?? 0).toBeGreaterThan(0);
  });
});

describe('doc pass: remember() detects sensitive content', () => {
  it('defaults to sensitive for sensitive-looking content; only the user can keep it normal', async () => {
    const cloud = cloudEmbedder();
    const { svc } = setup({ embedder: cloud.embedder });
    const tool = await svc.remember({ content: 'The user takes insulin for type 1 diabetes.', source: { by: 'tool' } });
    expect(tool.sensitivity).toBe('sensitive');
    const claimedNormal = await svc.remember({ content: 'The user is on medication for migraines.', sensitivity: 'normal', source: { by: 'tool' } });
    expect(claimedNormal.sensitivity).toBe('sensitive');
    const user = await svc.remember({ content: 'The user had knee surgery in 2019.', source: { by: 'user' } });
    expect(user.sensitivity).toBe('sensitive');
    await settle();
    expect(cloud.saw('insulin') || cloud.saw('migraines') || cloud.saw('surgery')).toBe(false);
    const userNormal = await svc.remember({ content: 'The user volunteers at church on Sundays.', sensitivity: 'normal', source: { by: 'user' } });
    expect(userNormal.sensitivity).toBe('normal');
    expect((await svc.remember({ content: 'The user likes jazz.', source: { by: 'tool' } })).sensitivity).toBe('normal');
  });
});

describe('doc pass: an invalid policy falls back per field', () => {
  it('keeps every valid field and replaces only the invalid ones with defaults', () => {
    const { svc } = setup({
      policy: { recallLimit: 9999, consolidation: { enabled: false, intervalHours: 0 } } as Partial<MemoryPolicy>,
    });
    const p = svc.getPolicy();
    expect(p.recallLimit).toBe(DEFAULT_MEMORY_POLICY.recallLimit);
    expect(p.consolidation).toEqual({ enabled: false, intervalHours: DEFAULT_MEMORY_POLICY.consolidation.intervalHours });
    svc.setPolicy({ ...p, sendSensitiveToCloud: 'yes', allowedKinds: ['fact', 'gossip'], minScore: 0.3, unknownField: 1 } as unknown as MemoryPolicy);
    expect(svc.getPolicy()).toMatchObject({ sendSensitiveToCloud: false, allowedKinds: ['fact'], recallLimit: 12, minScore: 0.3 });
    expect(svc.getPolicy()).not.toHaveProperty('unknownField');
  });
});

describe('doc pass: offline episode thresholds come from MEMORY_CONSTANTS', () => {
  it('heuristicEpisode reads episodeMinChars and episodeMinCharsCJK', () => {
    const C = MEMORY_CONSTANTS as unknown as Record<string, number>;
    expect(heuristicEpisode('We planned the Kyoto trip together', [])).toBe('We planned the Kyoto trip together');
    expect(heuristicEpisode('我们一起计划了京都旅行', [])).not.toBeNull();
    const saved = { en: C['episodeMinChars']!, zh: C['episodeMinCharsCJK'] };
    try {
      C['episodeMinChars'] = 40;
      C['episodeMinCharsCJK'] = 20;
      expect(heuristicEpisode('We planned the Kyoto trip together', [])).toBeNull();
      expect(heuristicEpisode('我们一起计划了京都旅行', [])).toBeNull();
    } finally {
      C['episodeMinChars'] = saved.en;
      if (saved.zh === undefined) delete C['episodeMinCharsCJK'];
      else C['episodeMinCharsCJK'] = saved.zh;
    }
  });
});

describe('doc pass: an aborted link discovery still counts its links', () => {
  it('report.linksCreated matches the similar edges created before the abort', async () => {
    const { svc, db } = setup();
    await svc.remember({ kind: 'fact', label: 'Dup fact one', content: 'Duplicate content about coffee', importance: 0.6, source: { by: 'user' } });
    await svc.remember({ kind: 'fact', label: 'Dup fact two', content: 'Duplicate content about coffee', importance: 0.6, source: { by: 'user' } });
    await svc.remember({ kind: 'fact', label: 'Tea', content: 'The user drinks tea', importance: 0.6, source: { by: 'user' } });
    const similar = () => countRows(db, `SELECT COUNT(*) n FROM memory_edges WHERE type = 'similar'`);
    // Cancelled as soon as the first similarity link exists.
    const signal = { get aborted() { return similar() > 0; } } as unknown as AbortSignal;
    const report = await svc.consolidate({ force: true, signal });
    expect(similar()).toBeGreaterThan(0);
    expect(report.linksCreated).toBe(similar());
    expect(report.notes).toContain(`Noticed ${similar() === 1 ? '1 new similarity' : `${similar()} new similarities`} between memories`);
    expect(report.notes).toContain('Stopped early: consolidation was cancelled');
  });
});

describe('doc pass: the hashing embedder', () => {
  it('tokenizes Han, kana and hangul by code point, with bigrams that never split a surrogate pair', () => {
    expect([...hashingTokens('𠮷野家').keys()]).toEqual(['𠮷', '野', '𠮷野', '家', '野家']);
    expect([...hashingTokens('ねこ').keys()]).toEqual(['ね', 'こ', 'ねこ']);
    expect([...hashingTokens('사랑').keys()]).toEqual(['사', '랑', '사랑']);
    expect([...hashingTokens('Hello世界').keys()]).toEqual(['hello', '世', '界', '世界']);
    for (const token of hashingTokens('𠮷野家と𩸽を食べた').keys()) expect(() => encodeURIComponent(token), token).not.toThrow();
  });

  it('kana and hangul words share features with the longer words that contain them', async () => {
    const e = new HashingEmbedder(512);
    const cos = async (a: string, b: string) => {
      const [x, y] = await e.embed([a, b]);
      return x!.reduce((s, v, i) => s + v * y![i]!, 0);
    };
    expect(await cos('ねこがすき', 'ねこ')).toBeGreaterThan(0.3);
    expect(await cos('사랑해요', '사랑')).toBeGreaterThan(0.3);
  });

  it('has a new id, so vectors of the previous version are re-embedded at start (main and local spaces)', async () => {
    expect(new HashingEmbedder(512).id).toBe('hash2-512');
    expect(LOCAL_MODEL).toBe('local-hash2-512');

    const db = openNeoDatabase(':memory:');
    const a = setup({ db, embedder: new HashingEmbedder(512) });
    const jazz = await a.svc.remember({ content: 'The user likes jazz.', source: { by: 'user' } });
    // As an older NEO stored it.
    db.prepare(`UPDATE memory_vectors SET model = 'hash-512'`).run();
    db.prepare(`UPDATE memory_nodes SET embedding_model = 'hash-512'`).run();
    const b = setup({ db, embedder: new HashingEmbedder(512) });
    await settle(50);
    expect(modelOf(db, jazz.id)).toBe('hash2-512');
    expect(countRows(db, `SELECT COUNT(*) n FROM memory_nodes WHERE embedding_model = 'hash2-512'`)).toBe(1);
    expect((await b.svc.recall({ text: 'jazz music', reinforce: false })).items[0]?.similarity ?? 0).toBeGreaterThan(0);

    const db2 = openNeoDatabase(':memory:');
    const c = setup({ db: db2, embedder: cloudEmbedder().embedder });
    const lupus = await c.svc.remember({ kind: 'fact', label: 'Lupus', content: 'The user has lupus.', sensitivity: 'sensitive', source: { by: 'user' } });
    db2.prepare(`UPDATE memory_vectors SET model = 'local-hash-512'`).run();
    db2.prepare(`UPDATE memory_nodes SET embedding_model = 'local-hash-512'`).run();
    const cloud = cloudEmbedder();
    setup({ db: db2, embedder: cloud.embedder });
    await settle(50);
    expect(modelOf(db2, lupus.id)).toBe('local-hash2-512');
    expect(cloud.saw('lupus')).toBe(false);
  });
});
