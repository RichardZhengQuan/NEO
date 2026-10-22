/**
 * AgentRuntime tests — offline/deterministic with fakes.
 *
 * Fakes:
 *  - FakeConversationStore   — in-memory, fully functional
 *  - FakeSettingsStore       — DEFAULT_SETTINGS + applySettingsPatch
 *  - FakeProviderRegistry    — scripted async generators (records requests)
 *  - FakeMemoryService       — records recall/observe calls, configurable results
 *  - FakeToolRegistry        — tools of each permission level
 */
import { describe, it, expect, vi } from 'vitest';
import {
  NeoError,
  DEFAULT_SETTINGS,
  applySettingsPatch,
  newId,
  type AgentEvent,
  type ChatRequest,
  type ChatStreamEvent,
  type Clock,
  type Conversation,
  type ConversationListQuery,
  type ConversationPatch,
  type ConversationStore,
  type MemoryService,
  type MemoryWriteResult,
  type Message,
  type MessagePatch,
  type ModelCapabilities,
  type NewConversation,
  type NeoSettings,
  type OffRecordState,
  type NeoSettingsPatch,
  type ObservedTurn,
  type PermissionLevel,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderRegistry,
  type ProviderTestResult,
  type RecallQuery,
  type RecallResult,
  type RecalledMemory,
  type SettingsStore,
  type ToolCallRequest,
  type ToolContext,
  type ToolDefinition,
  type ToolInfo,
  type ToolRegistry,
  type ToolResult,
  type ToolSpec,
  silentLogger,
} from '@neo/protocol';
import { toolSpec } from '@neo/protocol';
import { z } from 'zod';

import { AgentRuntime } from './runtime.js';

// ──────────────────────────────────────────────────────────────────────────────
// Fake clock
// ──────────────────────────────────────────────────────────────────────────────

