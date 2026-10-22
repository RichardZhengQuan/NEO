/**
 * Generative UI.
 *
 * The assistant never ships HTML or code to clients. It emits declarative
 * {@link UIBlock}s (via the `render_ui` tool, a tool result, or a ```neo-ui
 * fenced JSON block) that every client renders with its own native components:
 * React on web/desktop/mobile, plain text in the CLI ({@link uiBlockToText}).
 * Interactions come back as {@link UIAction}s.
 */
import { z } from 'zod';
import { NeoError } from './errors.js';

// ───────────────────────────── primitives ─────────────────────────────

export const ToneSchema = z.enum(['neutral', 'accent', 'info', 'success', 'warning', 'danger']);
export type Tone = z.infer<typeof ToneSchema>;

/** A lucide-style icon name (`"bell"`, `"check-circle"`) or a single emoji. */
export const IconSchema = z.string().min(1).max(40);

const SAFE_IMAGE_URL = /^(https?:\/\/\S+|data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+)$/i;
const SAFE_LINK_URL = /^(https?:\/\/\S+|mailto:\S+|tel:[+\d\s()-]+|neo:\/\/\S+)$/i;

export function isSafeImageUrl(url: string): boolean {
  return SAFE_IMAGE_URL.test(url.trim());
}

/** Links may only be http(s), mailto:, tel: or in-app `neo://` routes. Never `javascript:`. */
export function isSafeLinkUrl(url: string): boolean {
  return SAFE_LINK_URL.test(url.trim());
}

export const ImageUrlSchema = z
  .string()
  .max(4_000_000)
  .refine(isSafeImageUrl, 'Image URLs must be http(s) or data:image/(png|jpeg|gif|webp|avif);base64');
export const LinkUrlSchema = z
  .string()
  .max(4000)
  .refine(isSafeLinkUrl, 'Links must be http(s), mailto:, tel: or neo:// URLs');

const blockId = { id: z.string().min(1).max(64).optional() };

// ───────────────────────────── actions ─────────────────────────────

const actionBase = {
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  style: z.enum(['primary', 'secondary', 'ghost', 'danger']).optional(),
  icon: IconSchema.optional(),
  /** When set, clients ask "are you sure?" with this text before running the action. */
  confirm: z.string().max(200).optional(),
};

/**
 * What happens when the user activates a control:
 * - `message`: send `text` as a normal user message.
 * - `event`:   send a structured UI event to the agent (it sees the label + payload, and form values).
 * - `tool`:    the server runs `tool` with `input` directly (no LLM round trip), subject to tool permissions.
 * - `link`:    open a URL (`neo://` URLs navigate inside the app).
 * - `copy`:    copy `text` to the clipboard.
 */
export const UIActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...actionBase, kind: z.literal('message'), text: z.string().min(1).max(4000) }),
  z.object({ ...actionBase, kind: z.literal('event'), payload: z.unknown().optional() }),
  z.object({
    ...actionBase,
    kind: z.literal('tool'),
    tool: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ ...actionBase, kind: z.literal('link'), url: LinkUrlSchema }),
  z.object({ ...actionBase, kind: z.literal('copy'), text: z.string().max(20_000) }),
]);
export type UIAction = z.infer<typeof UIActionSchema>;
export type UIActionKind = UIAction['kind'];

/** Reserved namespace for built-in actions; model-authored actions may not use it. */
export const UI_ACTION_ID_PREFIX = '__neo:';

/** Legacy form submit id; accepted only when the stored tree has one form. */
export const FORM_SUBMIT_ACTION_ID = '__submit';

// ───────────────────────────── leaf blocks ─────────────────────────────

export const TextBlockSchema = z.object({ ...blockId, type: z.literal('text'), text: z.string().max(20_000) });
export const HeadingBlockSchema = z.object({
  ...blockId,
  type: z.literal('heading'),
  text: z.string().max(300),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

export const ListItemSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(300),
  subtitle: z.string().max(1000).optional(),
  icon: IconSchema.optional(),
  imageUrl: ImageUrlSchema.optional(),
  meta: z.string().max(100).optional(),
  badge: z.string().max(40).optional(),
  tone: ToneSchema.optional(),
  action: UIActionSchema.optional(),
});
export type ListItem = z.infer<typeof ListItemSchema>;
export const ListBlockSchema = z.object({
  ...blockId,
  type: z.literal('list'),
  title: z.string().max(200).optional(),
  ordered: z.boolean().optional(),
  items: z.array(ListItemSchema).max(100),
});

const CellSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
export const TableBlockSchema = z.object({
  ...blockId,
  type: z.literal('table'),
  caption: z.string().max(300).optional(),
  columns: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        label: z.string().max(100),
        align: z.enum(['left', 'center', 'right']).optional(),
        format: z.enum(['text', 'number', 'currency', 'percent', 'date']).optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      }),
    )
    .min(1)
    .max(12),
  rows: z.array(z.record(z.string(), CellSchema)).max(500),
});

export const ChartBlockSchema = z.object({
  ...blockId,
  type: z.literal('chart'),
  kind: z.enum(['bar', 'line', 'area', 'pie', 'donut']),
  title: z.string().max(200).optional(),
  xLabel: z.string().max(100).optional(),
  yLabel: z.string().max(100).optional(),
  unit: z.string().max(20).optional(),
  stacked: z.boolean().optional(),
  series: z
    .array(
      z.object({
        name: z.string().max(100),
        data: z.array(z.object({ x: z.union([z.string().max(100), z.number()]), y: z.number() })).max(1000),
      }),
    )
    .min(1)
    .max(8),
});

