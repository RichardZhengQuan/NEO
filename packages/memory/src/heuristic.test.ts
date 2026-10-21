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

  it.each([
    ['Please remember that I have diabetes.', 'The user has diabetes.'],
    ["Please remember that I've diabetes.", 'The user has diabetes.'],
    ['Please remember that I have been diagnosed with diabetes.', 'The user has been diagnosed with diabetes.'],
    ["Please remember that I've been diagnosed with diabetes.", 'The user has been diagnosed with diabetes.'],
    ['Please remember that I have been treated for diabetes.', 'The user has been treated for diabetes.'],
    ["Please remember that I've been treated for diabetes.", 'The user has been treated for diabetes.'],
    // Lowercase pronoun: the heuristic regex is case-insensitive, so `thirdPerson()` must handle it too.
    // Codex P2 on PR #445 head 22ef0e3: without lowercase handling, extraction stored "I have diabetes."
    // (first-person) which `isAboutSelf()` only accepts for `source.by === 'user'`, breaking the mem_self link.
    ['i have diabetes.', 'The user has diabetes.'],
    ["i've been diagnosed with diabetes.", 'The user has been diagnosed with diabetes.'],
    ["i've been treated for diabetes.", 'The user has been treated for diabetes.'],
  ])('suppresses normal copies of sensitive health facts for "%s"', (text, content) => {
    const results = heuristicExtract(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe('Health: diabetes');
    expect(results[0]!.sensitivity).toBe('sensitive');
    expect(results[0]!.content).toBe(content);
  });

  it('does not merge candidates with different cleaned labels', () => {
    const results = heuristicExtract('My name is Alice.');
    expect(results.some((r) => r.kind === 'entity' && r.label?.includes('Alice'))).toBe(true);
  });
});