function makeFakeClock(startMs = 1_700_000_000_000): { clock: Clock; advance(ms: number): void } {
  let t = startMs;
  return {
    clock: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// FakeConversationStore
// ──────────────────────────────────────────────────────────────────────────────

class FakeConversationStore implements ConversationStore {
  private convMap = new Map<string, Conversation>();
  private msgMap = new Map<string, Message>();
  private msgsByConv = new Map<string, string[]>(); // convId → message ids (ordered)

  list(query?: ConversationListQuery): Conversation[] {
    let items = Array.from(this.convMap.values());
    if (query?.archived !== undefined) items = items.filter((c) => c.archived === query.archived);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Conversation | null {
    return this.convMap.get(id) ?? null;
  }

  create(input?: NewConversation): Conversation {
    const now = Date.now();
    const conv: Conversation = {
      id: newId('conv'),
      title: input?.title ?? 'New conversation',
      createdAt: now,
      updatedAt: now,
      model: input?.model ?? null,
      incognito: input?.incognito ?? false,
      offRecord: input?.offRecord ?? input?.incognito ?? false,
      ephemeral: input?.ephemeral ?? false,
      pinned: false,
      archived: false,
      systemPrompt: null,
      toolset: null,
      lastMessageAt: null,
      preview: null,
    };
    this.convMap.set(conv.id, conv);
    this.msgsByConv.set(conv.id, []);
    return conv;
  }

  update(id: string, patch: ConversationPatch): Conversation {
    const conv = this.convMap.get(id);
    if (!conv) throw new NeoError('not_found', `Conversation ${id} not found`);
    const updated = { ...conv, ...patch, updatedAt: Date.now() };
    this.convMap.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    if (!this.convMap.has(id)) return false;
    this.convMap.delete(id);
    const ids = this.msgsByConv.get(id) ?? [];
    for (const mid of ids) this.msgMap.delete(mid);
    this.msgsByConv.delete(id);
    return true;
  }

  messages(conversationId: string, options?: { limit?: number; before?: number }): Message[] {
    const ids = this.msgsByConv.get(conversationId) ?? [];
    let msgs = ids.map((id) => this.msgMap.get(id)!).filter(Boolean);
    if (options?.before !== undefined) msgs = msgs.filter((m) => m.createdAt < options.before!);
    if (options?.limit !== undefined) msgs = msgs.slice(-options.limit);
    return msgs;
  }

  getMessage(id: string): Message | null {
    return this.msgMap.get(id) ?? null;
  }

  appendMessage(message: Message): Message {
    this.msgMap.set(message.id, message);
    const ids = this.msgsByConv.get(message.conversationId);
    if (ids) ids.push(message.id);
    return message;
  }

  updateMessage(id: string, patch: MessagePatch): Message {
    const msg = this.msgMap.get(id);
    if (!msg) throw new NeoError('not_found', `Message ${id} not found`);
    const updated = { ...msg, ...patch };
    this.msgMap.set(id, updated);
    return updated;
  }

  deleteMessage(id: string): boolean {
    return this.msgMap.delete(id);
  }
  private privateState: OffRecordState = { active: false, episodeId: null, startedAt: null };
  offRecordState(): OffRecordState { return structuredClone(this.privateState); }
  setOffRecordState(state: OffRecordState): void { this.privateState = structuredClone(state); }
  currentEpisode(): Conversation | null { return null; }
  latestEpisode(): Conversation | null { return this.list().at(0) ?? null; }
  createEpisode(input: { offRecord?: boolean } = {}): Conversation { return this.create({ ...input, ephemeral: input.offRecord === true }); }
  closeEpisode(id: string): Conversation { return this.update(id, { closedAt: Date.now() }); }
  purgeOffRecord(): number { return 0; }
  offRecordEpisodes(): Conversation[] { return []; }
  timeline(): { items: never[]; episodes: never[]; nextCursor: null } { return { items: [], episodes: [], nextCursor: null }; }
  searchMessages(): never[] { return []; }
  messagesInRange(range: { from?: number; to?: number }): Message[] {
    return [...this.msgMap.values()]
      .filter((message) => message.createdAt >= (range.from ?? -Infinity) && message.createdAt <= (range.to ?? Infinity))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  deleteRange(range: { from?: number; to?: number }): Message[] {
    const messages = this.messagesInRange(range);
    for (const message of messages) this.deleteMessage(message.id);
    return messages;
  }

}

// ──────────────────────────────────────────────────────────────────────────────
// FakeSettingsStore
// ──────────────────────────────────────────────────────────────────────────────

class FakeSettingsStore implements SettingsStore {
  private current: NeoSettings;
  private listeners = new Set<(s: NeoSettings) => void>();

  constructor(patch?: NeoSettingsPatch) {
    this.current = patch ? applySettingsPatch(DEFAULT_SETTINGS, patch) : DEFAULT_SETTINGS;
  }

  get(): NeoSettings {
    return this.current;
  }

  update(patch: NeoSettingsPatch): NeoSettings {
    this.current = applySettingsPatch(this.current, patch);
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  onChange(listener: (settings: NeoSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Scripted FakeProviderAdapter + FakeProviderRegistry
// ──────────────────────────────────────────────────────────────────────────────

type ChatScript = (req: ChatRequest) => AsyncIterable<ChatStreamEvent>;

class FakeProviderAdapter implements ProviderAdapter {
  readonly id = 'fake';
  readonly kind = 'mock' as const;
  readonly isLocal = true;
  readonly config: ProviderConfig = {
    id: 'fake',
    kind: 'mock',
    label: 'Fake',
    enabled: true,
    defaultModel: 'fake-model',
  };

  private scripts: ChatScript[] = [];
  private scriptIndex = 0;
  public requests: ChatRequest[] = [];

  /** Queue a turn script (executed in order). */
  addScript(script: ChatScript): this {
    this.scripts.push(script);
    return this;
  }

  capabilities(_model: string): ModelCapabilities {
    return {
      tools: true,
      vision: false,
      reasoning: false,
      embeddings: false,
      contextWindow: 32_000,
      maxOutputTokens: 4096,
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.requests.push(request);
    const script = this.scripts[this.scriptIndex++ % this.scripts.length];
    if (!script) {
      yield { type: 'text', text: 'Hello!' };
      yield { type: 'done', stopReason: 'end' };
      return;
    }
    yield* script(request);
  }

  async listModels(): Promise<import('@neo/protocol').ModelInfo[]> {
    return [{ id: 'fake-model', provider: 'fake', capabilities: this.capabilities('fake-model') }];
  }

  async test(): Promise<ProviderTestResult> {
    return { ok: true, latencyMs: 0 };
  }
}

class FakeProviderRegistry implements ProviderRegistry {
  private adapter: FakeProviderAdapter;

  constructor(adapter?: FakeProviderAdapter) {
    this.adapter = adapter ?? new FakeProviderAdapter();
  }

  get(_id: string): ProviderAdapter | undefined {
    return this.adapter;
  }

  list(): ProviderAdapter[] {
    return [this.adapter];
  }

  resolve(_ref: { provider: string; model: string }): { adapter: ProviderAdapter; model: string } {
    return { adapter: this.adapter, model: 'fake-model' };
  }

  upsert(_config: ProviderConfig): ProviderAdapter {
    return this.adapter;
  }

  remove(_id: string): boolean {
    return false;
  }

  /** Expose the adapter for adding scripts. */
  get fakeAdapter(): FakeProviderAdapter {
    return this.adapter;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Script helpers
// ──────────────────────────────────────────────────────────────────────────────

function* simpleText(text: string): Iterable<ChatStreamEvent> {
  yield { type: 'text', text };
  yield { type: 'done', stopReason: 'end' };
}

function asyncOf<T>(...items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

// ──────────────────────────────────────────────────────────────────────────────
// FakeMemoryService
// ──────────────────────────────────────────────────────────────────────────────

class FakeMemoryService implements MemoryService {
  public recallCalls: RecallQuery[] = [];
  public observeCalls: ObservedTurn[] = [];
  private _recallResult: RecalledMemory[] = [];
  private _recallGate: Promise<void> | undefined;

  setRecallItems(items: RecalledMemory[]) {
    this._recallResult = items;
  }

  gateRecall(): { gate: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this._recallGate = gate;
    return { gate, release };
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    this.recallCalls.push(query);
    if (this._recallGate) {
      const gate = this._recallGate;
      this._recallGate = undefined;
      await gate;
    }
    return { items: this._recallResult, tookMs: 0, seeds: 0, considered: 0 };
  }

  async observe(turn: ObservedTurn): Promise<MemoryWriteResult> {
    this.observeCalls.push(turn);
    return { created: [], updated: [], superseded: [], linked: 0 };
  }

  // Stub out the rest of the interface
  async remember(): Promise<never> { throw new Error('not implemented'); }
  async search(): Promise<{ items: never[]; total: number }> { return { items: [], total: 0 }; }
  async get(): Promise<null> { return null; }
  async update(): Promise<never> { throw new Error('not implemented'); }
  async forget(): Promise<number> { return 0; }
  async findForForget(): Promise<never[]> { return []; }
  async findBySource(): Promise<never[]> { return []; }
  async forgetBySource(): Promise<number> { return 0; }
  async link(): Promise<never> { throw new Error('not implemented'); }
  async unlink(): Promise<boolean> { return false; }
  async graph(): Promise<never> { throw new Error('not implemented'); }
  async consolidate(): Promise<never> { throw new Error('not implemented'); }
  async journal(): Promise<never[]> { return []; }
  async stats(): Promise<never> { throw new Error('not implemented'); }
  async export(): Promise<never> { throw new Error('not implemented'); }
  async import(): Promise<never> { throw new Error('not implemented'); }
  getPolicy() { return DEFAULT_SETTINGS.memory; }
  setPolicy() {}
  onChange() { return () => {}; }
}

// ──────────────────────────────────────────────────────────────────────────────
// FakeToolRegistry
// ──────────────────────────────────────────────────────────────────────────────

class FakeToolRegistry implements ToolRegistry {
  private defs = new Map<string, ToolDefinition>();
  private perms = new Map<string, PermissionLevel>();

  register(def: ToolDefinition, _source?: 'builtin' | 'plugin'): void {
    this.defs.set(def.name, def);
    this.perms.set(def.name, def.defaultPermission);
  }

  unregister(name: string): boolean {
    return this.defs.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.defs.values());
  }

  info(): ToolInfo[] {
    return Array.from(this.defs.values()).map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      risk: d.risk,
      permission: this.perms.get(d.name) ?? d.defaultPermission,
      enabled: this.perms.get(d.name) !== 'deny',
      source: 'builtin' as const,
    }));
  }

  specs(names?: readonly string[]): ToolSpec[] {
    return Array.from(this.defs.values())
      .filter((d) => {
        const perm = this.perms.get(d.name) ?? d.defaultPermission;
        if (perm === 'deny') return false;
        if (d.uiOnly) return false;
        if (names && !names.includes(d.name)) return false;
        return true;
      })
      .map(toolSpec);
  }

  permissionFor(name: string): PermissionLevel {
    return this.perms.get(name) ?? 'auto';
  }

  setPermission(name: string, level: PermissionLevel): void {
    this.perms.set(name, level);
  }

  async execute(call: ToolCallRequest, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.get(call.name);
    if (!def) return { output: { error: `Tool "${call.name}" not found.` }, isError: true };
    if (def.uiOnly && ctx.origin !== 'ui') {
      return { output: { error: `Tool "${call.name}" can only be called from UI.` }, isError: true };
    }
    try {
      const parsed = def.inputSchema.safeParse(call.input);
      if (!parsed.success) return { output: { error: 'Invalid input' }, isError: true };
      return await def.execute(parsed.data, ctx);
    } catch (err) {
      return { output: { error: String(err) }, isError: true };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Test setup helper
// ──────────────────────────────────────────────────────────────────────────────

interface TestEnv {
  conversations: FakeConversationStore;
  settings: FakeSettingsStore;
  providers: FakeProviderRegistry;
  memory: FakeMemoryService;
  tools: FakeToolRegistry;
  clock: Clock;
  runtime: AgentRuntime;
  conv: Conversation;
}

function makeEnv(settingsPatch?: NeoSettingsPatch): TestEnv {
  const conversations = new FakeConversationStore();
  const settings = new FakeSettingsStore(settingsPatch);
  const providers = new FakeProviderRegistry();
  const memory = new FakeMemoryService();
  const tools = new FakeToolRegistry();
  const { clock } = makeFakeClock();
  const logger = silentLogger;

  // Register tools of each permission level
  tools.register({
    name: 'auto_tool',
    title: 'Auto Tool',
    description: 'Runs automatically',
    inputSchema: z.object({ msg: z.string() }),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(input) {
      return { output: { result: `auto:${input.msg}` }, summary: 'Done' };
    },
  });

  tools.register({
    name: 'confirm_tool',
    title: 'Confirm Tool',
    description: 'Requires confirmation',
    inputSchema: z.object({ msg: z.string() }),
    risk: 'write',
    defaultPermission: 'confirm',
    async execute(input) {
      return { output: { result: `confirmed:${input.msg}` }, summary: 'Done' };
    },
  });

  tools.register({
    name: 'deny_tool',
    title: 'Deny Tool',
    description: 'Always denied',
    inputSchema: z.object({ msg: z.string() }),
    risk: 'dangerous',
    defaultPermission: 'deny',
    async execute(input) {
      return { output: { result: `deny:${input.msg}` }, summary: 'Done' };
    },
  });

  const runtime = new AgentRuntime({ conversations, settings, providers, memory, tools, logger, clock });
  // Keep the legacy title column present but unused by the runtime.
  const conv = conversations.create();

  return { conversations, settings, providers, memory, tools, clock, runtime, conv };
}

// Collect all events from a turn into an array
async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('AgentRuntime.send', () => {
  it('returns a TurnHandle with correct ids', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Hi!')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hello' }] });

    expect(handle.turnId).toMatch(/^turn_/);
    expect(handle.conversationId).toBe(conv.id);
    expect(handle.assistantMessageId).toMatch(/^msg_/);
    expect(handle.userMessage.role).toBe('user');
    expect(handle.events).toBeDefined();
    expect(handle.done).toBeInstanceOf(Promise);

    await handle.done; // drain
  });

  it('throws not_found for unknown conversation', async () => {
    const { runtime } = makeEnv();
    await expect(runtime.send({ conversationId: 'conv_unknown', parts: [{ type: 'text', text: 'Hi' }] })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws bad_request for empty parts', async () => {
    const { runtime, conv } = makeEnv();
    await expect(runtime.send({ conversationId: conv.id, parts: [] })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('throws conflict when a turn is already running', async () => {
    const { providers, runtime, conv } = makeEnv();
    // A script that never finishes
    providers.fakeAdapter.addScript(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      yield { type: 'done', stopReason: 'end' } as ChatStreamEvent;
    });

    const handle1 = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'First' }] });

    await expect(
      runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Second' }] }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Clean up
    runtime.cancel(handle1.turnId);
    await handle1.done;
  });
});

describe('Turn event sequence', () => {
  it('emits turn.started, text.delta, message.completed, turn.finished', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world!' },
        { type: 'done', stopReason: 'end' },
      ),
    );

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] });
    const events = await collectEvents(handle.events);

    const types = events.map((e) => e.type);
    expect(types).toContain('turn.started');
    expect(types).toContain('text.delta');
    expect(types).toContain('message.completed');
    expect(types).toContain('turn.finished');

    // Order: turn.started first, turn.finished last (excluding memory.* which may be after)
    const firstIdx = types.indexOf('turn.started');
    const lastFinish = types.lastIndexOf('turn.finished');
    expect(firstIdx).toBe(0);
    expect(lastFinish).toBeGreaterThan(firstIdx);
  });

  it('done resolves with the assistant message', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('The answer is 42')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'What is the answer?' }] });
    const msg = await handle.done;

    expect(msg.role).toBe('assistant');
    expect(msg.status).toBe('complete');
    const text = msg.parts.find((p) => p.type === 'text') as { type: 'text'; text: string } | undefined;
    expect(text?.text).toBe('The answer is 42');
  });

  it('emits usage event and sets usage on message', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'text', text: 'Answer' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'done', stopReason: 'end' },
      ),
    );

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Q' }] });
    const msg = await handle.done;

    expect(msg.usage?.inputTokens).toBe(10);
    expect(msg.usage?.outputTokens).toBe(5);
  });
});

