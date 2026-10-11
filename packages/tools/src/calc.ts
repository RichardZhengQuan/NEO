/**
 * evaluateExpression: a safe math expression evaluator (tokenizer + recursive
 * descent parser). There is no `eval`/`Function` anywhere: identifiers can only
 * name the constants and functions in the tables below.
 *
 * Grammar (highest binding last):
 *   expr    := mul (('+' | '-') mul)*
 *   mul     := unary (('*' | '/' | '%') unary)*
 *   unary   := ('+' | '-') unary | power
 *   power   := primary ('^' unary)?          right-associative; -2^2 = -4, 2^-1 = 0.5
 *   primary := number | constant | name '(' expr (',' expr)* ')' | '(' expr ')'
 *
 * Throws NeoError('bad_request') with a readable message on any error.
 */
import { NeoError } from '@neo/protocol';

/** Longest accepted expression (characters). */
export const MAX_EXPRESSION_LENGTH = 1000;
/** Deepest accepted nesting of parentheses / unary operators / function calls. */
const MAX_DEPTH = 100;

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '%' | '^'; pos: number }
  | { kind: 'ident'; name: string; pos: number }
  | { kind: 'lparen'; pos: number }
  | { kind: 'rparen'; pos: number }
  | { kind: 'comma'; pos: number };

const bad = (message: string) => new NeoError('bad_request', message);

/** Typographic operators models and users like to paste. */
const OPERATOR_ALIASES: Record<string, '+' | '-' | '*' | '/' | '%' | '^'> = {
  '+': '+', '-': '-', '*': '*', '/': '/', '%': '%', '^': '^',
  '×': '*', '·': '*', '÷': '/', '−': '-', '–': '-',
};

