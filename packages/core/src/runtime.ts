/**
 * AgentRuntime — the implementation of AgentRuntimeApi (@neo/protocol services.ts).
 *
 * Owns the bookkeeping shared by turns: which conversation is busy, pending tool
 * confirmations, and global subscribers. The turn itself lives in turn.ts.
 */
import {
  ContentPartSchema,
  NeoError,
  modelRefToString,
  newId,
  randomToken,
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
  type ProviderAdapter,
  type ProviderRegistry,
  type SendInput,
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
import { startTurn, type TurnRecord, type TurnServices } from './turn.js';
import { describeUiToolCall, findUiPart, patchWidgetBlock, resolveStoredAction, uiActionBinding, uiActionIdentity } from './ui-actions.js';

export interface AgentRuntimeDeps {
  conversations: ConversationStore;
  settings: SettingsStore;
  providers: ProviderRegistry;
  memory: MemoryService;
  tools: ToolRegistry;
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
  private readonly settingsStore: SettingsStore;
  private readonly providers: ProviderRegistry;
  private readonly memory: MemoryService;
  private readonly tools: ToolRegistry;
  private readonly logger: Logger;
  private readonly clock: Clock;

  private readonly confirmations = new ConfirmationManager();
  /** UI approvals are separate from model-turn confirmations, and are consumed before any await. */
  private readonly uiConfirmations = new Map<string, UiApproval>();
  /** A denial permanently revokes older UI approvals, including ones currently validating. */
  private readonly uiPermissionVersions = new Map<string, number>();
  /** Running turns by turnId. */
  private readonly turns = new Map<string, TurnRecord>();
  /** conversationId → turnId of the turn holding it (reserved synchronously in send()). */
  private readonly busy = new Map<string, string>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly services: TurnServices;

  constructor(deps: AgentRuntimeDeps) {
    this.conversations = deps.conversations;
    this.settingsStore = deps.settings;
    this.providers = deps.providers;
    this.memory = deps.memory;
    this.tools = deps.tools;
    this.logger = deps.logger ?? silentLogger;
    this.clock = deps.clock ?? systemClock;
    this.services = {
      conversations: this.conversations,
      settings: this.settingsStore,
      memory: this.memory,
      tools: this.tools,
      confirmations: this.confirmations,
      logger: this.logger,
      clock: this.clock,
      broadcast: (event) => this.broadcast(event),
    };
    this.settingsStore.onChange((settings) => {
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
    if (this.busy.has(conv.id)) throw new NeoError('conflict', 'A turn is already running in this conversation.');
    const parts = validateUserParts(input.parts);
    const settings = this.settingsStore.get();
    const { adapter, model } = this.resolveModel(input.model, conv, settings);

    // Reserve the conversation before the first await, so concurrent sends conflict.
    const record: TurnRecord = { turnId: newId('turn'), conversationId: conv.id, startedAt: this.clock(), controller: new AbortController() };
    this.turns.set(record.turnId, record);
    this.busy.set(conv.id, record.turnId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.turns.delete(record.turnId);
      if (this.busy.get(conv.id) === record.turnId) this.busy.delete(conv.id);
    };
    try {
      return await startTurn(this.services, { record, conversation: conv, parts, adapter, model, settings, release });
    } catch (err) {
      release();
      throw err;
    }
  }

  /** input.model → conversation model → settings.defaultModel → first enabled provider with a default model. */
  private resolveModel(override: ModelRef | undefined, conv: Conversation, settings: NeoSettings): { adapter: ProviderAdapter; model: string } {
    const ref = override ?? conv.model ?? settings.defaultModel ?? this.firstAvailableModel();
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
      if (adapter.config.enabled && adapter.config.defaultModel) return { provider: adapter.id, model: adapter.config.defaultModel };
    }
    throw new NeoError('config_error', 'No AI configured — add one in Settings.');
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

  // ── confirmations ──────────────────────────────────────────────────────────

  confirm(confirmationId: string, decision: ConfirmationDecision): boolean {
    return this.confirmations.resolve(confirmationId, decision);
  }

  pendingConfirmations(): ToolConfirmation[] {
    return this.confirmations.list();
  }

  // ── handleUiAction ─────────────────────────────────────────────────────────

  async handleUiAction(input: UiActionInput): Promise<UiActionResult> {
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
        return { kind: 'turn', turn: await this.send({ conversationId, parts: [{ type: 'text', text: action.text }] }) };
      case 'event': {
        const event: UIEventPart = { type: 'ui_event', messageId, uiId, actionId, label: action.label };
        if (action.payload !== undefined) event.payload = action.payload;
        if (values && Object.keys(values).length) event.values = values;
        return { kind: 'turn', turn: await this.send({ conversationId, parts: [event] }) };
      }
      case 'tool': {
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
          // Execute the exact data covered by the approval, without a second schema transform.
          const result = await this.runUiTool(message, action.tool, parsed.data, def);
          if (!result.isError) this.patchWidgets(message, result);
          return { kind: 'tool', result };
        }
        const result = await this.runUiTool(message, action.tool, action.input ?? {});
        if (!result.isError) this.patchWidgets(message, result);
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

  private async runUiTool(message: Message, tool: string, input: unknown, validatedDef?: ToolDefinition): Promise<ToolResult> {
    if (this.tools.permissionFor(tool) === 'deny') throw new NeoError('tool_denied', `The tool "${tool}" is turned off.`);
    const settings = this.settingsStore.get();
    const toolCallId = newId('tc');
    const ctx: ToolContext = {
      toolCallId,
      conversationId: message.conversationId,
      messageId: message.id,
      signal: AbortSignal.timeout(UI_TOOL_TIMEOUT_MS),
      now: this.clock,
      timezone: settings.timezone,
      locale: settings.locale,
      // The result goes to the user's screen, not to a model; stay conservative anyway.
      allowSensitive: false,
      origin: 'ui',
      logger: this.logger.child({ tool, toolCallId }),
    };
    if (!validatedDef) return this.tools.execute({ id: toolCallId, name: tool, input }, ctx);

    // Protected calls were already validated for the token binding. Preserve the registry's
    // result/error handling while executing that data directly, with no asynchronous re-parse.
    const errorResult = (error: string, code?: string): ToolResult => {
      const output = { error, ...(code ? { code } : {}) };
      return { isError: true, output: validatedDef.untrustedOutput ? wrapUntrusted(tool, JSON.stringify(output)) : output };
    };
    if (this.tools.permissionFor(tool) === 'deny') throw new NeoError('tool_denied', `The tool "${tool}" is turned off.`);
    try {
      if (ctx.signal.aborted) return errorResult('The operation was cancelled.', 'cancelled');
      const result = await validatedDef.execute(input, ctx);
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
  private patchWidgets(message: Message, result: ToolResult): void {
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
      this.conversations.updateMessage(fresh.id, { parts });
      if (!fresh.turnId) return;
      for (const { index, part } of changed) {
        this.broadcast({ type: 'part.added', conversationId: fresh.conversationId, turnId: fresh.turnId, messageId: fresh.id, index, part });
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