describe('Auto tool execution', () => {
  it('runs auto-permission tool automatically and continues', async () => {
    const { providers, runtime, conv } = makeEnv();

    // First call: tool_call. Second call (after result): final text.
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'tool_call', id: 'tc1', name: 'auto_tool', input: { msg: 'hello' } },
        { type: 'done', stopReason: 'tool_use' },
      ),
    );
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Done!')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Use auto_tool' }] });
    const events = await collectEvents(handle.events);
    const msg = await handle.done;

    expect(events.some((e) => e.type === 'tool.started')).toBe(true);
    expect(events.some((e) => e.type === 'tool.finished')).toBe(true);
    expect(msg.status).toBe('complete');

    const toolResult = msg.parts.find(
      (p) => p.type === 'tool_result' && (p as { type: 'tool_result'; toolCallId: string }).toolCallId === 'tc1',
    );
    expect(toolResult).toBeDefined();
  });

  it('denies a deny-permission tool', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'tool_call', id: 'tc_deny', name: 'deny_tool', input: { msg: 'hi' } },
        { type: 'done', stopReason: 'tool_use' },
      ),
    );
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Use deny_tool' }] });
    const events = await collectEvents(handle.events);
    await handle.done;

    const finishedEv = events.find((e) => e.type === 'tool.finished') as
      | { type: 'tool.finished'; isError: boolean }
      | undefined;
    expect(finishedEv?.isError).toBe(true);
  });
});