export const StatBlockSchema = z.object({
  ...blockId,
  type: z.literal('stat'),
  label: z.string().max(100),
  value: z.union([z.string().max(100), z.number()]),
  unit: z.string().max(20).optional(),
  delta: z.number().optional(),
  deltaLabel: z.string().max(60).optional(),
  caption: z.string().max(200).optional(),
  tone: ToneSchema.optional(),
  icon: IconSchema.optional(),
});

export const ProgressBlockSchema = z.object({
  ...blockId,
  type: z.literal('progress'),
  label: z.string().max(200).optional(),
  value: z.number().min(0).max(1),
  caption: z.string().max(200).optional(),
  tone: ToneSchema.optional(),
});

export const FormFieldSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][\w-]{0,63}$/),
  label: z.string().max(120),
  kind: z.enum([
    'text',
    'textarea',
    'number',
    'email',
    'url',
    'select',
    'multiselect',
    'checkbox',
    'switch',
    'date',
    'time',
    'datetime',
    'slider',
  ]),
  required: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
  help: z.string().max(300).optional(),
  options: z.array(z.object({ value: z.string().max(200), label: z.string().max(200) })).max(100).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  defaultValue: z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(200))]).optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;
export const FormBlockSchema = z.object({
  ...blockId,
  type: z.literal('form'),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  fields: z.array(FormFieldSchema).min(1).max(30),
  submitLabel: z.string().max(60).optional(),
});

export const ButtonsBlockSchema = z.object({
  ...blockId,
  type: z.literal('buttons'),
  actions: z.array(UIActionSchema).min(1).max(8),
  layout: z.enum(['row', 'column']).optional(),
});

export const ImageBlockSchema = z.object({
  ...blockId,
  type: z.literal('image'),
  url: ImageUrlSchema,
  alt: z.string().max(300),
  caption: z.string().max(300).optional(),
  aspectRatio: z.number().positive().max(10).optional(),
});

export const GalleryBlockSchema = z.object({
  ...blockId,
  type: z.literal('gallery'),
  images: z
    .array(z.object({ url: ImageUrlSchema, alt: z.string().max(300), caption: z.string().max(300).optional() }))
    .min(1)
    .max(24),
});

export const CalloutBlockSchema = z.object({
  ...blockId,
  type: z.literal('callout'),
  tone: ToneSchema,
  title: z.string().max(200).optional(),
  text: z.string().max(5000),
  icon: IconSchema.optional(),
});

export const CodeBlockSchema = z.object({
  ...blockId,
  type: z.literal('code'),
  code: z.string().max(100_000),
  language: z.string().max(30).optional(),
  filename: z.string().max(200).optional(),
});

export const QuoteBlockSchema = z.object({
  ...blockId,
  type: z.literal('quote'),
  text: z.string().max(5000),
  cite: z.string().max(200).optional(),
});

export const DividerBlockSchema = z.object({ ...blockId, type: z.literal('divider'), label: z.string().max(60).optional() });

export const LinkBlockSchema = z.object({
  ...blockId,
  type: z.literal('link'),
  url: LinkUrlSchema,
  title: z.string().max(300),
  description: z.string().max(1000).optional(),
  imageUrl: ImageUrlSchema.optional(),
  siteName: z.string().max(100).optional(),
});

export const TimelineBlockSchema = z.object({
  ...blockId,
  type: z.literal('timeline'),
  title: z.string().max(200).optional(),
  items: z
    .array(
      z.object({
        id: z.string().max(64).optional(),
        /** Epoch ms (rendered in the viewer's timezone) or a display string. */
        time: z.union([
          z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15, { message: 'epoch-ms value out of ECMAScript Date range' }),
          z.string().max(60),
        ]),
        title: z.string().max(300),
        description: z.string().max(1000).optional(),
        icon: IconSchema.optional(),
        tone: ToneSchema.optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const KeyValueBlockSchema = z.object({
  ...blockId,
  type: z.literal('keyvalue'),
  title: z.string().max(200).optional(),
  items: z
    .array(z.object({ key: z.string().max(100), value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]) }))
    .min(1)
    .max(40),
});

export const TagsBlockSchema = z.object({
  ...blockId,
  type: z.literal('tags'),
  items: z
    .array(z.object({ label: z.string().max(60), tone: ToneSchema.optional(), icon: IconSchema.optional() }))
    .min(1)
    .max(30),
});

export const CountdownBlockSchema = z.object({
  ...blockId,
  type: z.literal('countdown'),
  label: z.string().max(200),
  /** Epoch ms. */
  until: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15, { message: 'epoch-ms value out of ECMAScript Date range' }),
  timezone: z.string().max(64).optional(),
  doneText: z.string().max(200).optional(),
});

/** Live reminder widget. Clients may refresh it from the reminders API by `reminderId`. */
export const ReminderBlockSchema = z.object({
  ...blockId,
  type: z.literal('reminder'),
  reminderId: z.string().min(1).max(64),
  title: z.string().max(300),
  notes: z.string().max(5000).optional(),
  dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15, { message: 'epoch-ms value out of ECMAScript Date range' }),
  timezone: z.string().max(64).optional(),
  recurrenceText: z.string().max(200).optional(),
  status: z.enum(['scheduled', 'fired', 'completed', 'cancelled']),
});

