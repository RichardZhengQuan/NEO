/**
 * Tests for ANSI helper functions — especially stripModelText.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stripModelText } from './ansi.js';

// Disable ANSI in tests so assertions are clean text.
beforeEach(() => {
  vi.stubEnv('NO_COLOR', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stripModelText', () => {
  it('strips CSI sequences from text.delta text before stdout', () => {
    // This test MUST fail on unmodified code (before stripModelText exists).
    // It exercises the same path as chat.ts text.delta write.
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const evilText = '\x1b[2J\x1b[H safe text';
    process.stdout.write(stripModelText(evilText));
    const written = spy.mock.calls.map(([t]) => String(t)).join('');
    expect(written).not.toMatch(/\x1b/);
    expect(written).toContain('safe text');
    spy.mockRestore();
  });

  it('keeps \\n and \\t, strips other C0 and C1', () => {
    // \x00-\x08 and \x0b-\x1f are stripped; \x09 (tab) and \x0a (newline) kept
    const input = '\x00hello\x07\nworld\t!\x1f\x80\x9f';
    expect(stripModelText(input)).toBe('hello\nworld\t!');
  });

  it('replaces OSC 8 hyperlink pair (BEL terminator) with visible text', () => {
    // ESC ] 8 ;; https://example.com BEL visible-text ESC ] 8 ;; BEL
    const link = '\x1b]8;;https://example.com\x07click here\x1b]8;;\x07';
    expect(stripModelText(link)).toBe('click here');
  });

  it('replaces OSC 8 hyperlink pair (ST terminator) with visible text', () => {
    // ESC ] 8 ;; https://evil.example.com ESC \ visible-text ESC ] 8 ;; ESC \
    const link = '\x1b]8;;https://evil.example.com\x1b\\click here\x1b]8;;\x1b\\';
    expect(stripModelText(link)).toBe('click here');
  });

  it('strips lone ESC bytes and ESC-letter sequences', () => {
    // ESC + letter in \x20-\x7e is a single-char sequence; both bytes are stripped.
    expect(stripModelText('hello\x1bworld')).toBe('helloorld');
    // ESC at the end of a string (truly lone) is also stripped.
    expect(stripModelText('trail\x1b')).toBe('trail');
  });

  it('strips CSI clear-screen and cursor-home sequences', () => {
    // \x1b[2J = clear screen, \x1b[H = cursor home
    expect(stripModelText('\x1b[2J\x1b[H safe text')).toBe(' safe text');
  });

  it('strips cursor movement sequences', () => {
    // \x1b[5A = cursor up 5 lines
    expect(stripModelText('before\x1b[5Aafter')).toBe('beforeafter');
  });

  it('preserves plain text with no control sequences', () => {
    expect(stripModelText('Hello, world!\n\tIndented.')).toBe('Hello, world!\n\tIndented.');
  });
});
