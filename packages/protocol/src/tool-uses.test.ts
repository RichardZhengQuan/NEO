import { describe, expect, it } from 'vitest';
import { ToolUseEventSchema, ToolUseQuerySchema } from './index.js';

describe('tool-use protocol', () => {
  it('accepts inclusive numeric ranges, rejects reversed or nonfinite ranges and caps limits', () => {
    expect(ToolUseQuerySchema.parse({ from: 100, to: 100, limit: 501 })).toEqual({ from: 100, to: 100, limit: 500 });
    expect(ToolUseQuerySchema.parse({})).toEqual({});
    expect(ToolUseQuerySchema.safeParse({ from: 101, to: 100 }).success).toBe(false);
    expect(ToolUseQuerySchema.safeParse({ from: Infinity }).success).toBe(false);
    expect(ToolUseQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it('has only display fields and accepts HTTP(S) external targets', () => {
    const value = { id: 'use_1', at: 100, tool: 'web_fetch', category: 'search', title: 'Looked up “example.com”', messageId: 'msg_1', target: { kind: 'url', url: 'https://example.com/' } };
    expect(ToolUseEventSchema.parse({ ...value, input: { secret: true } })).toEqual(value);
    expect(ToolUseEventSchema.safeParse({ ...value, target: { kind: 'url', url: 'javascript:alert(1)' } }).success).toBe(false);
    expect(ToolUseEventSchema.safeParse({ ...value, title: 'a'.repeat(161) }).success).toBe(false);
  });
});
