/** Real readline + non-TTY streams; the server client is an explicit offline double. */
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runChat } from './chat.js';

const fixture = vi.hoisted(() => ({
  client: {
    timeline: { list: vi.fn(), stream: vi.fn(), cancel: vi.fn(), offRecord: vi.fn(), startOffRecord: vi.fn(), endOffRecord: vi.fn() },
    memory: { findForForget: vi.fn(), forget: vi.fn() },
    confirmations: { respond: vi.fn() }, connect: vi.fn(),
  },
  close: vi.fn(),
}));
vi.mock('@neo/client', () => ({ NeoClient: vi.fn(function () { return fixture.client; }) }));
vi.mock('@neo/server', () => ({ loadConfig: vi.fn(), startServer: vi.fn() }));
vi.mock('../config-file.js', () => ({ resolveDataDir: () => '/private/tmp/neo-chat-unused-fixture', readToken: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.client.timeline.list.mockResolvedValue({ items: [], episodes: [], nextCursor: null });
  fixture.client.timeline.stream.mockImplementation(async function* () {});
  fixture.client.timeline.cancel.mockResolvedValue({ cancelled: true });
  fixture.client.timeline.offRecord.mockResolvedValue({ active: false });
  fixture.client.timeline.startOffRecord.mockResolvedValue({ active: true });
  fixture.client.timeline.endOffRecord.mockResolvedValue({ deleted: 0 });
  fixture.client.connect.mockReturnValue({ close: fixture.close });
  fixture.client.memory.findForForget.mockResolvedValue({ items: [{ id: 'mem-tea', kind: 'fact', label: 'Tea preference' }] });
  fixture.client.memory.forget.mockResolvedValue({ deleted: 1 });
  fixture.client.confirmations.respond.mockResolvedValue({ ok: true });
});

function confirmation() {
  return { type: 'tool.confirmation', episodeId: 'ep', conversationId: 'ep', turnId: 'turn',
    confirmation: { id: 'nonce', toolCallId: 'call', title: 'Forget memories', description: 'Forget tea' } } as const;
}

async function withPipe(run: (stdin: PassThrough, waitFor: (text: string) => Promise<void>) => Promise<void>, offRecord = false): Promise<string> {
  const oldInput = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const oldOutput = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  // A genuine pipe has no isTTY flag and must not enter readline terminal mode.
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = '';
  const waiting = new Map<string, () => void>();
  stdout.on('data', (chunk: Buffer) => {
    written += chunk.toString();
    for (const [text, resolve] of waiting) if (written.includes(text)) { waiting.delete(text); resolve(); }
  });
  const waitFor = (text: string) => written.includes(text) ? Promise.resolve() : new Promise<void>((resolve) => { waiting.set(text, resolve); });
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  syncBuiltinESMExports();
  // Old-code red checks must never terminate the test worker on pipe EOF.
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const priorInterrupts = new Set(process.listeners('SIGINT'));
  let ownedInterrupt: (() => void) | undefined;
  let chat: Promise<void> | undefined;
  try {
    chat = runChat({ server: 'http://fixture.test', token: 'fixture-token', offRecord });
    await waitFor('Commands:');
    ownedInterrupt = process.listeners('SIGINT').find((listener) => !priorInterrupts.has(listener)) as (() => void) | undefined;
    await run(stdin, waitFor);
    await chat;
  } finally {
    stdin.end();
    ownedInterrupt?.();
    // Close/destroy owned input before any cleanup wait. On a failed action,
    // notify only this chat's registered pipe handler; never await it unbounded.
    if (chat) void chat.catch(() => undefined);
    stdin.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    Object.defineProperty(process, 'stdin', oldInput);
    Object.defineProperty(process, 'stdout', oldOutput);
    syncBuiltinESMExports();
    stdin.destroy();
    stdout.destroy();
    exit.mockRestore();
  }
  return written;
}

describe('chat piped stdin', () => {
  it.each([
    ['y', { approve: true, always: false }],
    ['a', { approve: true, always: true }],
    ['n', { approve: false, always: false }],
  ])('queues a same-chunk tool answer %s without echoing input or losing it at EOF', async (answer, decision) => {
    fixture.client.timeline.stream.mockImplementation(async function* () { yield confirmation(); });
    const text = await withPipe(async (stdin) => { stdin.end(`PIPE_UNIQUE_MESSAGE\n${answer}\n`); }, true);
    expect(fixture.client.timeline.stream).toHaveBeenCalledExactlyOnceWith({ text: 'PIPE_UNIQUE_MESSAGE' }, expect.any(AbortSignal));
    expect(fixture.client.confirmations.respond).toHaveBeenCalledExactlyOnceWith('nonce', decision);
    expect(text).not.toContain('PIPE_UNIQUE_MESSAGE');
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.client.timeline.endOffRecord).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.client.timeline.cancel).not.toHaveBeenCalled();
  });

  it('queues a same-chunk /forget answer after its asynchronous lookup', async () => {
    const text = await withPipe(async (stdin) => { stdin.end('/forget tea\ny\n'); });
    expect(fixture.client.memory.findForForget).toHaveBeenCalledExactlyOnceWith('tea', 10);
    expect(fixture.client.memory.forget).toHaveBeenCalledExactlyOnceWith(['mem-tea']);
    expect(fixture.client.timeline.stream).not.toHaveBeenCalled();
    expect(text).toContain('Deleted 1 memory.');
    expect(text).not.toContain('/forget tea');
  });

  it('processes multiple piped turns and their confirmations in order', async () => {
    fixture.client.timeline.stream.mockImplementation(async function* () { yield confirmation(); });
    await withPipe(async (stdin) => { stdin.end('first\ny\nsecond\nn\n'); });
    expect(fixture.client.timeline.stream.mock.calls.map(([input]) => input.text)).toEqual(['first', 'second']);
    expect(fixture.client.confirmations.respond.mock.calls).toEqual([
      ['nonce', { approve: true, always: false }], ['nonce', { approve: false, always: false }],
    ]);
  });

  it('cancels a tool turn if EOF arrives without its confirmation answer', async () => {
    fixture.client.timeline.stream.mockImplementation(async function* () { yield confirmation(); });
    const text = await withPipe(async (stdin) => { stdin.end('forget tea\n'); });
    expect(fixture.client.confirmations.respond).not.toHaveBeenCalled();
    expect(fixture.client.timeline.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.client.timeline.stream.mock.calls[0]![1].aborted).toBe(true);
    expect(text).toContain('Input ended before a confirmation answer.');
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith();
  });

  it('leaves memories untouched if EOF arrives at /forget confirmation', async () => {
    const text = await withPipe(async (stdin) => { stdin.end('/forget tea\n'); });
    expect(fixture.client.memory.findForForget).toHaveBeenCalledExactlyOnceWith('tea', 10);
    expect(fixture.client.memory.forget).not.toHaveBeenCalled();
    expect(text).not.toContain('Deleted 1 memory.');
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith();
  });

  it('aborts a waiting pipe confirmation on SIGINT without approving or hanging', async () => {
    fixture.client.timeline.stream.mockImplementation(async function* () { yield confirmation(); });
    await withPipe(async (stdin, waitFor) => {
      stdin.write('forget tea\n');
      await waitFor('  → ');
      process.emit('SIGINT');
    }, true);
    expect(fixture.client.timeline.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.client.confirmations.respond).not.toHaveBeenCalled();
    expect(fixture.client.timeline.endOffRecord).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['', 'y\n'])('cancels /forget on SIGINT with buffered answer %j without deleting memories', async (answer) => {
    await withPipe(async (stdin, waitFor) => {
      stdin.write('/forget tea\n');
      await waitFor('Forget all of these?');
      if (answer) stdin.write(answer);
      process.emit('SIGINT');
    }, true);
    expect(fixture.client.memory.findForForget).toHaveBeenCalledExactlyOnceWith('tea', 10);
    expect(fixture.client.memory.forget).not.toHaveBeenCalled();
    expect(fixture.client.timeline.stream).not.toHaveBeenCalled();
    expect(fixture.client.timeline.endOffRecord).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith();
  });

  it('does not consume a queued /forget approval after SIGINT during its lookup', async () => {
    let release!: () => void;
    let started!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
    fixture.client.memory.findForForget.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ items: [{ id: 'mem-tea', kind: 'fact', label: 'Tea preference' }] });
      started();
    }));
    await withPipe(async (stdin) => {
      stdin.write('/forget tea\ny\n');
      await lookupStarted;
      process.emit('SIGINT');
      release();
    });
    expect(fixture.client.memory.findForForget).toHaveBeenCalledExactlyOnceWith('tea', 10);
    expect(fixture.client.memory.forget).not.toHaveBeenCalled();
    expect(fixture.client.timeline.stream).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith();
  });

  it('closes an empty pipe without sending a turn', async () => {
    await withPipe(async (stdin) => { stdin.end(); });
    expect(fixture.client.timeline.stream).not.toHaveBeenCalled();
    expect(fixture.client.confirmations.respond).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith();
  });
});
