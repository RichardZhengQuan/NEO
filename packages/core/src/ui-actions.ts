/**
 * UI actions are resolved against the STORED ui part, never against anything the
 * client sends (docs/GENERATIVE_UI.md "Actions"), and live widgets in stored
 * messages are patched after their tool runs so a reload shows the new state.
 */
import { createHash } from 'node:crypto';
import {
  FORM_SUBMIT_ACTION_ID,
  UI_ACTION_ID_PREFIX,
  NeoError,
  RecurrenceSchema,
  collectActions,
  describeRecurrence,
  formSubmitActionId,
  resolveWidgetAction,
  validateUIBlocks,
  walkUIBlocks,
  type ContentPart,
  type UIAction,
  type UIBlock,
  type UIPart,
  type UiActionInput,
  type ToolDefinition,
} from '@neo/protocol';

export interface ResolvedUiAction {
  action: UIAction;
  /** Values to forward in the ui_event (form fields only for form submissions). */
  values?: Record<string, unknown>;
}

/** Stable JSON: equivalent object key orders must not change an approval's binding. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!isPlainObject(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  }) ?? 'null';
}

/** Bind the token to both the stored action's validated input and the submitted form values. */
export function uiActionIdentity(input: UiActionInput): string {
  return JSON.stringify([input.conversationId, input.messageId, input.uiId, input.actionId]);
}

/** Hash validated data rather than the model-written input before schema defaults/transforms. */
export function uiActionBinding(input: UiActionInput, tool: string, validatedInput: unknown): string {
  try {
    const inputHash = createHash('sha256').update(stableJson(validatedInput)).digest('hex');
    return createHash('sha256').update(stableJson({
      conversationId: input.conversationId, messageId: input.messageId, uiId: input.uiId,
      actionId: input.actionId, tool, inputHash, values: input.values ?? {},
    })).digest('hex');
  } catch (cause) {
    throw new NeoError('bad_request', 'UI action input and form values must be JSON-serializable.', { cause });
  }
}