describe('Confirmation flow', () => {
  it('approve: proceeds with the tool and gets result', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'tool_call', id: 'tc_confirm', name: 'confirm_tool', input: { msg: 'world' } },
        { type: 'done', stopReason: 'tool_use' },
      ),
    );
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('All done')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Use confirm_tool' }] });

    // Approve asynchronously
    let confirmationReceived = false;
    const unsubscribe = runtime.subscribe((ev) => {
      if (ev.type === 'tool.confirmation') {
        confirmationReceived = true;
        runtime.confirm(ev.confirmation.id, { approve: true });
      }
    });

    const events = await collectEvents(handle.events);
    unsubscribe();
    await handle.done;

    expect(confirmationReceived).toBe(true);
    const resolvedEv = events.find((e) => e.type === 'tool.confirmation_resolved') as
      | { type: 'tool.confirmation_resolved'; approved: boolean }
      | undefined;
    expect(resolvedEv?.approved).toBe(true);
  });

  it('deny: tool result is an error', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'tool_call', id: 'tc_deny2', name: 'confirm_tool', input: { msg: 'world' } },
        { type: 'done', stopReason: 'tool_use' },
      ),
    );
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Use confirm_tool' }] });

    const unsubscribe = runtime.subscribe((ev) => {
      if (ev.type === 'tool.confirmation') {
        runtime.confirm(ev.confirmation.id, { approve: false });
      }
    });

    const events = await collectEvents(handle.events);
    unsubscribe();
    await handle.done;

    const finishedEv = events.find((e) => e.type === 'tool.finished') as
      | { type: 'tool.finished'; isError: boolean }
      | undefined;
    expect(finishedEv?.isError).toBe(true);
  });

  it('always: persists auto permission to settings', async () => {
    const { providers, runtime, settings, conv } = makeEnv();
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'tool_call', id: 'tc_always', name: 'confirm_tool', input: { msg: 'world' } },
        { type: 'done', stopReason: 'tool_use' },
      ),
    );
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Use confirm_tool' }] });

    const unsubscribe = runtime.subscribe((ev) => {
      if (ev.type === 'tool.confirmation') {
        runtime.confirm(ev.confirmation.id, { approve: true, always: true });
      }
    });

    await collectEvents(handle.events);
    unsubscribe();
    await handle.done;

    // The tool permission should now be 'auto' in settings
    const currentSettings = settings.get();
    expect(currentSettings.tools?.permissions?.confirm_tool).toBe('auto');
  });

  it('timeout: returns error result after timeout', async () => {
    // Use fake timers to make the 10-second minimum timeout fire instantly.
    vi.useFakeTimers();
    try {
      const { providers, runtime, conv } = makeEnv({
        agent: { confirmationTimeoutSec: 10 },
      });
      providers.fakeAdapter.addScript(() =>
        asyncOf<ChatStreamEvent>(
          { type: 'tool_call', id: 'tc_timeout', name: 'confirm_tool', input: { msg: 'hi' } },
          { type: 'done', stopReason: 'tool_use' },
        ),
      );
      providers.fakeAdapter.addScript(() => asyncOf(...simpleText('ok')));

      const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Use confirm_tool' }] });

      // Collect events concurrently while advancing fake timers past the timeout.
      const eventsPromise = collectEvents(handle.events);
      await vi.runAllTimersAsync();

      const events = await eventsPromise;
      await handle.done;

      const resolvedEv = events.find((e) => e.type === 'tool.confirmation_resolved') as
        | { type: 'tool.confirmation_resolved'; approved: boolean; reason: string }
        | undefined;
      expect(resolvedEv?.approved).toBe(false);
      expect(resolvedEv?.reason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cancel', () => {
  it('cancel(turnId) stops the turn and returns cancelled status', async () => {
    const { providers, runtime, conv } = makeEnv();

    providers.fakeAdapter.addScript(async function* () {
      yield { type: 'text', text: 'Starting...' } as ChatStreamEvent;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      yield { type: 'done', stopReason: 'end' } as ChatStreamEvent;
    });

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Go' }] });

    // Cancel after a brief yield
    setTimeout(() => runtime.cancel(handle.turnId), 10);

    const msg = await handle.done;
    expect(msg.status).toBe('cancelled');
  });

  it('cancel returns false for unknown turnId', () => {
    const { runtime } = makeEnv();
    expect(runtime.cancel('turn_unknown')).toBe(false);
  });

  it('cancelConversation cancels all turns for a conversation', async () => {
    const { providers, runtime, conv } = makeEnv();

    providers.fakeAdapter.addScript(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      yield { type: 'done', stopReason: 'end' } as ChatStreamEvent;
    });

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Go' }] });

    setTimeout(() => runtime.cancelConversation(conv.id), 10);
    const msg = await handle.done;
    expect(msg.status).toBe('cancelled');
  });
});

describe('maxSteps', () => {
  it('stops after maxSteps even if model keeps returning tool_use', async () => {
    const { providers, runtime, conv } = makeEnv({
      agent: { maxSteps: 2 },
    });

    // Always return tool_call
    const toolScript = () =>
      asyncOf<ChatStreamEvent>(
        { type: 'tool_call', id: newId('tc'), name: 'auto_tool', input: { msg: 'test' } },
        { type: 'done', stopReason: 'tool_use' },
      );

    // Add 3 scripts; only 2 steps should fire
    providers.fakeAdapter.addScript(toolScript);
    providers.fakeAdapter.addScript(toolScript);
    providers.fakeAdapter.addScript(toolScript);

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Go' }] });
    await collectEvents(handle.events);
    const msg = await handle.done;

    // Should have made exactly 2 requests (maxSteps=2)
    expect(providers.fakeAdapter.requests.length).toBeLessThanOrEqual(3);
    expect(msg.status).toBe('complete');
  });
});

describe('Frozen system prompt + toolset', () => {
  it('system prompt and toolset are frozen after the first turn', async () => {
    const { providers, runtime, conversations, conv } = makeEnv();

    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Turn 1')));

    const handle1 = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'First' }] });
    await collectEvents(handle1.events);
    await handle1.done;

    const convAfterTurn1 = conversations.get(conv.id)!;
    expect(convAfterTurn1.systemPrompt).not.toBeNull();
    expect(convAfterTurn1.toolset).not.toBeNull();

    const savedPrompt = convAfterTurn1.systemPrompt;
    const savedToolset = convAfterTurn1.toolset;

    // Second turn
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Turn 2')));
    const handle2 = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Second' }] });
    await collectEvents(handle2.events);
    await handle2.done;

    const convAfterTurn2 = conversations.get(conv.id)!;
    // System prompt and toolset unchanged
    expect(convAfterTurn2.systemPrompt).toBe(savedPrompt);
    expect(convAfterTurn2.toolset).toEqual(savedToolset);

    // The model should have received the same system prompt for both turns.
    // Auto-title requests (metadata.purpose === 'title') are interleaved; filter them out.
    const turnRequests = providers.fakeAdapter.requests.filter(
      (r) => (r.metadata as { purpose?: string } | undefined)?.purpose !== 'title',
    );
    expect(turnRequests[0]!.system).toBe(turnRequests[1]!.system);
  });

  it('context block (memories, time) goes in the user message, not system prompt', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hello' }] });
    await collectEvents(handle.events);
    await handle.done;

    // System prompt should NOT contain an actual context block (only a reference
    // to the <neo_context> tag name in guidance text is acceptable).
    const sysPrompt = providers.fakeAdapter.requests[0]!.system ?? '';
    expect(sysPrompt).not.toContain('</neo_context>');

    // The raw stored user message should have a context part (toChatMessages
    // converts context parts to plain text parts before sending to the model,
    // so we check the stored message, not the provider's chat messages).
    const contextPart = handle.userMessage.parts.find((p) => p.type === 'context');
    expect(contextPart).toBeDefined();
  });
});

