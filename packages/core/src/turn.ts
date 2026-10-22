/**
 * One agent turn (docs/ARCHITECTURE.md "A timeline turn").
 *
 * startTurn() — called by AgentRuntime.send() with the conversation already
 * reserved and the model resolved:
 *   1. freeze the system prompt and toolset on the episode's first turn
 *      (off-record episodes leave out memory writes);
 *   2. recall memories (unless recall is off; failures are ignored);
 *   3. persist the user message [context part, ...parts] and an empty streaming
 *      assistant message, emit turn.started (+ memory.recalled);
 *   4. run the step loop in the background and return the TurnHandle.
 *
 * TurnRunner — the step loop: ≤ agent.maxSteps model calls (the last one with
 * toolChoice 'none'), streaming into ONE assistant message whose parts interleave
 * reasoning, text, tool calls, ui blocks and tool results. Then it finalizes the
 * message (complete | error | cancelled), releases the conversation, emits the
 * terminal events, resolves `done`, and — for completed turns only — starts the
 * async memory write-back.
 *
 * Invariants:
 * - Append-only transcript: the system prompt and tool specs are identical for
 *   every request of a conversation (a tool later set to deny stays declared and
 *   is refused at execution), stored parts are never rewritten once a request
 *   has used them, and the context part is rendered once per user message. Sensitive
 *   context is withheld at the provider boundary when cloud sharing is disabled.
 * - Every tool call in the stored message gets a tool_result, whatever happens.
 * - `done` resolves exactly once and never rejects; the per-turn event stream
 *   ends right after its terminal event (turn.finished / turn.failed).
 * - Event indices match what a client builds by appending text.delta to its last
 *   text part and placing part.added parts at `index`.
 */
import {
  NeoError,
  SourceSchema,
  addUsage,
  describeUiEvent,
  newId,
  previewOf,
  summarizeNode,
  textOf,
  toChatMessages,
  toolSpec,
  validateUIBlocks,
  extractInlineUI,
  childBlocks,
  collectActions,
  MAX_UI_BLOCKS,
  MAX_UI_TOP_LEVEL,
  episodeOf,
  wrapUntrusted,
  type AgentEvent,
  type ChatRequest,
  type ChatStreamEvent,
  type Clock,
  type ContentPart,
  type Conversation,
  type ConversationStore,
  type ErrorShape,
  type Logger,
  type MemoryService,
  type Message,
  type MessageStatus,
  type ModelCapabilities,
  type ModelRef,
  type NeoSettings,
  type ProviderAdapter,
  type ProviderRegistry,
  type ReasoningPart,
  type RecalledMemory,
  type SettingsStore,
  type Source,
  type StopReason,
  type ToolCallPart,
  type ToolConfirmation,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
  type ToolResultPart,
  type ToolSpec,
  type TurnHandle,
  type UIBlock,
  type UIPart,
  type Usage,
} from '@neo/protocol';

import { abortable, raceAbort } from './abort.js';
import type { ConfirmationManager, ConfirmationOutcome } from './confirmations.js';
import { EventQueue } from './event-queue.js';
import { trimHistory } from './history.js';
import { buildContextBlock, buildSystemPrompt } from './prompt.js';

/** Streaming text is persisted at most this often; structural parts and step ends are persisted immediately. */
const PERSIST_INTERVAL_MS = 250;
/** How much of the previous assistant reply is passed to recall as context (semantic nudge only), for continuity. */
const RECALL_PREVIOUS_REPLY_CHARS = 300;
/**
 * Off-record episodes can recall existing memories but cannot write or forget them.
 */
const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set(['remember', 'forget']);

type EventInput<T = AgentEvent> = T extends AgentEvent ? Omit<T, 'episodeId'> : never;

const MSG = {
  unknown: (name: string) => `Unknown tool "${name}".`,
  unavailable: (name: string) => `The tool "${name}" is not available in this conversation.`,
  denied: (name: string) => `The user has turned off the tool "${name}".`,
  declined: 'The user declined this action.',
  timedOut: 'The user did not answer the confirmation in time, so the action was not run.',
  confirmationCancelled: 'The confirmation request was cancelled, so the action was not run.',
  finalStep: 'Tool calls are not allowed in the final step of a turn; the tool was not run.',
  cancelled: 'The turn was cancelled before this tool call finished.',
  failed: 'The turn failed before this tool call finished.',
  notSerializable: 'The tool returned output that is not JSON-serializable.',
};

/** Shared services of the runtime, as seen by a turn. */
export interface TurnServices {
  conversations: ConversationStore;
  settings: SettingsStore;
  providers: ProviderRegistry;
  memory: MemoryService;
  tools: ToolRegistry;
  searchMode(settings: NeoSettings, adapter: ProviderAdapter, model: string): 'native' | 'engine' | 'off';
  searchTool(): ToolDefinition | undefined;
  confirmations: ConfirmationManager;
  logger: Logger;
  clock: Clock;
  /** Deliver an event to the runtime's global subscribers (each isolated from the others). */
  broadcast(event: AgentEvent): void;
  /** After a chat-turn forget, patch memory widgets in all stored messages of this conversation. */
  patchConversationWidgets(conversationId: string, result: ToolResult): void;
}

/** A turn that holds its conversation (AgentRuntime bookkeeping). */
export interface TurnRecord {
  turnId: string;
  conversationId: string;
  startedAt: number;
  controller: AbortController;
  enterOffRecord?(episode: Conversation): void;
}