/** Confirmation copy comes exclusively from trusted tool metadata and its validated input. */
export function describeUiToolCall(def: ToolDefinition, validatedInput: unknown): string {
  try {
    const description = def.describeCall?.(validatedInput);
    if (typeof description === 'string' && description.trim()) return description;
  } catch {
    // A broken optional description cannot authorize an action or hide its input.
  }
  return `${def.title}: ${stableJson(validatedInput)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The action `actionId` declared by `block`: a form submission, a live-widget
 * control (task toggle, reminder snooze/done, memory forget, change apply) or an
 * action listed in the block tree. Null when the block declares no such action.
 */
export function resolveStoredAction(block: UIBlock, actionId: string, values?: Record<string, unknown>): ResolvedUiAction | null {
  const clientValues = isPlainObject(values) ? values : undefined;
  if (actionId === FORM_SUBMIT_ACTION_ID || actionId.startsWith(`${UI_ACTION_ID_PREFIX}form.submit:`)) {
    const forms = [...walkUIBlocks(block)].filter(({ block: candidate, path }) => candidate.type === 'form'
      && (actionId === FORM_SUBMIT_ACTION_ID || formSubmitActionId(candidate, path) === actionId));
    if (forms.length > 1) throw new NeoError('not_found', `Action "${actionId}" is ambiguous: more than one form matches.`);
    const form = forms[0]?.block;
    if (!form || form.type !== 'form') return null;
    const fields = new Set(form.fields.map((f) => f.name));
    const declared = Object.fromEntries(Object.entries(clientValues ?? {}).filter(([name]) => fields.has(name)));
    return {
      action: { id: actionId, label: form.submitLabel || 'Submit', kind: 'event' },
      values: declared,
    };
  }
  const widget = resolveWidgetAction(block, actionId, clientValues);
  if (widget) return { action: widget };
  if (actionId.startsWith(UI_ACTION_ID_PREFIX) || actionId.startsWith('change.apply:')) return null;
  const action = collectActions([block]).find((a) => a.id === actionId);
  if (!action) return null;
  // Only a trusted changes snapshot may provide apply_change input.
  if (action.kind === 'tool' && action.tool === 'apply_change') return null;
  return clientValues ? { action, values: clientValues } : { action };
}

export function findUiPart(parts: readonly ContentPart[], uiId: string): { part: UIPart; index: number } | null {
  const index = parts.findIndex((p) => p.type === 'ui' && p.id === uiId);
  return index < 0 ? null : { part: parts[index] as UIPart, index };
}

// ───────────────────────────── live widget patching ─────────────────────────────

type TaskItem = Extract<UIBlock, { type: 'tasks' }>['tasks'][number];
type ReminderBlock = Extract<UIBlock, { type: 'reminder' }>;

function mapTree(block: UIBlock, fn: (b: UIBlock) => UIBlock): UIBlock {
  const b = fn(block);
  const map = (children: UIBlock[]) => children.map((c) => mapTree(c, fn));
  switch (b.type) {
    case 'card':
      return b.children ? { ...b, children: map(b.children) } : b;
    case 'grid':
    case 'stack':
      return { ...b, children: map(b.children) };
    case 'tabs':
      return { ...b, tabs: b.tabs.map((t) => ({ ...t, children: map(t.children) })) };
    case 'accordion':
      return { ...b, items: b.items.map((i) => ({ ...i, children: map(i.children) })) };
    default:
      return b;
  }
}

function patchTask(item: TaskItem, task: Record<string, unknown>): TaskItem {
  const next = { ...item };
  if (typeof task.done === 'boolean') next.done = task.done;
  if (typeof task.title === 'string') next.title = task.title.slice(0, 500);
  if (typeof task.dueAt === 'number' || task.dueAt === null) next.dueAt = task.dueAt;
  if (typeof task.priority === 'number' && Number.isInteger(task.priority) && task.priority >= 0 && task.priority <= 3) next.priority = task.priority;
  return next;
}

const REMINDER_STATUSES: readonly ReminderBlock['status'][] = ['scheduled', 'fired', 'completed', 'cancelled'];

function patchReminder(block: ReminderBlock, reminder: Record<string, unknown>): ReminderBlock {
  const next = { ...block };
  if (typeof reminder.dueAt === 'number') next.dueAt = reminder.dueAt;
  if (typeof reminder.title === 'string') next.title = reminder.title.slice(0, 300);
  if (typeof reminder.timezone === 'string') next.timezone = reminder.timezone.slice(0, 64);
  if (typeof reminder.notes === 'string') next.notes = reminder.notes.slice(0, 5000);
  else if (reminder.notes === null) delete next.notes;
  if (reminder.recurrence === null) delete next.recurrenceText;
  else if (reminder.recurrence !== undefined) {
    const recurrence = RecurrenceSchema.safeParse(reminder.recurrence);
    if (recurrence.success) next.recurrenceText = describeRecurrence(recurrence.data).slice(0, 200);
  }
  if (REMINDER_STATUSES.includes(reminder.status as ReminderBlock['status'])) next.status = reminder.status as ReminderBlock['status'];
  return next;
}

/**
 * Apply a tool's output to the live widgets of a block tree: `{ task }` updates the
 * matching item of `tasks` widgets, `{ reminder }` the matching `reminder` widget
 * (the shapes returned by update_task / snooze_reminder / complete_reminder…).
 * `{ change }` marks a proposed change applied alongside any task/reminder update.
 * `{ forgotten, ids }` marks matching memory nodes forgotten, using ids rather than labels.
 * Returns the patched block, or null when nothing changed or the result would be invalid.
 */
export function patchWidgetBlock(block: UIBlock, output: unknown): UIBlock | null {
  if (!isPlainObject(output)) return null;
  const task = isPlainObject(output.task) && typeof output.task.id === 'string' ? output.task : null;
  const reminder = isPlainObject(output.reminder) && typeof output.reminder.id === 'string' ? output.reminder : null;
  const change = isPlainObject(output.change) && typeof output.change.id === 'string' && output.change.status === 'applied' ? output.change : null;
  const forgottenIds = Array.isArray(output.forgotten) && Array.isArray(output.ids) && output.ids.every((id) => typeof id === 'string')
    ? new Set(output.ids as string[]) : null;
  if (!task && !reminder && !change && !forgottenIds?.size) return null;
  const patched = mapTree(block, (b) => {
    if (change && b.type === 'changes' && b.items.some((item) => item.id === change.id)) {
      return { ...b, items: b.items.map((item) => item.id === change.id ? {
        ...item, status: 'applied' as const,
        ...(item.kind === 'reminder.create' && typeof change.reminderId === 'string' ? { reminderId: change.reminderId } : {}),
      } : item) };
    }
    if (task && b.type === 'tasks' && b.tasks.some((t) => t.id === task.id)) {
      return { ...b, tasks: b.tasks.map((t) => (t.id === task.id ? patchTask(t, task) : t)) };
    }
    if (reminder && b.type === 'reminder' && b.reminderId === reminder.id) return patchReminder(b, reminder);
    if (forgottenIds && b.type === 'memory' && b.nodes.some((node) => forgottenIds.has(node.id))) {
      return { ...b, nodes: b.nodes.map((node) => forgottenIds.has(node.id) ? { ...node, status: 'forgotten' as const } : node) };
    }
    return b;
  });
  if (JSON.stringify(patched) === JSON.stringify(block)) return null;
  const valid = validateUIBlocks([patched]);
  return valid.ok ? (valid.blocks[0] ?? null) : null;
}
