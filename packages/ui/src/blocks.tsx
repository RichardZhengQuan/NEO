/**
 * BlockRenderer and BlockList — render every UIBlock type (docs/GENERATIVE_UI.md).
 *
 * Rules:
 * - Never throw. Invalid data (schema mismatch) or a render error shows a small
 *   "Can't display this content" fallback with the plain-text rendering inside
 *   <details>.
 * - Actions go through `onAction(action, { uiId, values })`. Live widgets send
 *   the reserved ids from `widgetActionId` (including reminder ids), which the server
 *   resolves against the stored block.
 * - `confirm` on a message / event / link / copy action asks first (in-app
 *   dialog). Tool actions ignore it: the server confirms them with its own
 *   description of the real tool call (ui-action → kind 'confirm').
 * - 360 px friendly: grids collapse, tables scroll inside their card.
 */
import {
  Component,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  formSubmitActionId,
  UIBlockSchema,
  isSafeImageUrl,
  isSafeLinkUrl,
  uiBlockToText,
  widgetActionId,
  type AccordionBlock,
  type ButtonsBlock,
  type CalloutBlock,
  type CardBlock,
  type ChangeItem,
  type ChangesBlock,
  type CodeBlock,
  type CountdownBlock,
  type DividerBlock,
  type FormBlock,
  type FormField,
  type GalleryBlock,
  type GridBlock,
  type HeadingBlock,
  type ImageBlock,
  type KeyValueBlock,
  type LinkBlock,
  type ListBlock,
  type MemoryBlock,
  type MemoryStatus,
  type ProgressBlock,
  type QuoteBlock,
  type Reminder,
  type ReminderBlock,
  type StackBlock,
  type StatBlock,
  type TableBlock,
  type TabsBlock,
  type TagsBlock,
  type Task,
  type TasksBlock,
  type TimelineBlock,
  type UIAction,
  type UIBlock,
} from '@neo/protocol';
import { Icon } from './icons.js';
import { ChartRenderer } from './chart.js';
import { CopyButton, Markdown } from './markdown.js';
import { useLocale, useT } from './i18n.js';
import { Badge, Button, IconButton, Spinner, Tabs, type ButtonVariant } from './primitives.js';
import { useConfirm } from './confirm.js';
import { useLinkClick } from './links.js';
import { formatDate, formatDateTime, formatRelative } from './format.js';
import { RemoteImagePlaceholder, SafeImage, useRemoteImages } from './remote-image.js';
import { RetainedStateScope, useRetainedState } from './retained-state.js';

export interface UIActionContext {
  uiId?: string;
  values?: Record<string, unknown>;
}
export type OnUIAction = (action: UIAction, context: UIActionContext) => void | Promise<void>;

/** Fresh state for live widgets (from the app's stores), keyed by id. */
export interface LiveData {
  reminders?: Record<string, Reminder>;
  tasks?: Record<string, Task>;
  /** Current status of memories shown in memory widgets. */
  memories?: Record<string, { status: MemoryStatus }>;
}

export interface BlockRendererProps {
  block: UIBlock;
  uiId?: string;
  onAction?: OnUIAction;
  live?: LiveData;
  depth?: number;
  /** Stable structural identity supplied by container renderers for blocks without ids. */
  stateKey?: string;
  /** Child indexes from the stored UI part's root, in childBlocks order. */
  blockPath?: readonly number[];
}

const MAX_DEPTH = 8;
type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';
const TONE_ICON: Record<Tone, string> = {
  neutral: 'info',
  accent: 'sparkles',
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  danger: 'alert-circle',
};

// ── action plumbing ───────────────────────────────────────────────────────

/** Runs actions (with confirm prompts) and tracks which one is in flight. */
function useActionRunner(onAction: OnUIAction | undefined, uiId: string | undefined) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: UIAction, values?: Record<string, unknown>, onError?: (error: unknown) => void): Promise<boolean> => {
    if (!onAction) return false;
    // Model-written `confirm` text only guards actions that stay on the client
    // side of the conversation (message / event / link / copy). Tool actions are
    // confirmed by the server, which describes the real tool call (see
    // UiActionConfirmation); model text must never stand in for that.
    if (action.confirm && action.kind !== 'tool') {
      const ok = await confirm({ message: action.confirm, danger: action.style === 'danger', confirmLabel: action.label });
      if (!ok) return false;
    }
    setBusy(action.id);
    try {
      const ctx: UIActionContext = { uiId };
      if (values) ctx.values = values;
      await onAction(action, ctx);
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}

const STYLE_VARIANT: Record<NonNullable<UIAction['style']>, ButtonVariant> = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'danger',
};

function ActionButton({ action, runner, size = 'md' }: { action: UIAction; runner: ReturnType<typeof useActionRunner>; size?: 'sm' | 'md' }): ReactElement {
  const icon = action.icon ?? (action.kind === 'link' ? 'external-link' : action.kind === 'copy' ? 'copy' : undefined);
  return (
    <Button
      variant={STYLE_VARIANT[action.style ?? 'secondary']}
      size={size}
      icon={icon}
      loading={runner.busy === action.id}
      disabled={runner.busy !== null && runner.busy !== action.id}
      onClick={() => void runner.run(action)}
    >
      {action.label}
    </Button>
  );
}

// ── fallback & error boundary ─────────────────────────────────────────────

function blockText(block: unknown): string {
  try {
    return uiBlockToText(block as UIBlock);
  } catch {
    try {
      return JSON.stringify(block, null, 2);
    } catch {
      return String(block);
    }
  }
}

function FallbackRenderer({ block }: { block: unknown }): ReactElement {
  const t = useT();
  return (
    <div className="neo-fallback" role="note">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
        <Icon name="alert-circle" size={14} />
        {t('block.invalid')}
      </div>
      <details>
        <summary>{t('block.invalid_detail')}</summary>
        <pre>{blockText(block)}</pre>
      </details>
    </div>
  );
}

class BlockBoundary extends Component<{ block: unknown; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The fallback is shown; nothing to report from a UI kit.
  }
  override componentDidUpdate(prev: { block: unknown }): void {
    if (prev.block !== this.props.block && this.state.failed) this.setState({ failed: false });
  }
  override render(): ReactNode {
    return this.state.failed ? <FallbackRenderer block={this.props.block} /> : this.props.children;
  }
}

// ── leaf renderers ────────────────────────────────────────────────────────

