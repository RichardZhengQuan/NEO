/**
 * AgentRuntime — the implementation of AgentRuntimeApi (@neo/protocol services.ts).
 *
 * Owns the bookkeeping shared by turns: which conversation is busy, pending tool
 * confirmations, and global subscribers. The turn itself lives in turn.ts.
 */
import {
  ContentPartSchema,
  episodeOf,
  estimateMessageTokens,
  NeoError,
  modelRefToString,
  newId,
  randomToken,
  resolveSearchMode,
  silentLogger,
  systemClock,
  wrapUntrusted,
  type AgentEvent,
  type AgentRuntimeApi,
  type Clock,
  type ConfirmationDecision,
  type ContentPart,
  type Conversation,
  type ConversationStore,
  type Logger,
  type MemoryService,
  type Message,
  type ModelRef,
  type NeoSettings,
  type OffRecordState,
  type ProviderAdapter,
  type ProviderRegistry,
  type ReminderStore,
  type SendInput,
  type SendTimelineInput,
  type SettingsStore,
  type ToolConfirmation,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
  type TurnHandle,
  type UIEventPart,
  type UIPart,
  type UiActionInput,
  type UiActionResult,
} from '@neo/protocol';

import { ConfirmationManager } from './confirmations.js';
import { raceAbort } from './abort.js';
import { prepareTurnContext, startTurn, type TurnPlan, type TurnRecord, type TurnServices } from './turn.js';
import { buildRecentContext } from './prompt.js';
import { describeUiToolCall, findUiPart, patchWidgetBlock, resolveStoredAction, uiActionBinding, uiActionIdentity } from './ui-actions.js';

export interface AgentRuntimeDeps {
  conversations: ConversationStore;
  reminders?: ReminderStore;
  settings: SettingsStore;
  providers: ProviderRegistry;
  memory: MemoryService;
  tools: ToolRegistry;
  /** The composition root resolves encrypted settings or the configured default search engine. */
  resolveSearchTool?(settings: NeoSettings): ToolDefinition | undefined;
  logger?: Logger;
  clock?: Clock;
}

/** Tool runs started from UI actions get this long before their signal aborts. */
const UI_TOOL_TIMEOUT_MS = 30_000;

const USER_PART_TYPES = new Set<ContentPart['type']>(['text', 'image', 'ui_event']);

interface UiApproval {
  identity: string;
  binding: string;
  tool: string;
  permissionVersion: number;
  expiresAt: number;
}

export class AgentRuntime implements AgentRuntimeApi {
  private readonly conversations: ConversationStore;
  private readonly reminders: ReminderStore | undefined;
  private readonly settingsStore: SettingsStore;
  private readonly providers: ProviderRegistry;
  private readonly memory: MemoryService;
  private readonly tools: ToolRegistry;
  private readonly resolveSearchTool: AgentRuntimeDeps['resolveSearchTool'];
  /** Old episodes retain this declaration even after the engine is removed. Execution still uses the registry. */
  private previousSearchTool: ToolDefinition | undefined;
  private readonly logger: Logger;
  private readonly clock: Clock;

  private readonly confirmations = new ConfirmationManager();
  /** UI approvals are separate from model-turn confirmations, and are consumed before any await. */
  private readonly uiConfirmations = new Map<string, UiApproval>();
  /** A denial permanently revokes older UI approvals, including ones currently validating. */
  private readonly uiPermissionVersions = new Map<string, number>();
  /** Running turns by turnId. */
  private readonly turns = new Map<string, TurnRecord>();
  private readonly turnDone = new Map<string, Promise<Message>>();
  private readonly uiTools = new Map<AbortController, { done: Promise<void>; enterOffRecord(): void; tool: string }>();
  private pendingTimeline: { done: Promise<void>; resolve(): void; cancelled: boolean; offRecord: boolean; controller: AbortController } | undefined;
  private mutatingTimeline = false;
  private privateEpoch = 0;
  /** conversationId → turnId of the turn holding it (reserved synchronously in send()). */
  private readonly busy = new Map<string, string>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly services: TurnServices;
  private readonly episodeSearchModes = new Map<string, 'native' | 'engine' | 'off'>();