/** Live task-list widget. Checkbox toggles run the `update_task` tool directly. */
export const TasksBlockSchema = z.object({
  ...blockId,
  type: z.literal('tasks'),
  title: z.string().max(200).optional(),
  listId: z.string().max(64).optional(),
  timezone: z.string().max(64).optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().max(500),
        done: z.boolean(),
        dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15, { message: 'epoch-ms value out of ECMAScript Date range' }).nullable().optional(),
        priority: z.number().int().min(0).max(3).optional(),
      }),
    )
    .max(100),
});

export const TaskFieldsSchema = z.object({
  dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15, { message: 'epoch-ms value out of ECMAScript Date range' }).nullable().optional(),
  title: z.string().min(1).max(1000).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  done: z.boolean().optional(),
}).strict();
export type TaskFields = z.infer<typeof TaskFieldsSchema>;

export const ReminderFieldsSchema = z.object({
  dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15, { message: 'epoch-ms value out of ECMAScript Date range' }).optional(),
  title: z.string().min(1).max(500).optional(),
  timezone: z.string().optional(),
}).strict();
export type ReminderFields = z.infer<typeof ReminderFieldsSchema>;

function matchingFields(item: { before: object; after: object }): boolean {
  const before = Object.keys(item.before);
  const after = Object.keys(item.after);
  return after.length > 0 && before.length === after.length
    && after.every((key) => before.includes(key))
    && Object.values(item.before).every((value) => value !== undefined)
    && Object.values(item.after).every((value) => value !== undefined);
}

const changeItemBase = {
  id: z.string().min(1).max(64),
  status: z.enum(['pending', 'applied']).optional(),
};

/** Trusted before/after snapshots created by productivity tools, never by the model. */
export const ChangeItemSchema = z.discriminatedUnion('kind', [
  z.object({
    ...changeItemBase,
    kind: z.literal('task.update'),
    taskId: z.string().min(1).max(64),
    title: z.string().max(500),
    before: TaskFieldsSchema,
    after: TaskFieldsSchema,
  }).refine(matchingFields, 'Before must contain exactly the fields in a non-empty after.'),
  z.object({
    ...changeItemBase,
    kind: z.literal('reminder.create'),
    title: z.string().min(1).max(500),
    dueAt: z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= 8.64e15, { message: 'epoch-ms value out of ECMAScript Date range' }),
    timezone: z.string().max(64).optional(),
    notes: z.string().max(5000).optional(),
    creationKey: z.uuid(),
    reminderId: z.string().min(1).max(64).optional(),
  }),
  z.object({
    ...changeItemBase,
    kind: z.literal('reminder.update'),
    reminderId: z.string().min(1).max(64),
    title: z.string().max(500),
    before: ReminderFieldsSchema,
    after: ReminderFieldsSchema,
  }).refine(matchingFields, 'Before must contain exactly the fields in a non-empty after.'),
]);
export type ChangeItem = z.infer<typeof ChangeItemSchema>;

/** Reviewable edits; each pending item applies its stored snapshot through apply_change. */
export const ChangesBlockSchema = z.object({
  ...blockId,
  type: z.literal('changes'),
  title: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  timezone: z.string().max(64).optional(),
  items: z.array(ChangeItemSchema).min(1).max(50)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'Change item ids must be unique.'),
});

/** Shows memories NEO just formed or recalled, with forget controls. */
export const MemoryBlockSchema = z.object({
  ...blockId,
  type: z.literal('memory'),
  title: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        kind: z.string().max(30),
        label: z.string().max(300),
        content: z.string().max(2000).optional(),
        status: z.enum(['active', 'archived', 'superseded', 'forgotten']).optional(),
      }),
    )
    .min(1)
    .max(20),
});

// ───────────────────────────── container blocks (recursive) ─────────────────────────────

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type HeadingBlock = z.infer<typeof HeadingBlockSchema>;
export type ListBlock = z.infer<typeof ListBlockSchema>;
export type TableBlock = z.infer<typeof TableBlockSchema>;
export type ChartBlock = z.infer<typeof ChartBlockSchema>;
export type StatBlock = z.infer<typeof StatBlockSchema>;
export type ProgressBlock = z.infer<typeof ProgressBlockSchema>;
export type FormBlock = z.infer<typeof FormBlockSchema>;
export type ButtonsBlock = z.infer<typeof ButtonsBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type GalleryBlock = z.infer<typeof GalleryBlockSchema>;
export type CalloutBlock = z.infer<typeof CalloutBlockSchema>;
export type CodeBlock = z.infer<typeof CodeBlockSchema>;
export type QuoteBlock = z.infer<typeof QuoteBlockSchema>;
export type DividerBlock = z.infer<typeof DividerBlockSchema>;
export type LinkBlock = z.infer<typeof LinkBlockSchema>;
export type TimelineBlock = z.infer<typeof TimelineBlockSchema>;
export type KeyValueBlock = z.infer<typeof KeyValueBlockSchema>;
export type TagsBlock = z.infer<typeof TagsBlockSchema>;
export type CountdownBlock = z.infer<typeof CountdownBlockSchema>;
export type ReminderBlock = z.infer<typeof ReminderBlockSchema>;
export type TasksBlock = z.infer<typeof TasksBlockSchema>;
export type ChangesBlock = z.infer<typeof ChangesBlockSchema>;
export type MemoryBlock = z.infer<typeof MemoryBlockSchema>;

