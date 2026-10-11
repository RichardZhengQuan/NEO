/**
 * @neo/client — typed client for the NEO API.
 *
 * FROZEN PUBLIC API (docs/IMPLEMENTATION_PLAN.md, WP-client). Implementations
 * may add members but must not change these signatures. Every method maps 1:1
 * to a route in docs/API.md.
 */
import {
  NeoError,
  type AgentEvent,
  type ConfirmToolRequest,
  type Conversation,
  type ConversationWithMessages,
  type CreateConversationRequest,
  type CreateDeviceResponse,
  type CreateProviderRequest,
  type Device,
  type ErrorShape,
  type EventEnvelope,
  type GraphQuery,
  type HealthResponse,
  type ImportReport,
  type ListResponse,
  type MemoryExport,
  type MemoryGraph,
  type MemoryNode,
  type MemoryNodeDetail,
  type MemoryNodePatch,
  type MemorySearchQuery,
  type MemoryStats,
  type ConsolidationReport,
  type ModelInfo,
  type NeoSettings,
  type NeoSettingsPatch,
  type Note,
  type NoteInput,
  type NotePatch,
  type Notification,
  type PermissionLevel,
  type ProviderTestResult,
  type ProviderView,
  type ProvidersResponse,
  type PushSubscriptionJSON,
  type Reminder,
  type ReminderInput,
  type ReminderPatch,
  type ReminderStatus,
  type RememberInput,
  type SendMessageRequest,
  type SendMessageResponse,
  type Task,
  type TaskInput,
  type TaskList,
  type TaskListInput,
  type TaskPatch,
  type ToolConfirmation,
  type ToolInfo,
  type UiActionRequest,
  type UiActionResponse,
  type UpdateConversationRequest,
  type UpdateProviderRequest,
  type ProviderKind,
} from '@neo/protocol';

export type {
  AgentEvent,
  ConfirmToolRequest,
  Conversation,
  ConversationWithMessages,
  CreateConversationRequest,
  CreateDeviceResponse,
  CreateProviderRequest,
  Device,
  ErrorShape,
  EventEnvelope,
  GraphQuery,
  HealthResponse,
  ImportReport,
  ListResponse,
  MemoryExport,
  MemoryGraph,
  MemoryNode,
  MemoryNodeDetail,
  MemoryNodePatch,
  MemorySearchQuery,
  MemoryStats,
  ConsolidationReport,
  ModelInfo,
  NeoSettings,
  NeoSettingsPatch,
  Note,
  NoteInput,
  NotePatch,
  Notification,
  PermissionLevel,
  ProviderTestResult,
  ProviderView,
  ProvidersResponse,
  PushSubscriptionJSON,
  Reminder,
  ReminderInput,
  ReminderPatch,
  ReminderStatus,
  RememberInput,
  SendMessageRequest,
  SendMessageResponse,
  Task,
  TaskInput,
  TaskList,
  TaskListInput,
  TaskPatch,
  ToolConfirmation,
  ToolInfo,
  UiActionRequest,
  UiActionResponse,
  UpdateConversationRequest,
  UpdateProviderRequest,
  ProviderKind,
};

export { NeoError };

// Re-export shared types from types.ts
export type { NeoClientOptions, ConnectOptions, ConnectionStatus, EventConnection } from './types.js';

// Re-export NeoApiError from errors.ts
export { NeoApiError } from './errors.js';

// Re-export utility functions
export { readEventStream } from './sse.js';
export { buildQuery } from './http.js';

// ─────────────────────────────────────────────────────────────────────────────
// NeoClient: delegating wrapper over NeoClientImpl
// ─────────────────────────────────────────────────────────────────────────────

import type { NeoClientOptions, ConnectOptions, EventConnection } from './types.js';
import { NeoClientImpl } from './client.js';

export class NeoClient {
  readonly baseUrl: string;

  private readonly _impl: NeoClientImpl;

  constructor(readonly options: NeoClientOptions) {
    this._impl = new NeoClientImpl(options);
    this.baseUrl = this._impl.baseUrl;
  }

  setToken(token: string | undefined): void {
    this._impl.setToken(token);
  }

  health(): Promise<HealthResponse> {
    return this._impl.health();
  }