  constructor(deps: AgentRuntimeDeps) {
    this.conversations = deps.conversations;
    this.reminders = deps.reminders;
    this.settingsStore = deps.settings;
    this.providers = deps.providers;
    this.memory = deps.memory;
    this.tools = deps.tools;
    this.resolveSearchTool = deps.resolveSearchTool;
    this.logger = deps.logger ?? silentLogger;
    this.clock = deps.clock ?? systemClock;
    this.configureSearchTool(this.settingsStore.get());
    this.services = {
      conversations: this.conversations,
      settings: this.settingsStore,
      providers: this.providers,
      memory: this.memory,
      tools: this.tools,
      searchMode: (settings, adapter, model) => this.searchMode(settings, adapter, model),
      searchTool: () => this.previousSearchTool,
      confirmations: this.confirmations,
      logger: this.logger,
      clock: this.clock,
      broadcast: (event) => this.broadcast(event),
      patchConversationWidgets: (conversationId, result) => {
        for (const message of this.conversations.messages(conversationId)) {
          this.patchWidgets(message, result);
        }
      },
    };
    this.settingsStore.onChange((settings) => {
      this.configureSearchTool(settings);
      // Apply overrides here too: the runtime must not depend on the server's listener ordering.
      for (const [name, permission] of Object.entries(settings.tools.permissions)) this.tools.setPermission(name, permission);
      for (const def of this.tools.list()) {
        if (this.tools.permissionFor(def.name) === 'deny') this.uiPermissionVersions.set(def.name, (this.uiPermissionVersions.get(def.name) ?? 0) + 1);
      }
      for (const confirmation of this.confirmations.list()) {
        if (this.tools.permissionFor(confirmation.name) === 'deny') this.confirmations.cancelTool(confirmation.name);
      }
    });
  }

  // ── send ───────────────────────────────────────────────────────────────────

  async send(input: SendInput): Promise<TurnHandle> {
    const conv = this.conversations.get(input.conversationId);
    if (!conv) throw new NeoError('not_found', `Conversation ${input.conversationId} not found.`);
    if (this.offRecordState().active) return this.sendTimeline({ parts: input.parts });
    if (this.busy.has(conv.id)) throw new NeoError('conflict', 'A turn is already running in this conversation.');
    const parts = validateUserParts(input.parts);
    const settings = this.settingsStore.get();
    const { adapter, model } = this.resolveModel(settings);
    this.configureSearchTool(settings);
    return this.beginTurn(conv, parts, adapter, model, settings);
  }