export interface CardBlock {
  id?: string | undefined;
  type: 'card';
  title?: string | undefined;
  subtitle?: string | undefined;
  icon?: string | undefined;
  imageUrl?: string | undefined;
  tone?: Tone | undefined;
  children?: UIBlock[] | undefined;
  actions?: UIAction[] | undefined;
  footer?: string | undefined;
}
export interface GridBlock {
  id?: string | undefined;
  type: 'grid';
  columns: number;
  children: UIBlock[];
}
export interface StackBlock {
  id?: string | undefined;
  type: 'stack';
  direction?: 'vertical' | 'horizontal' | undefined;
  gap?: 'sm' | 'md' | 'lg' | undefined;
  children: UIBlock[];
}
export interface TabsBlock {
  id?: string | undefined;
  type: 'tabs';
  tabs: { id: string; label: string; icon?: string | undefined; children: UIBlock[] }[];
}
export interface AccordionBlock {
  id?: string | undefined;
  type: 'accordion';
  items: { id: string; title: string; open?: boolean | undefined; children: UIBlock[] }[];
}

export type UIBlock =
  | TextBlock
  | HeadingBlock
  | CardBlock
  | ListBlock
  | TableBlock
  | ChartBlock
  | StatBlock
  | ProgressBlock
  | FormBlock
  | ButtonsBlock
  | ImageBlock
  | GalleryBlock
  | CalloutBlock
  | CodeBlock
  | QuoteBlock
  | DividerBlock
  | GridBlock
  | StackBlock
  | TabsBlock
  | AccordionBlock
  | LinkBlock
  | TimelineBlock
  | KeyValueBlock
  | TagsBlock
  | CountdownBlock
  | ReminderBlock
  | TasksBlock
  | ChangesBlock
  | MemoryBlock;

export type UIBlockType = UIBlock['type'];

export const UIBlockSchema: z.ZodType<UIBlock> = z.lazy(() =>
  z.discriminatedUnion('type', [
    TextBlockSchema,
    HeadingBlockSchema,
    CardBlockSchema,
    ListBlockSchema,
    TableBlockSchema,
    ChartBlockSchema,
    StatBlockSchema,
    ProgressBlockSchema,
    FormBlockSchema,
    ButtonsBlockSchema,
    ImageBlockSchema,
    GalleryBlockSchema,
    CalloutBlockSchema,
    CodeBlockSchema,
    QuoteBlockSchema,
    DividerBlockSchema,
    GridBlockSchema,
    StackBlockSchema,
    TabsBlockSchema,
    AccordionBlockSchema,
    LinkBlockSchema,
    TimelineBlockSchema,
    KeyValueBlockSchema,
    TagsBlockSchema,
    CountdownBlockSchema,
    ReminderBlockSchema,
    TasksBlockSchema,
    ChangesBlockSchema,
    MemoryBlockSchema,
  ]),
);

const children = () => z.array(UIBlockSchema).max(60);

const CardBlockSchema = z.object({
  ...blockId,
  type: z.literal('card'),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  icon: IconSchema.optional(),
  imageUrl: ImageUrlSchema.optional(),
  tone: ToneSchema.optional(),
  children: children().optional(),
  actions: z.array(UIActionSchema).max(8).optional(),
  footer: z.string().max(300).optional(),
});
const GridBlockSchema = z.object({
  ...blockId,
  type: z.literal('grid'),
  columns: z.number().int().min(1).max(4),
  children: children(),
});
const StackBlockSchema = z.object({
  ...blockId,
  type: z.literal('stack'),
  direction: z.enum(['vertical', 'horizontal']).optional(),
  gap: z.enum(['sm', 'md', 'lg']).optional(),
  children: children(),
});
const TabsBlockSchema = z.object({
  ...blockId,
  type: z.literal('tabs'),
  tabs: z
    .array(z.object({ id: z.string().min(1).max(64), label: z.string().max(60), icon: IconSchema.optional(), children: children() }))
    .min(1)
    .max(8),
});
const AccordionBlockSchema = z.object({
  ...blockId,
  type: z.literal('accordion'),
  items: z
    .array(z.object({ id: z.string().min(1).max(64), title: z.string().max(200), open: z.boolean().optional(), children: children() }))
    .min(1)
    .max(20),
});

export { CardBlockSchema, GridBlockSchema, StackBlockSchema, TabsBlockSchema, AccordionBlockSchema };

/** All block type names, for docs, prompts and renderers. */
export const UI_BLOCK_TYPES: readonly UIBlockType[] = [
  'text',
  'heading',
  'card',
  'list',
  'table',
  'chart',
  'stat',
  'progress',
  'form',
  'buttons',
  'image',
  'gallery',
  'callout',
  'code',
  'quote',
  'divider',
  'grid',
  'stack',
  'tabs',
  'accordion',
  'link',
  'timeline',
  'keyvalue',
  'tags',
  'countdown',
  'reminder',
  'tasks',
  'changes',
  'memory',
];

// ───────────────────────────── validation ─────────────────────────────