export interface TurnPlan {
  record: TurnRecord;
  conversation: Conversation;
  /** Validated user parts (text, image, ui_event). */
  parts: ContentPart[];
  adapter: ProviderAdapter;
  model: string;
  settings: NeoSettings;
  searchMode: 'native' | 'engine' | 'off';
  /** Preflight context is rendered once and used both for budget checks and persistence. */
  context?: ContentPart;
  recalled?: RecalledMemory[];
  recentContext?: ContentPart;
  /** Timeline episodes retain their whole prefix; legacy internal sends may trim. */
  timeline?: boolean;
  /** Frees the conversation for the next send(). Called exactly once, before the terminal event. */
  release(): void;
}

export async function startTurn(services: TurnServices, plan: TurnPlan): Promise<TurnHandle> {
  const { conversations, tools, logger, clock } = services;
  const { record, conversation: conv, adapter, model, settings } = plan;
  const { turnId, conversationId } = record;
  const caps = adapter.capabilities(model);
  const history = conversations.messages(conversationId);

  // 1. Freeze the system prompt and toolset on the first turn (append-only transcript).
  //    Off-record episodes omit memory writes while allowing recall.
  let systemPrompt = conv.systemPrompt;
  let toolset = conv.toolset;
  if (systemPrompt === null || toolset === null) {
    const specs = caps.tools ? tools.specs().filter((s) =>
      !(s.name === 'web_search' && plan.searchMode !== 'engine') && !((conv.offRecord ?? conv.incognito) && MEMORY_WRITE_TOOLS.has(s.name))) : [];
    systemPrompt ??= buildSystemPrompt({ tools: specs, nativeTools: caps.tools });
    toolset ??= specs.map((s) => s.name);
    conversations.update(conversationId, { systemPrompt, toolset });
  }

  // Queue migrations during recall until the runner can apply them.
  const pendingOffRecordEpisodes: Conversation[] = [];
  record.enterOffRecord = (episode) => {
    if (conv.ephemeral || pendingOffRecordEpisodes.length) return;
    pendingOffRecordEpisodes.push(episode);
    // The runtime moves the busy reservation as soon as this callback returns.
    record.conversationId = episode.id;
  };

  // 2. Recall.
  const allowSensitive = adapter.isLocal || settings.memory.sendSensitiveToCloud;
  let prepared: { context: ContentPart; recalled: RecalledMemory[] };
  if (plan.context && plan.recalled) {
    prepared = { context: plan.context, recalled: plan.recalled };
  } else {
    try {
      prepared = await prepareTurnContext(services, conv, settings, plan.parts, history, allowSensitive, undefined, record.controller.signal);
    } catch (err) {
      if (!(err instanceof NeoError && err.code === 'cancelled' && record.controller.signal.aborted)) throw err;
      // Recall was interrupted by cancellation before the TurnRunner existed.
      // Build a minimal context so the TurnRunner can run its cancelled-signal
      // fast-path and emit the terminal event cleanly.
      prepared = {
        recalled: [],
        context: {
          type: 'context',
          text: buildContextBlock({
            now: clock(),
            timezone: settings.timezone,
            locale: settings.locale,
            memories: [],
            offRecord: conv.offRecord ?? conv.incognito,
          }),
        },
      };
    }
  }
  const { context, recalled } = prepared;

  // 3. Persist the user message (with its context part) and the streaming assistant message.
  const now = clock();
  const lastCreatedAt = history.reduce((max, m) => Math.max(max, m.createdAt), Number.NEGATIVE_INFINITY);
  const createdAt = Math.max(now, lastCreatedAt + 1); // keeps the transcript ordered even if the clock steps back
  const modelRef: ModelRef = { provider: adapter.id, model };
  const userMessage = conversations.appendMessage({
    id: newId('msg', now),
    conversationId,
    episodeId: conversationId,
    role: 'user',
    parts: [context, ...(plan.recentContext ? [plan.recentContext] : []), ...plan.parts],
    createdAt,
    turnId,
    status: 'complete',
  });
  const assistantMessage: Message = {
    id: newId('msg', now),
    conversationId,
    episodeId: conversationId,
    role: 'assistant',
    parts: [],
    createdAt: createdAt + 1,
    turnId,
    model: modelRef,
    status: 'streaming',
  };
  try {
    conversations.appendMessage(assistantMessage);
  } catch (err) {
    try {
      conversations.deleteMessage(userMessage.id);
    } catch {
      // best effort: the store is failing anyway
    }
    throw err;
  }

  const runner = new TurnRunner(services, {
    plan,
    caps,
    systemPrompt,
    toolset,
    allowSensitive,
    userMessage,
    assistantMessage,
    logger: logger.child({ conversationId, turnId }),
  });

  record.enterOffRecord = (episode) => runner.enterOffRecord(episode);
  for (const episode of pendingOffRecordEpisodes) runner.enterOffRecord(episode);
  runner.emit({ type: 'turn.started', conversationId, turnId, userMessage, assistantMessageId: assistantMessage.id, model: modelRef });
  if (recalled.length) {
    runner.emit({
      type: 'memory.recalled',
      conversationId,
      turnId,
      items: recalled.map((r) => ({ id: r.node.id, kind: r.node.kind, label: r.node.label, score: r.score, reason: r.reason })),
    });
  }
  void runner.run();

  return {
    turnId,
    conversationId,
    episodeId: conversationId,
    userMessage,
    assistantMessageId: assistantMessage.id,
    events: runner.queue,
    done: runner.done,
  };
}