  /** Choose the storage episode while keeping the public relationship a single timeline. */
  async sendTimeline(input: SendTimelineInput): Promise<TurnHandle> {
    if (this.pendingTimeline || this.mutatingTimeline) throw new NeoError('conflict', 'The timeline is busy. Try again after the current operation finishes.');
    const parts = validateUserParts(input.parts);
    if (input.offRecord === true && !this.offRecordState().active) this.enterOffRecord();
    const settings = this.settingsStore.get();
    let resolve!: () => void;
    const pending = { done: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve(), cancelled: false, offRecord: this.offRecordState().active, controller: new AbortController() };
    this.pendingTimeline = pending;
    let created: Conversation | undefined;
    try {
      const offRecord = this.offRecordState().active;
      let current = this.conversations.currentEpisode();
      if (this.turns.size) throw new NeoError('conflict', 'A turn is already running in the timeline.');
      if (pending.cancelled) throw new NeoError('cancelled', 'The turn was cancelled.');
      const { adapter, model } = this.resolveModel(settings);
      this.configureSearchTool(settings);
      const searchMode = this.searchMode(settings, adapter, model);

      let history = current ? this.conversations.messages(current.id) : [];
      let previous = offRecord && current && !history.length
        ? this.conversations.list().filter((episode) => !episode.offRecord && !episode.incognito && episode.id !== current!.id).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))[0] ?? null
        : current ?? this.conversations.latestEpisode();
      const now = this.clock();
      const lastAt = current?.lastMessageAt ?? history.at(-1)?.createdAt;
      const gap = lastAt !== undefined && lastAt !== null && now - lastAt >= settings.timeline.episodeGapMinutes * 60_000;
      const previousSearchMode = current && (
        this.episodeSearchModes.get(current.id) ??
        current.searchMode ??
        (current.toolset?.includes('web_search') ? 'engine' : 'off')
      );
      const searchChanged = current?.toolset !== null && previousSearchMode !== searchMode;
      if (current && (gap || searchChanged || (current.offRecord ?? current.incognito) !== offRecord)) {
        this.conversations.closeEpisode(current.id);
        current = null;
      }
      if (!current) {
        created = this.conversations.createEpisode({ offRecord });
        current = created;
        if (offRecord) this.conversations.setOffRecordState({ ...this.offRecordState(), episodeId: current.id });
        history = [];
      }
      const allowSensitive = adapter.isLocal || settings.memory.sendSensitiveToCloud;
      const continuity = (episode: Conversation | null, tokenBudget: number): ContentPart | undefined => {
        if (!episode || episode.id === current!.id || episode.offRecord || episode.incognito) return undefined;
        const messages = this.conversations.messages(episode.id);
        const endedAt = episode.lastMessageAt ?? messages.at(-1)?.createdAt;
        if (endedAt === undefined || endedAt === null || now - endedAt >= 24 * 60 * 60_000) return undefined;
        return buildRecentContext(messages, allowSensitive, tokenBudget);
      };
      const recalledHistory = history.length ? history : previous && !(previous.offRecord ?? previous.incognito) ? this.conversations.messages(previous.id) : [];
      const preview = history.length > 0;
      let prepared = await prepareTurnContext(this.services, current, settings, parts, recalledHistory, allowSensitive, preview ? false : undefined, pending.controller.signal);
      if (pending.cancelled) throw new NeoError('cancelled', 'The turn was cancelled.');
      const incoming = (): Message => ({
        id: '', conversationId: current!.id, role: 'user', status: 'complete', createdAt: now,
        parts: [prepared.context, ...parts],
      });
      const exceedsBudget = () => history.length > 0 && history.reduce((total, message) => total + estimateMessageTokens(message), 0) + estimateMessageTokens(incoming()) > settings.agent.contextTokenBudget;
      const breakForBudget = async () => {
        previous = this.conversations.closeEpisode(current!.id);
        created = this.conversations.createEpisode({ offRecord });
        current = created;
        if (offRecord) this.conversations.setOffRecordState({ ...this.offRecordState(), episodeId: current.id });
        history = [];
        prepared = await prepareTurnContext(this.services, current, settings, parts, recalledHistory, allowSensitive, undefined, pending.controller.signal);
      };
      if (exceedsBudget()) {
        await breakForBudget();
      } else if (preview && !offRecord) {
        // The budget preview cannot strengthen memories. Recall once against the final
        // episode, so its own summary exclusion and reinforcement have the right source.
        prepared = await prepareTurnContext(this.services, current, settings, parts, recalledHistory, allowSensitive, undefined, pending.controller.signal);
        if (exceedsBudget()) await breakForBudget();
      }
      if (pending.cancelled) throw new NeoError('cancelled', 'The turn was cancelled.');
      // Include the origin normal episode from the first private turn onward to keep
      // the normal-conversation prefix intact. Apply the same 24-hour freshness guard
      // used by continuity().
      const originEpisode = offRecord
        ? this.conversations.list().filter((e) => {
            if (e.offRecord || e.incognito || e.id === current!.id) return false;
            const msgs = this.conversations.messages(e.id);
            const endedAt = e.lastMessageAt ?? msgs.at(-1)?.createdAt;
            return endedAt !== undefined && endedAt !== null && now - endedAt < 24 * 60 * 60_000;
          }).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))[0] ?? null
        : null;
      const originMessages = originEpisode ? this.conversations.messages(originEpisode.id) : undefined;
      const incomingTokens = estimateMessageTokens(incoming());
      // Guard: only use originMessages as previousHistory when they fit within the budget
      // together with history and incoming. exceedsBudget() short-circuits to false on the
      // first private turn (history.length === 0), so we must check independently here.
      const originFits = !originMessages?.length ||
        history.reduce((t, m) => t + estimateMessageTokens(m), 0) +
        originMessages.reduce((t, m) => t + estimateMessageTokens(m), 0) +
        incomingTokens <= settings.agent.contextTokenBudget;
      // Full previousHistory already supplies this content, so skip the redundant summary.
      const recentContext = (originMessages?.length && originFits)
        ? undefined
        : continuity(previous, settings.agent.contextTokenBudget - incomingTokens);
      if (created) this.broadcast({ type: 'episode.started', episodeId: current.id, episode: episodeOf(current) });
      return await this.beginTurn(current, parts, adapter, model, settings, {
        ...prepared,
        ...(recentContext ? { recentContext } : {}),
        ...((originMessages?.length && originFits) ? { previousHistory: originMessages } : {}),
        timeline: true,
      });
    } catch (err) {
      if (created && !this.conversations.messages(created.id).length && !offRecordEpisode(this.offRecordState(), created.id)) this.conversations.delete(created.id);
      throw err;
    } finally {
      if (this.pendingTimeline === pending) this.pendingTimeline = undefined;
      pending.resolve();
    }
  }

  private async beginTurn(
    conv: Conversation,
    parts: ContentPart[],
    adapter: ProviderAdapter,
    model: string,
    settings: NeoSettings,
    context: Partial<Pick<TurnPlan, 'context' | 'recalled' | 'recentContext' | 'timeline' | 'previousHistory'>> = {},
  ): Promise<TurnHandle> {
    if (this.busy.has(conv.id)) throw new NeoError('conflict', 'A turn is already running in this episode.');

    // Reserve the conversation before the first await, so concurrent sends conflict.
    const record: TurnRecord = { turnId: newId('turn'), conversationId: conv.id, startedAt: this.clock(), controller: new AbortController() };
    this.turns.set(record.turnId, record);
    this.busy.set(conv.id, record.turnId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.turns.delete(record.turnId);
      if (this.busy.get(record.conversationId) === record.turnId) this.busy.delete(record.conversationId);
    };
    try {
      const searchMode = this.searchMode(settings, adapter, model);
      this.episodeSearchModes.set(conv.id, searchMode);
      if (conv.searchMode !== searchMode) this.conversations.update(conv.id, { searchMode });
      // Register the pending-initialization promise in turnDone BEFORE awaiting
      // recall. Otherwise a startOffRecord/endOffRecord pair that races recall
      // leaves turnDone empty when endOffRecord's waitForTurns() runs, which
      // can delete the ephemeral episode out from under a queued migration
      // (see PR #584, Codex Finding 1).
      const pendingInit = startTurn(this.services, { record, conversation: conv, parts, adapter, model, settings, searchMode, release, ...context });
      const pendingDone: Promise<Message> = pendingInit.then((h) => h.done).catch(() => undefined as unknown as Message);
      this.turnDone.set(record.turnId, pendingDone);
      void pendingDone.finally(() => this.turnDone.delete(record.turnId));
      return await pendingInit;
    } catch (err) {
      release();
      throw err;
    }
  }

  private configureSearchTool(settings: NeoSettings): void {
    if (!this.resolveSearchTool) return;
    const tool = this.resolveSearchTool(settings);
    if (tool) this.previousSearchTool = tool;
    let nativeWebSearch = false;
    try {
      const { adapter, model } = this.resolveModel(settings);
      nativeWebSearch = adapter.capabilities(model).nativeWebSearch === true;
    } catch {
      // Search engine settings remain usable before the user connects their AI.
    }
    if (tool && resolveSearchMode(settings.ai.search, nativeWebSearch, true) === 'engine') this.tools.register(tool);
    else this.tools.unregister('web_search');
  }

  private searchMode(settings: NeoSettings, adapter: ProviderAdapter, model: string): 'native' | 'engine' | 'off' {
    const engine = this.resolveSearchTool ? this.resolveSearchTool(settings) : this.tools.get('web_search');
    return resolveSearchMode(settings.ai.search, adapter.capabilities(model).nativeWebSearch === true, !!engine);
  }

  /** Every turn follows the global Text capability, with a provider default for legacy settings. */
  private resolveModel(settings: NeoSettings): { adapter: ProviderAdapter; model: string } {
    if (!this.providers.list().some((adapter) => adapter.config.enabled)) {
      throw new NeoError('no_provider', 'Connect an AI to start chatting. Open Settings → AI to add a provider.');
    }
    const ref = settings.ai.capabilities.text ?? this.firstAvailableModel();
    try {
      return this.providers.resolve(ref);
    } catch (err) {
      const error = NeoError.from(err);
      if (error.code !== 'not_found') throw error;
      throw new NeoError('config_error', `The model "${modelRefToString(ref)}" is not available: ${error.message} Choose another model in Settings.`, {
        cause: err,
      });
    }
  }

  private firstAvailableModel(): ModelRef {
    for (const adapter of this.providers.list()) {
      if (adapter.config.enabled && adapter.config.defaultModel?.trim()) return { provider: adapter.id, model: adapter.config.defaultModel };
    }
    throw new NeoError('no_provider', 'Connect an AI to start chatting. Open Settings → AI to add a provider.');
  }

  // ── cancel ─────────────────────────────────────────────────────────────────

  cancel(turnId: string): boolean {
    const record = this.turns.get(turnId);
    if (!record) return false;
    record.controller.abort();
    this.confirmations.cancelTurn(turnId);
    return true;
  }

  cancelConversation(conversationId: string): boolean {
    const turnId = this.busy.get(conversationId);
    return turnId ? this.cancel(turnId) : false;
  }

  cancelTimeline(turnId?: string): boolean {
    if (turnId) return this.cancel(turnId);
    let cancelled = false;
    if (this.pendingTimeline) {
      this.pendingTimeline.cancelled = true;
      this.pendingTimeline.controller.abort();
      cancelled = true;
    }
    for (const id of this.turns.keys()) cancelled = this.cancel(id) || cancelled;
    return cancelled;
  }

  async waitForIdle(episodeIds?: string[]): Promise<void> {
    if (this.pendingTimeline) await this.pendingTimeline.done;
    await this.waitForTurns(episodeIds);
  }

  private async waitForTurns(episodeIds?: string[]): Promise<void> {
    const ids = new Set(episodeIds);
    const done = [...this.turnDone].filter(([id]) => !episodeIds || ids.has(this.turns.get(id)?.conversationId ?? '')).map(([, promise]) => promise);
    await Promise.all(done);
  }

  /** Hold the send boundary while a user deletion selects and removes its messages. */
  async mutateTimeline<T>(mutation: () => Promise<T>): Promise<T> {
    return this.withTimelineMutation(mutation, true);
  }

  private async withTimelineMutation<T>(mutation: () => Promise<T>, cancelNormalPreflight: boolean): Promise<T> {
    if (this.mutatingTimeline) throw new NeoError('conflict', 'The timeline is being changed. Try again after the current operation finishes.');
    this.mutatingTimeline = true;
    try {
      if (this.pendingTimeline) {
        if (cancelNormalPreflight || this.pendingTimeline.offRecord) {
          this.pendingTimeline.cancelled = true;
          this.pendingTimeline.controller.abort();
        }
        await this.pendingTimeline.done;
      }
      return await mutation();
    } finally {
      this.mutatingTimeline = false;
    }
  }

  offRecordState(): OffRecordState {
    return this.conversations.offRecordState();
  }

  async startOffRecord(): Promise<OffRecordState> {
    if (this.offRecordState().active) return this.offRecordState();
    return this.withTimelineMutation(async () => this.enterOffRecord(), true);
  }

  private enterOffRecord(): OffRecordState {
    const existing = this.offRecordState();
    if (existing.active) return existing;
    const episode = this.conversations.createEpisode({ offRecord: true });
    const state = { active: true, episodeId: episode.id, startedAt: this.clock() };
    this.conversations.setOffRecordState(state);
    this.privateEpoch++;
    for (const [controller, run] of this.uiTools) {
      run.enterOffRecord();
      if (run.tool === 'remember' || run.tool === 'forget') controller.abort();
    }
    this.broadcast({ type: 'episode.started', episodeId: episode.id, episode: episodeOf(episode) });
    for (const turn of this.turns.values()) {
      const previous = turn.conversationId;
      turn.enterOffRecord?.(episode);
      if (this.busy.get(previous) === turn.turnId) this.busy.delete(previous);
      this.busy.set(turn.conversationId, turn.turnId);
    }
    this.broadcast({ type: 'timeline.off_record', active: true });
    return this.offRecordState();
  }

  private privateEpisode(): Conversation {
    const state = this.offRecordState();
    const current = state.episodeId ? this.conversations.get(state.episodeId) : null;
    if (current?.offRecord && current.closedAt === null) return current;
    const episode = this.conversations.createEpisode({ offRecord: true });
    this.conversations.setOffRecordState({ ...state, episodeId: episode.id });
    this.broadcast({ type: 'episode.started', episodeId: episode.id, episode: episodeOf(episode) });
    return episode;
  }

  async endOffRecord(): Promise<{ deleted: number }> {
    return this.withTimelineMutation(async () => {
      if (!this.offRecordState().active) return { deleted: 0 };
      const active = [...this.turns.values()].filter((turn) => this.conversations.get(turn.conversationId)?.ephemeral);
      for (const turn of active) this.cancel(turn.turnId);
      await this.waitForTurns(active.map((turn) => turn.conversationId));
      await this.settleUiTools();
      const deleted = this.deleteOffRecord(Number.MAX_SAFE_INTEGER);
      this.conversations.setOffRecordState({ active: false, episodeId: null, startedAt: null });
      this.broadcast({ type: 'timeline.off_record', active: false });
      return { deleted };
    }, false);
  }

  async purgeOffRecord(before: number): Promise<number> {
    if (this.pendingTimeline || this.mutatingTimeline) return 0;
    return this.mutateTimeline(async () => {
      const state = this.offRecordState();
      const expires = state.active && state.startedAt !== null && state.startedAt < before;
      const expired = [...this.turns.values()].filter((turn) => {
        const episode = this.conversations.get(turn.conversationId);
        return episode?.offRecord && episode.ephemeral && (expires || (episode.startedAt ?? episode.createdAt) < before);
      });
      for (const turn of expired) this.cancel(turn.turnId);
      await this.waitForTurns(expired.map((turn) => turn.conversationId));
      if (expires) await this.settleUiTools();
      const deleted = this.deleteOffRecord(expires ? Number.MAX_SAFE_INTEGER : before);
      if (expires) {
        this.conversations.setOffRecordState({ active: false, episodeId: null, startedAt: null });
        this.broadcast({ type: 'timeline.off_record', active: false });
      }
      return deleted;
    });
  }

  private deleteOffRecord(before: number): number {
    const episodes = this.conversations.offRecordEpisodes(before);
    const messageIds = episodes.flatMap((episode) => this.conversations.messages(episode.id).map((message) => message.id));
    const deleted = this.conversations.purgeOffRecord(before);
    if (messageIds.length) this.reminders?.clearMessageLinks(messageIds);
    for (const episode of episodes) this.broadcast({ type: 'conversation.deleted', conversationId: episode.id, episodeId: episode.id });
    return deleted;
  }

  // ── confirmations ──────────────────────────────────────────────────────────

  confirm(confirmationId: string, decision: ConfirmationDecision): boolean {
    return this.confirmations.resolve(confirmationId, decision);
  }

  pendingConfirmations(): ToolConfirmation[] {
    return this.confirmations.list();
  }

  // ── handleUiAction ─────────────────────────────────────────────────────────

  async handleTimelineUiAction(input: Omit<UiActionInput, 'conversationId'>): Promise<UiActionResult> {
    const message = this.conversations.getMessage(input.messageId);
    if (!message) throw new NeoError('not_found', `Message ${input.messageId} not found.`);
    return this.handleUiAction({ ...input, conversationId: message.conversationId }, true);
  }

  async handleUiAction(input: UiActionInput, timeline = false): Promise<UiActionResult> {
    const modeVersion = this.privateEpoch;
    const privateAction = this.offRecordState().active;
    const approval = input.confirmationToken === undefined ? undefined : this.consumeUiConfirmation(input.confirmationToken);
    if (approval && approval.identity !== uiActionIdentity(input)) throw new NeoError('conflict', 'The UI confirmation token does not match this action.');
    const { conversationId, messageId, uiId, actionId } = input;
    const message = this.conversations.getMessage(messageId);
    // A message of another conversation is reported like a missing one (no existence leaks).
    if (!message || message.conversationId !== conversationId) throw new NeoError('not_found', `Message ${messageId} not found.`);
    const found = findUiPart(message.parts, uiId);
    if (!found) throw new NeoError('not_found', `UI element ${uiId} not found in message ${messageId}.`);
    const resolved = resolveStoredAction(found.part.block, actionId, input.values);
    if (!resolved) throw new NeoError('not_found', `Action "${actionId}" is not declared by UI element ${uiId}.`);
    const { action, values } = resolved;

    if (approval && action.kind !== 'tool') throw new NeoError('conflict', 'The UI confirmation token does not match this action.');

    switch (action.kind) {
      case 'message':
        return { kind: 'turn', turn: await (timeline ? this.sendTimeline({ parts: [{ type: 'text', text: action.text }], offRecord: this.offRecordState().active }) : this.send({ conversationId, parts: [{ type: 'text', text: action.text }] })) };
      case 'event': {
        const event: UIEventPart = { type: 'ui_event', messageId, uiId, actionId, label: action.label };
        if (action.payload !== undefined) event.payload = action.payload;
        if (values && Object.keys(values).length) event.values = values;
        return { kind: 'turn', turn: await (timeline ? this.sendTimeline({ parts: [event], offRecord: this.offRecordState().active }) : this.send({ conversationId, parts: [event] })) };
      }
      case 'tool': {
        const source = this.conversations.get(conversationId);
        if (((source?.offRecord ?? source?.incognito) || this.offRecordState().active) && (action.tool === 'remember' || action.tool === 'forget')) throw new NeoError('forbidden', 'Memory writes are unavailable off the record.');
        const permission = this.tools.permissionFor(action.tool);
        if (permission === 'deny') throw new NeoError('tool_denied', `The tool "${action.tool}" is turned off.`);
        const def = this.tools.get(action.tool);
        if (approval || permission === 'confirm' || def?.risk === 'dangerous') {
          if (!def) throw new NeoError('bad_request', `Unknown tool "${action.tool}".`);
          const parsed = await def.inputSchema.safeParseAsync(action.input ?? {});
          if (!parsed.success) throw new NeoError('bad_request', `Invalid input for the tool "${action.tool}".`, { details: parsed.error.issues });
          const binding = uiActionBinding(input, action.tool, parsed.data);
          if (approval && approval.binding !== binding) throw new NeoError('conflict', 'The UI confirmation token does not match this action, input or form values.');
          // Validation may await a schema refinement; permission changes take effect before execution.
          if (this.tools.permissionFor(action.tool) === 'deny') throw new NeoError('tool_denied', `The tool "${action.tool}" is turned off.`);
          if (approval && approval.permissionVersion !== (this.uiPermissionVersions.get(action.tool) ?? 0)) {
            throw new NeoError('conflict', 'The UI confirmation token was revoked when the tool was turned off; request a new confirmation.');
          }
          if (!approval) {
            const expiresAt = this.clock() + this.settingsStore.get().agent.confirmationTimeoutSec * 1000;
            const token = randomToken();
            this.pruneUiConfirmations();
            this.uiConfirmations.set(token, { identity: uiActionIdentity(input), binding, tool: action.tool, permissionVersion: this.uiPermissionVersions.get(action.tool) ?? 0, expiresAt });
            return { kind: 'confirm', confirmation: {
              token, tool: def.name, title: def.title, description: describeUiToolCall(def, parsed.data), risk: def.risk, expiresAt,
            } };
          }
          if (approval.expiresAt <= this.clock()) throw new NeoError('conflict', 'The UI confirmation token has expired; request a new confirmation.');
          // Validation may have awaited a schema refinement; re-read the message so we use the
          // post-await state and detect a concurrent delete that completed while we were waiting.
          const freshMessage = this.conversations.getMessage(messageId);
          if (!freshMessage || freshMessage.conversationId !== conversationId) throw new NeoError('not_found', `Message ${messageId} not found.`);
          // Execute the exact data covered by the approval, without a second schema transform.
          const result = await this.runUiTool(freshMessage, action.tool, parsed.data, privateAction || this.privateEpoch !== modeVersion, def);
          return { kind: 'tool', result };
        }
        const result = await this.runUiTool(message, action.tool, action.input ?? {}, privateAction || this.privateEpoch !== modeVersion);
        return { kind: 'tool', result };
      }
      case 'link':
      case 'copy':
        return { kind: 'client', action };
    }
  }

  private consumeUiConfirmation(token: string): UiApproval {
    const approval = this.uiConfirmations.get(token);
    // An attempt consumes the token even if lookup, validation, permission or execution later fails.
    this.uiConfirmations.delete(token);
    if (!approval) throw new NeoError('conflict', 'The UI confirmation token is unknown, expired or already used; request a new confirmation.');
    if (approval.expiresAt <= this.clock()) throw new NeoError('conflict', 'The UI confirmation token has expired; request a new confirmation.');
    if (this.tools.permissionFor(approval.tool) !== 'deny' && approval.permissionVersion !== (this.uiPermissionVersions.get(approval.tool) ?? 0)) {
      throw new NeoError('conflict', 'The UI confirmation token was revoked when the tool was turned off; request a new confirmation.');
    }
    return approval;
  }

  private pruneUiConfirmations(): void {
    const now = this.clock();
    for (const [token, approval] of this.uiConfirmations) if (approval.expiresAt <= now) this.uiConfirmations.delete(token);
  }

  private async settleUiTools(): Promise<void> {
    const pending = [...this.uiTools];
    for (const [controller] of pending) controller.abort();
    await Promise.all(pending.map(([, run]) => run.done));
  }

  private async runUiTool(message: Message, tool: string, input: unknown, privateAction: boolean, validatedDef?: ToolDefinition): Promise<ToolResult> {
    if (this.mutatingTimeline) throw new NeoError('conflict', 'The timeline is being changed. Try again after the current operation finishes.');
    const source = this.conversations.get(message.conversationId);
    let privateRun = privateAction || (source?.offRecord ?? source?.incognito ?? false) || this.offRecordState().active;
    if (privateRun && !this.offRecordState().active && !(source?.offRecord ?? source?.incognito)) {
      throw new NeoError('conflict', this.settingsStore.get().locale.startsWith('zh') ? '此操作执行前，不留记录会话已结束。' : 'The off-record session ended before this action could run.');
    }
    const offRecord = () => privateRun ||= this.offRecordState().active;
    if (privateRun && this.offRecordState().active) this.privateEpisode();
    const controller = new AbortController();
    let resolve!: () => void;
    this.uiTools.set(controller, { done: new Promise<void>((done) => { resolve = done; }), enterOffRecord: () => { privateRun = true; }, tool });
    try {
      const result = await this.executeUiTool(message, tool, input, controller, offRecord, validatedDef);
      if (!result.isError && !controller.signal.aborted) this.patchWidgets(message, result, offRecord());
      return result;
    } finally {
      this.uiTools.delete(controller);
      resolve();
    }
  }

  private async executeUiTool(message: Message, tool: string, input: unknown, controller: AbortController, offRecord: () => boolean, validatedDef?: ToolDefinition): Promise<ToolResult> {
    if (this.tools.permissionFor(tool) === 'deny') throw new NeoError('tool_denied', `The tool "${tool}" is turned off.`);
    const checkMemoryWrite = () => {
      if (offRecord() && (tool === 'remember' || tool === 'forget')) throw new NeoError('forbidden', 'Memory writes are unavailable off the record.');
    };
    checkMemoryWrite();
    const settings = this.settingsStore.get();
    const toolCallId = newId('tc');
    const runtime = this;
    const ctx: ToolContext = {
      toolCallId,
      get conversationId() { return offRecord() ? runtime.offRecordState().episodeId ?? message.conversationId : message.conversationId; },
      messageId: message.id,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(UI_TOOL_TIMEOUT_MS)]),
      now: this.clock,
      timezone: settings.timezone,
      locale: settings.locale,
      // The result goes to the user's screen, not to a model; stay conservative anyway.
      allowSensitive: false,
      // Registries may await validation; memory tools read the current mode at execution.
      get offRecord() { return offRecord(); },
      origin: 'ui',
      logger: this.logger.child({ tool, toolCallId }),
    };
    if (!validatedDef) {
      try {
        return await raceAbort(this.tools.execute({ id: toolCallId, name: tool, input }, ctx), ctx.signal);
      } catch (err) {
        return { isError: true, output: { error: NeoError.from(err).message } };
      }
    }

    // Protected calls were already validated for the token binding. Preserve the registry's
    // result/error handling while executing that data directly, with no asynchronous re-parse.
    const errorResult = (error: string, code?: string): ToolResult => {
      const output = { error, ...(code ? { code } : {}) };
      return { isError: true, output: validatedDef.untrustedOutput ? wrapUntrusted(tool, JSON.stringify(output)) : output };
    };
    if (this.tools.permissionFor(tool) === 'deny') throw new NeoError('tool_denied', `The tool "${tool}" is turned off.`);
    try {
      if (ctx.signal.aborted) return errorResult('The operation was cancelled.', 'cancelled');
      checkMemoryWrite();
      const result = await raceAbort(validatedDef.execute(input, ctx), ctx.signal);
      if (typeof result !== 'object' || result === null || !('output' in result)) {
        this.logger.error('tool returned an invalid result', { tool });
        return errorResult(`The tool "${tool}" returned an invalid result.`);
      }
      if (validatedDef.untrustedOutput) {
        const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null);
        return { ...result, output: wrapUntrusted(tool, text) };
      }
      return result;
    } catch (err) {
      const error = NeoError.from(err);
      this.logger.warn('tool failed', { tool, code: error.code, error: error.message });
      return errorResult(error.message, error.code);
    }
  }

  /**
   * Best effort: bring the message's live widgets (task lists, reminders) in line
   * with the tool result, and tell clients via part.added. Skipped while the
   * message's turn is running (the turn owns its parts until it ends).
   */
  private patchWidgets(message: Message, result: ToolResult, offRecord = false): void {
    try {
      const fresh = this.conversations.getMessage(message.id);
      if (!fresh || (fresh.turnId && this.turns.has(fresh.turnId))) return;
      const changed: { index: number; part: UIPart }[] = [];
      const parts = fresh.parts.map((p, index) => {
        if (p.type !== 'ui') return p;
        const block = patchWidgetBlock(p.block, result.output);
        if (!block) return p;
        const part: UIPart = { ...p, block };
        changed.push({ index, part });
        return part;
      });
      if (!changed.length) return;
      if (offRecord && !(this.conversations.get(fresh.conversationId)?.offRecord ?? false)) {
        const state = this.offRecordState();
        if (!state.active || !state.episodeId) return;
        const existing = this.conversations.messages(state.episodeId);
        const lastCreatedAt = existing.reduce((max, m) => Math.max(max, m.createdAt), Number.NEGATIVE_INFINITY);
        const now = Math.max(this.clock(), lastCreatedAt + 1);
        const turnId = newId('turn', now);
        const privateMessage = this.conversations.appendMessage({ ...fresh, id: newId('msg', now), conversationId: state.episodeId, episodeId: state.episodeId, parts, createdAt: now, turnId });
        this.broadcast({ type: 'message.completed', conversationId: state.episodeId, episodeId: state.episodeId, turnId, message: privateMessage });
        return;
      }
      this.conversations.updateMessage(fresh.id, { parts });
      if (!fresh.turnId) return;
      for (const { index, part } of changed) {
        this.broadcast({ type: 'part.added', conversationId: fresh.conversationId, episodeId: fresh.conversationId, turnId: fresh.turnId, messageId: fresh.id, index, part });
      }
    } catch (err) {
      this.logger.warn('could not update the stored widget', { messageId: message.id, error: String(err) });
    }
  }

  // ── subscribe ──────────────────────────────────────────────────────────────

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn('an event subscriber threw', { event: event.type, error: String(err) });
      }
    }
  }

  // ── activeTurns ────────────────────────────────────────────────────────────

  activeTurns(): { turnId: string; conversationId: string; startedAt: number }[] {
    return [...this.turns.values()].map(({ turnId, conversationId, startedAt }) => ({ turnId, conversationId, startedAt }));
  }
}

/** User-authored parts only (text, image) or a ui_event; validated against the protocol schemas. */
function validateUserParts(parts: readonly unknown[] | undefined): ContentPart[] {
  if (!Array.isArray(parts) || parts.length === 0) throw new NeoError('bad_request', 'At least one content part is required.');
  const out: ContentPart[] = [];
  for (const raw of parts) {
    const parsed = ContentPartSchema.safeParse(raw);
    if (!parsed.success) throw new NeoError('bad_request', 'Invalid message part.', { details: parsed.error.issues });
    if (!USER_PART_TYPES.has(parsed.data.type)) {
      throw new NeoError('bad_request', `Part type "${parsed.data.type}" is not valid for user input.`);
    }
    out.push(parsed.data);
  }
  if (!out.some((p) => p.type !== 'text' || p.text.trim())) throw new NeoError('bad_request', 'The message is empty.');
  return out;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  return new AgentRuntime(deps);
}

function offRecordEpisode(state: OffRecordState, episodeId: string): boolean {
  return state.active && state.episodeId === episodeId;
}