export const MAX_UI_DEPTH = 8;
export const MAX_UI_BLOCKS = 300;
export const MAX_UI_TOP_LEVEL = 50;

/** Direct children of a block (containers only). */
export function childBlocks(block: UIBlock): UIBlock[] {
  switch (block.type) {
    case 'card':
      return block.children ?? [];
    case 'grid':
    case 'stack':
      return block.children;
    case 'tabs':
      return block.tabs.flatMap((t) => t.children);
    case 'accordion':
      return block.items.flatMap((i) => i.children);
    default:
      return [];
  }
}

/** Stable block key: an encoded explicit id, or child indexes from the UI part's root. */
export function uiBlockKey(block: UIBlock, path: readonly number[]): string {
  return block.id !== undefined ? `id:${encodeURIComponent(block.id)}` : `path:${path.length ? path.join('.') : 'root'}`;
}

/** Traverse a stored tree in childBlocks order, including hidden tabs and accordion items. */
export function* walkUIBlocks(root: UIBlock, path: readonly number[] = []): Generator<{ block: UIBlock; path: readonly number[]; key: string }> {
  yield { block: root, path, key: uiBlockKey(root, path) };
  const children = childBlocks(root);
  for (let i = 0; i < children.length; i++) yield* walkUIBlocks(children[i]!, [...path, i]);
}

/** Target-aware form submit id; values travel in the UI event. */
export function formSubmitActionId(form: FormBlock, path: readonly number[] = []): string {
  return `${UI_ACTION_ID_PREFIX}form.submit:${uiBlockKey(form, path)}`;
}

export const TOOL_ONLY_BLOCK_TYPES = ['changes'] as const;

/** Find a tool-only widget anywhere in a block tree, including closed containers. */
export function findToolOnlyBlock(blocks: readonly UIBlock[]): UIBlock | null {
  for (const block of blocks) {
    if (TOOL_ONLY_BLOCK_TYPES.some((type) => type === block.type)) return block;
    const nested = findToolOnlyBlock(childBlocks(block));
    if (nested) return nested;
  }
  return null;
}

/** Every action reachable in a block tree (card actions, buttons, list item actions). */
export function collectActions(blocks: UIBlock[]): UIAction[] {
  const out: UIAction[] = [];
  const visit = (b: UIBlock) => {
    if (b.type === 'card' && b.actions) out.push(...b.actions);
    if (b.type === 'buttons') out.push(...b.actions);
    if (b.type === 'list') for (const item of b.items) if (item.action) out.push(item.action);
    childBlocks(b).forEach(visit);
  };
  blocks.forEach(visit);
  return out;
}

export type UIValidationResult = { ok: true; blocks: UIBlock[] } | { ok: false; error: string; issues?: unknown };

/** Parse untrusted model output into UI blocks, enforcing schema, depth and size limits. */
export function validateUIBlocks(input: unknown): UIValidationResult {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) return { ok: false, error: 'No UI blocks given.' };
  if (list.length > MAX_UI_TOP_LEVEL) return { ok: false, error: `At most ${MAX_UI_TOP_LEVEL} top-level blocks are allowed.` };
  // Wrap safeParse: Zod's recursive UIBlockSchema parse can throw RangeError for
  // deeply nested input before our own depth check runs. Convert to typed rejection.
  const parseResult = (() => {
    try {
      return z.array(UIBlockSchema).safeParse(list);
    } catch (e) {
      if (e instanceof RangeError) return null;
      throw e;
    }
  })();
  if (parseResult === null) return { ok: false, error: `UI blocks may nest at most ${MAX_UI_DEPTH} levels deep.` };
  const parsed = parseResult;
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error), issues: parsed.error.issues };
  }
  let count = 0;
  let tooDeep = false;
  const walk = (b: UIBlock, depth: number) => {
    count++;
    if (depth > MAX_UI_DEPTH) tooDeep = true;
    for (const c of childBlocks(b)) walk(c, depth + 1);
  };
  for (const b of parsed.data) walk(b, 1);
  if (tooDeep) return { ok: false, error: `UI blocks may nest at most ${MAX_UI_DEPTH} levels deep.` };
  if (count > MAX_UI_BLOCKS) return { ok: false, error: `At most ${MAX_UI_BLOCKS} UI blocks are allowed per message.` };
  const ids = collectActions(parsed.data).map((a) => a.id);
  const reserved = ids.find((id) => id.startsWith(UI_ACTION_ID_PREFIX));
  if (reserved) return { ok: false, error: `Action id "${reserved}" uses the reserved "${UI_ACTION_ID_PREFIX}" prefix.` };
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return { ok: false, error: `Duplicate action id "${dup}"; action ids must be unique within a message.` };
  return { ok: true, blocks: parsed.data };
}

/**
 * Extract ```neo-ui fenced JSON blocks from model text (fallback for models
 * without tool calling). Returns the text with fences removed plus the blocks.
 */
