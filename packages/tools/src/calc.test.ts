/** Review tests for evaluateExpression: grammar, safety and error handling. */
import { describe, expect, it } from 'vitest';
import { NeoError } from '@neo/protocol';
import { evaluateExpression } from './calc.js';

const badRequest = (fn: () => unknown, message?: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(NeoError);
    expect((err as NeoError).code).toBe('bad_request');
    if (message) expect((err as NeoError).message).toMatch(message);
    return;
  }
  throw new Error('expected a bad_request NeoError');
};

describe('evaluateExpression grammar', () => {
  it('power is right-associative and binds tighter than unary minus', () => {
    expect(evaluateExpression('2^3^2')).toBe(512);
    expect(evaluateExpression('-2^2')).toBe(-4);
    expect(evaluateExpression('(-2)^2')).toBe(4);
    expect(evaluateExpression('2^-1')).toBe(0.5);
    expect(evaluateExpression('-3^-2')).toBeCloseTo(-1 / 9);
    expect(evaluateExpression('2*-3')).toBe(-6);
    expect(evaluateExpression('--3')).toBe(3);
  });

  it('modulo, precedence and associativity', () => {
    expect(evaluateExpression('10 % 4')).toBe(2);
    expect(evaluateExpression('2 + 10 % 4 * 3')).toBe(8);
    expect(evaluateExpression('100 / 10 / 5')).toBe(2);
    expect(evaluateExpression('10 - 4 - 3')).toBe(3);
  });

  it('functions and constants', () => {
    expect(evaluateExpression('max(1, 7, 3)')).toBe(7);
    expect(evaluateExpression('min(4, -2, 9)')).toBe(-2);
    expect(evaluateExpression('pow(2, 10)')).toBe(1024);
    expect(evaluateExpression('exp(0)')).toBe(1);
    expect(evaluateExpression('PI')).toBeCloseTo(Math.PI);
    expect(evaluateExpression('sqrt(16) + abs(-2)')).toBe(6);
  });

  it('hides binary floating point noise', () => {
    expect(evaluateExpression('0.1 + 0.2')).toBe(0.3);
    expect(evaluateExpression('2^53')).toBe(9007199254740992);
  });

  it('accepts typographic operators', () => {
    expect(evaluateExpression('6 × 7')).toBe(42);
    expect(evaluateExpression('84 ÷ 2')).toBe(42);
    expect(evaluateExpression('50 − 8')).toBe(42);
  });
});

describe('evaluateExpression errors', () => {
  it('division and modulo by zero', () => {
    badRequest(() => evaluateExpression('1/0'), /zero/i);
    badRequest(() => evaluateExpression('5 % (2-2)'), /zero/i);
  });

  it('rejects malformed numbers instead of silently truncating them', () => {
    badRequest(() => evaluateExpression('1.2.3'));
    badRequest(() => evaluateExpression('1..2'));
    badRequest(() => evaluateExpression('2e'));
    badRequest(() => evaluateExpression('.'));
  });

  it('does not resolve identifiers through the prototype chain', () => {
    badRequest(() => evaluateExpression('constructor'), /unknown/i);
    badRequest(() => evaluateExpression('constructor^0'), /unknown/i);
    badRequest(() => evaluateExpression('__proto__'), /unknown/i);
    badRequest(() => evaluateExpression('tostring(1)'), /unknown/i);
  });

  it('rejects code-like input', () => {
    for (const expr of ['process.exit(1)', 'a=1', '[1]', '"x"', "'x'", '`x`', 'x => 1', '1;2', '{}', 'eval(1)', 'Math.max(1)']) {
      badRequest(() => evaluateExpression(expr));
    }
  });

  it('rejects very long or deeply nested input without blowing the stack', () => {
    badRequest(() => evaluateExpression('1+'.repeat(2000) + '1'), /long/i);
    badRequest(() => evaluateExpression('('.repeat(300) + '1' + ')'.repeat(300)), /nest/i);
    badRequest(() => evaluateExpression('-'.repeat(300) + '1'), /nest/i);
  });

  it('reports wrong function arity', () => {
    badRequest(() => evaluateExpression('sqrt(1, 2)'));
    badRequest(() => evaluateExpression('pow(2)'));
    badRequest(() => evaluateExpression('max()'));
  });

  it('rejects non-finite results', () => {
    badRequest(() => evaluateExpression('10^400'));
    badRequest(() => evaluateExpression('sqrt(-1)'));
  });
});