  readonly conversations = {
    list: (q?: { limit?: number; before?: number; archived?: boolean; query?: string }): Promise<ListResponse<Conversation>> =>
      this._impl.conversations.list(q),
    get: (id: string, q?: { limit?: number; before?: number }): Promise<ConversationWithMessages> =>
      this._impl.conversations.get(id, q),
    create: (body?: CreateConversationRequest): Promise<Conversation> =>
      this._impl.conversations.create(body),
    update: (id: string, body: UpdateConversationRequest): Promise<Conversation> =>
      this._impl.conversations.update(id, body),
    delete: (id: string): Promise<void> =>
      this._impl.conversations.delete(id),
    /** POST …/messages → 202. Events arrive on the WebSocket. */
    send: (id: string, body: SendMessageRequest): Promise<SendMessageResponse> =>
      this._impl.conversations.send(id, body),
    /** POST …/messages with Accept: text/event-stream; yields this turn's events until turn.finished/failed. */
    stream: (id: string, body: SendMessageRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> =>
      this._impl.conversations.stream(id, body, signal),
    cancel: (id: string, turnId?: string): Promise<{ cancelled: boolean }> =>
      this._impl.conversations.cancel(id, turnId),
    uiAction: (id: string, body: UiActionRequest): Promise<UiActionResponse> =>
      this._impl.conversations.uiAction(id, body),
  };

  readonly confirmations = {
    list: (): Promise<ListResponse<ToolConfirmation>> =>
      this._impl.confirmations.list(),
    respond: (toolCallId: string, body: ConfirmToolRequest): Promise<{ ok: boolean }> =>
      this._impl.confirmations.respond(toolCallId, body),
  };

  readonly memory = {
    search: (q?: MemorySearchQuery): Promise<ListResponse<MemoryNode>> =>
      this._impl.memory.search(q),
    get: (id: string): Promise<MemoryNodeDetail> =>
      this._impl.memory.get(id),
    create: (body: RememberInput): Promise<MemoryNode> =>
      this._impl.memory.create(body),
    update: (id: string, body: MemoryNodePatch): Promise<MemoryNode> =>
      this._impl.memory.update(id, body),
    delete: (id: string): Promise<{ deleted: number }> =>
      this._impl.memory.delete(id),
    forget: (ids: string[]): Promise<{ deleted: number }> =>
      this._impl.memory.forget(ids),
    findForForget: (query: string, limit?: number): Promise<ListResponse<MemoryNode>> =>
      this._impl.memory.findForForget(query, limit),
    approve: (ids: string[]): Promise<{ count: number }> =>
      this._impl.memory.approve(ids),
    reject: (ids: string[]): Promise<{ count: number }> =>
      this._impl.memory.reject(ids),
    link: (body: { from: string; to: string; type: string; weight?: number }): Promise<unknown> =>
      this._impl.memory.link(body),
    unlink: (edgeId: string): Promise<{ ok: boolean }> =>
      this._impl.memory.unlink(edgeId),
    graph: (q?: GraphQuery): Promise<MemoryGraph> =>
      this._impl.memory.graph(q),
    consolidate: (): Promise<ConsolidationReport> =>
      this._impl.memory.consolidate(),
    journal: (limit?: number): Promise<ListResponse<ConsolidationReport>> =>
      this._impl.memory.journal(limit),
    stats: (): Promise<MemoryStats> =>
      this._impl.memory.stats(),
    export: (includeEmbeddings?: boolean): Promise<MemoryExport> =>
      this._impl.memory.export(includeEmbeddings),
    import: (data: MemoryExport, mode?: 'merge' | 'replace'): Promise<ImportReport> =>
      this._impl.memory.import(data, mode),
  };

  readonly reminders = {
    list: (q?: { status?: ReminderStatus[]; from?: number; to?: number; limit?: number }): Promise<ListResponse<Reminder>> =>
      this._impl.reminders.list(q),
    get: (id: string): Promise<Reminder> =>
      this._impl.reminders.get(id),
    create: (body: ReminderInput): Promise<Reminder> =>
      this._impl.reminders.create(body),
    update: (id: string, body: ReminderPatch): Promise<Reminder> =>
      this._impl.reminders.update(id, body),
    delete: (id: string): Promise<void> =>
      this._impl.reminders.delete(id),
    snooze: (id: string, minutes: number): Promise<Reminder> =>
      this._impl.reminders.snooze(id, minutes),
    complete: (id: string): Promise<Reminder> =>
      this._impl.reminders.complete(id),
  };

  readonly tasks = {
    lists: (): Promise<ListResponse<TaskList>> =>
      this._impl.tasks.lists(),
    createList: (body: TaskListInput): Promise<TaskList> =>
      this._impl.tasks.createList(body),
    updateList: (id: string, body: Partial<TaskListInput>): Promise<TaskList> =>
      this._impl.tasks.updateList(id, body),
    deleteList: (id: string): Promise<void> =>
      this._impl.tasks.deleteList(id),
    list: (q?: { listId?: string; done?: boolean; query?: string; limit?: number }): Promise<ListResponse<Task>> =>
      this._impl.tasks.list(q),
    create: (body: TaskInput): Promise<Task> =>
      this._impl.tasks.create(body),
    update: (id: string, body: TaskPatch): Promise<Task> =>
      this._impl.tasks.update(id, body),
    delete: (id: string): Promise<void> =>
      this._impl.tasks.delete(id),
  };

  readonly notes = {
    list: (q?: { query?: string; tag?: string; limit?: number }): Promise<ListResponse<Note>> =>
      this._impl.notes.list(q),
    get: (id: string): Promise<Note> =>
      this._impl.notes.get(id),
    create: (body: NoteInput): Promise<Note> =>
      this._impl.notes.create(body),
    update: (id: string, body: NotePatch): Promise<Note> =>
      this._impl.notes.update(id, body),
    delete: (id: string): Promise<void> =>
      this._impl.notes.delete(id),
  };

  readonly notifications = {
    list: (q?: { unread?: boolean; limit?: number }): Promise<ListResponse<Notification>> =>
      this._impl.notifications.list(q),
    markRead: (ids: string[] | 'all'): Promise<{ count: number }> =>
      this._impl.notifications.markRead(ids),
  };

  readonly providers = {
    list: (): Promise<ProvidersResponse> =>
      this._impl.providers.list(),
    create: (body: CreateProviderRequest): Promise<ProviderView> =>
      this._impl.providers.create(body),
    update: (id: string, body: UpdateProviderRequest): Promise<ProviderView> =>
      this._impl.providers.update(id, body),
    delete: (id: string): Promise<void> =>
      this._impl.providers.delete(id),
    models: (id: string): Promise<ListResponse<ModelInfo>> =>
      this._impl.providers.models(id),
    test: (id: string): Promise<ProviderTestResult> =>
      this._impl.providers.test(id),
    testDraft: (body: { kind: ProviderKind; baseUrl?: string; apiKey?: string }): Promise<ProviderTestResult> =>
      this._impl.providers.testDraft(body),
  };

  readonly settings = {
    get: (): Promise<NeoSettings> =>
      this._impl.settings.get(),
    update: (patch: NeoSettingsPatch): Promise<NeoSettings> =>
      this._impl.settings.update(patch),
  };

  readonly tools = {
    list: (): Promise<ListResponse<ToolInfo>> =>
      this._impl.tools.list(),
    setPermission: (name: string, permission: PermissionLevel): Promise<ToolInfo> =>
      this._impl.tools.setPermission(name, permission),
  };

  readonly devices = {
    list: (): Promise<ListResponse<Device>> =>
      this._impl.devices.list(),
    create: (name: string, platform?: Device['platform']): Promise<CreateDeviceResponse> =>
      this._impl.devices.create(name, platform),
    revoke: (id: string): Promise<void> =>
      this._impl.devices.revoke(id),
  };

  readonly push = {
    vapidPublicKey: (): Promise<string | null> =>
      this._impl.push.vapidPublicKey(),
    subscribe: (subscription: PushSubscriptionJSON): Promise<{ ok: boolean }> =>
      this._impl.push.subscribe(subscription),
    unsubscribe: (endpoint: string): Promise<{ ok: boolean }> =>
      this._impl.push.unsubscribe(endpoint),
  };

  /** Open the event WebSocket (GET /api/ws, first message `auth`). */
  connect(options: ConnectOptions): EventConnection {
    return this._impl.connect(options);
  }
}