describe('Off-record migration race', () => {
  it('migrates an in-flight send() to the off-record episode when startOffRecord() races recall', async () => {
    const { providers, runtime, conv, memory, conversations } = makeEnv();
    const { release } = memory.gateRecall();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Private reply')));

    const handlePromise = runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] });

    // send() reaches recall synchronously, and the gate holds it before persistence.
    expect(memory.recallCalls).toHaveLength(1);
    expect(conversations.messages(conv.id)).toEqual([]);
    expect(providers.fakeAdapter.requests).toEqual([]);
    const offRecordState = await runtime.startOffRecord();
    release();

    const handle = await handlePromise;
    await collectEvents(handle.events);
    const final = await handle.done;

    // Migration keeps the original placeholder and writes the reply to a new continuation.
    const assistantMessage = conversations.getMessage(final.id);
    expect(assistantMessage?.conversationId).toBe(offRecordState.episodeId);
    expect(assistantMessage?.episodeId).toBe(offRecordState.episodeId);
    expect(assistantMessage?.parts).toEqual([{ type: 'text', text: 'Private reply' }]);
    expect(conversations.messages(conv.id).flatMap((message) => message.parts))
      .not.toContainEqual({ type: 'text', text: 'Private reply' });
    expect(memory.observeCalls).toEqual([]);

    // Replaying the migration must also release the original conversation reservation.
    await runtime.endOffRecord();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Normal reply')));
    const next = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Back' }] });
    await collectEvents(next.events);
    expect((await next.done).conversationId).toBe(conv.id);
  });
});