export function extractInlineUI(text: string): { text: string; blocks: UIBlock[]; errors: string[] } {
  const blocks: UIBlock[] = [];
  const errors: string[] = [];
  const stripped = text.replace(/```neo-ui\s*\n([\s\S]*?)```/g, (_m, json: string) => {
    try {
      const result = validateUIBlocks(JSON.parse(json));
      if (result.ok) {
        const filter = (list: UIBlock[]): UIBlock[] => list.flatMap((block): UIBlock[] => {
          if (TOOL_ONLY_BLOCK_TYPES.some((type) => type === block.type)) {
            errors.push('The changes block is only available via propose_changes, not inline UI.');
            return [];
          }
          switch (block.type) {
            case 'card': return [{ ...block, ...(block.children ? { children: filter(block.children) } : {}) }];
            case 'grid':
            case 'stack': return [{ ...block, children: filter(block.children) }];
            case 'tabs': return [{ ...block, tabs: block.tabs.map((tab) => ({ ...tab, children: filter(tab.children) })) }];
            case 'accordion': return [{ ...block, items: block.items.map((item) => ({ ...item, children: filter(item.children) })) }];
            default: return [block];
          }
        });
        blocks.push(...filter(result.blocks));
      }
      else errors.push(result.error);
    } catch (e) {
      errors.push(`Invalid neo-ui JSON: ${(e as Error).message}`);
    }
    return '';
  });

  // Aggregate re-check across all fences: the combined blocks form one assistant
  // message, so the per-message limits and uniqueness rules apply to the whole set.
  // Run unconditionally — per-fence errors do not excuse the successfully parsed
  // blocks from the aggregate limits.
  if (blocks.length > MAX_UI_TOP_LEVEL) {
    errors.push(`At most ${MAX_UI_TOP_LEVEL} top-level blocks are allowed.`);
    blocks.splice(0);
  } else {
    let totalCount = 0;
    const countBlocks = (b: UIBlock) => {
      totalCount++;
      for (const c of childBlocks(b)) countBlocks(c);
    };
    for (const b of blocks) countBlocks(b);
    if (totalCount > MAX_UI_BLOCKS) {
      errors.push(`At most ${MAX_UI_BLOCKS} UI blocks are allowed per message.`);
      blocks.splice(0);
    } else {
      const ids = collectActions(blocks).map((a) => a.id);
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup) {
        errors.push(`Duplicate action id "${dup}"; action ids must be unique within a message.`);
        blocks.splice(0);
      }
    }
  }

  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), blocks, errors };
}

// ───────────────────────────── text fallback ─────────────────────────────

const TONE_PREFIX: Record<Tone, string> = {
  neutral: '•',
  accent: '★',
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  danger: '✖',
};

function fmtTime(ms: number, timezone?: string): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '—';
  try {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function actionsText(actions: UIAction[] | undefined): string {
  return actions && actions.length ? actions.map((a) => `[${a.label}]${a.kind === 'link' ? ` <${a.url}>` : ''}`).join(' ') : '';
}

/** Shared table formatting for visual clients and plain-text fallbacks. */
export function formatTableCell(value: string | number | boolean | null | undefined, format: string | undefined, locale = 'en-US', currency = 'USD'): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  try {
    if (typeof value === 'number') {
      if (format === 'currency') return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
      if (format === 'percent') return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
      if (format !== 'date') return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
    }
    if (format === 'date') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
    }
  } catch {
    // Invalid stored formats fall back to their original value.
  }
  return String(value);
}

