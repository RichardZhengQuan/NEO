/**
 * Primitive UI components shared by the generative-UI renderer and the apps:
 * buttons, form controls, chips, tabs, segmented controls, modal, empty state,
 * avatar initials. Styling comes from the `neo-` classes in styles.css.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.js';
import { useT } from './i18n.js';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── Button ────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';

export interface ButtonProps {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: string;
  /** Icon after the label. */
  iconRight?: string;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
  /** Full width. */
  block?: boolean;
  autoFocus?: boolean;
  id?: string;
  form?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  style?: CSSProperties;
  onClick?: () => void;
}

export function Button(props: ButtonProps): ReactElement {
  const {
    children,
    variant = 'secondary',
    size = 'md',
    icon,
    iconRight,
    loading = false,
    disabled = false,
    type = 'button',
    title,
    className,
    block,
    autoFocus,
    id,
    form,
    style,
    onClick,
  } = props;
  const iconSize = size === 'lg' ? 18 : size === 'sm' ? 14 : 16;
  return (
    <button
      id={id}
      type={type}
      form={form}
      title={title}
      autoFocus={autoFocus}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      onClick={onClick}
      style={style}
      className={cx('neo-btn', `neo-btn--${variant}`, size !== 'md' && `neo-btn--${size}`, block && 'neo-btn--block', className)}
    >
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={iconSize} />}
    </button>
  );
}

// ── IconButton ────────────────────────────────────────────────────────────

