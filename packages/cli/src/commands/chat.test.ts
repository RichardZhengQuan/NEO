/**
 * Tests for /new (and slash commands generally) in the chat REPL.
 *
 * F05: after /new --incognito the shared context must point to the new conversation so
 * the next streamed message targets it — not the original conversation.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Conversation } from '@neo/protocol';
import type { NeoClient } from '@neo/client';
import { handleSlash, runChat, type SlashContext } from './chat.js';

const repl = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => Promise<void> | void>(),
  client: { conversations: { create: vi.fn(), stream: vi.fn() } },
}));

vi.mock('@neo/client', () => ({ NeoClient: vi.fn(function () { return repl.client; }) }));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    on: (name: string, handler: (...args: any[]) => Promise<void> | void) => repl.listeners.set(name, handler),
    setPrompt: vi.fn(), prompt: vi.fn(), pause: vi.fn(), resume: vi.fn(),
  }),
}));

// Minimal fake readline that satisfies handleSlash's usage (only question() is called for /forget).
const fakeRl = {
  question: vi.fn().mockResolvedValue('n'),
} as unknown as Parameters<typeof handleSlash>[1];

function makeConv(id: string): Conversation {
  return {
    id,
    title: id,
    model: null,
    incognito: false,
    pinned: false,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    systemPrompt: null,
    toolset: null,
    lastMessageAt: null,
    preview: null,
  };
}

function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    conv: makeConv('conv-original'),
    incognito: false,
    opts: {},
    embeddedServer: null,
    ...overrides,
  };
}

describe('/new slash command — shared session context', () => {
  it('the real REPL line handler streams the next message to the new incognito conversation', async () => {
    const original = makeConv('conv-original');
    const incognito = { ...makeConv('conv-incognito'), incognito: true };
    repl.listeners.clear();
    repl.client.conversations.create.mockReset().mockResolvedValueOnce(original).mockResolvedValueOnce(incognito);
    repl.client.conversations.stream.mockReset().mockImplementation(async function* () {});
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runChat({ server: 'http://fixture.test', token: 'fixture-token' });
      const line = repl.listeners.get('line')!;
      await line('/new --incognito');
      await line('Keep this conversation private.');
      expect(repl.client.conversations.create).toHaveBeenLastCalledWith({ incognito: true });
      expect(repl.client.conversations.stream).toHaveBeenCalledWith(
        incognito.id, { text: 'Keep this conversation private.', model: undefined }, expect.any(AbortSignal),
      );
      expect(repl.client.conversations.stream).not.toHaveBeenCalledWith(original.id, expect.anything(), expect.anything());
    } finally {
      output.mockRestore();
    }
  });

  it('updates ctx.conv so the next message streams to the new conversation', async () => {
    const newConv = makeConv('conv-new-123');
    const mockClient = {
      conversations: {
        create: vi.fn().mockResolvedValue(newConv),
      },
    } as unknown as NeoClient;

    const ctx = makeCtx();
    expect(ctx.conv.id).toBe('conv-original');

    await handleSlash('/new', fakeRl, mockClient, ctx);

    expect(mockClient.conversations.create).toHaveBeenCalledWith({ incognito: false });
    expect(ctx.conv.id).toBe('conv-new-123');
    expect(ctx.incognito).toBe(false);
  });

  it('/new --incognito creates an incognito conversation and updates ctx', async () => {
    const newConv = makeConv('conv-incognito-456');
    const mockClient = {
      conversations: {
        create: vi.fn().mockResolvedValue(newConv),
      },
    } as unknown as NeoClient;

    const ctx = makeCtx();
    await handleSlash('/new --incognito', fakeRl, mockClient, ctx);

    expect(mockClient.conversations.create).toHaveBeenCalledWith({ incognito: true });
    expect(ctx.conv.id).toBe('conv-incognito-456');
    expect(ctx.incognito).toBe(true);
  });

  it('/title uses ctx.conv.id (the current conversation, not the original)', async () => {
    const newConv = makeConv('conv-new-789');
    let updatedId: string | undefined;
    const mockClient = {
      conversations: {
        create: vi.fn().mockResolvedValue(newConv),
        update: vi.fn().mockImplementation((id: string) => { updatedId = id; return Promise.resolve(newConv); }),
      },
    } as unknown as NeoClient;

    const ctx = makeCtx();

    // First switch to a new conversation.
    await handleSlash('/new', fakeRl, mockClient, ctx);
    expect(ctx.conv.id).toBe('conv-new-789');

    // Then rename — must target the NEW conversation.
    await handleSlash('/title My Notes', fakeRl, mockClient, ctx);
    expect(updatedId).toBe('conv-new-789');
  });
});