/** Render a block tree as readable plain text (CLI, notifications, model summaries). */
export function uiBlockToText(block: UIBlock, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  const push = (s: string) => {
    for (const line of s.split('\n')) lines.push(pad + line);
  };
  const nested = (bs: UIBlock[]) => {
    for (const b of bs) lines.push(uiBlockToText(b, indent + 1));
  };
  switch (block.type) {
    case 'text':
      push(block.text);
      break;
    case 'heading':
      push(`${'#'.repeat(block.level ?? 2)} ${block.text}`);
      break;
    case 'card': {
      const head = [block.icon && !/^[a-z-]+$/.test(block.icon) ? block.icon : '', block.title ?? ''].join(' ').trim();
      if (head) push(`┌ ${head}`);
      if (block.subtitle) push(`│ ${block.subtitle}`);
      if (block.children) nested(block.children);
      if (block.footer) push(`│ ${block.footer}`);
      const acts = actionsText(block.actions);
      if (acts) push(`└ ${acts}`);
      break;
    }
    case 'list':
      if (block.title) push(block.title);
      block.items.forEach((item, i) => {
        const bullet = block.ordered ? `${i + 1}.` : '-';
        const extra = [item.subtitle, item.meta, item.badge].filter(Boolean).join(' · ');
        push(`${bullet} ${item.title}${extra ? ` — ${extra}` : ''}${item.action ? ` ${actionsText([item.action])}` : ''}`);
      });
      break;
    case 'table': {
      if (block.caption) push(block.caption);
      const cols = block.columns;
      const cell = (r: TableBlock['rows'][number], c: TableBlock['columns'][number]) => formatTableCell(r[c.key], c.format, 'en-US', c.currency);
      const widths = cols.map((c) => Math.min(40, Math.max(c.label.length, ...block.rows.map((r) => cell(r, c).length))));
      const row = (vals: string[]) => vals.map((v, i) => v.slice(0, 40).padEnd(widths[i] ?? 0)).join(' │ ');
      push(row(cols.map((c) => c.label)));
      push(widths.map((w) => '─'.repeat(w)).join('─┼─'));
      for (const r of block.rows.slice(0, 50)) push(row(cols.map((c) => cell(r, c))));
      if (block.rows.length > 50) push(`… ${block.rows.length - 50} more rows`);
      break;
    }
    case 'chart':
      push(`📊 ${block.title ?? `${block.kind} chart`}${block.unit ? ` (${block.unit})` : ''}`);
      for (const s of block.series) {
        const pts = s.data.slice(0, 12).map((p) => `${p.x}: ${p.y}`).join(', ');
        push(`  ${s.name}: ${pts}${s.data.length > 12 ? ', …' : ''}`);
      }
      break;
    case 'stat': {
      const delta = block.delta === undefined ? '' : ` (${block.delta >= 0 ? '+' : ''}${block.delta}${block.deltaLabel ? ` ${block.deltaLabel}` : ''})`;
      push(`${block.label}: ${block.value}${block.unit ? ` ${block.unit}` : ''}${delta}`);
      if (block.caption) push(`  ${block.caption}`);
      break;
    }
    case 'progress': {
      const pct = Math.round(block.value * 100);
      const filled = Math.round(block.value * 20);
      push(`${block.label ? `${block.label} ` : ''}[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${pct}%`);
      if (block.caption) push(block.caption);
      break;
    }
    case 'form':
      push(`📝 ${block.title ?? 'Form'}`);
      if (block.description) push(block.description);
      for (const f of block.fields) {
        push(`  • ${f.label}${f.required ? ' *' : ''} (${f.kind})`);
        if (f.help) push(`    ${f.help}`);
        if (f.placeholder) push(`    ${f.placeholder}`);
        if (f.options?.length) push(`    Options: ${f.options.map((o) => `${o.label} (${o.value})`).join(', ')}`);
        const bounds = [f.min !== undefined ? `min ${f.min}` : '', f.max !== undefined ? `max ${f.max}` : '', f.step !== undefined ? `step ${f.step}` : ''].filter(Boolean);
        if (bounds.length) push(`    ${bounds.join(', ')}`);
        if (f.defaultValue !== undefined) push(`    Default: ${Array.isArray(f.defaultValue) ? f.defaultValue.join(', ') : f.defaultValue}`);
      }
      push(`  [${block.submitLabel ?? 'Submit'}]`);
      break;
    case 'buttons':
      push(actionsText(block.actions));
      break;
    case 'image':
      push(`🖼  ${block.alt}${block.caption ? ` — ${block.caption}` : ''}`);
      break;
    case 'gallery':
      for (const img of block.images) push(`🖼  ${img.alt}${img.caption ? ` — ${img.caption}` : ''}`);
      break;
    case 'callout':
      push(`${TONE_PREFIX[block.tone]} ${block.title ? `${block.title}: ` : ''}${block.text}`);
      break;
    case 'code':
      if (block.filename) push(block.filename);
      push(`\`\`\`${block.language ?? ''}\n${block.code}\n\`\`\``);
      break;
    case 'quote':
      push(`> ${block.text}${block.cite ? `\n> — ${block.cite}` : ''}`);
      break;
    case 'divider':
      push(block.label ? `──── ${block.label} ────` : '────────────');
      break;
    case 'grid':
    case 'stack':
      nested(block.children);
      break;
    case 'tabs':
      for (const t of block.tabs) {
        push(`▸ ${t.label}`);
        nested(t.children);
      }
      break;
    case 'accordion':
      for (const item of block.items) {
        push(`▸ ${item.title}`);
        nested(item.children);
      }
      break;
    case 'link':
      push(`🔗 ${block.title} <${block.url}>${block.description ? `\n   ${block.description}` : ''}`);
      break;
    case 'timeline':
      if (block.title) push(block.title);
      for (const item of block.items) {
        const t = typeof item.time === 'number' ? fmtTime(item.time) : item.time;
        push(`  ${t} — ${item.title}${item.description ? `: ${item.description}` : ''}`);
      }
      break;
    case 'keyvalue':
      if (block.title) push(block.title);
      for (const kv of block.items) push(`  ${kv.key}: ${kv.value ?? '—'}`);
      break;
    case 'tags':
      push(block.items.map((t) => `#${t.label}`).join(' '));
      break;
    case 'countdown':
      push(`⏳ ${block.label} — ${fmtTime(block.until, block.timezone)}`);
      break;
    case 'reminder':
      push(
        `⏰ ${block.title} — ${fmtTime(block.dueAt, block.timezone)}${block.recurrenceText ? ` (${block.recurrenceText})` : ''} [${block.status}]`,
      );
      if (block.notes) push(block.notes);
      break;
    case 'tasks':
      if (block.title) push(block.title);
      for (const t of block.tasks) push(`  ${t.done ? '☑' : '☐'} ${t.title}${t.dueAt != null ? ` (due ${fmtTime(t.dueAt)})` : ''}${t.priority ? ` [priority ${t.priority}]` : ''}`);
      break;
    case 'changes':
      push(block.title ?? 'Proposed changes');
      if (block.note) push(block.note);
      for (const item of block.items) {
        const applied = item.status === 'applied' ? ' (applied)' : '';
        if (item.kind === 'reminder.create') {
          push(`• New reminder: ${item.title}, ${fmtTime(item.dueAt, block.timezone ?? item.timezone)}${applied}`);
          if (item.notes) push(`  ${item.notes}`);
          continue;
        }
        const edits: string[] = [];
        if (item.after.dueAt !== undefined) {
          const time = (value: number | null | undefined) => value == null ? 'No due date' : fmtTime(value, block.timezone);
          edits.push(`due ${time(item.before.dueAt)} → ${time(item.after.dueAt)}`);
        }
        if (item.after.title !== undefined) edits.push(`title ${item.before.title} → ${item.after.title}`);
        if (item.kind === 'reminder.update' && item.after.timezone !== undefined) {
          edits.push(`timezone ${item.before.timezone} → ${item.after.timezone}`);
        }
        if (item.kind === 'task.update') {
          if (item.after.priority !== undefined) edits.push(`priority ${item.before.priority} → ${item.after.priority}`);
          if (item.after.done !== undefined) edits.push(item.after.done ? 'Mark done' : 'Reopen');
        }
        push(`• ${item.title}: ${edits.join('; ')}${applied}`);
      }
      break;
    case 'memory':
      push(`🧠 ${block.title ?? 'Memory'}${block.note ? ` — ${block.note}` : ''}`);
      for (const n of block.nodes) {
        push(`  • [${n.kind}] ${n.label}${n.status && n.status !== 'active' ? ` (${n.status})` : ''}`);
        if (n.content && n.content !== n.label) push(`    ${n.content}`);
      }
      break;
  }
  return lines.join('\n');
}

