/**
 * NeoClient implementation — all API method groups.
 */
import type {
  AgentEvent,
  ClaimPairingRequest,
  ClaimPairingResponse,
  ConfirmToolRequest,
  Conversation,
  ConversationWithMessages,
  CreateConversationRequest,
  CreateDeviceResponse,
  CreateProviderRequest,
  Device,
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
  PairingSession,
  PhoneAccessStatus,
  UpdatePhoneAccessRequest,
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
} from '@neo/protocol';
import type { NeoClientOptions, ConnectOptions, EventConnection } from './types.js';
import type { HttpContext } from './http.js';
import { apiRequest } from './http.js';
import { NeoApiError } from './errors.js';
import { readEventStream as parseEventStream } from './sse.js';
import { createConnection } from './ws.js';

// ─────────────────────────────────────────────────────────────────────────────

export class NeoClientImpl {
  readonly baseUrl: string;
  private ctx: HttpContext;
  private readonly WsCtor: typeof WebSocket;

  constructor(private readonly options: NeoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.WsCtor = options.WebSocket ?? globalThis.WebSocket;

    this.ctx = {
      baseUrl: this.baseUrl,
      token: options.token,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.timeoutMs ?? 30_000,
    };
  }

  setToken(token: string | undefined): void {
    this.ctx = { ...this.ctx, token };
  }