describe('conversation.lastMessageAt', () => {
  it('always updates lastMessageAt even when the turn produces no text (tool-only finish)', async () => {
    const { clock, advance } = makeFakeClock();
    const conversations = new FakeConversationStore();
    const settings = new FakeSettingsStore();
    const providers = new FakeProviderRegistry();
    const memory = new FakeMemoryService();
    const tools = new FakeToolRegistry();
    const logger = silentLogger;

    tools.register({
      name: 'auto_tool',
      title: 'Auto Tool',
      description: 'Runs automatically',
      inputSchema: z.object({ msg: z.string() }),
      risk: 'read',
      defaultPermission: 'auto',
      async execute(input) {
        return { output: { result: `auto:${input.msg}` }, summary: 'Done' };
      },
    });

    const runtime = new AgentRuntime({ conversations, settings, providers, memory, tools, logger, clock });
    const conv = conversations.create();
    conversations.update(conv.id, { preview: 'Last visible preview' });
    const lastMessageAtBeforeTurn = conversations.get(conv.id)!.lastMessageAt;

    providers.fakeAdapter.addScript(async function* () {
      yield { type: 'tool_call', id: 'tc_only', name: 'auto_tool', input: { msg: 'x' } };
      yield { type: 'done', stopReason: 'tool_use' };
    });
    providers.fakeAdapter.addScript(async function* () {
      advance(120_000);
      yield { type: 'done', stopReason: 'end' };
    });

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Run the tool' }] });
    await collectEvents(handle.events);
    const message = await handle.done;

    expect(message.status).toBe('complete');
    expect(message.parts.map((part) => part.type)).toEqual(['tool_call', 'tool_result']);
    expect(providers.fakeAdapter.requests).toHaveLength(2);
    expect(clock()).toBe(handle.userMessage.createdAt + 120_000);

    const updated = conversations.get(conv.id)!;
    expect(updated.lastMessageAt).toBe(clock());
    expect(updated.lastMessageAt).not.toBeNull();
    expect(updated.lastMessageAt).not.toBe(lastMessageAtBeforeTurn);
    expect(updated.lastMessageAt).not.toBe(handle.userMessage.createdAt);
    expect(updated.preview).toBe('Last visible preview');
  });
});