export function IconButton(props: {
  icon: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  /** Toggle state (renders aria-pressed). */
  pressed?: boolean;
  loading?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  /** Show the label as a native tooltip (default true). */
  tooltip?: boolean;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  'aria-haspopup'?: 'menu' | 'listbox' | 'dialog' | true;
}): ReactElement {
  const { icon, label, onClick, disabled = false, variant = 'ghost', size = 'md', pressed, loading, className, type = 'button', tooltip = true } = props;
  const iconSize = size === 'sm' ? 15 : size === 'lg' ? 20 : 18;
  return (
    <button
      type={type}
      aria-label={label}
      title={tooltip ? label : undefined}
      disabled={disabled || loading}
      aria-pressed={pressed}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      aria-haspopup={props['aria-haspopup']}
      onClick={onClick}
      className={cx('neo-btn', `neo-btn--${variant}`, 'neo-btn--icon', size === 'sm' && 'neo-btn--sm', size === 'lg' && 'neo-btn--lg', className)}
      style={size === 'lg' ? { width: '2.75rem', height: '2.75rem' } : undefined}
    >
      {loading ? <Spinner size={iconSize - 2} /> : <Icon name={icon} size={iconSize} />}
    </button>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────

export function Spinner(props: { size?: number; className?: string; label?: string }): ReactElement {
  const t = useT();
  const { size = 20, className, label } = props;
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      className={cx('neo-spinner', className)}
      role="img"
      aria-label={label ?? t('common.loading')}
    >
      <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray={`${circ * 0.28} ${circ * 0.72}`}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export function Badge(props: { children: ReactNode; tone?: Tone; icon?: string; className?: string; title?: string }): ReactElement {
  const { children, tone = 'neutral', icon, className, title } = props;
  return (
    <span className={cx('neo-badge', className)} data-tone={tone} title={title}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

// ── Chip ──────────────────────────────────────────────────────────────────

export function Chip(props: {
  children: ReactNode;
  /** Toggle state; renders aria-pressed. */
  pressed?: boolean;
  onClick?: () => void;
  /** Shows a remove (×) button. */
  onRemove?: () => void;
  removeLabel?: string;
  icon?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  title?: string;
}): ReactElement {
  const t = useT();
  const { children, pressed, onClick, onRemove, removeLabel, icon, size = 'md', disabled, className, title } = props;
  const cls = cx('neo-chip', size === 'sm' && 'neo-chip--sm', className);
  if (onRemove && !onClick) {
    return (
      <span className={cls} title={title}>
        {icon && <Icon name={icon} size={13} />}
        {children}
        <button type="button" className="neo-chip__remove" aria-label={removeLabel ?? t('common.remove')} onClick={onRemove} disabled={disabled}>
          <Icon name="x" size={12} />
        </button>
      </span>
    );
  }
  return (
    <button type="button" className={cls} aria-pressed={pressed} onClick={onClick} disabled={disabled} title={title}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </button>
  );
}

// ── Switch ────────────────────────────────────────────────────────────────

export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  /** Visually hidden label (when the visible label lives elsewhere). */
  ariaLabel?: string;
  description?: string;
  disabled?: boolean;
  id?: string;
}): ReactElement {
  const { checked, onChange, label, ariaLabel, description, disabled = false } = props;
  const autoId = useId();
  const id = props.id ?? autoId;
  return (
    <label htmlFor={id} className="neo-switch" data-disabled={disabled || undefined}>
      <span className="neo-switch__track">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="neo-switch__input"
          checked={checked}
          disabled={disabled}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={description ? `${id}-desc` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="neo-switch__thumb" aria-hidden="true" />
      </span>
      {(label || description) && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0 }}>
          {label && <span>{label}</span>}
          {description && (
            <span id={`${id}-desc`} className="neo-help">
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
}

// ── Form fields ───────────────────────────────────────────────────────────

interface FieldShellProps {
  id: string;
  label?: ReactNode;
  help?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label + control + help/error, wired with ids for assistive tech. */
export function Field({ id, label, help, error, required, className, children }: FieldShellProps): ReactElement {
  const t = useT();
  return (
    <div className={cx('neo-field', className)}>
      {label && (
        <label htmlFor={id} className="neo-label">
          {label}
          {required && (
            <span aria-hidden="true" style={{ color: 'var(--neo-tone-danger-text)' }}>
              {' '}
              *
            </span>
          )}
          {required && <span className="neo-sr"> ({t('common.required')})</span>}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="neo-error-text" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="neo-help" style={{ margin: 0 }}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, help: unknown, error: unknown): string | undefined {
  if (error) return `${id}-error`;
  if (help) return `${id}-help`;
  return undefined;
}

export interface TextFieldProps {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password' | 'email' | 'url' | 'number' | 'search' | 'date' | 'time' | 'datetime-local' | 'tel';
  placeholder?: string;
  help?: ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'url' | 'email' | 'numeric' | 'decimal' | 'search' | 'tel' | 'none';
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  step?: number;
  id?: string;
  name?: string;
  className?: string;
  size?: 'sm' | 'md';
  /** Leading icon. */
  icon?: string;
  /** Trailing element inside the field (e.g. a show/hide button). */
  addon?: ReactNode;
  spellCheck?: boolean;
  ariaLabel?: string;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
}

export function TextField(props: TextFieldProps): ReactElement {
  const autoId = useId();
  const id = props.id ?? autoId;
  const { label, value, onChange, type = 'text', placeholder, help, error, required, disabled, icon, addon, size = 'md' } = props;
  const input = (
    <input
      id={id}
      ref={props.inputRef}
      name={props.name}
      type={type}
      className={cx('neo-input', size === 'sm' && 'neo-input--sm')}
      value={value}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      autoFocus={props.autoFocus}
      autoComplete={props.autoComplete}
      inputMode={props.inputMode}
      maxLength={props.maxLength}
      min={props.min}
      max={props.max}
      step={props.step}
      spellCheck={props.spellCheck}
      aria-label={label ? undefined : props.ariaLabel}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, help, error)}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      onKeyDown={props.onKeyDown}
      onBlur={props.onBlur}
    />
  );
  return (
    <Field id={id} label={label} help={help} error={error} required={required} className={props.className}>
      {icon || addon ? (
        <div className="neo-input-group">
          {icon && (
            <span className="neo-input-icon">
              <Icon name={icon} size={16} />
            </span>
          )}
          {input}
          {addon && <span className="neo-input-addon">{addon}</span>}
        </div>
      ) : (
        input
      )}
    </Field>
  );
}

export function TextArea(props: {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  help?: ReactNode;
  error?: string | null;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
  id?: string;
  className?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  style?: CSSProperties;
  onBlur?: () => void;
}): ReactElement {
  const autoId = useId();
  const id = props.id ?? autoId;
  const { label, value, onChange, placeholder, help, error, rows = 4, required, disabled } = props;
  return (
    <Field id={id} label={label} help={help} error={error} required={required} className={props.className}>
      <textarea
        id={id}
        className="neo-textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        maxLength={props.maxLength}
        autoFocus={props.autoFocus}
        style={props.style}
        aria-label={label ? undefined : props.ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={props.onBlur}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

export function Select(props: {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroup[];
  help?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  style?: CSSProperties;
}): ReactElement {
  const autoId = useId();
  const id = props.id ?? autoId;
  const { label, value, onChange, options = [], groups = [], help, error, disabled, required, size = 'md' } = props;
  const select = (
    <div className="neo-select-wrap" style={props.style}>
      <select
        id={id}
        className={cx('neo-select', size === 'sm' && 'neo-select--sm')}
        value={value}
        disabled={disabled}
        required={required}
        aria-label={label ? undefined : props.ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="neo-select-chevron">
        <Icon name="chevron-down" size={14} />
      </span>
    </div>
  );
  if (!label && !help && !error) return <div className={props.className}>{select}</div>;
  return (
    <Field id={id} label={label} help={help} error={error} required={required} className={props.className}>
      {select}
    </Field>
  );
}

// ── SegmentedControl ──────────────────────────────────────────────────────

export function SegmentedControl<T extends string>(props: {
  value: T;
  options: { value: T; label: string; icon?: string }[];
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
  disabled?: boolean;
}): ReactElement {
  const { value, options, onChange, label, className, disabled } = props;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const opt = options[next];
    if (opt) {
      onChange(opt.value);
      refs.current[next]?.focus();
    }
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx('neo-segmented', className)}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={disabled}
          className="neo-segmented__item"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────

export interface TabItem {
  id: string;
  label: string;
  icon?: string;
  /** Small count badge (hidden when 0/undefined). */
  count?: number;
}

/** Tab strip with roving focus. Pair with panels that use `tabPanelProps`. */
export function Tabs(props: {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  /** Prefix for tab/panel ids (defaults to a generated id). */
  idPrefix?: string;
  className?: string;
}): ReactElement {
  const autoId = useId();
  const prefix = props.idPrefix ?? autoId;
  const { tabs, value, onChange, label, className } = props;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const tab = tabs[next];
    if (tab) {
      onChange(tab.id);
      refs.current[next]?.focus();
    }
  };
  return (
    <div role="tablist" aria-label={label} className={cx('neo-tabs', className)}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`${prefix}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          aria-controls={`${prefix}-panel-${tab.id}`}
          tabIndex={tab.id === value ? 0 : -1}
          className="neo-tab"
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {tab.icon && <Icon name={tab.icon} size={15} />}
          {tab.label}
          {tab.count ? <span className="neo-tab__count">{tab.count > 99 ? '99+' : tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Props for the panel that belongs to a tab rendered by <Tabs idPrefix={prefix}>. */
export function tabPanelProps(prefix: string, id: string): { id: string; role: 'tabpanel'; 'aria-labelledby': string; tabIndex: number } {
  return { id: `${prefix}-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `${prefix}-tab-${id}`, tabIndex: 0 };
}

// ── Modal ─────────────────────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Element to focus when opening (defaults to the first focusable control in the body). */
  initialFocus?: string;
  /** Hide the × button (the dialog still closes on Escape / backdrop). */
  hideClose?: boolean;
  /** Clicking the backdrop closes the dialog (default true). */
  dismissable?: boolean;
  /**
   * Element to restore focus to when the dialog closes. When provided, Modal
   * uses this instead of reading `document.activeElement` at mount time — which
   * would capture the autoFocused child rather than the original opener.
   */
  restoreFocus?: HTMLElement | null;
}): ReactElement | null {
  const t = useT();
  const { open, onClose, title, children, footer, size = 'md', hideClose, dismissable = true, restoreFocus } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // When a restoreFocus element is passed, prefer it over document.activeElement.
  // Capturing document.activeElement inside the effect is too late: React's
  // autoFocus runs during the commit phase, before effects fire, so the focused
  // element at that point is already the autoFocused child, not the opener.
  const restoreFocusRef = useRef(restoreFocus ?? null);
  restoreFocusRef.current = restoreFocus ?? null;

  useEffect(() => {
    if (!open) return;
    const previous = restoreFocusRef.current ?? (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null);
    const el = dialogRef.current;
    if (el) {
      const preferred = props.initialFocus ? el.querySelector<HTMLElement>(props.initialFocus) : null;
      const body = el.querySelector<HTMLElement>('.neo-modal__body');
      const target = preferred ?? body?.querySelector<HTMLElement>(FOCUSABLE) ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
      target.focus();
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        // stopImmediatePropagation prevents a second Modal listener (registered
        // earlier, i.e. an outer/parent Modal) from also firing on the same
        // event — avoiding a double-close when Modals are nested.
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      // Prevent outer Modal listeners from also processing this Tab keystroke.
      e.stopImmediatePropagation();
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="neo-modal-backdrop"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cx('neo-modal', `neo-modal--${size}`)}
      >
        {(title || !hideClose) && (
          <div className="neo-modal__header">
            {title ? (
              <h2 id={titleId} className="neo-modal__title">
                {title}
              </h2>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            {!hideClose && <IconButton icon="x" label={t('common.close')} onClick={onClose} size="sm" />}
          </div>
        )}
        <div className="neo-modal__body">{children}</div>
        {footer && <div className="neo-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────

export function EmptyState(props: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Custom artwork instead of the icon tile. */
  art?: ReactNode;
  className?: string;
}): ReactElement {
  const { icon, title, description, action, art, className } = props;
  return (
    <div className={cx('neo-empty', className)}>
      {art ??
        (icon && (
          <span className="neo-empty__icon">
            <Icon name={icon} size={22} />
          </span>
        ))}
      <p className="neo-empty__title">{title}</p>
      {description && <p className="neo-empty__text">{description}</p>}
      {action && <div style={{ marginTop: '0.375rem' }}>{action}</div>}
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────

export function Skeleton(props: { width?: number | string; height?: number | string; className?: string; style?: CSSProperties }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cx('neo-skeleton', props.className)}
      style={{ display: 'block', width: props.width ?? '100%', height: props.height ?? 14, ...props.style }}
    />
  );
}

// ── Avatar (initials / image) ─────────────────────────────────────────────

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${[...parts[0]!][0] ?? ''}${[...parts[1]!][0] ?? ''}`.toUpperCase();
  return [...name.trim()].slice(0, 2).join('').toUpperCase() || '?';
}

/** Deterministic color from a name. */
function nameColor(name: string): string {
  const colors = ['#7C5CFF', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#F97316', '#6366F1'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return colors[h % colors.length] ?? colors[0]!;
}

export function Avatar(props: { name: string; src?: string | null; size?: number }): ReactElement {
  const { name, src, size = 32 } = props;
  const [imgError, setImgError] = useState(false);
  useEffect(() => setImgError(false), [src]);

  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        onError={() => setImgError(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0 }}
      />
    );
  }
  return (
    <span role="img" aria-label={name} className="neo-initials" style={{ width: size, height: size, background: nameColor(name), fontSize: size * 0.38 }}>
      {initials(name)}
    </span>
  );
}
