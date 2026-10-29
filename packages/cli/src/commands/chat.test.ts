/** Tests for timeline startup, off-record mode and confirmations in the REPL. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NeoError } from '@neo/protocol';
import type { NeoClient } from '@neo/client';
import { handleSlash, runChat, type SlashContext } from './chat.js';

const repl = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => Promise<void> | void>(),
  client: { timeline: { list: vi.fn(), stream: vi.fn(), cancel: vi.fn(), offRecord: vi.fn(), startOffRecord: vi.fn(), endOffRecord: vi.fn() }, confirmations: { respond: vi.fn() }, connect: vi.fn() },
  question: vi.fn(),
  setPrompt: vi.fn(),
  closeConnection: vi.fn(),
}));
// These mocked REPL fixtures exercise the interactive terminal path.
vi.mock('node:process', () => ({ stdin: { isTTY: true }, stdout: process.stdout }));
vi.mock('@neo/client', () => ({ NeoClient: vi.fn(function () { return repl.client; }) }));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    on: (name: string, handler: (...args: any[]) => Promise<void> | void) => repl.listeners.set(name, handler),
    setPrompt: repl.setPrompt, prompt: vi.fn(), pause: vi.fn(), resume: vi.fn(), question: repl.question,
  }),
}));
const fakeRl = { question: vi.fn().mockResolvedValue('n') } as unknown as Parameters<typeof handleSlash>[1];
const makeCtx = (): SlashContext => ({ offRecord: false, opts: {}, embeddedServer: null });

beforeEach(() => {
  repl.listeners.clear();
  repl.question.mockReset().mockResolvedValue('n');
  repl.client.timeline.list.mockReset().mockResolvedValue({ items: [], episodes: [], nextCursor: null });
  repl.client.timeline.stream.mockReset().mockImplementation(async function* () {});
  repl.client.timeline.cancel.mockReset().mockResolvedValue({ cancelled: true });
  repl.client.timeline.offRecord.mockReset().mockResolvedValue({ active: false, episodeId: null, startedAt: null });
  repl.client.timeline.startOffRecord.mockReset().mockImplementation(async () => {
    const state = { active: true, episodeId: 'private-ep', startedAt: 42 };
    repl.client.timeline.offRecord.mockResolvedValue(state);
    return state;
  });
  repl.client.timeline.endOffRecord.mockReset().mockImplementation(async () => {
    repl.client.timeline.offRecord.mockResolvedValue({ active: false, episodeId: null, startedAt: null });
    return { deleted: 2 };
  });
  repl.client.confirmations.respond.mockReset().mockResolvedValue({ ok: true });
  repl.closeConnection.mockReset();
  repl.setPrompt.mockReset();
  repl.client.connect.mockReset().mockReturnValue({ close: repl.closeConnection });
});

describe('timeline REPL', () => {
  it.each([
    ['y', { approve: true, always: false }],
    ['n', { approve: false, always: false }],
    ['a', { approve: true, always: true }],
    ['', { approve: false, always: false }],
    ['maybe', { approve: false, always: false }],
    ['/exit', { approve: false, always: false }],
  ])('responds to %s with the confirmation nonce', async (answer, decision) => {
    repl.client.timeline.stream.mockImplementation(async function* () {
      yield { type: 'tool.confirmation', episodeId: 'ep', conversationId: 'ep', turnId: 'turn_1',
        confirmation: { id: 'cnf_nonce', toolCallId: 'call_reused', title: 'Forget memories', description: 'Forget tea' } };
    });
    repl.question.mockResolvedValue(answer);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test', token: 'fixture-token' });
      await repl.listeners.get('line')!('Forget my tea preference.');
      expect(repl.client.confirmations.respond).toHaveBeenCalledExactlyOnceWith('cnf_nonce', decision);
    } finally { output.mockRestore(); }
  });

  it('loads and prints the last six timeline messages, hiding persisted context', async () => {
    repl.client.timeline.list.mockResolvedValue({ items: [{ id: 'm', episodeId: 'ep', conversationId: 'ep', role: 'user', createdAt: 1,
      parts: [{ type: 'context', text: 'private context' }, { type: 'text', text: 'Earlier hello' }] }, { id: 'ui_message', episodeId: 'ep', conversationId: 'ep', role: 'assistant', createdAt: 2, parts: [{ type: 'ui', id: 'ui', block: { type: 'text', text: 'Earlier UI' } }] }], episodes: [], nextCursor: null });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      expect(repl.client.timeline.list).toHaveBeenCalledExactlyOnceWith({ limit: 6 });
      const text = output.mock.calls.map(([value]) => String(value)).join('');
      expect(text).toContain('Earlier hello');
      expect(text).toContain('Earlier UI');
      expect(text).not.toContain('private context');
    } finally { output.mockRestore(); }
  });

  it('strips control sequences from assistant history messages but not user messages', async () => {
    repl.client.timeline.list.mockResolvedValue({ items: [
      { id: 'u1', episodeId: 'ep', conversationId: 'ep', role: 'user', createdAt: 1,
        parts: [{ type: 'text', text: 'user says \x1b[31mred\x1b[0m' }] },
      { id: 'a1', episodeId: 'ep', conversationId: 'ep', role: 'assistant', createdAt: 2,
        parts: [{ type: 'text', text: 'assistant says \x1b[31mred\x1b[0m' }] },
    ], episodes: [], nextCursor: null });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      const text = output.mock.calls.map(([value]) => String(value)).join('');
      // assistant message: control sequences stripped
      expect(text).toContain('assistant says red');
      const assistantIdx = text.indexOf('assistant says red');
      expect(text.slice(assistantIdx, assistantIdx + 60)).not.toContain('\x1b');
    } finally { output.mockRestore(); }
  });

  it('sends into the timeline in off-record mode and ends it explicitly', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test', offRecord: true });
      expect(repl.client.timeline.startOffRecord).toHaveBeenCalledExactlyOnceWith();
      expect(repl.client.timeline.startOffRecord.mock.invocationCallOrder[0]).toBeLessThan(repl.client.timeline.list.mock.invocationCallOrder[0]!);
      const line = repl.listeners.get('line')!;
      await line('Keep this private.');
      expect(repl.client.timeline.stream).toHaveBeenCalledWith({ text: 'Keep this private.' }, expect.any(AbortSignal));
      await line('/off-record off');
      expect(repl.client.timeline.endOffRecord).toHaveBeenCalledExactlyOnceWith();
      await line('Normal again.');
      expect(repl.client.timeline.stream).toHaveBeenLastCalledWith({ text: 'Normal again.' }, expect.any(AbortSignal));
    } finally { output.mockRestore(); }
  });

  it('cancels the server turn when Ctrl+C aborts SSE', async () => {
    let release!: () => void;
    repl.client.timeline.stream.mockImplementation(async function* () { await new Promise<void>((resolve) => { release = resolve; }); });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      const pending = repl.listeners.get('line')!('Hello');
      await repl.listeners.get('SIGINT')!();
      expect(repl.client.timeline.cancel).toHaveBeenCalledExactlyOnceWith();
      release();
      await pending;
    } finally { output.mockRestore(); }
  });

  it('aborts a pending confirmation question on cancellation without approving it', async () => {
    let ready!: () => void;
    const questionStarted = new Promise<void>((resolve) => { ready = resolve; });
    repl.client.timeline.stream.mockImplementation(async function* () {
      yield { type: 'tool.confirmation', episodeId: 'ep', conversationId: 'ep', turnId: 'turn', confirmation: { id: 'nonce', toolCallId: 'call', title: 'Forget', description: 'Forget tea' } };
    });
    repl.question.mockImplementation((_prompt, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      ready();
    }));
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      const sending = repl.listeners.get('line')!('Forget tea');
      await questionStarted;
      await repl.listeners.get('SIGINT')!();
      await sending;
      expect(repl.client.timeline.cancel).toHaveBeenCalledExactlyOnceWith();
      expect(repl.client.confirmations.respond).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });

  it('ends the ephemeral off-record session when the terminal closes', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await runChat({ server: 'http://fixture.test', offRecord: true });
      await repl.listeners.get('close')!();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(repl.client.timeline.endOffRecord).toHaveBeenCalledExactlyOnceWith();
      expect(repl.closeConnection).toHaveBeenCalledExactlyOnceWith();
    } finally { output.mockRestore(); exit.mockRestore(); }
  });

  it('restores server privacy and updates the prompt when another client ends it', async () => {
    repl.client.timeline.offRecord.mockResolvedValue({ active: true, episodeId: 'private-ep', startedAt: 42 });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      expect(repl.client.timeline.offRecord).toHaveBeenCalledExactlyOnceWith();
      expect(repl.setPrompt).toHaveBeenLastCalledWith(expect.stringContaining('[off the record]'));
      repl.client.connect.mock.calls[0]![0].onEvent({ event: { type: 'timeline.off_record', active: false } });
      expect(repl.setPrompt.mock.calls.at(-1)![0]).not.toContain('[off the record]');
      await repl.listeners.get('line')!('After expiry');
      expect(repl.client.timeline.stream).toHaveBeenLastCalledWith({ text: 'After expiry' }, expect.any(AbortSignal));
      expect(repl.client.timeline.startOffRecord).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });

  it('refreshes server privacy on reconnect without overwriting a newer event', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      let release!: (state: { active: boolean; episodeId: string; startedAt: number }) => void;
      repl.client.timeline.offRecord.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const connection = repl.client.connect.mock.calls[0]![0];
      connection.onStatus('open');
      connection.onEvent({ event: { type: 'timeline.off_record', active: false } });
      release({ active: true, episodeId: 'stale-ep', startedAt: 42 });
      await Promise.resolve();
      expect(repl.setPrompt.mock.calls.at(-1)![0]).not.toContain('[off the record]');
      repl.client.timeline.offRecord.mockResolvedValue({ active: true, episodeId: 'new-ep', startedAt: 43 });
      connection.onStatus('open');
      await Promise.resolve();
      expect(repl.setPrompt).toHaveBeenLastCalledWith(expect.stringContaining('[off the record]'));
    } finally { output.mockRestore(); }
  });

  it('starts private mode from a slash command before any message', async () => {
    const ctx = makeCtx();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await handleSlash('/off-record', fakeRl, repl.client as unknown as NeoClient, ctx);
      expect(repl.client.timeline.startOffRecord).toHaveBeenCalledExactlyOnceWith();
      expect(ctx.offRecord).toBe(true);
      expect(repl.client.timeline.stream).not.toHaveBeenCalled();
      await handleSlash('/off-record', fakeRl, repl.client as unknown as NeoClient, ctx);
      expect(repl.client.timeline.endOffRecord).toHaveBeenCalledExactlyOnceWith();
      expect(ctx.offRecord).toBe(false);
    } finally { output.mockRestore(); }
  });

  it('leaves privacy off and reports a failed start', async () => {
    repl.client.timeline.startOffRecord.mockRejectedValue(new Error('Start failed'));
    const ctx = makeCtx();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await handleSlash('/off-record on', fakeRl, repl.client as unknown as NeoClient, ctx);
      expect(ctx.offRecord).toBe(false);
      expect(output.mock.calls.map(([text]) => String(text)).join('')).toContain('Start failed');
      expect(repl.client.timeline.endOffRecord).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });

  it('keeps a newer private-mode event when an end request finishes late', async () => {
    repl.client.timeline.offRecord.mockResolvedValue({ active: true, episodeId: 'private-ep', startedAt: 42 });
    let release!: (value: { deleted: number }) => void;
    let ready!: () => void;
    const ending = new Promise<void>((resolve) => { ready = resolve; });
    repl.client.timeline.endOffRecord.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
      ready();
    }));
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      const pending = repl.listeners.get('line')!('/off-record off');
      await ending;
      const connection = repl.client.connect.mock.calls[0]![0];
      connection.onEvent({ event: { type: 'timeline.off_record', active: false } });
      connection.onEvent({ event: { type: 'timeline.off_record', active: true } });
      release({ deleted: 2 });
      await pending;
      expect(repl.setPrompt).toHaveBeenLastCalledWith(expect.stringContaining('[off the record]'));
    } finally { output.mockRestore(); }
  });

  it('retains private mode when ending fails', async () => {
    repl.client.timeline.offRecord.mockResolvedValue({ active: true, episodeId: 'private-ep', startedAt: 42 });
    repl.client.timeline.endOffRecord.mockRejectedValue(new Error('End failed'));
    const ctx = { ...makeCtx(), offRecord: true };
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await handleSlash('/off-record off', fakeRl, repl.client as unknown as NeoClient, ctx);
      expect(ctx.offRecord).toBe(true);
      expect(output.mock.calls.map(([text]) => String(text)).join('')).toContain('End failed');
    } finally { output.mockRestore(); }
  });

  it('shows connection guidance for no provider', async () => {
    repl.client.timeline.stream.mockImplementation(async function* () { throw new NeoError('no_provider', 'Connect an AI.'); });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test' });
      await repl.listeners.get('line')!('Hello');
      expect(output.mock.calls.map(([text]) => String(text)).join('')).toContain('Settings → AI');
    } finally { output.mockRestore(); }
  });

  it('keeps manual memory writes out of off-record mode', async () => {
    const create = vi.fn();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await handleSlash('/remember tea', fakeRl, { memory: { create } } as unknown as NeoClient, { ...makeCtx(), offRecord: true });
      expect(create).not.toHaveBeenCalled();
      expect(output.mock.calls.map(([text]) => String(text)).join('')).toContain('End off the record');
    } finally { output.mockRestore(); }
  });

  it('no longer creates threads, selects per-thread models or titles', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      for (const command of ['/new', '/model', '/title old']) await handleSlash(command, fakeRl, repl.client as unknown as NeoClient, makeCtx());
      expect(output.mock.calls.map(([text]) => String(text)).join('')).toContain('Unknown command');
    } finally { output.mockRestore(); }
  });
});
