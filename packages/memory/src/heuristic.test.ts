import { describe, it, expect } from 'vitest';
import { heuristicExtract } from './heuristic.js';

describe('heuristicExtract', () => {
  it('preserves sensitivity across duplicate-label candidates', () => {
    for (const text of [
      "I'm allergic to penicillin.",
      "Remember that I'm allergic to penicillin.",
      "Please remember that I'm allergic to penicillin.",
    ]) {
      const results = heuristicExtract(text);
      expect(results).toHaveLength(1);
      expect(results[0]!.label).toBe('Allergic to penicillin');
      expect(results[0]!.sensitivity).toBe('sensitive');
    }
  });

  it('takes the max importance across duplicate-label candidates', () => {
    const results = heuristicExtract("Remember that I'm allergic to penicillin.");
    expect(results).toHaveLength(1);
    expect(results[0]!.importance).toBe(0.9);
  });

  it('does not merge candidates with different cleaned labels', () => {
    const results = heuristicExtract('My name is Alice.');
    expect(results.some((r) => r.kind === 'entity' && r.label?.includes('Alice'))).toBe(true);
  });
});