  private req<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeout?: boolean;
    } = {},
  ): Promise<T> {
    return apiRequest<T>(this.ctx, { method, path, ...opts });
  }

  // ─────────────────────────────────────────────────────────────────────────

  health(): Promise<HealthResponse> {
    return apiRequest<HealthResponse>(this.ctx, { method: 'GET', path: '/health', timeout: true });
  }

  // ─── Conversations ────────────────────────────────────────────────────────

  readonly conversations = {
    list: (q?: { limit?: number; before?: number; archived?: boolean; query?: string }) =>
      this.req<ListResponse<Conversation>>('GET', '/conversations', { query: q }),

    get: (id: string, q?: { limit?: number; before?: number }) =>
      this.req<ConversationWithMessages>('GET', `/conversations/${id}`, { query: q }),

    create: (body?: CreateConversationRequest) =>
      this.req<Conversation>('POST', '/conversations', { body: body ?? {} }),

    update: (id: string, body: UpdateConversationRequest) =>
      this.req<Conversation>('PATCH', `/conversations/${id}`, { body }),

    delete: (id: string) =>
      this.req<void>('DELETE', `/conversations/${id}`),

    send: (id: string, body: SendMessageRequest) =>
      this.req<SendMessageResponse>('POST', `/conversations/${id}/messages`, { body }),

    stream: (id: string, body: SendMessageRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> => {
      // Return an async iterable that fires the SSE fetch when iterated.
      const self = this;
      return {
        [Symbol.asyncIterator]() {
          return streamConversation(self.ctx, id, body, signal)[Symbol.asyncIterator]();
        },
      };
    },

    cancel: (id: string, turnId?: string) =>
      this.req<{ cancelled: boolean }>('POST', `/conversations/${id}/cancel`, {
        body: turnId ? { turnId } : {},
      }),

    uiAction: (id: string, body: UiActionRequest) =>
      this.req<UiActionResponse>('POST', `/conversations/${id}/ui-action`, { body }),
  };

  // ─── Confirmations ────────────────────────────────────────────────────────

  readonly confirmations = {
    list: () => this.req<ListResponse<ToolConfirmation>>('GET', '/confirmations'),
    respond: (toolCallId: string, body: ConfirmToolRequest) =>
      this.req<{ ok: boolean }>('POST', `/confirmations/${toolCallId}`, { body }),
  };

  // ─── Memory ───────────────────────────────────────────────────────────────

  readonly memory = {
    search: (q?: MemorySearchQuery) =>
      this.req<ListResponse<MemoryNode>>('GET', '/memory', { query: q as Record<string, unknown> }),

    get: (id: string) => this.req<MemoryNodeDetail>('GET', `/memory/${id}`),

    create: (body: RememberInput) => this.req<MemoryNode>('POST', '/memory', { body }),

    update: (id: string, body: MemoryNodePatch) =>
      this.req<MemoryNode>('PATCH', `/memory/${id}`, { body }),

    delete: (id: string) => this.req<{ deleted: number }>('DELETE', `/memory/${id}`),

    forget: (ids: string[]) => this.req<{ deleted: number }>('POST', '/memory/forget', { body: { ids } }),

    findForForget: (query: string, limit?: number) =>
      this.req<ListResponse<MemoryNode>>('POST', '/memory/find-for-forget', {
        body: { query, ...(limit !== undefined ? { limit } : {}) },
      }),

    approve: (ids: string[]) => this.req<{ count: number }>('POST', '/memory/approve', { body: { ids } }),

    reject: (ids: string[]) => this.req<{ count: number }>('POST', '/memory/reject', { body: { ids } }),

    link: (body: { from: string; to: string; type: string; weight?: number }) =>
      this.req<unknown>('POST', '/memory/links', { body }),

    unlink: (edgeId: string) => this.req<{ ok: boolean }>('DELETE', `/memory/links/${edgeId}`),

    graph: (q?: GraphQuery) =>
      this.req<MemoryGraph>('GET', '/memory/graph', { query: q as Record<string, unknown> }),

    consolidate: () => this.req<ConsolidationReport>('POST', '/memory/consolidate'),

    journal: (limit?: number) =>
      this.req<ListResponse<ConsolidationReport>>('GET', '/memory/journal', {
        query: limit !== undefined ? { limit } : undefined,
      }),

    stats: () => this.req<MemoryStats>('GET', '/memory/stats'),

    export: (includeEmbeddings?: boolean) =>
      this.req<MemoryExport>('GET', '/memory/export', {
        query: includeEmbeddings ? { embeddings: '1' } : undefined,
      }),

    import: (data: MemoryExport, mode?: 'merge' | 'replace') =>
      this.req<ImportReport>('POST', '/memory/import', { body: { data, ...(mode ? { mode } : {}) } }),
  };

  // ─── Reminders ────────────────────────────────────────────────────────────

  readonly reminders = {
    list: (q?: { status?: ReminderStatus[]; from?: number; to?: number; limit?: number }) =>
      this.req<ListResponse<Reminder>>('GET', '/reminders', { query: q as Record<string, unknown> }),

    get: (id: string) => this.req<Reminder>('GET', `/reminders/${id}`),

    create: (body: ReminderInput) => this.req<Reminder>('POST', '/reminders', { body }),

    update: (id: string, body: ReminderPatch) =>
      this.req<Reminder>('PATCH', `/reminders/${id}`, { body }),

    delete: (id: string) => this.req<void>('DELETE', `/reminders/${id}`),

    snooze: (id: string, minutes: number) =>
      this.req<Reminder>('POST', `/reminders/${id}/snooze`, { body: { minutes } }),

    complete: (id: string) => this.req<Reminder>('POST', `/reminders/${id}/complete`),
  };

  // ─── Tasks ────────────────────────────────────────────────────────────────

  readonly tasks = {
    lists: () => this.req<ListResponse<TaskList>>('GET', '/task-lists'),

    createList: (body: TaskListInput) => this.req<TaskList>('POST', '/task-lists', { body }),

    updateList: (id: string, body: Partial<TaskListInput>) =>
      this.req<TaskList>('PATCH', `/task-lists/${id}`, { body }),

    deleteList: (id: string) => this.req<void>('DELETE', `/task-lists/${id}`),

    list: (q?: { listId?: string; done?: boolean; query?: string; limit?: number }) =>
      this.req<ListResponse<Task>>('GET', '/tasks', { query: q as Record<string, unknown> }),

    create: (body: TaskInput) => this.req<Task>('POST', '/tasks', { body }),

    update: (id: string, body: TaskPatch) =>
      this.req<Task>('PATCH', `/tasks/${id}`, { body }),

    delete: (id: string) => this.req<void>('DELETE', `/tasks/${id}`),
  };

  // ─── Notes ────────────────────────────────────────────────────────────────

  readonly notes = {
    list: (q?: { query?: string; tag?: string; limit?: number }) =>
      this.req<ListResponse<Note>>('GET', '/notes', { query: q as Record<string, unknown> }),

    get: (id: string) => this.req<Note>('GET', `/notes/${id}`),

    create: (body: NoteInput) => this.req<Note>('POST', '/notes', { body }),

    update: (id: string, body: NotePatch) => this.req<Note>('PATCH', `/notes/${id}`, { body }),

    delete: (id: string) => this.req<void>('DELETE', `/notes/${id}`),
  };

  // ─── Notifications ────────────────────────────────────────────────────────

  readonly notifications = {
    list: (q?: { unread?: boolean; limit?: number }) =>
      this.req<ListResponse<Notification>>('GET', '/notifications', {
        query: q as Record<string, unknown>,
      }),

    markRead: (ids: string[] | 'all') =>
      this.req<{ count: number }>('POST', '/notifications/read', { body: { ids } }),
  };

  // ─── Providers ────────────────────────────────────────────────────────────

  readonly providers = {
    list: () => this.req<ProvidersResponse>('GET', '/providers'),

    create: (body: CreateProviderRequest) =>
      this.req<ProviderView>('POST', '/providers', { body }),

    update: (id: string, body: UpdateProviderRequest) =>
      this.req<ProviderView>('PATCH', `/providers/${id}`, { body }),

    delete: (id: string) => this.req<void>('DELETE', `/providers/${id}`),

    models: (id: string) => this.req<ListResponse<ModelInfo>>('GET', `/providers/${id}/models`),

    test: (id: string) => this.req<ProviderTestResult>('POST', `/providers/${id}/test`),

    testDraft: (body: { kind: ProviderKind; baseUrl?: string; apiKey?: string }) =>
      this.req<ProviderTestResult>('POST', '/providers/test', { body }),
  };

  // ─── Settings ─────────────────────────────────────────────────────────────

  readonly settings = {
    get: () => this.req<NeoSettings>('GET', '/settings'),
    update: (patch: NeoSettingsPatch) =>
      this.req<NeoSettings>('PATCH', '/settings', { body: patch }),
  };

  // ─── Tools ────────────────────────────────────────────────────────────────

  readonly tools = {
    list: () => this.req<ListResponse<ToolInfo>>('GET', '/tools'),
    setPermission: (name: string, permission: PermissionLevel) =>
      this.req<ToolInfo>('PUT', `/tools/${name}/permission`, { body: { permission } }),
  };

  // ─── Devices ──────────────────────────────────────────────────────────────

  readonly devices = {
    list: () => this.req<ListResponse<Device>>('GET', '/devices'),
    create: (name: string, platform?: Device['platform']) =>
      this.req<CreateDeviceResponse>('POST', '/devices', {
        body: { name, platform: platform ?? 'other' },
      }),
    revoke: (id: string) => this.req<void>('DELETE', `/devices/${id}`),
  };

  // ─── Pairing ──────────────────────────────────────────────────────────────

  readonly phoneAccess = {
    status: () => this.req<PhoneAccessStatus>('GET', '/phone-access'),
    update: (body: UpdatePhoneAccessRequest) =>
      this.req<PhoneAccessStatus>('PATCH', '/phone-access', { body }),
  };

  readonly pairing = {
    create: () => this.req<PairingSession>('POST', '/pairing'),
    cancel: (id: string) => this.req<void>('DELETE', `/pairing/${id}`),
    claim: (body: ClaimPairingRequest) =>
      this.req<ClaimPairingResponse>('POST', '/pairing/claim', { body }),
  };

  // ─── Push ─────────────────────────────────────────────────────────────────

  readonly push = {
    vapidPublicKey: async (): Promise<string | null> => {
      const r = await this.req<{ publicKey: string | null }>('GET', '/push/vapid-public-key');
      return r.publicKey;
    },
    subscribe: (subscription: PushSubscriptionJSON) =>
      this.req<{ ok: boolean }>('POST', '/push/subscribe', { body: { subscription } }),
    unsubscribe: (endpoint: string) =>
      this.req<{ ok: boolean }>('POST', '/push/unsubscribe', { body: { endpoint } }),
  };

  // ─── WebSocket ────────────────────────────────────────────────────────────

  connect(opts: ConnectOptions): EventConnection {
    return createConnection(
      {
        baseUrl: this.baseUrl,
        getToken: () => this.ctx.token,
        WebSocketCtor: this.WsCtor,
      },
      opts,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE streaming helper
// ─────────────────────────────────────────────────────────────────────────────

async function* streamConversation(
  ctx: HttpContext,
  id: string,
  body: SendMessageRequest,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const url = `${ctx.baseUrl}/api/conversations/${id}/messages`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (ctx.token) headers['Authorization'] = `Bearer ${ctx.token}`;

  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw err;
    }
    throw new NeoApiError(0, { code: 'internal', message: err instanceof Error ? err.message : 'Network error', retryable: true });
  }

  if (!response.ok) {
    let shape: import('@neo/protocol').ErrorShape;
    try {
      shape = (await response.json()) as import('@neo/protocol').ErrorShape;
      if (typeof shape.code !== 'string' || typeof shape.message !== 'string') {
        throw new Error('invalid shape');
      }
    } catch {
      shape = { code: 'internal', message: `HTTP ${response.status}`, retryable: response.status >= 500 };
    }
    throw new NeoApiError(response.status, shape);
  }

  yield* parseEventStream(response, signal);
}
