import { describe, expect, it } from 'vitest';
import type { ChatModel, MemoryPolicy, ObservedTurn } from '@neo/protocol';
import { DEFAULT_MEMORY_POLICY, newId, silentLogger } from '@neo/protocol';
import { openNeoDatabase } from '@neo/storage';
import { ASSISTANT_STYLE_TAG, createMemoryService, heuristicExtract, MEMORY_CONSTANTS } from './index.js';
import { EXTRACTION_PROMPT } from './extract.js';
import { estimateTokens } from './text.js';

const T0 = 1_700_000_000_000;
const examples = [
  ['keep answers short', 'The user prefers short answers.'],
  ['call me Rich', 'The user wants to be called Rich.'],
  ['reply in Chinese', 'The user wants NEO to reply in Chinese.'],
  ['call yourself Luna', 'The user calls me Luna.'],
  ['be more playful', 'The user wants NEO to be more playful.'],
] as const;

function turn(text: string, now = T0, rememberedId?: string): ObservedTurn {
  const conversationId = 'conv_style';
  return {
    conversationId, now,
    userMessage: { id: newId('msg', now), conversationId, role: 'user', parts: [{ type: 'text', text }], createdAt: now, status: 'complete' },
    assistantMessage: {
      id: newId('msg', now + 1), conversationId, role: 'assistant',
      parts: rememberedId ? [{ type: 'tool_result', name: 'remember', toolCallId: 'call_style', output: { id: rememberedId } }] : [{ type: 'text', text: 'Okay.' }],
      createdAt: now + 1, status: 'complete',
    },
  };
}

function setup(llm?: ChatModel, policy: Partial<MemoryPolicy> = {}) {
  let now = T0;
  const db = openNeoDatabase(':memory:');
  const svc = createMemoryService({
    db, logger: silentLogger, clock: () => now,
    policy: { ...DEFAULT_MEMORY_POLICY, storeEpisodes: false, ...policy },
    llm: () => llm ? { model: llm, name: 'style-test', isLocal: true } : null,
  });
  return { db, svc, tick: (ms = 1000) => now += ms };
}

function extracting(content: string): ChatModel {
  return {
    async *chat() {
      yield { type: 'text', text: JSON.stringify({ episode: null, memories: [{ op: 'create', kind: 'preference', label: 'Conversation preference', content }], links: [] }) };
      yield { type: 'done', stopReason: 'end' };
    },
  };
}

const isStyle = (node: { tags: string[] }) => node.tags.includes(ASSISTANT_STYLE_TAG);

describe('assistant-style extraction', () => {
  it.each(examples)('extracts %s offline as a tagged preference', (text, content) => {
    expect(heuristicExtract(text)).toEqual([expect.objectContaining({ kind: 'preference', content, tags: expect.arrayContaining([ASSISTANT_STYLE_TAG]) })]);
  });

  it.each(examples)('tags the model-extracted preference for %s even when the model omits tags', async (text, content) => {
    const { db, svc } = setup(extracting(content));
    try {
      const result = await svc.observe(turn(text));
      expect(result.created).toEqual([expect.objectContaining({ kind: 'preference', content, tags: expect.arrayContaining([ASSISTANT_STYLE_TAG]) })]);
      expect(EXTRACTION_PROMPT).toContain(`"${text}"`);
    } finally { db.close(); }
  });

  it.each(['请保持回答简短。', '叫我Rich。', '用中文回复。', '你叫Luna。', '更严肃一点。'])('extracts Chinese style requests: %s', (text) => {
    expect(heuristicExtract(text)).toEqual([expect.objectContaining({ kind: 'preference', tags: expect.arrayContaining([ASSISTANT_STYLE_TAG]) })]);
  });

  it('does not turn questions, forget requests or call-me-tomorrow into preferences', () => {
    for (const text of ['Should you be more playful?', 'Forget that I asked you to keep answers short.', 'call me tomorrow please']) expect(heuristicExtract(text)).toEqual([]);
  });

  it('keeps a remember-tool write tagged without making a second copy during observation', async () => {
    const { db, svc } = setup();
    try {
      const written = await svc.remember({ kind: 'preference', content: 'The user prefers short answers.' });
      const result = await svc.observe(turn('keep answers short', T0, written.id));
      expect(result.created).toEqual([]);
      expect((await svc.search({ tags: [ASSISTANT_STYLE_TAG] })).items.map((node) => node.id)).toEqual([written.id]);
      expect((await svc.recall({ text: 'How many moons does Jupiter have?', reinforce: false })).items.map((item) => item.node.id)).toContain(written.id);
    } finally { db.close(); }
  });
});