export function uiBlocksToText(blocks: UIBlock[]): string {
  return blocks.map((b) => uiBlockToText(b)).join('\n\n');
}

// ───────────────────────────── live widget actions ─────────────────────────────

/**
 * Built-in controls of live widgets (task checkboxes, reminder snooze/done,
 * memory forget, proposed change apply). Clients send these action ids to the
 * ui-action endpoint; the server resolves them against the STORED block with
 * {@link resolveWidgetAction}, so a client can only act on items the block shows.
 */
export const widgetActionId = {
  taskToggle: (taskId: string) => `task.toggle:${taskId}`,
  reminderSnooze: (reminderId: string, minutes: number) => `${UI_ACTION_ID_PREFIX}reminder.snooze:${encodeURIComponent(reminderId)}:${minutes}`,
  reminderComplete: (reminderId: string) => `${UI_ACTION_ID_PREFIX}reminder.complete:${encodeURIComponent(reminderId)}`,
  memoryForget: (nodeId: string) => `memory.forget:${nodeId}`,
  changeApply: (itemId: string) => `change.apply:${itemId}`,
} as const;

/** Map a widget action id to the tool action it stands for, or null when it doesn't apply to this block tree. */
export function resolveWidgetAction(root: UIBlock, actionId: string, values?: Record<string, unknown>): UIAction | null {
  const blocks = [...walkUIBlocks(root)].map(({ block }) => block);
  const snooze = actionId.match(/^__neo:reminder\.snooze:([^:]+):([^:]+)$/);
  const complete = actionId.match(/^__neo:reminder\.complete:([^:]+)$/);
  const legacySnooze = actionId.match(/^reminder\.snooze:([^:]+)$/);
  const legacyComplete = actionId === 'reminder.complete';
  if (snooze || complete || legacySnooze || legacyComplete) {
    const minutes = snooze || legacySnooze ? Number(snooze?.[2] ?? legacySnooze?.[1]) : undefined;
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60)) return null;
    let reminderId: string | undefined;
    if (snooze || complete) {
      try {
        reminderId = decodeURIComponent((snooze ?? complete)![1]!);
      } catch {
        return null;
      }
    }
    const reminders = blocks.filter((b): b is ReminderBlock => b.type === 'reminder'
      && (reminderId === undefined || b.reminderId === reminderId));
    if (reminderId === undefined && reminders.length > 1) {
      throw new NeoError('not_found', 'This reminder action is ambiguous; the stored UI contains multiple reminders.');
    }
    const reminder = reminders[0];
    if (!reminder) return null;
    return minutes === undefined
      ? { id: actionId, label: 'Done', kind: 'tool', tool: 'complete_reminder', input: { id: reminder.reminderId } }
      : { id: actionId, label: `Snooze ${minutes} min`, kind: 'tool', tool: 'snooze_reminder', input: { id: reminder.reminderId, minutes } };
  }
  const [verb, arg = ''] = actionId.split(/:(.*)/s, 2) as [string, string | undefined];
  for (const b of blocks) {
    if (b.type === 'changes' && verb === 'change.apply') {
      const item = b.items.find((item) => item.id === arg && item.status !== 'applied');
      if (item) return { id: actionId, label: 'Apply change', kind: 'tool', tool: 'apply_change', input: { item } };
    }
    if (b.type === 'tasks' && verb === 'task.toggle') {
      const task = b.tasks.find((t) => t.id === arg);
      if (!task) continue;
      const done = typeof values?.done === 'boolean' ? values.done : !task.done;
      return { id: actionId, label: done ? 'Complete task' : 'Reopen task', kind: 'tool', tool: 'update_task', input: { id: task.id, done } };
    }
    if (b.type === 'memory' && verb.startsWith('memory.') && b.nodes.some((n) => n.id === arg && n.status !== 'forgotten')) {
      if (verb === 'memory.forget')
        return { id: actionId, label: 'Forget', kind: 'tool', tool: 'forget', input: { ids: [arg] }, style: 'danger', confirm: 'Forget this memory for good?' };
    }
  }
  return null;
}
