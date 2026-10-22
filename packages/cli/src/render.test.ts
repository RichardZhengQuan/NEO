/**
 * Rendering tests — pure functions only, no I/O.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentEvent } from '@neo/protocol';
import { renderEvent, renderEvents, renderBanner } from './render.js';

// Disable ANSI in tests so assertions are clean text
beforeEach(() => {
  vi.stubEnv('NO_COLOR', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderEvent', () => {
  it('text.delta returns delta line', () => {
    const ev: AgentEvent = { type: 'text.delta', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm', text: 'hello' };
    const lines = renderEvent(ev);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: 'hello', delta: true });
  });

  it('reasoning.delta is hidden by default', () => {
    const ev: AgentEvent = { type: 'reasoning.delta', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm', text: 'thinking…' };
    expect(renderEvent(ev, {})).toHaveLength(0);
  });

  it('reasoning.delta shown with showReasoning', () => {
    const ev: AgentEvent = { type: 'reasoning.delta', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm', text: 'thinking…' };
    const lines = renderEvent(ev, { showReasoning: true });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]?.text).toContain('thinking…');
  });

  it('reasoning.delta strips control sequences from model reasoning text', () => {
    const ev: AgentEvent = { type: 'reasoning.delta', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm', text: 'clean\x1b[31mred\x1b[0m' };
    const lines = renderEvent(ev, { showReasoning: true });
    expect(lines[0]?.text).toContain('cleanred');
    expect(lines[0]?.text).not.toContain('\x1b');
  });

  it('part.added reasoning strips control sequences from model reasoning text', () => {
    const ev: Extract<AgentEvent, { type: 'part.added' }> = {
      type: 'part.added', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm', index: 0,
      part: { type: 'reasoning', text: 'think\x1b[31mred\x1b[0m' },
    };
    const lines = renderEvent(ev, { showReasoning: true });
    expect(lines[0]?.text).toContain('thinkred');
    expect(lines[0]?.text).not.toContain('\x1b');
  });

  it('tool.started returns chip line', () => {
    const ev: AgentEvent = {
      type: 'tool.started', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm',
      toolCallId: 'tc1', name: 'create_reminder', title: 'Create reminder', input: {},
    };
    const lines = renderEvent(ev);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]?.text).toContain('Create reminder');
  });

  it('tool.started strips ANSI from title/name', () => {
    const ev: AgentEvent = {
      type: 'tool.started', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm',
      toolCallId: 'tc1', name: 'bad\x1b[2Jname', title: 'bad\x1b[2Jtitle', input: {},
    };
    const lines = renderEvent(ev);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.map((l) => l.text).join('');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('badtitle');
    const fallbackText = renderEvent({ ...ev, title: '' }).map((l) => l.text).join('');
    expect(fallbackText).not.toContain('\x1b');
    expect(fallbackText).toContain('badname');
  });

  it('tool.confirmation strips ANSI from title and description', () => {
    const ev: AgentEvent = {
      type: 'tool.confirmation', episodeId: 'c', conversationId: 'c', turnId: 't',
      confirmation: {
        id: 'cnf_1', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm',
        toolCallId: 'tc1', name: 'web_fetch', title: 'bad\x1b[2Jtitle', input: {},
        description: 'bad\x1b[2Jdesc', risk: 'read', requestedAt: 0, expiresAt: 1000,
      },
    };
    const lines = renderEvent(ev);
    const text = lines.map((l) => l.text).join('');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('badtitle');
    expect(text).toContain('baddesc');
  });

  it('tool.finished (error) strips ANSI from name and summary', () => {
    const ev: AgentEvent = {
      type: 'tool.finished', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm',
      toolCallId: 'tc1', name: 'bad\x1b[2Jname', isError: true, summary: 'bad\x1b[2Jsum',
    };
    const lines = renderEvent(ev);
    const text = lines.map((l) => l.text).join('');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('badname');
    expect(text).toContain('badsum');
  });

  it('tool.finished (success) strips ANSI from name and summary', () => {
    const ev: AgentEvent = {
      type: 'tool.finished', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm',
      toolCallId: 'tc1', name: 'bad\x1b[2Jname', isError: false, summary: 'bad\x1b[2Jsum',
    };
    const lines = renderEvent(ev);
    const text = lines.map((l) => l.text).join('');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('badname');
    expect(text).toContain('badsum');
  });

  it('turn.failed strips ANSI from error message', () => {
    const ev: AgentEvent = {
      type: 'turn.failed', episodeId: 'c', conversationId: 'c', turnId: 't',
      error: { code: 'internal', message: 'bad\x1b[2Jmessage' },
    };
    const lines = renderEvent(ev);
    const text = lines.map((l) => l.text).join('');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('badmessage');
  });

  it('tool.finished ok returns check chip', () => {
    const ev: AgentEvent = {
      type: 'tool.finished', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm',
      toolCallId: 'tc1', name: 'create_reminder', isError: false, summary: 'Created for 5 PM',
    };
    const lines = renderEvent(ev);
    expect(lines[0]?.text).toContain('Created for 5 PM');
  });

  it('tool.finished error returns error chip', () => {
    const ev: AgentEvent = {
      type: 'tool.finished', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm',
      toolCallId: 'tc1', name: 'web_fetch', isError: true, summary: 'Network error',
    };
    const lines = renderEvent(ev);
    expect(lines[0]?.text).toContain('Network error');
  });

  it('memory.recalled returns summary line', () => {
    const ev: AgentEvent = {
      type: 'memory.recalled', episodeId: 'c', conversationId: 'c', turnId: 't',
      items: [{ id: 'mem1', kind: 'fact', label: 'I like cats', score: 0.9, reason: 'query' }],
    };
    const lines = renderEvent(ev);
    expect(lines[0]?.text).toContain('I like cats');
  });

  it('memory.recalled is empty when no items', () => {
    const ev: AgentEvent = { type: 'memory.recalled', episodeId: 'c', conversationId: 'c', turnId: 't', items: [] };
    expect(renderEvent(ev)).toHaveLength(0);
  });

  it('memory.recalled strips control sequences from model-authored labels', () => {
    const ev: AgentEvent = {
      type: 'memory.recalled', episodeId: 'c', conversationId: 'c', turnId: 't',
      items: [
        { id: 'mem1', kind: 'fact', label: 'safe\x1b[2J\x1b[Hpoisoned', score: 0.9, reason: 'query' },
        { id: 'mem2', kind: 'fact', label: 'also\x1b[31mred\x1b[0m label', score: 0.8, reason: 'query' },
      ],
    };
    const lines = renderEvent(ev);
    expect(lines).toHaveLength(1);
    const text = lines[0]!.text;
    expect(text).not.toContain('\x1b');
    // Visible characters must survive
    expect(text).toContain('safe');
    expect(text).toContain('poisoned');
    expect(text).toContain('also');
    expect(text).toContain('red');
    expect(text).toContain('label');
  });

  it('turn.finished emits usage line', () => {
    const ev: AgentEvent = {
      type: 'turn.finished', episodeId: 'c', conversationId: 'c', turnId: 't',
      stopReason: 'end', usage: { inputTokens: 100, outputTokens: 50 },
    };
    const lines = renderEvent(ev);
    const all = lines.map((l) => l.text).join(' ');
    expect(all).toContain('100');
    expect(all).toContain('50');
  });

  it('turn.failed emits error line', () => {
    const ev: AgentEvent = {
      type: 'turn.failed', episodeId: 'c', conversationId: 'c', turnId: 't',
      error: { code: 'internal', message: 'Something broke' },
    };
    const lines = renderEvent(ev);
    const all = lines.map((l) => l.text).join(' ');
    expect(all).toContain('Something broke');
  });

  it('message.completed returns empty', () => {
    const msg = { id: 'm', episodeId: 'c', conversationId: 'c', role: 'assistant' as const, parts: [], createdAt: 0, status: 'complete' as const };
    const ev: AgentEvent = { type: 'message.completed', episodeId: 'c', conversationId: 'c', turnId: 't', message: msg };
    expect(renderEvent(ev)).toHaveLength(0);
  });

  it('prints source parts as a numbered list without repeating them on completion', () => {
    const ev: Extract<AgentEvent, { type: 'part.added' }> = {
      type: 'part.added', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm', index: 0,
      part: { type: 'sources', items: [{ title: 'One', url: 'https://one.example/article' }, { title: 'Two', url: 'https://two.example/article', snippet: 'Details' }] },
    };
    expect(renderEvent(ev).map((line) => line.text)).toEqual([
      '  Sources',
      '  1. One — https://one.example/article',
      '  2. Two — https://two.example/article',
    ]);
    expect(renderEvent({ ...ev, part: { type: 'sources', items: [] } })).toEqual([]);
  });

  it('part.added sources strips ANSI from title and url', () => {
    const ev: Extract<AgentEvent, { type: 'part.added' }> = {
      type: 'part.added', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'm', index: 0,
      part: {
        type: 'sources',
        items: [
          { title: 'bad\x1b[2Jtitle', url: 'https://safe.example/\x1b[2J' },
          { title: '', url: 'https://also.example/\x1b[31mred\x1b[0m' },
        ],
      },
    };
    const lines = renderEvent(ev);
    const text = lines.map((l) => l.text).join('\n');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('badtitle');
    expect(text).toContain('safe.example');
    expect(text).toContain('also.example');
    expect(text).toContain('red');
  });
});

describe('renderEvents', () => {
  it('renders a full scripted event sequence', () => {
    const events: AgentEvent[] = [
      { type: 'turn.started', episodeId: 'c', conversationId: 'c', turnId: 't', assistantMessageId: 'a',
        model: { provider: 'anthropic', model: 'claude-opus-5-5' },
        userMessage: { id: 'u', episodeId: 'c', conversationId: 'c', role: 'user', parts: [], createdAt: 0, status: 'complete' } },
      { type: 'text.delta', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'a', text: 'Hello' },
      { type: 'text.delta', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'a', text: ', world!' },
      { type: 'tool.started', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'a',
        toolCallId: 'tc1', name: 'get_time', title: 'Get current time', input: {} },
      { type: 'tool.finished', episodeId: 'c', conversationId: 'c', turnId: 't', messageId: 'a',
        toolCallId: 'tc1', name: 'get_time', isError: false, summary: '2026-10-10 20:15' },
      { type: 'turn.finished', episodeId: 'c', conversationId: 'c', turnId: 't', stopReason: 'end',
        usage: { inputTokens: 10, outputTokens: 20 } },
    ];
    const text = renderEvents(events);
    expect(text).toContain('Hello');
    expect(text).toContain('world!');
    expect(text).toContain('2026-10-10 20:15');
    expect(text).toContain('10');
    expect(text).toContain('20');
  });
});

describe('renderBanner', () => {
  it('includes URL and mode', () => {
    const banner = renderBanner({
      url: 'http://127.0.0.1:7777',
      mode: 'local',
      dataDir: '/home/user/.neo',
      ownerToken: 'abc123',
      showToken: true,
      webDir: null,
    });
    expect(banner).toContain('http://127.0.0.1:7777');
    expect(banner).toContain('local');
    expect(banner).toContain('/home/user/.neo');
    expect(banner).toContain('abc123');
  });

  it('shows QR info in server mode only with showToken', () => {
    const banner = renderBanner({
      url: 'https://neo.example.com',
      mode: 'server',
      dataDir: '/data',
      ownerToken: 'secret',
      showToken: true,
      webDir: '/var/web',
      qrText: '██ QR ██',
      pairingUrl: 'neo://pair?server=https://neo.example.com&token=secret',
    });
    expect(banner).toContain('neo://pair');
    expect(banner).toContain('QR');
  });

  it('does not show token in server mode without showToken', () => {
    const banner = renderBanner({
      url: 'https://neo.example.com',
      mode: 'server',
      dataDir: '/data',
      ownerToken: 'MY_SECRET_TOKEN',
      showToken: false,
      webDir: null,
    });
    expect(banner).not.toContain('MY_SECRET_TOKEN');
  });

  it('suppresses owner pairing links and QR codes in server logs', () => {
    const banner = renderBanner({
      url: 'https://neo.example.com',
      mode: 'server',
      dataDir: '/data',
      ownerToken: 'MY_SECRET_TOKEN',
      showToken: false,
      webDir: null,
      qrText: 'OWNER_TOKEN_QR',
      pairingUrl: 'neo://pair?server=https://neo.example.com&token=MY_SECRET_TOKEN',
    });
    expect(banner).not.toContain('MY_SECRET_TOKEN');
    expect(banner).not.toContain('OWNER_TOKEN_QR');
    expect(banner).not.toContain('neo://pair');
    expect(banner).toContain('run `neo pair` to add a device');
  });

  it('suppresses the owner token in captured local output', () => {
    const banner = renderBanner({
      url: 'http://127.0.0.1:7777',
      mode: 'local',
      dataDir: '/data',
      ownerToken: 'MY_SECRET_TOKEN',
      showToken: false,
      webDir: null,
    });
    expect(banner).not.toContain('MY_SECRET_TOKEN');
  });
});