describe('assistant-style recall', () => {
  it('recalls style for turns with only attachments and no text query', async () => {
    const { db, svc } = setup();
    try {
      const style = await svc.remember({ kind: 'preference', content: 'The user prefers short answers.' });
      const pinned = await svc.remember({ kind: 'fact', content: 'The user enjoys mountain hiking.', pinned: true });
      await svc.link(style.id, pinned.id, 'related', 1);
      expect((await svc.recall({ text: '', reinforce: false })).items.map((item) => item.node.id)).toEqual([style.id]);
    } finally { db.close(); }
  });

  it('reserves five newest preferences before strong unrelated matches and ranks ties by strength', async () => {
    const { db, svc, tick } = setup();
    try {
      const styles = [];
      for (let i = 0; i < 7; i++) {
        if (i !== 6) tick();
        styles.push(await svc.remember({ kind: 'preference', label: `Interaction habit ${i}`, content: `The user requests enduring interaction habit ${i * 977} with ${'abcdefghijkl'[i]}.`, tags: [ASSISTANT_STYLE_TAG], importance: i === 6 ? 0.9 : 0.4 }));
      }
      for (const topic of ['volcanoes', 'orbits', 'telescopes', 'clouds', 'storms', 'rings', 'probes', 'gravity']) {
        await svc.remember({ kind: 'fact', label: `Jupiter ${topic}`, content: `Jupiter research covers ${topic} and their observations.`, importance: 1 });
      }
      const result = await svc.recall({ text: 'Jupiter research observations', limit: 8, reinforce: false });
      expect(result.items.slice(0, 5).map((item) => item.node.id)).toEqual([styles[6]!.id, styles[5]!.id, styles[4]!.id, styles[3]!.id, styles[2]!.id]);
      expect(result.items.filter((item) => isStyle(item.node))).toHaveLength(MEMORY_CONSTANTS.assistantStyleSeedLimit);
      expect(result.items.slice(0, 5).every((item) => item.reason === 'assistant-style preference')).toBe(true);
      expect(result.items.slice(5).some((item) => item.node.kind === 'fact')).toBe(true);
    } finally { db.close(); }
  });

  it('fits smaller style preferences after an oversized one and respects both budgets', async () => {
    const { db, svc, tick } = setup(undefined, { minScore: 1 });
    try {
      const small = await svc.remember({ kind: 'preference', label: 'Length', content: 'The user prefers short answers.' });
      tick();
      await svc.remember({ kind: 'preference', label: 'Long instruction', content: `An enduring interaction rule: ${'never '.repeat(300)}`, tags: [ASSISTANT_STYLE_TAG] });
      const tokenBudget = estimateTokens(`${small.label} ${small.content}`);
      const result = await svc.recall({ text: 'What is the capital of Norway?', tokenBudget, limit: 1, reinforce: false });
      expect(result.items.map((item) => item.node.id)).toEqual([small.id]);
      expect((await svc.recall({ text: 'What is the capital of Norway?', tokenBudget: 0, reinforce: false })).items).toEqual([]);
      expect((await svc.recall({ text: 'What is the capital of Norway?', limit: 0, reinforce: false })).items).toEqual([]);
    } finally { db.close(); }
  });

  it('only seeds active, unexpired style preferences and keeps sensitive preferences private', async () => {
    const { db, svc } = setup();
    try {
      const style = (content: string) => ({ kind: 'preference' as const, content, tags: [ASSISTANT_STYLE_TAG] });
      const active = await svc.remember(style('Use an enduring custom interaction convention for astronomy.'));
      const archived = await svc.remember(style('Use an enduring custom interaction convention for botany.'));
      const expired = await svc.remember({ ...style('Use an enduring custom interaction convention for chemistry.'), validUntil: T0 - 1 });
      const sensitive = await svc.remember({ ...style('Use an enduring custom interaction convention for dermatology.'), sensitivity: 'sensitive' });
      await svc.update(archived.id, { status: 'archived' });
      const query = { text: 'What is the capital of Norway?', includeArchived: true, reinforce: false };
      const result = await svc.recall(query);
      expect(result.items.map((item) => item.node.id)).toEqual([active.id]);
      expect(result.items.map((item) => item.node.id)).not.toContain(expired.id);
      expect((await svc.recall({ ...query, allowSensitive: true })).items.filter((item) => isStyle(item.node)).map((item) => item.node.id)).toContain(sensitive.id);
      expect((await svc.recall({ ...query, kinds: ['fact'] })).items).toEqual([]);
    } finally { db.close(); }
  });

  it('excludes style preferences from Hebbian wiring even when the query matches their words', async () => {
    const { db, svc } = setup();
    try {
      const style = await svc.remember({ kind: 'preference', content: 'The user prefers short answers.' });
      const alpha = await svc.remember({ kind: 'entity', label: 'Alpha', content: 'Entity: Alpha' });
      const beta = await svc.remember({ kind: 'entity', label: 'Beta', content: 'Entity: Beta' });
      const result = await svc.recall({ text: 'Alpha Beta short answers', reinforce: true });
      expect(result.items.map((item) => item.node.id)).toContain(style.id);
      const related = db.prepare("SELECT src, dst FROM memory_edges WHERE type = 'related'").all() as { src: string; dst: string }[];
      expect(related).toHaveLength(1);
      expect(new Set([related[0]!.src, related[0]!.dst])).toEqual(new Set([alpha.id, beta.id]));
    } finally { db.close(); }
  });
});