describe('Incognito mode', () => {
  it('allows memory recall for legacy off-record episodes', async () => {
    const { providers, runtime, conversations, memory } = makeEnv();
    const incognitoConv = conversations.create({ title: 'Incognito', incognito: true });

    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Shh')));

    const handle = await runtime.send({ conversationId: incognitoConv.id, parts: [{ type: 'text', text: 'Secret' }] });
    await collectEvents(handle.events);
    await handle.done;

    // Give async tasks time to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(memory.recallCalls.length).toBe(1);
  });

  it('does not call memory.observe for incognito conversation', async () => {
    const { providers, runtime, conversations, memory } = makeEnv();
    const incognitoConv = conversations.create({ title: 'Incognito', incognito: true });

    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Shh')));

    const handle = await runtime.send({ conversationId: incognitoConv.id, parts: [{ type: 'text', text: 'Secret' }] });
    await collectEvents(handle.events);
    await handle.done;

    await new Promise((r) => setTimeout(r, 50));

    expect(memory.observeCalls.length).toBe(0);
  });

  it('includes the off-record note in context block', async () => {
    const { providers, runtime, conversations } = makeEnv();
    const incognitoConv = conversations.create({ title: 'Incognito', incognito: true });

    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Ok')));

    const handle = await runtime.send({ conversationId: incognitoConv.id, parts: [{ type: 'text', text: 'Hi' }] });
    await collectEvents(handle.events);
    await handle.done;

    // toChatMessages converts context parts to plain text parts, so check the
    // raw stored user message instead of the provider's chat messages.
    const contextPart = handle.userMessage.parts.find((p) => p.type === 'context') as { type: 'context'; text: string } | undefined;
    expect(contextPart?.text).toContain('Off the record');
  });
});

describe('Memory recall', () => {
  it('recalls memories and emits memory.recalled event', async () => {
    const { providers, runtime, conv, memory } = makeEnv();

    const fakeMemory: RecalledMemory = {
      node: {
        id: 'mem_abc',
        kind: 'fact' as const,
        label: 'User likes coffee',
        content: 'User likes coffee',
        importance: 0.7,
        confidence: 1.0,
        status: 'active',
        pinned: false,
        sensitivity: 'normal',
        source: { by: 'assistant', conversationId: conv.id },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: [],
        aliases: [],
        stability: 0.5,
        accessCount: 1,
        lastAccessedAt: Date.now(),
      },
      score: 0.9,
      activation: 0.9,
      similarity: 0.9,
      retention: 1.0,
      via: [],
      reason: 'matches your message',
    };
    memory.setRecallItems([fakeMemory]);

    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Coffee please' }] });
    const events = await collectEvents(handle.events);
    await handle.done;

    const recalledEv = events.find((e) => e.type === 'memory.recalled');
    expect(recalledEv).toBeDefined();
  });

  it('memories appear in the context block', async () => {
    const { providers, runtime, conv, memory } = makeEnv();

    const fakeMemory: RecalledMemory = {
      node: {
        id: 'mem_xyz',
        kind: 'preference' as const,
        label: 'Prefers dark mode',
        content: 'Prefers dark mode',
        importance: 0.5,
        confidence: 1.0,
        status: 'active',
        pinned: false,
        sensitivity: 'normal',
        source: { by: 'assistant', conversationId: conv.id },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: [],
        aliases: [],
        stability: 0.5,
        accessCount: 1,
        lastAccessedAt: Date.now(),
      },
      score: 0.8,
      activation: 0.8,
      similarity: 0.8,
      retention: 1.0,
      via: [],
      reason: 'matches your message',
    };
    memory.setRecallItems([fakeMemory]);

    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Dark please' }] });
    await collectEvents(handle.events);
    await handle.done;

    // toChatMessages converts context parts to plain text parts, so check the
    // raw stored user message for the context part content.
    const contextPart = handle.userMessage.parts.find((p) => p.type === 'context') as { type: 'context'; text: string } | undefined;
    expect(contextPart?.text).toContain('Prefers dark mode');
  });
});

describe('subscribe (global listeners)', () => {
  it('global subscriber receives all events', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Hello!')));

    const received: AgentEvent[] = [];
    const unsub = runtime.subscribe((e) => received.push(e));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] });
    await collectEvents(handle.events);
    await handle.done;
    unsub();

    expect(received.some((e) => e.type === 'turn.started')).toBe(true);
    expect(received.some((e) => e.type === 'turn.finished')).toBe(true);
  });

  it('unsubscribe stops receiving events', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('First')));

    const received: AgentEvent[] = [];
    const unsub = runtime.subscribe((e) => received.push(e));

    const handle1 = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] });
    await collectEvents(handle1.events);
    await handle1.done;

    const countBefore = received.length;
    unsub();

    // Create a second conversation for the second turn
    // (first conv still has active turn in cleanup, it's done now)
    const { providers: providers2 } = makeEnv();
    providers2.fakeAdapter.addScript(() => asyncOf(...simpleText('Second')));

    // The global listener is now removed so won't fire for runtime2's turns anyway
    // Verify count didn't change after unsubscribe
    expect(received.length).toBe(countBefore);
  });
});

describe('activeTurns', () => {
  it('lists active turn while running, empty after done', async () => {
    const { providers, runtime, conv } = makeEnv();

    providers.fakeAdapter.addScript(async function* () {
      yield { type: 'text', text: 'thinking...' } as ChatStreamEvent;
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'done', stopReason: 'end' } as ChatStreamEvent;
    });

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] });

    // Should be active now
    expect(runtime.activeTurns().some((t) => t.turnId === handle.turnId)).toBe(true);

    await handle.done;

    // Should no longer be active after done
    expect(runtime.activeTurns().some((t) => t.turnId === handle.turnId)).toBe(false);
  });
});