export async function prepareTurnContext(
  services: TurnServices,
  conversation: Conversation,
  settings: NeoSettings,
  parts: readonly ContentPart[],
  history: readonly Message[],
  allowSensitive: boolean,
  reinforce?: boolean,
  signal?: AbortSignal,
): Promise<{ context: ContentPart; recalled: RecalledMemory[] }> {
  const recalled = await recallMemories(services, conversation, settings, parts, history, allowSensitive, reinforce, signal);
  const sensitive = recalled.some(({ node }) => node.sensitivity === 'sensitive');
  return {
    recalled,
    context: {
      type: 'context',
      text: buildContextBlock({ now: services.clock(), timezone: settings.timezone, locale: settings.locale, memories: recalled, offRecord: conversation.offRecord ?? conversation.incognito }),
      ...(sensitive ? { sensitive: true } : {}),
    },
  };
}

function containsSensitive(message: Message): boolean {
  return message.sensitive === true || message.parts.some((p) => (p.type === 'context' || p.type === 'tool_result') && p.sensitive === true);
}

/** Text the user contributed in this turn (text parts + ui_event descriptions). */
function inputText(parts: readonly ContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'ui_event' ? describeUiEvent(p).replace(/<\/?ui_event>/g, '') : ''))
    .filter((t) => t.trim())
    .join('\n');
}

