import { z } from 'zod';
import { NeoError, defineTool } from '@neo/protocol';
import { evaluateExpression } from '../calc.js';

export const calculateTool = defineTool({
  name: 'calculate',
  title: 'Calculate',
  description:
    'Evaluate an arithmetic expression exactly instead of doing math in your head. Supports + - * / ' +
    '% (remainder), ^ (power, right-associative; -2^2 = -4), parentheses, the constants pi, e, tau and the functions ' +
    'sqrt, cbrt, abs, round, floor, ceil, trunc, sign, exp, ln, log (base 10), log2, sin, cos, tan, asin, acos, atan ' +
    '(radians), pow(a, b), min(…), max(…). Example: "(1200 * 0.15 + 30) / 3". Percentages: write 15% of 80 as "0.15 * 80".',
  inputSchema: z.object({
    expression: z.string().min(1).max(1000).describe('The expression, e.g. "sqrt(2) * pi" or "2^10 - 1".'),
  }),
  risk: 'read',
  defaultPermission: 'auto',
  async execute(input) {
    try {
      const result = evaluateExpression(input.expression);
      return { output: { expression: input.expression, result }, summary: `${input.expression} = ${result}` };
    } catch (err) {
      return { isError: true, output: { error: NeoError.from(err).message, expression: input.expression }, summary: 'Calculation error' };
    }
  },
});
