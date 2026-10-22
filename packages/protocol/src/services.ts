/**
 * Service interfaces shared across package boundaries. Concrete
 * implementations live in @neo/storage, @neo/tools, @neo/core; the server
 * composes them. Depending on these interfaces (not classes) is what lets every
 * package be built and tested in isolation with fakes.
 *
 * Store methods are synchronous because the backing store (node:sqlite) is.
 */
import type { NeoSettings, NeoSettingsPatch } from './config.js';
import type { ContentPart, Conversation, Message, ModelRef } from './content.js';
import type { AgentEvent, ToolConfirmation } from './events.js';
import type {
  Device,
  Note,
  NoteInput,
  NotePatch,
  Notification,
  NotificationInput,
  PushSubscriptionJSON,
  Reminder,
  ReminderFiring,
  ReminderInput,
  ReminderPatch,
  ReminderStatus,
  Task,
  TaskInput,
  TaskList,
  TaskListInput,
  TaskPatch,
} from './productivity.js';
import type { ToolResult, ToolRisk } from './tools.js';
import type { UIAction } from './ui.js';
import type { OffRecordState, TimelinePage, TimelineQuery, TimelineSearchHit } from './api.js';
import type { ToolUseEvent, ToolUseQuery } from './memory.js';

// ───────────────────────────── logging & time ─────────────────────────────

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Minimal structured logger writing one line per record to the console. */
export function createConsoleLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const min = LEVELS[level];
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const extra = { ...bindings, ...data };
    const tail = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${tail}`;
    if (lvl === 'error') console.error(line);
    else if (lvl === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (b) => createConsoleLogger(level, { ...bindings, ...b }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/** Returns epoch ms. Injected everywhere so tests can control time. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

// ───────────────────────────── stores ─────────────────────────────

export interface ConversationListQuery {
  limit?: number;
  /** Cursor updatedAt; beforePinned must accompany it for correct composite pagination. */
  before?: number;
  beforePinned?: boolean;
  archived?: boolean;
  query?: string;
}

export interface NewConversation {
  title?: string;
  model?: ModelRef | null;
  incognito?: boolean;
  offRecord?: boolean;
  ephemeral?: boolean;
  closedAt?: number | null;
}

export type ConversationPatch = Partial<
  Pick<Conversation, 'title' | 'model' | 'pinned' | 'archived' | 'systemPrompt' | 'toolset' | 'lastMessageAt' | 'preview' | 'closedAt' | 'searchMode'>
>;

export type MessagePatch = Partial<Pick<Message, 'parts' | 'status' | 'error' | 'usage' | 'model' | 'sensitive'>>;

export interface ConversationStore {
  list(query?: ConversationListQuery): Conversation[];
  get(id: string): Conversation | null;
  create(input?: NewConversation): Conversation;
  update(id: string, patch: ConversationPatch): Conversation;
  /** Deletes the conversation and all its messages. */
  delete(id: string): boolean;
  /** Oldest → newest. `before` is a message createdAt for pagination; `limit` keeps the newest N. */
  messages(conversationId: string, options?: { limit?: number; before?: number; beforeId?: string }): Message[];
  getMessage(id: string): Message | null;
  /** Inserts the message and bumps the conversation's updatedAt/lastMessageAt/preview. */
  appendMessage(message: Message): Message;
  updateMessage(id: string, patch: MessagePatch): Message;
  deleteMessage(id: string): boolean;
  currentEpisode(): Conversation | null;
  latestEpisode(): Conversation | null;
  createEpisode(input?: { offRecord?: boolean }): Conversation;
  closeEpisode(id: string): Conversation;
  offRecordState(): OffRecordState;
  setOffRecordState(state: OffRecordState): void;
  /** Hard-delete only ephemeral off-record episodes that started before the cutoff. */
  purgeOffRecord(before: number): number;
  /** New off-record episodes only; migrated private history is never ephemeral. */
  offRecordEpisodes(before?: number): Conversation[];
  timeline(query?: TimelineQuery): TimelinePage;
  searchMessages(query: string, limit?: number): TimelineSearchHit[];
  messagesInRange(range: { from?: number; to?: number }): Message[];
  /** Completed tool calls, oldest → newest; excludes off-record episodes. Optional for legacy/custom stores. */
  toolUses?(query?: ToolUseQuery): ToolUseEvent[];
  /** Inclusive timestamp range. Closes every touched active episode. */
  deleteRange(range: { from?: number; to?: number }): Message[];
}

export interface SettingsStore {
  get(): NeoSettings;
  /** Deep-merges and validates; throws NeoError('bad_request') on invalid values. */
  update(patch: NeoSettingsPatch): NeoSettings;
  onChange(listener: (settings: NeoSettings) => void): () => void;
}

export interface SecretStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): boolean;
  list(): string[];
}

export interface DeviceStore {
  list(): Device[];
  /** Returns the plaintext token once; only a hash is stored. */
  create(input: { name: string; platform: Device['platform']; owner?: boolean; token?: string }): { device: Device; token: string };
  /** Constant-time token check; updates lastSeenAt. */
  verify(token: string): Device | null;
  revoke(id: string): boolean;
}

export interface PushSubscriptionStore {
  list(): { id: string; subscription: PushSubscriptionJSON; deviceId: string | null; createdAt: number }[];
  add(subscription: PushSubscriptionJSON, deviceId?: string | null): string;
  remove(endpoint: string): boolean;
}

export interface ReminderListQuery {
  status?: ReminderStatus[];
  from?: number;
  to?: number;
  limit?: number;
  /** Filter to reminders whose last_fired_at >= this timestamp (ms). */
  lastFiredAtFrom?: number;
}

export interface ReminderStore {
  list(query?: ReminderListQuery): Reminder[];
  get(id: string): Reminder | null;
  create(input: ReminderInput): Reminder;
  update(id: string, patch: ReminderPatch): Reminder;
  delete(id: string): boolean;
  snooze(id: string, minutes: number): Reminder;
  complete(id: string): Reminder;
  /** Scheduled reminders with dueAt <= now, oldest first. */
  due(now: number): Reminder[];
  /** The scheduled reminder with the smallest dueAt, excluding the given ids. */
  nextDue(excludeIds?: ReadonlySet<string>): Reminder | null;
  /** Record a firing: advances recurring reminders or marks one-shots 'fired'. */
  markFired(id: string, firedAt: number, missed?: boolean): ReminderFiring;
  onChange(listener: (event: { type: 'upsert'; reminder: Reminder } | { type: 'delete'; id: string }) => void): () => void;
  /**
   * Set messageId to null for every reminder whose messageId is in the given set.
   * Called by the server's delete route after messages are removed.
   */
  clearMessageLinks(messageIds: string[]): void;
  /**
   * Return every pending_firings row that has not yet been acknowledged.
   * A pending firing is written atomically with markFired so it survives
   * a crash between markFired and the downstream notification write.
   * On re-delivery (scheduler start), each row is re-emitted to onFire listeners.
   */
  pendingFirings?(): ReminderFiring[];
  /**
   * Remove one pending_firings row after the downstream notification succeeds.
   * Idempotent: calling it twice for the same id is harmless.
   */
  clearPendingFiring?(id: string): void;
}

export interface TaskListQuery {
  listId?: string;
  done?: boolean;
  dueBefore?: number;
  query?: string;
  limit?: number;
}

export interface TaskStore {
  lists(): TaskList[];
  createList(input: TaskListInput): TaskList;
  updateList(id: string, patch: Partial<TaskListInput>): TaskList;
  /** Moves its tasks to the inbox. The inbox itself cannot be deleted. */
  deleteList(id: string): boolean;
  list(query?: TaskListQuery): Task[];
  get(id: string): Task | null;
  create(input: TaskInput): Task;
  update(id: string, patch: TaskPatch): Task;
  delete(id: string): boolean;
  onChange(listener: (event: { type: 'upsert'; task: Task } | { type: 'delete'; id: string }) => void): () => void;
}

export interface NoteStore {
  list(query?: { query?: string; tag?: string; limit?: number }): Note[];
  get(id: string): Note | null;
  create(input: NoteInput): Note;
  update(id: string, patch: NotePatch): Note;
  delete(id: string): boolean;
  onChange(listener: (event: { type: 'upsert'; note: Note } | { type: 'delete'; id: string }) => void): () => void;
}

export interface NotificationStore {
  list(query?: { unread?: boolean; limit?: number }): Notification[];
  create(input: NotificationInput): Notification;
  markRead(ids: string[] | 'all'): number;
}

export interface ProductivityStores {
  reminders: ReminderStore;
  tasks: TaskStore;
  notes: NoteStore;
  notifications: NotificationStore;
}

export interface ReminderScheduler {
  /** Fires overdue reminders (catch-up, flagged `missed` past the grace period) and arms timers. */
  start(): void;
  stop(): void;
  /** Re-arm after reminders changed (stores call this via onChange automatically). */
  reschedule(): void;
  /** Fire everything due at `now`; returns the firings. Used by timers and tests. */
  tick(now?: number): ReminderFiring[];
  onFire(listener: (firing: ReminderFiring) => void): () => void;
}

// ───────────────────────────── agent runtime ─────────────────────────────

export interface SendInput {
  conversationId: string;
  /** User-authored parts (text, image) or a ui_event. */
  parts: ContentPart[];
}

export interface SendTimelineInput {
  parts: ContentPart[];
  /** Legacy entry hint; false cannot end the persisted private session. */
  offRecord?: boolean;
}

export interface TurnHandle {
  turnId: string;
  conversationId: string;
  episodeId: string;
  userMessage: Message;
  assistantMessageId: string;
  /** Events of this turn only, ending after turn.finished / turn.failed. */
  events: AsyncIterable<AgentEvent>;
  /** Resolves with the final assistant message (status complete | error | cancelled). Never rejects. */
  done: Promise<Message>;
}

export interface ConfirmationDecision {
  approve: boolean;
  /** Approve this tool permanently (sets its permission to 'auto'). */
  always?: boolean;
}

export interface UiActionInput {
  conversationId: string;
  messageId: string;
  uiId: string;
  actionId: string;
  values?: Record<string, unknown>;
  /** Echo of a {@link UiActionConfirmation.token} after the user approved the server's description. */
  confirmationToken?: string;
}

/**
 * A UI action that runs a tool needing confirmation. The description is generated by the server from
 * the real tool and its validated input (never from model-written labels). The client shows it and,
 * on approval, repeats the same ui-action request with `confirmationToken: token`. Tokens are bound
 * to the conversation, message, ui part, action and input, expire, and work once.
 */
export interface UiActionConfirmation {
  token: string;
  tool: string;
  title: string;
  description: string;
  risk: ToolRisk;
  expiresAt: number;
}

export type UiActionResult =
  | { kind: 'turn'; turn: TurnHandle }
  | { kind: 'tool'; result: ToolResult }
  | { kind: 'client'; action: UIAction }
  | { kind: 'confirm'; confirmation: UiActionConfirmation }
  | { kind: 'noop' };

/** Implemented by @neo/core AgentRuntime; consumed by @neo/server. */
export interface AgentRuntimeApi {
  /** Persists the user message and starts a turn. Rejects with NeoError if the conversation is busy/unknown. */
  send(input: SendInput): Promise<TurnHandle>;
  sendTimeline(input: SendTimelineInput): Promise<TurnHandle>;
  cancelTimeline(turnId?: string): boolean;
  startOffRecord(): Promise<OffRecordState>;
  offRecordState(): OffRecordState;
  endOffRecord(): Promise<{ deleted: number }>;
  purgeOffRecord(before: number): Promise<number>;
  waitForIdle(episodeIds?: string[]): Promise<void>;
  /** Serialize a user timeline mutation with pending sends and off-record cleanup. */
  mutateTimeline<T>(mutation: () => Promise<T>): Promise<T>;
  cancel(turnId: string): boolean;
  /** Cancel whatever turn is running in a conversation. */
  cancelConversation(conversationId: string): boolean;
  /** Answer a pending confirmation by its `ToolConfirmation.id` nonce. */
  confirm(confirmationId: string, decision: ConfirmationDecision): boolean;
  pendingConfirmations(): ToolConfirmation[];
  /**
   * Resolve an action declared in a stored UI part (never trust client-sent
   * action definitions): message/event → new turn; tool → direct tool run;
   * link/copy → returned for the client to perform.
   */
  handleUiAction(input: UiActionInput): Promise<UiActionResult>;
  handleTimelineUiAction(input: Omit<UiActionInput, 'conversationId'>): Promise<UiActionResult>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  activeTurns(): { turnId: string; conversationId: string; startedAt: number }[];
}