async function recallMemories(
  services: TurnServices,
  conv: Conversation,
  settings: NeoSettings,
  parts: readonly ContentPart[],
  history: readonly Message[],
  allowSensitive: boolean,
  reinforce?: boolean,
  signal?: AbortSignal,
): Promise<RecalledMemory[]> {
  const policy = settings.memory;
  if (!policy.recall) return [];
  // What the user said drives recall. The tail of the previous reply is only context: it nudges
  // the semantic query ("what else?" stays on topic) but never seeds keyword or entity matches,
  // so NEO's own wording can't pull memories in.
  const text = inputText(parts).trim();
  const previousMessage = [...history].reverse().find((m) => m.role === 'assistant');
  const previousReply = previousMessage && !(containsSensitive(previousMessage) && !allowSensitive) ? textOf(previousMessage.parts).trim() : '';
  const context = previousReply.slice(-RECALL_PREVIOUS_REPLY_CHARS).trim();
  try {
    const pending = services.memory.recall({
      text,
      ...(context ? { context } : {}),
      conversationId: conv.id,
      limit: policy.recallLimit,
      tokenBudget: policy.recallTokenBudget,
      allowSensitive,
      ...((conv.offRecord ?? conv.incognito) || reinforce === false ? { reinforce: false } : {}),
      now: services.clock(),
      signal,
    });
    const result = await (signal ? raceAbort(pending, signal) : pending);
    return result.items;
  } catch (err) {
    if (err instanceof NeoError && err.code === 'cancelled') throw err;
    services.logger.warn('memory recall failed; continuing without memories', { conversationId: conv.id, error: String(err) });
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────

interface RunnerInit {
  plan: TurnPlan;
  caps: ModelCapabilities;
  systemPrompt: string;
  toolset: readonly string[];
  allowSensitive: boolean;
  userMessage: Message;
  assistantMessage: Message;
  logger: Logger;
}

class TurnRunner {
  readonly queue = new EventQueue<AgentEvent>();
  readonly done: Promise<Message>;
  private resolveDone!: (message: Message) => void;

  private readonly services: TurnServices;
  private readonly init: RunnerInit;
  private readonly logger: Logger;
  private readonly signal: AbortSignal;
  private conversationId: string;
  private readonly turnId: string;
  private messageId: string;
  private readonly toolset: ReadonlySet<string>;
  /** Specs of the frozen toolset, computed once so every request carries identical bytes. */
  private readonly toolSpecs: ToolSpec[];
  private previousHistory: Message[] = [];
  private privateTurn = false;
  private readonly memoryExecutions = new Set<AbortController>();

  /** The assistant message's parts. Part objects are replaced, never mutated. */
  private parts: ContentPart[] = [];
  private usage: Usage | null = null;
  private stopReason: StopReason = 'end';
  /** Set once a request to the model included sensitive content. */
  private sawSensitive = false;
  /** A grounded answer is external context, never evidence of what the user authored. */
  private sawWebContent = false;
  private readonly sourceUrls = new Set<string>();
  private dirty = false;
  private lastPersistAt: number;
  /** Reasoning placeholders of the current step that await their reasoning_part. */
  private openReasoning: number[] = [];
  /** Text parts written in the current step (inline UI extraction). */
  private stepText = new Set<number>();

  constructor(services: TurnServices, init: RunnerInit) {
    this.services = services;
    this.init = init;
    this.logger = init.logger;
    this.signal = init.plan.record.controller.signal;
    // A queued migration may have moved the reservation ahead of the stored messages.
    this.conversationId = init.assistantMessage.conversationId;
    this.turnId = init.plan.record.turnId;
    this.messageId = init.assistantMessage.id;
    this.privateTurn = (init.plan.conversation.offRecord ?? init.plan.conversation.incognito) || services.conversations.offRecordState().active;
    this.toolset = new Set(init.toolset);
    this.toolSpecs = init.caps.tools ? this.buildToolSpecs() : [];
    this.lastPersistAt = services.clock();
    this.done = new Promise<Message>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  enterOffRecord(episode: Conversation): void {
    if (this.conversationId === episode.id || this.init.plan.conversation.ephemeral) return;
    this.privateTurn = true;
    for (const controller of this.memoryExecutions) controller.abort();
    const store = this.services.conversations;
    this.previousHistory = store.messages(this.conversationId).filter((message) => message.id !== this.messageId);
    const answered = new Set(this.parts.flatMap((part) => part.type === 'tool_result' ? [part.toolCallId] : []));
    const zh = this.init.plan.settings.locale.startsWith('zh');
    const closedCalls = this.parts.flatMap((part): ContentPart[] => {
      if (part.type !== 'tool_call' || answered.has(part.id)) return [];
      return [{
        type: 'tool_result', toolCallId: part.id, name: part.name,
        output: { error: zh ? '此操作已转入不留记录模式继续。' : 'This action continued off the record.' },
        isError: true, summary: zh ? '转入不留记录模式' : 'Continued off record',
      }];
    });
    const publicParts: ContentPart[] = [...this.parts, ...closedCalls];
    const publicSensitive = this.sawSensitive || publicParts.some((p) => p.type === 'tool_result' && p.sensitive === true);
    const previous = store.updateMessage(this.messageId, {
      parts: publicParts,
      status: 'complete',
      usage: this.usage,
      ...(publicSensitive ? { sensitive: true } : {}),
    });
    this.emit({ type: 'message.completed', conversationId: this.conversationId, turnId: this.turnId, message: previous });
    const now = this.services.clock();
    const continuation = store.appendMessage({ ...this.snapshot('streaming', null), id: newId('msg', now), conversationId: episode.id, episodeId: episode.id, createdAt: now });
    this.messageId = continuation.id;
    this.conversationId = episode.id;
    this.init.plan.record.conversationId = episode.id;
    this.init.plan.conversation = episode;
    this.init.assistantMessage = continuation;
    this.emit({ type: 'message.completed', conversationId: this.conversationId, turnId: this.turnId, message: continuation });
  }

  private offRecord(): boolean {
    return this.privateTurn ||= this.services.conversations.offRecordState().active;
  }

  emit(input: EventInput): void {
    const event = { ...input, episodeId: this.conversationId } as AgentEvent;
    this.queue.push(event);
    this.services.broadcast(event);
  }

  /** Runs the turn to its end. Never rejects. */
  async run(): Promise<void> {
    let status: MessageStatus = 'complete';
    let failure: NeoError | null = null;
    try {
      await this.loop();
      if (this.signal.aborted) status = 'cancelled';
    } catch (err) {
      if (this.signal.aborted) {
        status = 'cancelled';
      } else {
        status = 'error';
        failure = NeoError.from(err);
        this.logger.warn('turn failed', { code: failure.code, error: failure.message });
      }
    }
    let final: Message;
    try {
      final = this.finish(status, failure);
    } catch (err) {
      // finish() guards every step; this is a last line of defence for `done`.
      this.logger.error('turn finalization failed', { error: String(err) });
      this.init.plan.release();
      this.queue.close();
      final = this.snapshot(status, failure);
    }
    this.resolveDone(final);
    if (status === 'complete') this.afterTurn(final);
  }

  // ───────────────────────────── step loop ─────────────────────────────

  private async loop(): Promise<void> {
    const { maxSteps } = this.init.plan.settings.agent;
    for (let step = 1; step <= maxSteps; step++) {
      if (this.signal.aborted) return;
      const finalStep = step === maxSteps;
      const calls: ToolCallPart[] = [];
      this.openReasoning = [];
      this.stepText = new Set();

      const stream = this.init.plan.adapter.chat(this.buildRequest(finalStep));
      for await (const event of abortable(stream, this.signal)) this.onStreamEvent(event, calls);
      this.endStep();

      if (calls.length === 0) return;
      for (const call of calls) {
        if (this.signal.aborted) return;
        await this.runToolCall(call, finalStep);
      }
      this.persist(true);
    }
  }

  private buildToolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const name of this.init.toolset) {
      const def = this.services.tools.get(name) ?? (name === 'web_search' ? this.services.searchTool() : undefined);
      if (!def || def.uiOnly) continue;
      try {
        specs.push(toolSpec(def));
      } catch (err) {
        this.logger.warn('tool spec could not be built; the tool is not offered', { tool: name, error: String(err) });
      }
    }
    return specs;
  }

  private buildRequest(finalStep: boolean): ChatRequest {
    const { plan, caps, systemPrompt } = this.init;
    const agent = plan.settings.agent;
    const stored = [...this.previousHistory, ...this.services.conversations.messages(this.conversationId)];
    const current: Message = {
      ...this.init.assistantMessage,
      parts: [...this.parts],
      ...(this.sawSensitive || this.parts.some((p) => p.type === 'tool_result' && p.sensitive) ? { sensitive: true } : {}),
    };
    const history = stored.some((m) => m.id === this.messageId)
      ? stored.map((m) => (m.id === this.messageId ? current : m))
      : [...stored, current];
    const omitSensitiveContext = !plan.adapter.isLocal && !this.services.settings.get().memory.sendSensitiveToCloud;
    const trimmed = plan.timeline ? history : trimHistory(history, agent.contextTokenBudget);
    // What this model reads shapes its answer: if it was shown anything sensitive, the answer is sensitive too.
    if (!omitSensitiveContext && trimmed.some(containsSensitive)) this.sawSensitive = true;
    const messages = toChatMessages(trimmed, { dropReasoning: !caps.reasoning, omitSensitiveContext });
    const maxTokens = caps.maxOutputTokens > 0 ? Math.min(agent.maxOutputTokens, caps.maxOutputTokens) : agent.maxOutputTokens;
    const request: ChatRequest = {
      model: plan.model,
      system: systemPrompt,
      messages,
      maxTokens,
      reasoning: caps.reasoning ? agent.reasoning : 'off',
      signal: this.signal,
    };
    // Tools stay declared on the final step (the transcript references them); only the choice changes.
    const toolSpecs = this.offRecord() ? this.toolSpecs.filter((spec) => !MEMORY_WRITE_TOOLS.has(spec.name)) : this.toolSpecs;
    if (toolSpecs.length) {
      request.tools = toolSpecs;
      request.toolChoice = finalStep ? 'none' : 'auto';
    }
    if (agent.temperature !== null) request.temperature = agent.temperature;
    if (this.services.searchMode(this.services.settings.get(), plan.adapter, plan.model) === 'native') {
      request.webSearch = {};
      this.sawWebContent = true;
    }
    return request;
  }

  // ───────────────────────────── streaming ─────────────────────────────

  private onStreamEvent(event: ChatStreamEvent, calls: ToolCallPart[]): void {
    switch (event.type) {
      case 'text':
        this.onText(event.text);
        break;
      case 'reasoning':
        this.onReasoning(event.text);
        break;
      case 'reasoning_part':
        this.onReasoningPart(event.part);
        break;
      case 'provider_part':
        this.addPart(event.part);
        break;
      case 'sources':
        this.addSources(event.items);
        break;
      case 'tool_call': {
        const part: ToolCallPart = {
          type: 'tool_call',
          id: this.uniqueCallId(event.id),
          name: event.name,
          input: event.input,
          provider: this.init.plan.adapter.kind,
          ...(event.data !== undefined ? { data: event.data } : {}),
        };
        calls.push(part);
        this.addPart(part);
        break;
      }
      case 'usage':
        this.usage = addUsage(this.usage, event.usage);
        break;
      case 'done':
        this.stopReason = event.stopReason;
        break;
    }
  }

  /** Text deltas extend the last part when it is text (exactly what clients do), else start a text part. */
  private onText(text: string): void {
    if (!text) return;
    const lastIndex = this.parts.length - 1;
    const last = this.parts[lastIndex];
    if (last?.type === 'text') {
      this.parts[lastIndex] = { type: 'text', text: last.text + text };
      this.stepText.add(lastIndex);
    } else {
      this.parts.push({ type: 'text', text });
      this.stepText.add(this.parts.length - 1);
    }
    this.emit({ type: 'text.delta', conversationId: this.conversationId, turnId: this.turnId, messageId: this.messageId, text });
    this.dirty = true;
    this.persist();
  }

  /**
   * Reasoning deltas extend an open placeholder when it is the last part, else open
   * a new one (announced with part.added so client indices stay aligned).
   */
  private onReasoning(text: string): void {
    if (!text) return;
    const lastIndex = this.parts.length - 1;
    const last = this.parts[lastIndex];
    if (last?.type === 'reasoning' && this.openReasoning.includes(lastIndex)) {
      this.parts[lastIndex] = { ...last, text: last.text + text };
      this.dirty = true;
    } else {
      const placeholder: ReasoningPart = { type: 'reasoning', text: '', provider: this.init.plan.adapter.kind, model: this.init.plan.model };
      const index = this.addPart(placeholder);
      this.openReasoning.push(index);
      this.parts[index] = { ...placeholder, text };
      this.dirty = true;
    }
    this.emit({ type: 'reasoning.delta', conversationId: this.conversationId, turnId: this.turnId, messageId: this.messageId, text });
    this.persist();
  }

  /** A finished reasoning block completes the latest open placeholder of this step, or is appended. */
  private onReasoningPart(part: ReasoningPart): void {
    const tag = { provider: this.init.plan.adapter.kind, model: this.init.plan.model };
    const index = this.openReasoning.pop();
    if (index === undefined) {
      this.addPart({ ...part, type: 'reasoning', ...tag });
      return;
    }
    const placeholder = this.parts[index] as ReasoningPart;
    this.replacePart(index, { ...part, type: 'reasoning', text: part.text || placeholder.text, ...tag });
  }

  private endStep(): void {
    // Placeholders that never got a reasoning_part are final now; tell clients their text.
    for (const index of this.openReasoning) this.replacePart(index, this.parts[index]!);
    this.openReasoning = [];
    // Without native tools in the request (tool-less model, or a conversation whose frozen prompt
    // taught ```neo-ui fences), inline UI blocks become ui parts.
    if (!this.toolSpecs.length) {
      // Gather per-part results first so one cross-part aggregate check can run
      // before any part is written — a model streaming multiple text parts in a
      // single step must not collectively exceed MAX_UI_BLOCKS.
      const pending: Array<{ index: number; extracted: ReturnType<typeof extractInlineUI> }> = [];
      for (const index of [...this.stepText].sort((a, b) => a - b)) {
        const part = this.parts[index];
        if (part?.type !== 'text') continue;
        const extracted = extractInlineUI(part.text);
        if (!extracted.blocks.length) continue;
        pending.push({ index, extracted });
      }
      if (pending.length) {
        // Cross-part aggregate: total block count, top-level block count, and duplicate action ids.
        let totalCount = 0;
        const countBlock = (b: UIBlock) => { totalCount++; for (const c of childBlocks(b)) countBlock(c); };
        for (const { extracted } of pending) for (const b of extracted.blocks) countBlock(b);
        const totalTopLevel = pending.reduce((sum, { extracted }) => sum + extracted.blocks.length, 0);
        const allIds = pending.flatMap(({ extracted }) => collectActions(extracted.blocks).map((a) => a.id));
        const crossPartDup = allIds.find((id, i) => allIds.indexOf(id) !== i);
        if (totalCount <= MAX_UI_BLOCKS && totalTopLevel <= MAX_UI_TOP_LEVEL && !crossPartDup) {
          for (const { index, extracted } of pending) {
            this.replacePart(index, { type: 'text', text: extracted.text });
            for (const block of extracted.blocks) this.addPart({ type: 'ui', id: newId('ui'), block });
          }
        }
        // Blocks exceeding the aggregate limit, the top-level limit, or with cross-part duplicate ids are silently dropped.
      }
    }
    this.persist(true);
  }

  private uniqueCallId(id: string): string {
    const taken = (candidate: string) =>
      this.parts.some((p) => p.type === 'tool_call' && p.id === candidate) || this.services.confirmations.hasToolCall(candidate);
    return id && !taken(id) ? id : newId('tc');
  }

  // ───────────────────────────── tools ─────────────────────────────

  private async runToolCall(call: ToolCallPart, finalStep: boolean): Promise<void> {
    const { tools } = this.services;
    const def = tools.get(call.name);
    if (finalStep) return this.refuse(call, MSG.finalStep, 'Not run');
    if (call.name === 'web_search' && this.services.searchMode(this.services.settings.get(), this.init.plan.adapter, this.init.plan.model) !== 'engine') {
      return this.refuse(call, 'Web search is unavailable with the current search settings.', 'Not available');
    }
    if (!def) return this.refuse(call, MSG.unknown(call.name), 'Unknown tool');
    if (this.offRecord() && MEMORY_WRITE_TOOLS.has(call.name)) return this.refuse(call, 'Memory writes are unavailable off the record.', 'Not available');
    if (!this.toolset.has(call.name) || def.uiOnly || !this.init.caps.tools) return this.refuse(call, MSG.unavailable(call.name), 'Not available');

    const permission = tools.permissionFor(call.name);
    if (permission === 'deny') return this.refuse(call, MSG.denied(call.name), 'Not allowed');
    if (permission === 'confirm') {
      const outcome = await this.askConfirmation(call, def);
      if (!outcome.approve) {
        if (outcome.reason === 'cancelled' && this.signal.aborted) return; // closed when the turn finishes
        if (outcome.reason === 'timeout') return this.refuse(call, MSG.timedOut, 'Timed out');
        if (outcome.reason === 'cancelled') return this.refuse(call, MSG.confirmationCancelled, 'Cancelled');
        return this.refuse(call, MSG.declined, 'Declined');
      }
      // Approval cannot revive a tool revoked while its confirmation was pending;
      // in particular, an "always" answer must never overwrite a new denial.
      if (tools.permissionFor(call.name) === 'deny') return this.refuse(call, MSG.declined, 'Declined');
      if (this.offRecord() && MEMORY_WRITE_TOOLS.has(call.name)) return this.refuse(call, 'Memory writes are unavailable off the record.', 'Not available');
      if (outcome.always) this.allowAlways(call.name);
      if (this.signal.aborted) return;
    }

    if (tools.permissionFor(call.name) === 'deny') return this.refuse(call, MSG.declined, 'Declined');
    if (this.offRecord() && MEMORY_WRITE_TOOLS.has(call.name)) return this.refuse(call, 'Memory writes are unavailable off the record.', 'Not available');

    // Registries may validate asynchronously before calling the implementation.
    // Keep revocation observable by that registry's post-validation signal check.
    const executionController = new AbortController();
    if (MEMORY_WRITE_TOOLS.has(call.name)) this.memoryExecutions.add(executionController);
    const executionSignal = AbortSignal.any([this.signal, executionController.signal]);
    const revokeIfDenied = (settings: NeoSettings): void => {
      if (settings.tools.permissions[call.name] === 'deny' || tools.permissionFor(call.name) === 'deny' ||
        (call.name === 'web_search' && this.services.searchMode(settings, this.init.plan.adapter, this.init.plan.model) !== 'engine')) executionController.abort();
    };
    const unsubscribe = this.services.settings.onChange(revokeIfDenied);
    let result: ToolResult;
    try {
      // Read after registration so a denial cannot fall between the read and subscription.
      revokeIfDenied(this.services.settings.get());
      if (this.signal.aborted) return;
      if (executionController.signal.aborted) return this.refuse(call, MSG.declined, 'Declined');
      this.emit({
        type: 'tool.started',
        conversationId: this.conversationId,
        turnId: this.turnId,
        messageId: this.messageId,
        toolCallId: call.id,
        name: call.name,
        title: def.title,
        input: call.input,
      });
      // Global event subscribers can change settings synchronously on tool.started.
      // Check again at the execution boundary, without another await in between.
      revokeIfDenied(this.services.settings.get());
      if (executionController.signal.aborted) return this.refuse(call, MSG.declined, 'Declined');
      if (def.untrustedOutput) this.sawWebContent = true;
      result = await raceAbort(
        tools.execute({ id: call.id, name: call.name, input: call.input }, this.toolContext(call, executionSignal)),
        executionSignal,
      );
    } catch (err) {
      if (this.signal.aborted) return; // closed when the turn finishes
      if (executionController.signal.aborted) return this.refuse(call, MSG.declined, 'Declined');
      result = { isError: true, output: { error: NeoError.from(err, 'tool_error').message } };
    } finally {
      this.memoryExecutions.delete(executionController);
      unsubscribe();
    }
    if (this.signal.aborted) return;
    if (executionController.signal.aborted) return this.refuse(call, MSG.declined, 'Declined');
    this.addToolResult(call, result, def);
    if (call.name === 'forget' && !result.isError) {
      this.services.patchConversationWidgets(this.conversationId, result);
    }
  }

  private toolContext(call: ToolCallPart, signal = this.signal): ToolContext {
    const { settings } = this.init.plan;
    const runner = this;
    return {
      toolCallId: call.id,
      get conversationId() { return runner.conversationId; },
      get messageId() { return runner.messageId; },
      signal,
      now: this.services.clock,
      timezone: settings.timezone,
      locale: settings.locale,
      allowSensitive: this.init.allowSensitive,
      get offRecord() { return runner.offRecord(); },
      origin: 'model',
      logger: this.logger.child({ tool: call.name, toolCallId: call.id }),
    };
  }

  private async askConfirmation(call: ToolCallPart, def: ToolDefinition): Promise<ConfirmationOutcome> {
    const timeoutMs = this.init.plan.settings.agent.confirmationTimeoutSec * 1000;
    const requestedAt = this.services.clock();
    const confirmation: ToolConfirmation = {
      id: newId('cnf', requestedAt),
      conversationId: this.conversationId,
      episodeId: this.conversationId,
      turnId: this.turnId,
      messageId: this.messageId,
      toolCallId: call.id,
      name: call.name,
      title: def.title,
      input: call.input,
      description: this.describeCall(def, call.input),
      risk: def.risk,
      requestedAt,
      expiresAt: requestedAt + timeoutMs,
    };
    // Register before announcing, so a subscriber may confirm synchronously.
    const outcome = this.services.confirmations.waitForDecision(confirmation, timeoutMs, this.signal);
    this.emit({ type: 'tool.confirmation', conversationId: this.conversationId, turnId: this.turnId, confirmation });
    const decided = await outcome;
    this.emit({
      type: 'tool.confirmation_resolved',
      conversationId: this.conversationId,
      turnId: this.turnId,
      confirmationId: confirmation.id,
      toolCallId: call.id,
      approved: decided.approve,
      reason: decided.reason,
    });
    return decided;
  }

  /** describeCall() on validated input; the tool title when that is impossible or it throws. */
  private describeCall(def: ToolDefinition, input: unknown): string {
    if (!def.describeCall) return def.title;
    const parsed = def.inputSchema.safeParse(input);
    if (!parsed.success) return def.title;
    try {
      const text = def.describeCall(parsed.data);
      return typeof text === 'string' && text.trim() ? text.trim() : def.title;
    } catch (err) {
      this.logger.warn('describeCall failed; using the tool title', { tool: def.name, error: String(err) });
      return def.title;
    }
  }

  private allowAlways(name: string): void {
    try {
      this.services.settings.update({ tools: { permissions: { [name]: 'auto' } } });
    } catch (err) {
      this.logger.warn('could not persist the tool permission', { tool: name, error: String(err) });
    }
    try {
      // A settings listener may synchronously revoke the tool while the update
      // is being published. That newer denial outranks the earlier "always".
      const current = this.services.settings.get().tools.permissions[name];
      const permission = current === 'deny' || this.services.tools.permissionFor(name) === 'deny' ? 'deny' : (current ?? 'auto');
      this.services.tools.setPermission(name, permission);
    } catch (err) {
      this.logger.warn('could not update the tool permission', { tool: name, error: String(err) });
    }
  }

  private refuse(call: ToolCallPart, error: string, summary: string): void {
    this.addToolResult(call, { isError: true, output: { error }, summary });
  }

  /** ui parts (validated) + the tool_result part + tool.finished. */
  private addToolResult(call: ToolCallPart, result: ToolResult, def?: ToolDefinition): void {
    let output = jsonSafe(result.output);
    let isError = result.isError === true;
    if (output === NOT_SERIALIZABLE) {
      output = { error: MSG.notSerializable };
      isError = true;
    }
    if (def?.untrustedOutput) output = wrapOnce(call.name, output);

    if (result.ui?.length) {
      const valid = validateUIBlocks(result.ui);
      if (valid.ok) {
        for (const block of valid.blocks) this.addPart({ type: 'ui', id: newId('ui'), block, toolCallId: call.id } satisfies UIPart);
      } else {
        this.logger.warn('tool returned invalid ui blocks; they were dropped', { tool: call.name, error: valid.error });
      }
    }
    const summary = typeof result.summary === 'string' && result.summary.trim() ? result.summary.trim().slice(0, 300) : undefined;
    const part: ToolResultPart = {
      type: 'tool_result',
      toolCallId: call.id,
      name: call.name,
      output,
      ...(isError ? { isError: true } : {}),
      ...(summary ? { summary } : {}),
      ...(result.sensitive ? { sensitive: true } : {}),
    };
    this.addPart(part);
    if (result.sources?.length) this.addSources(result.sources);
    this.emit({
      type: 'tool.finished',
      conversationId: this.conversationId,
      turnId: this.turnId,
      messageId: this.messageId,
      toolCallId: call.id,
      name: call.name,
      isError,
      summary,
    });
  }

  // ───────────────────────────── parts & persistence ─────────────────────────────

  private addSources(items: readonly Source[]): void {
    const sources: Source[] = [];
    for (const item of items) {
      if (this.sourceUrls.size >= 100) break;
      const parsed = SourceSchema.safeParse(item);
      if (!parsed.success || this.sourceUrls.has(parsed.data.url)) continue;
      this.sourceUrls.add(parsed.data.url);
      sources.push(parsed.data);
    }
    if (!sources.length) return;
    this.sawWebContent = true;
    this.addPart({ type: 'sources', items: sources });
  }

  /** Append a finished (non-delta) part, announce it and persist. Returns its index. */
  private addPart(part: ContentPart): number {
    const index = this.parts.push(part) - 1;
    this.emit({ type: 'part.added', conversationId: this.conversationId, turnId: this.turnId, messageId: this.messageId, index, part });
    this.dirty = true;
    this.persist(true);
    return index;
  }

  private replacePart(index: number, part: ContentPart): void {
    this.parts[index] = part;
    this.emit({ type: 'part.added', conversationId: this.conversationId, turnId: this.turnId, messageId: this.messageId, index, part });
    this.dirty = true;
    this.persist(true);
  }

  /** Write the streaming message. Throttled unless forced; a failing store fails the turn. */
  private persist(force = false): void {
    if (!this.dirty) return;
    const now = this.services.clock();
    if (!force && now - this.lastPersistAt < PERSIST_INTERVAL_MS) return;
    this.services.conversations.updateMessage(this.messageId, { parts: [...this.parts], usage: this.usage });
    this.dirty = false;
    this.lastPersistAt = now;
  }

  // ───────────────────────────── end of turn ─────────────────────────────

  private snapshot(status: MessageStatus, failure: NeoError | null): Message {
    const message: Message = { ...this.init.assistantMessage, parts: [...this.parts], status, usage: this.usage };
    if (failure) message.error = failure.toJSON();
    return message;
  }

  /** Close unfinished calls, persist, release the conversation, emit the terminal events. Never throws. */
  private finish(status: MessageStatus, failure: NeoError | null): Message {
    const { conversations, clock } = this.services;

    // Every tool call gets a result, also in the stored message.
    const answered = new Set(this.parts.flatMap((p) => (p.type === 'tool_result' ? [p.toolCallId] : [])));
    for (const part of [...this.parts]) {
      if (part.type !== 'tool_call' || answered.has(part.id)) continue;
      const closing: ToolResultPart = {
        type: 'tool_result',
        toolCallId: part.id,
        name: part.name,
        output: { error: status === 'cancelled' ? MSG.cancelled : MSG.failed },
        isError: true,
        summary: status === 'cancelled' ? 'Cancelled' : 'Not run',
      };
      this.parts.push(closing);
      this.emit({ type: 'part.added', conversationId: this.conversationId, turnId: this.turnId, messageId: this.messageId, index: this.parts.length - 1, part: closing });
    }

    let final = this.snapshot(status, failure);
    // An answer written after seeing sensitive memories (or carrying a sensitive tool result) is itself
    // sensitive: replay to a cloud model without sharing withholds it (toChatMessages omitSensitiveContext).
    const msgSensitive = this.sawSensitive || this.parts.some((p) => p.type === 'tool_result' && p.sensitive === true);
    if (msgSensitive) final.sensitive = true;

    try {
      final = conversations.updateMessage(this.messageId, {
        parts: final.parts,
        status,
        usage: this.usage,
        ...(msgSensitive ? { sensitive: true } : {}),
        ...(failure ? { error: failure.toJSON() } : {}),
      });
    } catch (err) {
      // Also happens when the conversation was deleted while the turn ran.
      this.logger.warn('could not persist the final assistant message', { error: String(err) });
    }

    const preview = previewOf(this.parts);
    try {
      const conversation = conversations.update(this.conversationId, {
        ...(preview ? { preview } : {}),
        lastMessageAt: clock(),
      });
      this.emit({ type: 'conversation.updated', conversation: episodeOf(conversation) });
    } catch (err) {
      this.logger.warn('could not update the conversation preview', { error: String(err) });
    }

    // Free the conversation before the terminal event, so its listeners may send again.
    this.init.plan.release();
    this.emit({ type: 'message.completed', conversationId: this.conversationId, turnId: this.turnId, message: final });
    if (status === 'error') {
      const error: ErrorShape = failure ? failure.toJSON() : { code: 'internal', message: 'The turn failed.' };
      this.emit({ type: 'turn.failed', conversationId: this.conversationId, turnId: this.turnId, error });
    } else {
      this.emit({
        type: 'turn.finished',
        conversationId: this.conversationId,
        turnId: this.turnId,
        stopReason: status === 'cancelled' ? 'cancelled' : this.stopReason,
        usage: this.usage,
      });
    }
    this.queue.close();
    return final;
  }

  /**
   * Post-turn work for completed turns, off the critical path; never throws.
   * Failed and cancelled turns are not observed: the exchange did not complete,
   * and a cancel often means "I did not mean to send that".
   */
  private afterTurn(final: Message): void {
    if (!this.offRecord()) void this.observe(final);
  }

  private async observe(final: Message): Promise<void> {
    const { adapter, model } = this.init.plan;
    try {
      const result = await this.services.memory.observe({
        conversationId: this.conversationId,
        userMessage: this.init.userMessage,
        assistantMessage: this.sawWebContent
          ? { ...final, parts: final.parts.filter((part) => part.type !== 'text' && part.type !== 'sources' && part.type !== 'provider_part') }
          : final,
        model: { provider: adapter.id, model },
        now: this.services.clock(),
      });
      const created = result.created.map(summarizeNode);
      const updated = result.updated.map(summarizeNode);
      if (created.length || updated.length) {
        this.services.broadcast({ type: 'memory.written', conversationId: this.conversationId, episodeId: this.conversationId, turnId: this.turnId, created, updated });
      }
    } catch (err) {
      this.logger.warn('memory observe failed', { error: String(err) });
    }
  }

}

// ───────────────────────────── helpers ─────────────────────────────

const NOT_SERIALIZABLE = Symbol('not serializable');

/** A JSON round-trip, so stored and replayed outputs are byte-stable. */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : (JSON.parse(json) as unknown);
  } catch {
    return NOT_SERIALIZABLE;
  }
}

/** wrapUntrusted, unless the registry already did it (its output contains no nested markers). */
function wrapOnce(source: string, output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const wrapped = wrapUntrusted(source, '');
  const [head, tail] = [wrapped.slice(0, wrapped.indexOf('\n') + 1), wrapped.slice(wrapped.lastIndexOf('\n'))];
  if (text.startsWith(head) && text.endsWith(tail)) {
    const inner = text.slice(head.length, text.length - tail.length);
    if (!/<\/?untrusted_content/i.test(inner)) return text;
  }
  return wrapUntrusted(source, text);
}