const NUMBER_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(s.charAt(i + 1)))) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(s);
      // A number must not run straight into more digits, dots or letters ("1.2.3", "2e", "1..2").
      if (!m || /[\d.A-Za-z_]/.test(s.charAt(i + m[0].length))) {
        const end = s.slice(i).search(/[^\d.eE+\-A-Za-z_]/);
        throw bad(`Invalid number "${s.slice(i, end === -1 ? undefined : i + end)}" at position ${i + 1}.`);
      }
      tokens.push({ kind: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(s) as RegExpExecArray;
      const name = m[0].toLowerCase();
      if (!CONSTANTS.has(name) && !FUNCTIONS.has(name)) throw unknownName(name);
      tokens.push({ kind: 'ident', name, pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPERATOR_ALIASES[c];
    if (op) {
      tokens.push({ kind: 'op', op, pos: i });
      i++;
      continue;
    }
    if (c === '(') tokens.push({ kind: 'lparen', pos: i });
    else if (c === ')') tokens.push({ kind: 'rparen', pos: i });
    else if (c === ',') tokens.push({ kind: 'comma', pos: i });
    else throw bad(`Unexpected character "${c}" at position ${i + 1}. Only numbers, + - * / % ^, parentheses, constants and math functions are allowed.`);
    i++;
  }
  return tokens;
}

// Own-property lookup tables (Maps never consult Object.prototype, so names
// like "constructor" or "__proto__" are simply unknown).
const CONSTANTS = new Map<string, number>([
  ['pi', Math.PI],
  ['e', Math.E],
  ['tau', 2 * Math.PI],
]);

interface Fn {
  min: number;
  max: number;
  apply(args: number[]): number;
}
const unary = (f: (x: number) => number): Fn => ({ min: 1, max: 1, apply: (a) => f(a[0] as number) });
const FUNCTIONS = new Map<string, Fn>([
  ['sqrt', unary(Math.sqrt)],
  ['cbrt', unary(Math.cbrt)],
  ['abs', unary(Math.abs)],
  ['round', unary(Math.round)],
  ['floor', unary(Math.floor)],
  ['ceil', unary(Math.ceil)],
  ['trunc', unary(Math.trunc)],
  ['sign', unary(Math.sign)],
  ['exp', unary(Math.exp)],
  ['ln', unary(Math.log)],
  ['log', unary(Math.log10)],
  ['log10', unary(Math.log10)],
  ['log2', unary(Math.log2)],
  ['sin', unary(Math.sin)],
  ['cos', unary(Math.cos)],
  ['tan', unary(Math.tan)],
  ['asin', unary(Math.asin)],
  ['acos', unary(Math.acos)],
  ['atan', unary(Math.atan)],
  ['pow', { min: 2, max: 2, apply: (a) => Math.pow(a[0] as number, a[1] as number) }],
  ['min', { min: 1, max: 100, apply: (a) => Math.min(...a) }],
  ['max', { min: 1, max: 100, apply: (a) => Math.max(...a) }],
]);

function unknownName(name: string): NeoError {
  return bad(`Unknown name "${name}". Known constants: ${[...CONSTANTS.keys()].join(', ')}; functions: ${[...FUNCTIONS.keys()].join(', ')}.`);
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expr();
    const t = this.tokens[this.pos];
    if (t) throw bad(`Unexpected ${describe(t)} at position ${t.pos + 1}.`);
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(t: Token | undefined, ...ops: string[]): t is Extract<Token, { kind: 'op' }> {
    return t !== undefined && t.kind === 'op' && ops.includes(t.op);
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw bad(`Expression is nested too deeply (max ${MAX_DEPTH} levels).`);
  }

  private expr(): number {
    let left = this.mul();
    for (let t = this.peek(); this.isOp(t, '+', '-'); t = this.peek()) {
      this.pos++;
      const right = this.mul();
      left = t.op === '+' ? left + right : left - right;
    }
    return left;
  }

  private mul(): number {
    let left = this.unary();
    for (let t = this.peek(); this.isOp(t, '*', '/', '%'); t = this.peek()) {
      this.pos++;
      const right = this.unary();
      if (t.op === '*') left *= right;
      else if (right === 0) throw bad(t.op === '/' ? 'Division by zero.' : 'Modulo by zero.');
      else left = t.op === '/' ? left / right : left % right;
    }
    return left;
  }

  private unary(): number {
    const t = this.peek();
    if (this.isOp(t, '-', '+')) {
      this.pos++;
      this.enter();
      const v = this.unary();
      this.depth--;
      return t.op === '-' ? -v : v;
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (this.isOp(this.peek(), '^')) {
      this.pos++;
      this.enter();
      const exponent = this.unary();
      this.depth--;
      return Math.pow(base, exponent);
    }
    return base;
  }

  private expectRParen(context: string): void {
    const t = this.peek();
    if (!t || t.kind !== 'rparen') {
      throw bad(t ? `Expected ")" ${context} at position ${t.pos + 1}.` : `Missing ")" ${context}.`);
    }
    this.pos++;
  }

  private primary(): number {
    const t = this.peek();
    if (!t) throw bad('Unexpected end of expression.');
    this.pos++;
    if (t.kind === 'num') return t.value;
    if (t.kind === 'lparen') {
      this.enter();
      const v = this.expr();
      this.depth--;
      this.expectRParen('to close the parenthesis');
      return v;
    }
    if (t.kind === 'ident') {
      const constant = CONSTANTS.get(t.name);
      if (constant !== undefined) return constant;
      const fn = FUNCTIONS.get(t.name);
      if (!fn) throw unknownName(t.name);
      const lp = this.peek();
      if (!lp || lp.kind !== 'lparen') throw bad(`Function "${t.name}" must be called with parentheses, e.g. ${t.name}(2).`);
      this.pos++;
      this.enter();
      const args: number[] = [];
      if (this.peek()?.kind !== 'rparen') {
        args.push(this.expr());
        while (this.peek()?.kind === 'comma') {
          this.pos++;
          args.push(this.expr());
        }
      }
      this.depth--;
      this.expectRParen(`after the arguments of ${t.name}`);
      if (args.length < fn.min || args.length > fn.max) {
        const want = fn.min === fn.max ? `${fn.min}` : `${fn.min} or more`;
        throw bad(`${t.name}() takes ${want} argument${fn.max === 1 ? '' : 's'}, got ${args.length}.`);
      }
      const result = fn.apply(args);
      if (Number.isNaN(result)) throw bad(`${t.name}(${args.join(', ')}) is undefined.`);
      return result;
    }
    throw bad(`Unexpected ${describe(t)} at position ${t.pos + 1}.`);
  }
}

function describe(t: Token): string {
  switch (t.kind) {
    case 'num':
      return `number ${t.value}`;
    case 'op':
      return `"${t.op}"`;
    case 'ident':
      return `"${t.name}"`;
    case 'lparen':
      return '"("';
    case 'rparen':
      return '")"';
    case 'comma':
      return '","';
  }
}

/**
 * Evaluate a math expression such as `"sqrt(2) * pi"` or `"2^10 - 1"`.
 * Non-integer results are rounded to 15 significant digits to hide binary
 * floating point noise (0.1 + 0.2 → 0.3).
 */
export function evaluateExpression(expression: string): number {
  if (typeof expression !== 'string') throw bad('The expression must be a string.');
  const trimmed = expression.trim();
  if (!trimmed) throw bad('Empty expression.');
  if (trimmed.length > MAX_EXPRESSION_LENGTH) throw bad(`Expression is too long (max ${MAX_EXPRESSION_LENGTH} characters).`);
  const tokens = tokenize(trimmed);
  const result = new Parser(tokens).parse();
  if (Number.isNaN(result)) throw bad('The result is not a number.');
  if (!Number.isFinite(result)) throw bad('The result is infinite or too large.');
  if (Number.isInteger(result)) return result === 0 ? 0 : result;
  return Number(result.toPrecision(15));
}
