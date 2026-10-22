import { describe, expect, it } from 'vitest';
import type { ChatModel, ChatStreamEvent } from '@neo/protocol';
import { buildExtractionInput, llmExtract } from './extract.js';

describe('extractMemories validUntil guard', () => {
  it.each([
    { name: 'drops out-of-range validUntil 1e20', json: '1e20', expected: undefined },
    { name: 'drops negative validUntil -1', json: '-1', expected: undefined },
    { name: 'drops zero validUntil', json: '0', expected: undefined },
    // A valid JSON number that parses as Infinity, rather than stringifying to null.
    { name: 'drops infinite validUntil', json: '1e309', expected: undefined },
    { name: 'preserves in-range numeric validUntil', json: '1765000000000', expected: 1_765_000_000_000 },
    { name: 'parses ISO string validUntil', json: '"2026-11-01T00:00:00Z"', expected: Date.parse('2026-11-01T00:00:00Z') },
  ])('$name', async ({ json, expected }) => {
    const llm: ChatModel = {
      async *chat(): AsyncIterable<ChatStreamEvent> {
        yield {
          type: 'text',
          text: `{"memories":[{"op":"create","kind":"fact","label":"Visiting Paris","content":"The user is visiting Paris.","validUntil":${json}}]}`,
        };
        yield { type: 'done', stopReason: 'end' };
      },
    };
    const input = buildExtractionInput({
      userText: 'I am visiting Paris for a while.',
      assistantText: 'I will remember that.',
      related: [],
      policy: { allowedKinds: ['fact'] },
      date: '2026-10-22',
    });

    const result = await llmExtract(llm, 'fake', input);

    expect(result?.memories).toHaveLength(1);
    const op = result!.memories[0]!;
    expect(op.op).toBe('create');
    if (op.op !== 'create') throw new Error('Expected the create operation to survive extraction');
    expect(op.validUntil).toBe(expected);
  });
});