describe('assistant-style belief revision', () => {
  it('stops recalling a revised preference after its incoming expiry', async () => {
    const { db, svc, tick } = setup();
    try {
      const old = await svc.remember({ kind: 'preference', content: 'The user wants NEO to be playful.' });
      const now = tick();
      const current = await svc.remember({ kind: 'preference', content: 'The user wants NEO to be more serious.', validUntil: now + 3_600_000 });
      expect((await svc.get(old.id))?.node.status).toBe('superseded');
      expect((await svc.get(current.id))?.history.map((node) => node.id)).toEqual([old.id]);
      const query = { text: 'What is the capital of Norway?', reinforce: false };
      expect((await svc.recall(query)).items.map((item) => item.node.id)).toEqual([current.id]);
      tick(3_600_001);
      expect((await svc.recall(query)).items).toEqual([]);
    } finally { db.close(); }
  });

  it('revises a conflicting migrated trait while preserving compatible traits and tone', async () => {
    const { db, svc, tick } = setup();
    try {
      const source = { by: 'user' as const, note: 'migrated from persona settings' };
      const professional = await svc.remember({ kind: 'preference', content: 'The user wants me to use a professional tone.', tags: [ASSISTANT_STYLE_TAG, `${ASSISTANT_STYLE_TAG}:tone`], source });
      const traits = [];
      for (const trait of ['playful', 'warm', 'patient']) {
        tick();
        traits.push(await svc.remember({ kind: 'preference', content: `The user wants me to be ${trait}.`, tags: [ASSISTANT_STYLE_TAG, `${ASSISTANT_STYLE_TAG}:traits`], source }));
      }
      tick();
      const changed = await svc.observe(turn('be more serious', T0 + 4000));
      expect(changed.superseded.map((node) => node.id)).toEqual([traits[0]!.id]);
      expect((await svc.get(changed.created[0]!.id))?.history.map((node) => node.id)).toEqual([traits[0]!.id]);
      for (const node of [professional, traits[1]!, traits[2]!]) expect((await svc.get(node.id))?.node.status).toBe('active');
      const recalled = await svc.recall({ text: 'What is the capital of Norway?', reinforce: false });
      expect(recalled.items.map((item) => item.node.id)).toEqual([changed.created[0]!.id, traits[2]!.id, traits[1]!.id, professional.id]);
    } finally { db.close(); }
  });

  it('keeps compatible tone preferences and migrated traits active together', async () => {
    const { db, svc, tick } = setup();
    try {
      const playful = (await svc.observe(turn('be playful'))).created[0]!;
      tick();
      const warm = (await svc.observe(turn('be warm', T0 + 1000))).created[0]!;
      tick();
      const traits = await svc.remember({ kind: 'preference', content: 'The user wants me to be humorous and direct.', tags: [ASSISTANT_STYLE_TAG, `${ASSISTANT_STYLE_TAG}:traits`], source: { by: 'user', note: 'migrated from persona settings' } });
      for (const node of [playful, warm, traits]) expect((await svc.get(node.id))?.node.status).toBe('active');
      const recalled = await svc.recall({ text: 'What is the capital of Norway?', reinforce: false });
      expect(recalled.items.map((item) => item.node.id)).toEqual([traits.id, warm.id, playful.id]);
    } finally { db.close(); }
  });

  it('supersedes playful with serious offline, keeps history and recalls only the current preference', async () => {
    const { db, svc, tick } = setup();
    try {
      const old = (await svc.observe(turn('be playful'))).created[0]!;
      tick();
      const changed = await svc.observe(turn('be more serious', T0 + 1000));
      expect(changed.superseded.map((node) => node.id)).toEqual([old.id]);
      expect(changed.created).toEqual([expect.objectContaining({ content: 'The user wants NEO to be more serious.', tags: expect.arrayContaining([ASSISTANT_STYLE_TAG]) })]);
      const current = changed.created[0]!;
      expect((await svc.get(current.id))?.history.map((node) => node.id)).toEqual([old.id]);
      expect((await svc.get(old.id))?.node.status).toBe('superseded');
      expect((await svc.recall({ text: 'What is the capital of Norway?', reinforce: false })).items.map((item) => item.node.id)).toEqual([current.id]);
      expect((await svc.observe(turn('be more serious', T0 + 2000))).created).toEqual([]);
    } finally { db.close(); }
  });

  it('revises a migrated tone through a remember-tool write', async () => {
    const { db, svc, tick } = setup();
    try {
      const old = await svc.remember({ kind: 'preference', content: 'The user wants me to use a playful tone.', tags: [ASSISTANT_STYLE_TAG], source: { by: 'user', note: 'migrated from persona settings' } });
      tick();
      const current = await svc.remember({ kind: 'preference', content: 'The user wants NEO to be more serious.' });
      expect((await svc.get(old.id))?.node.status).toBe('superseded');
      expect((await svc.get(current.id))?.history.map((node) => node.id)).toEqual([old.id]);
    } finally { db.close(); }
  });
});