function HeadingRenderer({ block }: { block: HeadingBlock }): ReactElement {
  const level = block.level ?? 2;
  if (level === 1) return <h1 className="neo-block-heading">{block.text}</h1>;
  if (level === 3) return <h3 className="neo-block-heading">{block.text}</h3>;
  return <h2 className="neo-block-heading">{block.text}</h2>;
}

function CardRenderer({ block, uiId, onAction, live, depth, blockPath = [] }: BlockRendererProps & { block: CardBlock }): ReactElement {
  const runner = useActionRunner(onAction, uiId);
  const hasImage = Boolean(block.imageUrl && isSafeImageUrl(block.imageUrl));
  const body = (
    <>
      {(block.icon || block.title || block.subtitle) && (
        <div className="neo-card__head">
          {block.icon && (
            <span className="neo-card__icon">
              <Icon name={block.icon} size={17} />
            </span>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            {block.title && <h3 className="neo-card__title" style={{ margin: 0 }}>{block.title}</h3>}
            {block.subtitle && <p className="neo-card__subtitle" style={{ margin: '0.125rem 0 0' }}>{block.subtitle}</p>}
          </div>
        </div>
      )}
      {block.children && block.children.length > 0 && (
        <div style={{ marginTop: block.title || block.icon || block.subtitle ? '0.75rem' : 0 }}>
          <BlockList blocks={block.children} parentPath={blockPath} uiId={uiId} onAction={onAction} live={live} depth={(depth ?? 0) + 1} />
        </div>
      )}
      {block.actions && block.actions.length > 0 && (
        <div className="neo-card__actions">
          {block.actions.map((a) => (
            <ActionButton key={a.id} action={a} runner={runner} />
          ))}
        </div>
      )}
      {block.footer && <div className="neo-card__footer">{block.footer}</div>}
    </>
  );
  return (
    <section className={`neo-card${hasImage ? ' neo-card--flush' : ''}`} data-tone={block.tone}>
      {hasImage && <SafeImage className="neo-card__media" src={block.imageUrl!} placeholderClassName="neo-remote-image--media" />}
      {hasImage ? <div style={{ padding: '1rem' }}>{body}</div> : body}
    </section>
  );
}

function ListRenderer({ block, uiId, onAction }: BlockRendererProps & { block: ListBlock }): ReactElement {
  const runner = useActionRunner(onAction, uiId);
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    <div>
      {block.title && <p className="neo-block-title">{block.title}</p>}
      <Tag className="neo-list">
        {block.items.map((item, i) => {
          const content = (
            <>
              {block.ordered && <span className="neo-list-item__index">{i + 1}.</span>}
              {item.imageUrl && isSafeImageUrl(item.imageUrl) ? (
                <SafeImage className="neo-list-item__image" src={item.imageUrl} compact nested />
              ) : item.icon ? (
                <span className="neo-list-item__icon">
                  <Icon name={item.icon} size={18} />
                </span>
              ) : null}
              <span className="neo-list-item__main">
                <span className="neo-list-item__title">{item.title}</span>
                {item.subtitle && <span className="neo-list-item__subtitle">{item.subtitle}</span>}
              </span>
              {item.badge && <Badge tone={item.tone ?? 'neutral'}>{item.badge}</Badge>}
              {item.meta && <span className="neo-list-item__meta">{item.meta}</span>}
              {item.action &&
                (runner.busy === item.action.id ? (
                  <Spinner size={14} />
                ) : (
                  <span className="neo-list-item__icon">
                    <Icon name={item.action.kind === 'link' ? 'external-link' : 'chevron-right'} size={15} />
                  </span>
                ))}
            </>
          );
          return (
            <li key={item.id}>
              {item.action ? (
                <button type="button" className="neo-list-item" data-tone={item.tone} onClick={() => void runner.run(item.action!)}>
                  {content}
                </button>
              ) : (
                <div className="neo-list-item" data-tone={item.tone}>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </Tag>
    </div>
  );
}

export function formatCell(value: string | number | boolean | null | undefined, format: string | undefined, locale: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  try {
    if (typeof value === 'number') {
      if (format === 'currency') return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value);
      if (format === 'percent') return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
      if (format === 'date') return formatDate(value, locale);
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
    }
    if (format === 'date') {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return formatDate(d.getTime(), locale);
    }
  } catch {
    // fall through
  }
  return String(value);
}

const TABLE_PAGE = 50;

function TableRenderer({ block }: { block: TableBlock }): ReactElement {
  const locale = useLocale();
  const t = useT();
  const [all, setAll] = useRetainedState('table:all', false);
  const rows = all ? block.rows : block.rows.slice(0, TABLE_PAGE);
  const numeric = (f?: string) => f === 'number' || f === 'currency' || f === 'percent';
  return (
    <div className="neo-table-wrap">
      <table className="neo-table">
        {block.caption && <caption>{block.caption}</caption>}
        <thead>
          <tr>
            {block.columns.map((col) => (
              <th key={col.key} scope="col" style={{ textAlign: col.align ?? (numeric(col.format) ? 'right' : 'left') }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {block.columns.map((col) => (
                <td key={col.key} style={{ textAlign: col.align ?? (numeric(col.format) ? 'right' : 'left') }}>
                  {formatCell(row[col.key], col.format, locale)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {block.rows.length > TABLE_PAGE && (
        <button type="button" className="neo-table__more" onClick={() => setAll((v) => !v)}>
          {all ? t('block.show_less') : t('block.show_all_rows', { n: block.rows.length })}
        </button>
      )}
    </div>
  );
}

function StatRenderer({ block }: { block: StatBlock }): ReactElement {
  const locale = useLocale();
  const value = typeof block.value === 'number' ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(block.value) : block.value;
  const dir = block.delta === undefined ? undefined : block.delta > 0 ? 'up' : block.delta < 0 ? 'down' : 'flat';
  return (
    <div className="neo-card neo-stat" data-tone={block.tone}>
      <div className="neo-stat__label">
        {block.icon && <Icon name={block.icon} size={15} />}
        {block.label}
      </div>
      <div className="neo-stat__value">
        <span>{value}</span>
        {block.unit && <span className="neo-stat__unit">{block.unit}</span>}
        {block.delta !== undefined && (
          <span className="neo-stat__delta" data-dir={dir}>
            {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'} {block.delta > 0 ? '+' : ''}
            {new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(block.delta)}
            {block.deltaLabel ? ` ${block.deltaLabel}` : ''}
          </span>
        )}
      </div>
      {block.caption && <div className="neo-stat__caption">{block.caption}</div>}
    </div>
  );
}

function ProgressRenderer({ block }: { block: ProgressBlock }): ReactElement {
  const pct = Math.round(Math.min(1, Math.max(0, block.value)) * 100);
  return (
    <div className="neo-progress" data-tone={block.tone ?? 'accent'}>
      <div className="neo-progress__head">
        <span style={{ color: 'var(--neo-text)' }}>{block.label}</span>
        <span style={{ color: 'var(--neo-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
      </div>
      <div className="neo-meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={block.label ?? undefined}>
        <div className="neo-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      {block.caption && <p className="neo-help" style={{ margin: '0.375rem 0 0' }}>{block.caption}</p>}
    </div>
  );
}

// ── form ─────────────────────────────────────────────────────────────────

type FieldValue = string | number | boolean | string[];

function initialValue(field: FormField): FieldValue {
  if (field.defaultValue !== undefined) return field.defaultValue as FieldValue;
  if (field.kind === 'checkbox' || field.kind === 'switch') return false;
  if (field.kind === 'slider') return field.min ?? 0;
  if (field.kind === 'multiselect') return [];
  return '';
}

export function validateFormField(field: FormField, value: FieldValue, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  const empty = value === '' || value === false || (Array.isArray(value) && value.length === 0);
  if (field.required && empty) return t('block.form_error_required');
  if (empty) return null;
  const s = String(value);
  if (field.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return t('block.form_error_email');
  if (field.kind === 'url' && !/^https?:\/\/\S+$/i.test(s)) return t('block.form_error_url');
  if (field.kind === 'number' || field.kind === 'slider') {
    const n = typeof value === 'number' ? value : Number(s);
    if (!Number.isFinite(n)) return t('block.form_error_number');
    if (field.min !== undefined && n < field.min) return t('block.form_error_min', { min: field.min });
    if (field.max !== undefined && n > field.max) return t('block.form_error_max', { max: field.max });
  }
  return null;
}

function FormFieldControl({ field, id, value, error, onChange }: { field: FormField; id: string; value: FieldValue; error: string | null; onChange: (v: FieldValue) => void }): ReactElement {
  const t = useT();
  const described = error ? `${id}-err` : field.help ? `${id}-help` : undefined;
  const common = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': described } as const;
  const label = (
    <label htmlFor={id} className="neo-label">
      {field.label}
      {field.required && <span style={{ color: 'var(--neo-tone-danger-text)' }} aria-hidden="true"> *</span>}
      {field.required && <span className="neo-sr"> ({t('common.required')})</span>}
    </label>
  );
  const help = error ? (
    <p id={`${id}-err`} className="neo-error-text" role="alert" style={{ margin: 0 }}>
      {error}
    </p>
  ) : field.help ? (
    <p id={`${id}-help`} className="neo-help" style={{ margin: 0 }}>
      {field.help}
    </p>
  ) : null;

  if (field.kind === 'checkbox' || field.kind === 'switch') {
    return (
      <div className="neo-field">
        <label className="neo-check-row" htmlFor={id}>
          <input
            {...common}
            type="checkbox"
            role={field.kind === 'switch' ? 'switch' : undefined}
            className="neo-checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>
            {field.label}
            {field.required && <span style={{ color: 'var(--neo-tone-danger-text)' }} aria-hidden="true"> *</span>}
          </span>
        </label>
        {help}
      </div>
    );
  }
  if (field.kind === 'multiselect') {
    const arr = Array.isArray(value) ? value : [];
    return (
      <fieldset className="neo-field" style={{ border: 0, margin: 0, padding: 0 }} aria-describedby={described}>
        <legend className="neo-label" style={{ marginBottom: '0.375rem' }}>
          {field.label}
        </legend>
        <div className="neo-tags">
          {(field.options ?? []).map((o) => {
            const on = arr.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                className="neo-chip neo-chip--sm"
                aria-pressed={on}
                onClick={() => onChange(on ? arr.filter((v) => v !== o.value) : [...arr, o.value])}
              >
                {on && <Icon name="check" size={12} />}
                {o.label}
              </button>
            );
          })}
        </div>
        {help}
      </fieldset>
    );
  }
  let control: ReactElement;
  if (field.kind === 'textarea') {
    control = <textarea {...common} className="neo-textarea" rows={3} placeholder={field.placeholder} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  } else if (field.kind === 'select') {
    control = (
      <div className="neo-select-wrap">
        <select {...common} className="neo-select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.placeholder ?? t('block.form_choose')}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="neo-select-chevron">
          <Icon name="chevron-down" size={14} />
        </span>
      </div>
    );
  } else if (field.kind === 'slider') {
    const n = typeof value === 'number' ? value : Number(value) || 0;
    control = (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <input
          {...common}
          type="range"
          className="neo-range"
          min={field.min ?? 0}
          max={field.max ?? 100}
          step={field.step ?? 1}
          value={n}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id} style={{ minWidth: '2.5rem', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {n}
        </output>
      </div>
    );
  } else {
    const type = field.kind === 'datetime' ? 'datetime-local' : field.kind;
    control = (
      <input
        {...common}
        type={type}
        className="neo-input"
        placeholder={field.placeholder}
        value={typeof value === 'boolean' || Array.isArray(value) ? '' : String(value)}
        min={field.min}
        max={field.max}
        step={field.step}
        inputMode={field.kind === 'number' ? 'decimal' : undefined}
        onChange={(e) => onChange(field.kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
      />
    );
  }
  return (
    <div className="neo-field">
      {label}
      {control}
      {help}
    </div>
  );
}

function FormRenderer({ block, uiId, onAction, blockPath = [] }: BlockRendererProps & { block: FormBlock }): ReactElement {
  const t = useT();
  const formId = useId();
  const [values, setValues] = useRetainedState<Record<string, FieldValue>>('form:values', () => Object.fromEntries(block.fields.map((f) => [f.name, initialValue(f)])));
  const [errors, setErrors] = useRetainedState<Record<string, string | null>>('form:errors', {});
  const [state, setState] = useRetainedState<'idle' | 'sending' | 'sent' | 'error'>('form:status', 'idle');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string | null> = {};
    let invalid = false;
    for (const f of block.fields) {
      const err = validateFormField(f, values[f.name] ?? '', t);
      next[f.name] = err;
      if (err) invalid = true;
    }
    setErrors(next);
    if (invalid || !onAction || state === 'sending') return;
    setState('sending');
    try {
      await onAction({ id: formSubmitActionId(block, blockPath), kind: 'event', label: block.submitLabel ?? t('common.submit') }, { uiId, values });
      setState('sent');
    } catch {
      setState('error');
    }
  };

  return (
    <form className="neo-card neo-form" onSubmit={(e) => void submit(e)} noValidate aria-labelledby={block.title ? `${formId}-title` : undefined}>
      {block.title && (
        <h3 id={`${formId}-title`} className="neo-form__title">
          {block.title}
        </h3>
      )}
      {block.description && <p className="neo-form__description">{block.description}</p>}
      {block.fields.map((field) => (
        <FormFieldControl
          key={field.name}
          field={field}
          id={`${formId}-${field.name}`}
          value={values[field.name] ?? ''}
          error={errors[field.name] ?? null}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, [field.name]: v }));
            if (errors[field.name]) setErrors((prev) => ({ ...prev, [field.name]: null }));
            if (state === 'sent') setState('idle');
          }}
        />
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Button type="submit" variant="primary" loading={state === 'sending'}>
          {block.submitLabel ?? t('common.submit')}
        </Button>
        {state === 'sent' && (
          <span className="neo-form__sent" role="status">
            <Icon name="check-circle" size={14} />
            {t('block.form_sent')}
          </span>
        )}
        {state === 'error' && (
          <span className="neo-error-text" role="alert">
            {t('block.form_failed')}
          </span>
        )}
      </div>
    </form>
  );
}

function ButtonsRenderer({ block, uiId, onAction }: BlockRendererProps & { block: ButtonsBlock }): ReactElement {
  const runner = useActionRunner(onAction, uiId);
  return (
    <div style={{ display: 'flex', flexDirection: block.layout === 'column' ? 'column' : 'row', alignItems: block.layout === 'column' ? 'stretch' : 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
      {block.actions.map((a) => (
        <ActionButton key={a.id} action={a} runner={runner} />
      ))}
    </div>
  );
}

// ── media ────────────────────────────────────────────────────────────────

function Lightbox({ images, index, onClose, onIndex }: { images: { url: string; alt: string; caption?: string | undefined }[]; index: number; onClose: () => void; onIndex: (i: number) => void }): ReactElement | null {
  const t = useT();
  const img = images[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && images.length > 1) onIndex((index + 1) % images.length);
      if (e.key === 'ArrowLeft' && images.length > 1) onIndex((index - 1 + images.length) % images.length);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, images.length, onClose, onIndex]);
  if (!img) return null;
  return (
    <div className="neo-lightbox" role="dialog" aria-modal="true" aria-label={img.alt} onClick={onClose}>
      <span className="neo-lightbox__close">
        <IconButton icon="x" label={t('common.close')} onClick={onClose} />
      </span>
      <img src={img.url} alt={img.alt} onClick={(e) => e.stopPropagation()} />
      {(img.caption || images.length > 1) && (
        <div className="neo-lightbox__caption" onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {images.length > 1 && <IconButton icon="chevron-left" label={t('block.previous')} onClick={() => onIndex((index - 1 + images.length) % images.length)} />}
          <span>{img.caption ?? `${index + 1} / ${images.length}`}</span>
          {images.length > 1 && <IconButton icon="chevron-right" label={t('block.next')} onClick={() => onIndex((index + 1) % images.length)} />}
        </div>
      )}
    </div>
  );
}

function ImageRenderer({ block }: { block: ImageBlock }): ReactElement {
  const [open, setOpen] = useState(false);
  const gate = useRemoteImages([block.url]);
  if (!isSafeImageUrl(block.url) || gate.status === 'blocked') return <FallbackRenderer block={block} />;
  return (
    <figure className="neo-figure">
      {gate.status === 'ask' ? (
        <RemoteImagePlaceholder hosts={gate.hosts} onLoad={gate.allow} className="neo-remote-image--media" style={{ aspectRatio: block.aspectRatio ? String(block.aspectRatio) : undefined }} />
      ) : (
        <button type="button" className="neo-link-btn" style={{ display: 'block', width: '100%', cursor: 'zoom-in' }} onClick={() => setOpen(true)} aria-label={block.alt}>
          <img src={block.url} alt={block.alt} loading="lazy" referrerPolicy="no-referrer" style={{ width: '100%', aspectRatio: block.aspectRatio ? String(block.aspectRatio) : undefined }} />
        </button>
      )}
      {block.caption && <figcaption>{block.caption}</figcaption>}
      {open && <Lightbox images={[block]} index={0} onClose={() => setOpen(false)} onIndex={() => undefined} />}
    </figure>
  );
}

function GalleryRenderer({ block }: { block: GalleryBlock }): ReactElement {
  const images = block.images.filter((img) => isSafeImageUrl(img.url));
  const [index, setIndex] = useState<number | null>(null);
  const gate = useRemoteImages(images.map((img) => img.url));
  if (gate.status === 'ask') return <RemoteImagePlaceholder hosts={gate.hosts} count={images.length} onLoad={gate.allow} className="neo-remote-image--media" />;
  return (
    <>
      <div className="neo-gallery">
        {images.map((img, i) => (
          <button key={i} type="button" className="neo-gallery__thumb" onClick={() => setIndex(i)} aria-label={img.alt}>
            <img src={img.url} alt={img.alt} loading="lazy" referrerPolicy="no-referrer" />
          </button>
        ))}
      </div>
      {index !== null && <Lightbox images={images} index={index} onClose={() => setIndex(null)} onIndex={setIndex} />}
    </>
  );
}

function CalloutRenderer({ block }: { block: CalloutBlock }): ReactElement {
  return (
    <div className="neo-callout" data-tone={block.tone} role={block.tone === 'danger' || block.tone === 'warning' ? 'alert' : 'note'}>
      <span className="neo-callout__icon">
        <Icon name={block.icon ?? TONE_ICON[block.tone]} size={17} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {block.title && <p className="neo-callout__title">{block.title}</p>}
        <Markdown text={block.text} />
      </div>
    </div>
  );
}

function CodeRenderer({ block }: { block: CodeBlock }): ReactElement {
  return (
    <div className="neo-code">
      <div className="neo-code__head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', minWidth: 0 }}>
          <Icon name={block.filename ? 'file-text' : 'code'} size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.filename ?? block.language ?? 'code'}</span>
        </span>
        <CopyButton text={block.code} />
      </div>
      <pre>
        <code>{block.code}</code>
      </pre>
    </div>
  );
}

function QuoteRenderer({ block }: { block: QuoteBlock }): ReactElement {
  return (
    <blockquote className="neo-quote">
      <Markdown text={block.text} />
      {block.cite && <footer className="neo-quote__cite">— {block.cite}</footer>}
    </blockquote>
  );
}

function DividerRenderer({ block }: { block: DividerBlock }): ReactElement {
  if (block.label) {
    return (
      <div className="neo-divider" role="separator" aria-label={block.label}>
        {block.label}
      </div>
    );
  }
  return <hr className="neo-divider neo-divider--plain" style={{ border: 0, height: 1, background: 'var(--neo-border)', margin: '0.25rem 0' }} />;
}

// ── containers ───────────────────────────────────────────────────────────

function GridRenderer({ block, uiId, onAction, live, depth, blockPath = [] }: BlockRendererProps & { block: GridBlock }): ReactElement {
  const cols = Math.min(4, Math.max(1, Math.round(block.columns)));
  return (
    <div className="neo-grid" data-cols={cols} style={{ ['--neo-cols' as string]: cols }}>
      {block.children.map((child, i) => (
        <BlockRenderer key={child.id ?? i} stateKey={blockStateKey(child, i)} blockPath={[...blockPath, i]} block={child} uiId={uiId} onAction={onAction} live={live} depth={(depth ?? 0) + 1} />
      ))}
    </div>
  );
}

function StackRenderer({ block, uiId, onAction, live, depth, blockPath = [] }: BlockRendererProps & { block: StackBlock }): ReactElement {
  return (
    <div className="neo-stack" data-direction={block.direction ?? 'vertical'} data-gap={block.gap ?? 'md'}>
      {block.children.map((child, i) => (
        <BlockRenderer key={child.id ?? i} stateKey={blockStateKey(child, i)} blockPath={[...blockPath, i]} block={child} uiId={uiId} onAction={onAction} live={live} depth={(depth ?? 0) + 1} />
      ))}
    </div>
  );
}

function TabsRenderer({ block, uiId, onAction, live, depth, blockPath = [] }: BlockRendererProps & { block: TabsBlock }): ReactElement {
  const prefix = useId();
  const [active, setActive] = useRetainedState('tabs:active', block.tabs[0]?.id ?? '');
  const currentIndex = Math.max(0, block.tabs.findIndex((tab) => tab.id === active));
  const current = block.tabs[currentIndex];
  const childOffset = block.tabs.slice(0, currentIndex).reduce((count, tab) => count + tab.children.length, 0);
  return (
    <div>
      <Tabs
        idPrefix={prefix}
        label={block.tabs.map((tab) => tab.label).join(', ')}
        value={current?.id ?? ''}
        onChange={setActive}
        tabs={block.tabs.map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon }))}
      />
      {current && (
        <div className="neo-tabpanel" role="tabpanel" id={`${prefix}-panel-${current.id}`} aria-labelledby={`${prefix}-tab-${current.id}`}>
          <RetainedStateScope key={current.id} scope={`tab:${current.id}`}>
            <BlockList blocks={current.children} parentPath={blockPath} childOffset={childOffset} uiId={uiId} onAction={onAction} live={live} depth={(depth ?? 0) + 1} />
          </RetainedStateScope>
        </div>
      )}
    </div>
  );
}

function AccordionRenderer({ block, uiId, onAction, live, depth, blockPath = [] }: BlockRendererProps & { block: AccordionBlock }): ReactElement {
  const prefix = useId();
  const [open, setOpen] = useRetainedState<Record<string, boolean>>('accordion:open', () => Object.fromEntries(block.items.map((item) => [item.id, item.open ?? false])));
  return (
    <div className="neo-accordion">
      {block.items.map((item, itemIndex) => {
        const isOpen = open[item.id] ?? false;
        const panelId = `${prefix}-${item.id}`;
        const childOffset = block.items.slice(0, itemIndex).reduce((count, previous) => count + previous.children.length, 0);
        return (
          <div key={item.id} className="neo-accordion__item">
            <button
              type="button"
              className="neo-accordion__trigger"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpen((prev) => ({ ...prev, [item.id]: !isOpen }))}
            >
              <span>{item.title}</span>
              <span className="neo-accordion__chevron">
                <Icon name="chevron-down" size={16} />
              </span>
            </button>
            {isOpen && (
              <div id={panelId} className="neo-accordion__panel">
                <RetainedStateScope scope={`item:${item.id}`}>
                  <BlockList blocks={item.children} parentPath={blockPath} childOffset={childOffset} uiId={uiId} onAction={onAction} live={live} depth={(depth ?? 0) + 1} />
                </RetainedStateScope>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function siteOf(url: string): string {
  if (url.toLowerCase().startsWith('neo://')) return 'NEO';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function LinkRenderer({ block }: { block: LinkBlock }): ReactElement {
  const onClick = useLinkClick(block.url);
  if (!isSafeLinkUrl(block.url)) return <FallbackRenderer block={block} />;
  const external = /^https?:/i.test(block.url);
  return (
    <a className="neo-linkcard" href={block.url} onClick={onClick} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>
      {block.imageUrl && isSafeImageUrl(block.imageUrl) && <SafeImage className="neo-linkcard__image" src={block.imageUrl} compact nested />}
      <span className="neo-linkcard__main">
        <span className="neo-linkcard__site">
          <Icon name={external ? 'globe' : 'link'} size={12} />
          {block.siteName ?? siteOf(block.url)}
        </span>
        <span className="neo-linkcard__title" style={{ display: 'block' }}>
          {block.title}
        </span>
        {block.description && <span className="neo-linkcard__desc">{block.description}</span>}
      </span>
      <span style={{ color: 'var(--neo-text-subtle)', alignSelf: 'center' }}>
        <Icon name={external ? 'external-link' : 'chevron-right'} size={15} />
      </span>
    </a>
  );
}

function TimelineRenderer({ block }: { block: TimelineBlock }): ReactElement {
  const locale = useLocale();
  return (
    <div>
      {block.title && <p className="neo-block-title">{block.title}</p>}
      <ol className="neo-timeline">
        {block.items.map((item, i) => (
          <li key={item.id ?? i} className="neo-timeline__item">
            <span className="neo-timeline__dot" data-tone={item.tone ?? 'neutral'}>
              <Icon name={item.icon ?? 'circle-dot'} size={13} />
            </span>
            <div style={{ minWidth: 0, paddingTop: '0.125rem' }}>
              <time className="neo-timeline__time" dateTime={typeof item.time === 'number' ? new Date(item.time).toISOString() : undefined}>
                {typeof item.time === 'number' ? formatDateTime(item.time, locale) : item.time}
              </time>
              <p className="neo-timeline__title">{item.title}</p>
              {item.description && <p className="neo-timeline__desc">{item.description}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function KeyValueRenderer({ block }: { block: KeyValueBlock }): ReactElement {
  const t = useT();
  return (
    <div>
      {block.title && <p className="neo-block-title">{block.title}</p>}
      <dl className="neo-kv">
        {block.items.map((item, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <dt>{item.key}</dt>
            <dd>{item.value === null ? <span style={{ color: 'var(--neo-text-subtle)' }}>—</span> : typeof item.value === 'boolean' ? (item.value ? t('common.yes') : t('common.no')) : String(item.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TagsRenderer({ block }: { block: TagsBlock }): ReactElement {
  return (
    <div className="neo-tags">
      {block.items.map((item, i) => (
        <Badge key={i} tone={item.tone ?? 'neutral'} icon={item.icon}>
          {item.label}
        </Badge>
      ))}
    </div>
  );
}

function CountdownRenderer({ block }: { block: CountdownBlock }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const [now, setNow] = useState(() => Date.now());
  const done = block.until <= now;
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [done]);
  if (done) {
    return (
      <div className="neo-card neo-countdown">
        <span className="neo-countdown__label">{block.label}</span>
        <span className="neo-countdown__done">{block.doneText ?? t('countdown.done')}</span>
      </div>
    );
  }
  const diff = block.until - now;
  const units: [number, string][] = [
    [Math.floor(diff / 86_400_000), t('countdown.unit_days')],
    [Math.floor((diff % 86_400_000) / 3_600_000), t('countdown.unit_hours')],
    [Math.floor((diff % 3_600_000) / 60_000), t('countdown.unit_minutes')],
    [Math.floor((diff % 60_000) / 1000), t('countdown.unit_seconds')],
  ];
  const visible = units[0]![0] > 0 ? units : units.slice(1);
  return (
    <div className="neo-card neo-countdown" role="timer" aria-label={`${block.label}: ${formatDateTime(block.until, locale)}`}>
      <span className="neo-countdown__label">{block.label}</span>
      <div className="neo-countdown__units" aria-hidden="true">
        {visible.map(([n, label], i) => (
          <span key={i} className="neo-countdown__unit">
            <span className="neo-countdown__num">{String(n).padStart(2, '0')}</span>
            <span className="neo-countdown__unit-label">{label}</span>
          </span>
        ))}
      </div>
      <span className="neo-help">{formatDateTime(block.until, locale)}</span>
    </div>
  );
}

// ── live widgets ─────────────────────────────────────────────────────────

const REMINDER_TONE: Record<ReminderBlock['status'], Tone> = { scheduled: 'accent', fired: 'warning', completed: 'success', cancelled: 'neutral' };

function ReminderRenderer({ block, uiId, onAction, live }: BlockRendererProps & { block: ReminderBlock }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const runner = useActionRunner(onAction, uiId);
  const fresh = live?.reminders?.[block.reminderId];
  const status = fresh?.status ?? block.status;
  const dueAt = fresh?.dueAt ?? block.dueAt;
  const title = fresh?.title ?? block.title;
  const tz = fresh?.timezone ?? block.timezone;
  const active = status === 'scheduled' || status === 'fired';
  const actions: UIAction[] = [
    { id: widgetActionId.reminderSnooze(block.reminderId, 10), kind: 'tool', tool: 'snooze_reminder', label: t('reminder.snooze_10'), icon: 'alarm-clock', input: { id: block.reminderId, minutes: 10 } },
    { id: widgetActionId.reminderSnooze(block.reminderId, 60), kind: 'tool', tool: 'snooze_reminder', label: t('reminder.snooze_60'), input: { id: block.reminderId, minutes: 60 } },
    { id: widgetActionId.reminderComplete(block.reminderId), kind: 'tool', tool: 'complete_reminder', label: t('reminder.done'), icon: 'check', style: 'primary', input: { id: block.reminderId } },
  ];
  return (
    <section className="neo-card neo-widget" data-state={status} aria-label={t('reminder.widget_label', { title })}>
      <div className="neo-widget__head">
        <span className="neo-widget__icon">
          <Icon name={status === 'completed' ? 'check' : status === 'fired' ? 'bell-ring' : 'bell'} size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="neo-widget__title">{title}</p>
          <div className="neo-widget__meta">
            <span>
              <time dateTime={new Date(dueAt).toISOString()}>{formatDateTime(dueAt, locale, tz)}</time>
              {active && <> · {formatRelative(dueAt, locale)}</>}
            </span>
            {block.recurrenceText && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                <Icon name="repeat" size={12} />
                {block.recurrenceText}
              </span>
            )}
          </div>
        </div>
        <Badge tone={REMINDER_TONE[status]}>{t(`reminder.status.${status}`)}</Badge>
      </div>
      {active && onAction && (
        <div className="neo-widget__actions">
          {actions.map((a) => (
            <ActionButton key={a.id} action={a} runner={runner} size="sm" />
          ))}
        </div>
      )}
    </section>
  );
}

function TasksRenderer({ block, uiId, onAction, live }: BlockRendererProps & { block: TasksBlock }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const runner = useActionRunner(onAction, uiId);
  const tasks = block.tasks.map((task) => {
    const fresh = live?.tasks?.[task.id];
    return { ...task, title: fresh?.title ?? task.title, dueAt: fresh ? fresh.dueAt : task.dueAt, priority: fresh?.priority ?? task.priority, done: optimistic[task.id] ?? fresh?.done ?? task.done };
  });
  // Drop optimistic values once live data agrees.
  useEffect(() => {
    setOptimistic((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [id, done] of Object.entries(prev)) {
        if (live?.tasks?.[id]?.done === done) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [live?.tasks]);
  const doneCount = tasks.filter((x) => x.done).length;
  const toggle = async (id: string, title: string, done: boolean) => {
    setOptimistic((prev) => ({ ...prev, [id]: done }));
    const ok = await runner.run({ id: widgetActionId.taskToggle(id), kind: 'tool', tool: 'update_task', label: title, input: { id, done } }, { done });
    if (!ok) setOptimistic((prev) => ({ ...prev, [id]: !done }));
  };
  return (
    <section className="neo-card neo-widget" aria-label={block.title ?? t('block.tasks_title')}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
        <p className="neo-widget__title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Icon name="list-checks" size={16} />
          {block.title ?? t('block.tasks_title')}
        </p>
        {tasks.length > 0 && <span className="neo-help">{t('block.tasks_progress', { done: doneCount, total: tasks.length })}</span>}
      </div>
      {tasks.length === 0 ? (
        <p className="neo-help" style={{ margin: 0 }}>
          {t('block.tasks_empty')}
        </p>
      ) : (
        <ul className="neo-task-list">
          {tasks.map((task) => {
            const id = `${uiId ?? 'tasks'}-${task.id}`;
            return (
              <li key={task.id} className="neo-task" data-done={task.done}>
                <input
                  id={id}
                  type="checkbox"
                  className="neo-checkbox neo-task__check"
                  checked={task.done}
                  disabled={!onAction}
                  onChange={(e) => void toggle(task.id, task.title, e.target.checked)}
                />
                <label htmlFor={id} className="neo-task__title">
                  {task.title}
                </label>
                <span className="neo-task__meta">
                  {task.priority ? (
                    <span className="neo-priority" data-level={task.priority} title={t(`task.priority_${task.priority}`)}>
                      <Icon name="flag" size={12} />
                    </span>
                  ) : null}
                  {task.dueAt ? <time dateTime={new Date(task.dueAt).toISOString()}>{formatDate(task.dueAt, locale, undefined, 'short')}</time> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ChangeDetails({ item, timezone }: { item: ChangeItem; timezone?: string }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const time = (dueAt: number | null | undefined) => dueAt == null ? t('block.changes_no_due') : formatDateTime(dueAt, locale, timezone);
  const priority = (value: number | undefined) => value ? t(`task.priority_${value}`) : t('block.changes_no_priority');
  if (item.kind === 'reminder.create') return <div className="neo-change__details">{time(item.dueAt)}</div>;
  return (
    <div className="neo-change__details">
      {item.after.dueAt !== undefined && <p>{t('block.changes_due', { from: time(item.before.dueAt), to: time(item.after.dueAt) })}</p>}
      {item.after.title !== undefined && <p>{t('block.changes_title_field', { from: item.before.title ?? '', to: item.after.title })}</p>}
      {item.kind === 'task.update' && item.after.priority !== undefined && <p>{priority(item.before.priority)} → {priority(item.after.priority)}</p>}
      {item.kind === 'task.update' && item.after.done !== undefined && <p>{t(item.after.done ? 'block.changes_mark_done' : 'block.changes_reopen')}</p>}
    </div>
  );
}

type ChangeApplyState = {
  running: boolean;
  applying: string | null;
  results: Record<string, { status: 'applied' } | { status: 'failed'; error: string }>;
};

function ChangesRenderer({ block, uiId, onAction }: BlockRendererProps & { block: ChangesBlock }): ReactElement {
  const t = useT();
  const id = useId();
  const runner = useActionRunner(onAction, uiId);
  const [selected, setSelected] = useRetainedState<Record<string, boolean>>('selection', () => Object.fromEntries(block.items.map((item) => [item.id, item.status !== 'applied'])));
  const [state, setState] = useRetainedState<ChangeApplyState>('apply', { running: false, applying: null, results: {} });
  const running = useRef(false);
  const currentBlock = useRef(block);
  currentBlock.current = block;
  const isApplied = (item: ChangeItem) => item.status === 'applied' || state.results[item.id]?.status === 'applied';
  const pending = block.items.filter((item) => !isApplied(item) && (selected[item.id] ?? true));
  const retry = pending.some((item) => state.results[item.id]?.status === 'failed');
  const applyLabel = t(retry ? 'block.changes_retry' : 'block.changes_apply', { n: pending.length });
  const allApplied = block.items.every(isApplied);
  const apply = async () => {
    if (!onAction || state.running || running.current || pending.length === 0) return;
    running.current = true;
    setState((previous) => ({ ...previous, running: true }));
    try {
      for (const item of pending) {
        if (currentBlock.current.items.find((current) => current.id === item.id)?.status === 'applied') continue;
        setState((previous) => ({ ...previous, applying: item.id }));
        let error = t('block.changes_failed');
        const ok = await runner.run(
          { id: widgetActionId.changeApply(item.id), kind: 'tool', tool: 'apply_change', label: t('block.changes_apply_item'), input: {} },
          undefined,
          (cause) => { if (cause instanceof Error && cause.message) error = cause.message; else if (typeof cause === 'string' && cause) error = cause; },
        );
        setState((previous) => ({
          ...previous,
          applying: null,
          results: { ...previous.results, [item.id]: ok ? { status: 'applied' } : { status: 'failed', error } },
        }));
      }
    } finally {
      running.current = false;
      setState((previous) => ({ ...previous, running: false, applying: null }));
    }
  };
  return (
    <section className="neo-card neo-widget neo-changes" aria-label={block.title ?? t('block.changes_title')}>
      <div className="neo-widget__head">
        <span className="neo-widget__icon"><Icon name="list-checks" size={18} /></span>
        <div className="neo-change__main">
          <p className="neo-widget__title">{block.title ?? t('block.changes_title')}</p>
          {block.note && <p className="neo-changes__note neo-help">{block.note}</p>}
        </div>
      </div>
      <ul className="neo-changes__list">
        {block.items.map((item) => {
          const applied = isApplied(item);
          const result = state.results[item.id];
          const applying = state.applying === item.id;
          const checkboxId = `${id}-${item.id}`;
          const kind = item.kind === 'task.update' ? 'task' : item.kind === 'reminder.create' ? 'new_reminder' : 'reminder';
          return (
            <li key={item.id} className="neo-change" data-state={applied ? 'applied' : applying ? 'applying' : result?.status ?? 'pending'}>
              {applied ? <span className="neo-change__check" aria-hidden="true"><Icon name="check" size={16} /></span> : (
                <input
                  id={checkboxId}
                  className="neo-checkbox neo-change__check"
                  type="checkbox"
                  checked={selected[item.id] ?? true}
                  disabled={state.running || !onAction}
                  onChange={(event) => setSelected((previous) => ({ ...previous, [item.id]: event.target.checked }))}
                />
              )}
              <div className="neo-change__main">
                {applied ? <p className="neo-change__title">{item.title}</p> : <label htmlFor={checkboxId} className="neo-change__title">{item.title}</label>}
                <span className="neo-change__kind">{t(`block.changes_kind_${kind}`)}</span>
                <ChangeDetails item={item} timezone={block.timezone} />
                <div className="neo-change__status" aria-live="polite" aria-atomic="true">
                  {applied ? <span className="neo-change__applied">{t('block.changes_applied')}</span> : applying ? (
                    <span><Spinner size={12} />{t('block.changes_applying')}</span>
                  ) : result?.status === 'failed' ? <span className="neo-error-text">{result.error}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="neo-widget__actions" aria-live="polite">
        {allApplied ? <span className="neo-change__applied" role="status">{t('block.changes_all_applied')}</span> : (
          <Button variant="primary" aria-label={applyLabel} loading={state.running} disabled={!onAction || pending.length === 0} onClick={() => void apply()}>
            {applyLabel}
          </Button>
        )}
      </div>
    </section>
  );
}

type MemoryResolution = 'forgotten';

function MemoryWidgetRenderer({ block, uiId, onAction, live }: BlockRendererProps & { block: MemoryBlock }): ReactElement {
  const t = useT();
  const runner = useActionRunner(onAction, uiId);
  const [resolved, setResolved] = useState<Record<string, MemoryResolution>>({});
  const act = async (action: UIAction, nodeId: string, result: MemoryResolution) => {
    if (await runner.run(action)) setResolved((prev) => ({ ...prev, [nodeId]: result }));
  };
  return (
    <section className="neo-card neo-widget" data-tone="accent" aria-label={block.title ?? t('block.memory_title')}>
      <div className="neo-widget__head">
        <span className="neo-widget__icon">
          <Icon name="brain" size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="neo-widget__title">{block.title ?? t('block.memory_title')}</p>
          {block.note && <p className="neo-help" style={{ margin: '0.125rem 0 0' }}>{block.note}</p>}
        </div>
      </div>
      <div>
        {block.nodes.map((node) => {
          const status = live?.memories?.[node.id]?.status ?? node.status ?? 'active';
          const result = resolved[node.id];
          return (
            <div key={node.id} className="neo-mem-row">
              <div className="neo-mem-row__main">
                <span className="neo-kind" data-kind={node.kind}>
                  {t(`memory.kind.${node.kind}`) === `memory.kind.${node.kind}` ? node.kind : t(`memory.kind.${node.kind}`)}
                </span>
                <p className="neo-mem-row__label">{node.label}</p>
                {node.content && node.content !== node.label && <p className="neo-mem-row__content">{node.content}</p>}
              </div>
              <div className="neo-mem-row__actions">
                {result ? (
                  <span className="neo-mem-row__resolved" role="status">
                    {t(`memory.resolved_${result}`)}
                  </span>
                ) : !onAction ? null : status === 'active' || status === 'archived' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    loading={runner.busy === widgetActionId.memoryForget(node.id)}
                    onClick={() =>
                      void act(
                        { id: widgetActionId.memoryForget(node.id), kind: 'tool', tool: 'forget', label: t('memory.forget'), style: 'danger', input: { ids: [node.id] } },
                        node.id,
                        'forgotten',
                      )
                    }
                  >
                    {t('memory.forget')}
                  </Button>
                ) : (
                  <span className="neo-mem-row__resolved">{t(`memory.status.${status}`)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── dispatcher ───────────────────────────────────────────────────────────

function renderBlock(props: BlockRendererProps): ReactElement {
  const { block } = props;
  switch (block.type) {
    case 'text':
      return <Markdown text={block.text} />;
    case 'heading':
      return <HeadingRenderer block={block} />;
    case 'card':
      return <CardRenderer {...props} block={block} />;
    case 'list':
      return <ListRenderer {...props} block={block} />;
    case 'table':
      return <TableRenderer block={block} />;
    case 'chart':
      return <ChartRenderer block={block} />;
    case 'stat':
      return <StatRenderer block={block} />;
    case 'progress':
      return <ProgressRenderer block={block} />;
    case 'form':
      return <FormRenderer {...props} block={block} />;
    case 'buttons':
      return <ButtonsRenderer {...props} block={block} />;
    case 'image':
      return <ImageRenderer block={block} />;
    case 'gallery':
      return <GalleryRenderer block={block} />;
    case 'callout':
      return <CalloutRenderer block={block} />;
    case 'code':
      return <CodeRenderer block={block} />;
    case 'quote':
      return <QuoteRenderer block={block} />;
    case 'divider':
      return <DividerRenderer block={block} />;
    case 'grid':
      return <GridRenderer {...props} block={block} />;
    case 'stack':
      return <StackRenderer {...props} block={block} />;
    case 'tabs':
      return <TabsRenderer {...props} block={block} />;
    case 'accordion':
      return <AccordionRenderer {...props} block={block} />;
    case 'link':
      return <LinkRenderer block={block} />;
    case 'timeline':
      return <TimelineRenderer block={block} />;
    case 'keyvalue':
      return <KeyValueRenderer block={block} />;
    case 'tags':
      return <TagsRenderer block={block} />;
    case 'countdown':
      return <CountdownRenderer block={block} />;
    case 'reminder':
      return <ReminderRenderer {...props} block={block} />;
    case 'tasks':
      return <TasksRenderer {...props} block={block} />;
    case 'changes':
      return <ChangesRenderer {...props} block={block} />;
    case 'memory':
      return <MemoryWidgetRenderer {...props} block={block} />;
    default:
      return <FallbackRenderer block={block} />;
  }
}

function blockStateKey(block: UIBlock, index: number): string {
  return block?.id ? `id:${block.id}` : `index:${index}`;
}

/** Render one block. Top-level blocks (depth 0) are validated against the schema first. */
export function BlockRenderer(props: BlockRendererProps): ReactElement | null {
  const { block, depth = 0 } = props;
  const instance = useId();
  const scope = props.stateKey ?? (block?.id ? `id:${block.id}` : props.uiId ? `ui:${props.uiId}` : `instance:${instance}`);
  const valid = useMemo(() => (depth > 0 ? true : UIBlockSchema.safeParse(block).success), [block, depth]);
  if (depth > MAX_DEPTH) return null;
  if (!valid || !block || typeof block !== 'object') return <FallbackRenderer block={block} />;
  return (
    <RetainedStateScope scope={scope}>
      <RetainedStateScope scope={block.type}>
        <BlockBoundary block={block}>{renderBlock({ ...props, depth })}</BlockBoundary>
      </RetainedStateScope>
    </RetainedStateScope>
  );
}

export function BlockList({
  blocks,
  uiId,
  onAction,
  live,
  depth = 0,
  parentPath,
  childOffset = 0,
}: {
  blocks: UIBlock[];
  uiId?: string;
  onAction?: OnUIAction;
  live?: LiveData;
  depth?: number;
  parentPath?: readonly number[];
  childOffset?: number;
}): ReactElement {
  return (
    <div className={`neo-blocks${depth === 0 ? ' neo-blocks--root' : ''}`}>
      {blocks.map((block, i) => (
        <BlockRenderer key={block?.id ?? i} stateKey={blockStateKey(block, i)} blockPath={parentPath ? [...parentPath, childOffset + i] : []} block={block} uiId={uiId} onAction={onAction} live={live} depth={depth} />
      ))}
    </div>
  );
}
