import { describe, expect, it } from 'vitest';
import { summarizeToolDescription } from './ToolsSection.js';

describe('summarizeToolDescription', () => {
  it('keeps the first sentence without code formatting', () => {
    expect(summarizeToolDescription('Search the user\'s notes by `query`. Returns titles with an excerpt.')).toBe("Search the user's notes by query.");
  });

  it('does not stop at abbreviations', () => {
    expect(summarizeToolDescription('Show rich UI (e.g. tables, charts) next to text. Use it often.')).toBe('Show rich UI (e.g. tables, charts) next to text.');
  });

  it('handles Chinese punctuation and caps long text', () => {
    expect(summarizeToolDescription('搜索笔记。返回标题。')).toBe('搜索笔记。');
    const long = summarizeToolDescription(`${'word '.repeat(60)}end`);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith('…')).toBe(true);
  });
});