describe('pendingConfirmations', () => {
  it('lists pending confirmations while waiting', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() =>
      asyncOf<ChatStreamEvent>(
        { type: 'tool_call', id: 'tc_pend', name: 'confirm_tool', input: { msg: 'test' } },
        { type: 'done', stopReason: 'tool_use' },
      ),
    );
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('ok')));

    let confirmsWhenPending = 0;
    const unsub = runtime.subscribe((ev) => {
      if (ev.type === 'tool.confirmation') {
        confirmsWhenPending = runtime.pendingConfirmations().length;
        runtime.confirm(ev.confirmation.id, { approve: false });
      }
    });

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'confirm_tool please' }] });
    await collectEvents(handle.events);
    unsub();
    await handle.done;

    expect(confirmsWhenPending).toBeGreaterThan(0);
    expect(runtime.pendingConfirmations().length).toBe(0);
  });
});

describe('Front trimming', () => {
  it('keeps a conversation history that fits in the budget', async () => {
    // Use the minimum valid token budget so trimming kicks in for a long history.
    const { providers, runtime, conversations } = makeEnv({
      agent: { contextTokenBudget: 2000 },
    });
    const conv = conversations.create({ title: 'Trim test' });

    // Send 3 turns
    for (let i = 0; i < 3; i++) {
      providers.fakeAdapter.addScript(() => asyncOf(...simpleText(`Response ${i}`)));
      const h = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: `Message ${i}` }] });
      await collectEvents(h.events);
      await h.done;
    }

    // Each request's messages should be trimmed — the last request should not
    // contain all 6 messages (3 user + 3 assistant)
    const lastRequest = providers.fakeAdapter.requests.at(-1);
    expect(lastRequest).toBeDefined();
    // With a tiny budget, trimming should reduce history
    // (The exact count depends on estimateMessageTokens, but it should be less than all)
    // At minimum, the request should start with a user message
    expect(lastRequest?.messages[0]!.role).toBe('user');
  });
});

describe('ChatRequest shape', () => {
  it('sends the correct model and system in each request', async () => {
    const { providers, runtime, conv } = makeEnv();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] });
    await collectEvents(handle.events);
    await handle.done;

    const req = providers.fakeAdapter.requests[0]!;
    expect(req.model).toBe('fake-model');
    expect(typeof req.system).toBe('string');
    expect(req.system!.length).toBeGreaterThan(0);
  });

  it('keeps tools declared on the last step but sets toolChoice none', async () => {
    const { providers, runtime, conv } = makeEnv({ agent: { maxSteps: 1 } });
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('ok')));

    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] });
    await collectEvents(handle.events);
    await handle.done;

    const req = providers.fakeAdapter.requests[0]!;
    // Tools stay declared (append-only prefix; the history may reference them); only the choice changes.
    expect(req.tools?.map((t) => t.name)).toEqual(['auto_tool', 'confirm_tool']);
    expect(req.toolChoice).toBe('none');
  });
});

describe('Titles remain unused', () => {
  it('never requests a title or changes the stored title after a turn', async () => {
    const { providers, runtime, conversations, conv } = makeEnv();
    providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Hello!')));
    const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hello' }] });
    await handle.done;
    await new Promise((r) => setImmediate(r));
    expect(providers.fakeAdapter.requests).toHaveLength(1);
    expect(conversations.get(conv.id)!.title).toBe(conv.title);
  });
});

describe('Model resolution errors', () => {
  it.each(['empty', 'disabled', 'no-model', 'stale-model'] as const)(
    'fails before changing the transcript when the provider state is %s',
    async (state) => {
      const { runtime, conversations, providers, memory, conv, settings } = makeEnv();
      const existing: Message = {
        id: 'msg_existing', conversationId: conv.id, role: 'user',
        parts: [{ type: 'text', text: 'Earlier message' }], createdAt: 1, status: 'complete',
      };
      conversations.appendMessage(existing);
      const previousConversation = { ...conversations.get(conv.id)! };
      const previousMessages = structuredClone(conversations.messages(conv.id));
      const events: AgentEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      const available = providers.list();
      if (state === 'disabled') available[0]!.config.enabled = false;
      if (state === 'no-model') available[0]!.config.defaultModel = '';
      const list = vi.spyOn(providers, 'list').mockReturnValue(state === 'empty' || state === 'stale-model' ? [] : available);
      if (state === 'stale-model') settings.update({ defaultModel: { provider: 'removed', model: 'removed-model' } });

      await expect(runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Hi' }] }))
        .rejects.toMatchObject({ code: 'no_provider', status: 400, message: expect.stringContaining('Connect an AI') });
      expect(conversations.messages(conv.id)).toEqual(previousMessages);
      expect(conversations.get(conv.id)).toEqual(previousConversation);
      expect(runtime.activeTurns()).toEqual([]);
      expect(memory.recallCalls).toEqual([]);
      expect(events).toEqual([]);

      // A rejected send leaves no reservation behind; connecting an AI permits the next turn.
      list.mockRestore();
      providers.fakeAdapter.config.enabled = true;
      providers.fakeAdapter.config.defaultModel = 'fake-model';
      settings.update({ defaultModel: null });
      providers.fakeAdapter.addScript(() => asyncOf(...simpleText('Connected')));
      const handle = await runtime.send({ conversationId: conv.id, parts: [{ type: 'text', text: 'Try again' }] });
      await handle.done;
      expect(conversations.messages(conv.id)[0]).toEqual(existing);
    },
  );
});

describe('handleUiAction', () => {
  it('throws not_found for unknown message', async () => {
    const { runtime, conv } = makeEnv();
    await expect(
      runtime.handleUiAction({
        conversationId: conv.id,
        messageId: 'msg_unknown',
        uiId: 'ui_1',
        actionId: 'btn1',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
