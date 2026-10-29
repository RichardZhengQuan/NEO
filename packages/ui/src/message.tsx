/**
 * MessageView and ConfirmationCard.
 *
 * Renders exactly the protocol's content parts (content.ts): text, image,
 * reasoning, tool_call, tool_result, ui, ui_event, sources; context and provider replay parts are hidden.
 * A tool_call and its tool_result are paired into one chip (running → done /
 * error); tool confirmations appear inline under the call they belong to.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type {
  ConfirmationDecision,
  ContentPart,
  ImagePart,
  Message,
  RecalledMemorySummary,
  ReasoningPart,
  Source,
  ToolCallPart,
  ToolConfirmation,
  ToolResultPart,
  UIAction,
  UIEventPart,
  UiActionConfirmation,
} from '@neo/protocol';
import { Icon } from './icons.js';
import { Markdown } from './markdown.js';
import { BlockList, type LiveData, type OnUIAction } from './blocks.js';
import { RetainedStateScope } from './retained-state.js';
import { useT, type TranslateFn } from './i18n.js';
import { Badge, Button, IconButton, Spinner, type Tone } from './primitives.js';
import { useConfirm, type ConfirmOptions } from './confirm.js';
import { NeoAvatar } from './avatar/index.js';
import type { AvatarState } from './avatar/index.js';
import { copyText } from './clipboard.js';
import { SafeImage } from './remote-image.js';
import { useLinkClick } from './links.js';
import { isSafeLinkUrl } from '@neo/protocol';

/** Tools whose calls only exist to show UI; their chips would be noise. */
const SILENT_TOOLS = new Set(['render_ui']);

/** "create_reminder" → "Create reminder". */
export function humanizeToolName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function imageSrc(part: ImagePart): string | null {
  if (part.url) return /^https?:\/\//i.test(part.url) ? part.url : null;
  if (part.data && /^image\/(png|jpe?g|gif|webp|avif)$/i.test(part.mediaType)) return `data:${part.mediaType};base64,${part.data}`;
  return null;
}

function stringify(value: unknown, max = 4000): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value, null, 2) ?? '';
    } catch {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── ConfirmationCard ──────────────────────────────────────────────────────

const RISK_TONE: Record<string, Tone> = { read: 'info', write: 'accent', external: 'warning', dangerous: 'danger' };

/**
 * Dialog options for a UI action the server wants confirmed. Built ONLY from
 * the server's confirmation (generated from the real tool and its input),
 * never from model-written labels such as `UIAction.confirm`.
 */
export function uiActionConfirmOptions(confirmation: UiActionConfirmation, t: TranslateFn): ConfirmOptions {
  const title = confirmation.title || humanizeToolName(confirmation.tool);
  return {
    title,
    message: confirmation.description || title,
    badge: { label: t(`chat.risk.${confirmation.risk}`), tone: RISK_TONE[confirmation.risk] ?? 'neutral' },
    detail: confirmation.tool,
    danger: confirmation.risk === 'dangerous',
    confirmLabel: t('common.approve'),
    cancelLabel: t('common.cancel'),
  };
}

/** `ask(confirmation) → Promise<boolean>`: shows the server's confirmation for a UI action. */
export function useUiActionConfirm(): (confirmation: UiActionConfirmation) => Promise<boolean> {
  const confirm = useConfirm();
  const t = useT();
  return useCallback((confirmation: UiActionConfirmation) => confirm(uiActionConfirmOptions(confirmation, t)), [confirm, t]);
}

function useCountdown(until: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  return until != null ? Math.max(0, Math.round((until - now) / 1000)) : null;
}

export function ConfirmationCard({
  confirmation,
  onDecision,
  assistantName = 'NEO',
}: {
  confirmation: ToolConfirmation;
  onDecision?: (decision: ConfirmationDecision) => void | Promise<void>;
  /** Persona name for the heading ("Nova wants to do this"). */
  assistantName?: string;
}): ReactElement {
  const t = useT();
  const [busy, setBusy] = useState<'approve' | 'always' | 'deny' | null>(null);
  const [showInput, setShowInput] = useState(false);
  const left = useCountdown(confirmation.expiresAt);
  const decide = async (kind: 'approve' | 'always' | 'deny') => {
    if (!onDecision) return;
    setBusy(kind);
    try {
      await onDecision(kind === 'deny' ? { approve: false } : kind === 'always' ? { approve: true, always: true } : { approve: true });
    } finally {
      setBusy(null);
    }
  };
  const title = confirmation.title || humanizeToolName(confirmation.name);
  const hasInput = confirmation.input !== undefined && confirmation.input !== null && stringify(confirmation.input) !== '{}';
  return (
    <div className="neo-confirm" data-risk={confirmation.risk} role="group" aria-label={t('chat.confirm_title', { name: assistantName })}>
      <div className="neo-confirm__head">
        <span className="neo-confirm__icon">
          <Icon name={confirmation.risk === 'dangerous' ? 'alert-triangle' : 'shield'} size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.375rem 0.5rem' }}>
            <span style={{ fontWeight: 650, fontSize: '0.9375rem', color: 'var(--neo-text)' }}>{t('chat.confirm_title', { name: assistantName })}</span>
            <Badge tone={RISK_TONE[confirmation.risk] ?? 'neutral'}>{t(`chat.risk.${confirmation.risk}`)}</Badge>
          </div>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--neo-text)', lineHeight: 1.5 }}>{confirmation.description || title}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem', fontSize: '0.75rem', color: 'var(--neo-text-muted)' }}>
            <span>{title}</span>
            {left !== null && left > 0 && (
              <span aria-live="off">{t('chat.confirm_expires', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</span>
            )}
            {hasInput && (
              <button type="button" className="neo-link-btn" aria-expanded={showInput} onClick={() => setShowInput((v) => !v)} style={{ fontSize: '0.75rem' }}>
                {showInput ? t('chat.hide_details') : t('chat.show_details')}
              </button>
            )}
          </div>
        </div>
      </div>
      {showInput && (
        <div className="neo-disclosure">
          <pre>{stringify(confirmation.input)}</pre>
        </div>
      )}
      <div className="neo-confirm__actions">
        <Button variant="primary" size="sm" icon="check" loading={busy === 'approve'} disabled={busy !== null || !onDecision} onClick={() => void decide('approve')}>
          {t('common.approve')}
        </Button>
        <Button variant="secondary" size="sm" loading={busy === 'always'} disabled={busy !== null || !onDecision} onClick={() => void decide('always')}>
          {t('common.always_allow')}
        </Button>
        <Button variant="ghost" size="sm" loading={busy === 'deny'} disabled={busy !== null || !onDecision} onClick={() => void decide('deny')}>
          {t('common.deny')}
        </Button>
      </div>
    </div>
  );
}

// ── Tool chip ─────────────────────────────────────────────────────────────

type ToolStatus = 'running' | 'waiting' | 'done' | 'error' | 'incomplete';

function ToolChip({ call, result, status }: { call?: ToolCallPart; result?: ToolResultPart; status: ToolStatus }): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = call?.name ?? result?.name ?? 'tool';
  const icon = status === 'running' ? null : status === 'waiting' ? 'shield' : status === 'done' ? 'check-circle' : 'alert-circle';
  const summary = result?.summary ?? (status === 'running' ? t('chat.tool_running') : status === 'waiting' ? t('chat.tool_waiting') : status === 'incomplete' ? t('chat.tool_incomplete') : status === 'error' ? t('chat.tool_error') : t('chat.tool_done'));
  return (
    <div style={{ minWidth: 0 }}>
      <button type="button" className="neo-pill" data-status={status === 'incomplete' ? 'error' : status} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="neo-pill__icon" style={{ display: 'inline-flex' }}>
          {icon ? <Icon name={icon} size={14} /> : <Spinner size={13} />}
        </span>
        <span className="neo-pill__label">{humanizeToolName(name)}</span>
        <span className="neo-pill__meta">{summary}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
      </button>
      {open && (
        <div className="neo-disclosure">
          {call && (
            <>
              <div style={{ fontWeight: 600 }}>{t('chat.tool_input')}</div>
              <pre>{stringify(call.input)}</pre>
            </>
          )}
          {result && (
            <>
              <div style={{ fontWeight: 600, marginTop: call ? '0.5rem' : 0 }}>{t('chat.tool_output')}</div>
              <pre>{stringify(result.output)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Reasoning ─────────────────────────────────────────────────────────────

function ReasoningView({ part, active, defaultOpen }: { part: ReasoningPart; active: boolean; defaultOpen: boolean }): ReactElement | null {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  if (part.redacted && !part.text) {
    return (
      <span className="neo-pill" style={{ cursor: 'default' }}>
        <Icon name="lock" size={13} />
        {t('chat.reasoning_hidden')}
      </span>
    );
  }
  if (!part.text && !active) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <button type="button" className="neo-pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="neo-pill__icon" style={{ display: 'inline-flex', color: 'var(--neo-accent-text)' }}>
          {active ? <Spinner size={13} /> : <Icon name="sparkles" size={14} />}
        </span>
        <span className="neo-pill__label">{active ? t('chat.thinking') : t('chat.thought_process')}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
      </button>
      {open && part.text && <div className="neo-reasoning-text">{part.text}</div>}
    </div>
  );
}

// ── Recalled memories ─────────────────────────────────────────────────────

function RecalledChip({ recalled, onOpenMemory }: { recalled: RecalledMemorySummary[]; onOpenMemory?: (id: string) => void }): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ minWidth: 0 }}>
      <button type="button" className="neo-pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="neo-pill__icon" style={{ display: 'inline-flex', color: 'var(--neo-accent-text)' }}>
          <Icon name="brain" size={14} />
        </span>
        <span className="neo-pill__label">{t('chat.recalled', { n: recalled.length })}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
      </button>
      {open && (
        <div className="neo-disclosure">
          <ul className="neo-recalled-list">
            {recalled.map((r) => (
              <li key={r.id} className="neo-recalled-item">
                <span className="neo-kind-dot" data-kind={r.kind} title={t(`memory.kind.${r.kind}`)} />
                {onOpenMemory ? (
                  <button type="button" className="neo-link-btn neo-recalled-item__label" onClick={() => onOpenMemory(r.id)}>
                    {r.label}
                  </button>
                ) : (
                  <span className="neo-recalled-item__label">{r.label}</span>
                )}
                {r.reason && <span className="neo-recalled-item__reason">{r.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── MessageView ───────────────────────────────────────────────────────────

export interface MessageViewProps {
  message: Message;
  /** This message is the assistant message of the running turn. */
  streaming?: boolean;
  confirmations?: ToolConfirmation[];
  /**
   * Answer a tool confirmation. The first argument is the confirmation's
   * server nonce (`ToolConfirmation.id`, `cnf_…`), which is what the API
   * expects; never answer with the tool call id.
   */
  onConfirm?: (confirmationId: string, decision: ConfirmationDecision, confirmation: ToolConfirmation) => void | Promise<void>;
  onUiAction?: (input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> }) => void | Promise<void>;
  recalled?: RecalledMemorySummary[];
  /** Expand reasoning by default (it is always available as a collapsed chip). */
  showReasoning?: boolean;
  assistantName?: string;
  /** persona.avatar: a `neo-avatar:` config, legacy emoji/URL, or null (default character). */
  assistantAvatar?: string | null;
  live?: LiveData;
  /** Animation state for the assistant avatar while streaming. */
  avatarState?: AvatarState;
  /** Shown on error/cancelled assistant messages. */
  onRetry?: () => void;
  /** Recalled-memory labels become links. */
  onOpenMemory?: (id: string) => void;
  /** e.g. "Anthropic · claude-sonnet-5-5", shown as a tooltip on the avatar. */
  modelLabel?: string;
  /** Extra content under the message (memory card, notices…). */
  footer?: ReactNode;
}

interface RenderItem {
  key: string;
  node: ReactElement;
}

function SourceLink({ source }: { source: Source }): ReactElement {
  const onClick = useLinkClick(source.url);
  return <a className="neo-source" href={source.url} target="_blank" rel="noopener noreferrer" title={source.snippet ? `${source.title}\n${source.snippet}` : source.url} onClick={onClick}>{source.title || source.url}</a>;
}

function SourcesView({ sources }: { sources: Source[] }): ReactElement | null {
  const t = useT();
  const seen = new Set<string>();
  const items = sources.filter((source) => {
    if (!/^https?:\/\//i.test(source.url) || !isSafeLinkUrl(source.url) || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
  if (!items.length) return null;
  return (
    <div className="neo-sources" role="group" aria-label={t('chat.sources')}>
      <span className="neo-sources__label">{t('chat.sources')}</span>
      {items.map((source) => <SourceLink key={source.url} source={source} />)}
    </div>
  );
}

export function MessageView(props: MessageViewProps): ReactElement {
  const {
    message,
    streaming = false,
    confirmations = [],
    onConfirm,
    onUiAction,
    recalled = [],
    showReasoning = false,
    assistantName = 'NEO',
    assistantAvatar = null,
    live,
    avatarState,
    onRetry,
    onOpenMemory,
    modelLabel,
    footer,
  } = props;
  const t = useT();
  const [copied, setCopied] = useState(false);

  const onAction: OnUIAction | undefined = onUiAction
    ? (action, ctx) => {
        if (!ctx.uiId) return;
        const input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> } = { messageId: message.id, uiId: ctx.uiId, action };
        if (ctx.values) input.values = ctx.values;
        return onUiAction(input);
      }
    : undefined;

  const parts: ContentPart[] = useMemo(() => message.parts.filter((p) => p.type !== 'context'), [message.parts]);
  const plainText = useMemo(() => parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n\n').trim(), [parts]);

  // ── system notice ──
  if (message.role === 'system') {
    return (
      <div className="neo-msg" style={{ justifyContent: 'center' }}>
        <div className="neo-msg__notice">{plainText}</div>
      </div>
    );
  }

  // ── user message ──
  if (message.role === 'user') {
    const images = parts.filter((p): p is ImagePart => p.type === 'image');
    const events = parts.filter((p): p is UIEventPart => p.type === 'ui_event');
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');
    return (
      <div className="neo-msg neo-msg--user" data-message-id={message.id}>
        <div className="neo-msg__body">
          {images.length > 0 && (
            <div className="neo-msg__images">
              {images.map((img, i) => {
                const src = imageSrc(img);
                return src ? <SafeImage key={i} className="neo-msg__image" src={src} alt={img.alt ?? t('chat.image_attachment')} /> : null;
              })}
            </div>
          )}
          {events.map((ev, i) => (
            <span key={`ev${i}`} className="neo-pill" style={{ cursor: 'default' }}>
              <Icon name="corner-down-left" size={13} />
              <span className="neo-pill__label">{ev.label ?? t('chat.ui_event')}</span>
              {ev.values && Object.keys(ev.values).length > 0 && <span className="neo-pill__meta">{t('chat.ui_event_values', { n: Object.keys(ev.values).length })}</span>}
            </span>
          ))}
          {text && <div className="neo-bubble">{text}</div>}
        </div>
      </div>
    );
  }

  // ── assistant message ──
  const results = new Map<string, ToolResultPart>();
  const calls = new Set<string>();
  for (const p of parts) {
    if (p.type === 'tool_result') results.set(p.toolCallId, p);
    if (p.type === 'tool_call') calls.add(p.id);
  }
  // Placed next to their tool chip by tool call id (this message's own first:
  // provider call ids can repeat across turns); answered by `id`.
  const confirmationFor = new Map<string, ToolConfirmation>();
  for (const c of confirmations.filter((c) => c.messageId === message.id)) {
    if (!confirmationFor.has(c.toolCallId) || c.messageId === message.id) confirmationFor.set(c.toolCallId, c);
  }
  const shownConfirmations = new Set<string>();
  const lastIndex = parts.length - 1;
  const items: RenderItem[] = [];

  parts.forEach((part, i) => {
    switch (part.type) {
      case 'text':
        if (part.text) items.push({ key: `t${i}`, node: <Markdown text={part.text} streaming={streaming && i === lastIndex} /> });
        break;
      case 'reasoning':
        items.push({ key: `r${i}`, node: <ReasoningView part={part} active={streaming && i === lastIndex} defaultOpen={showReasoning} /> });
        break;
      case 'tool_call': {
        const result = results.get(part.id);
        const confirmation = confirmationFor.get(part.id);
        const status: ToolStatus = result ? (result.isError ? 'error' : 'done') : confirmation ? 'waiting' : streaming ? 'running' : 'incomplete';
        if (SILENT_TOOLS.has(part.name) && status !== 'error' && status !== 'incomplete') break;
        items.push({ key: `c${part.id}`, node: <ToolChip call={part} result={result} status={status} /> });
        if (confirmation) {
          shownConfirmations.add(confirmation.id);
          items.push({ key: `k${confirmation.id}`, node: <ConfirmationCard confirmation={confirmation} assistantName={assistantName} onDecision={onConfirm ? (d) => onConfirm(confirmation.id, d, confirmation) : undefined} /> });
        }
        break;
      }
      case 'tool_result':
        // Paired with its call above; an orphan result still gets a chip.
        if (!calls.has(part.toolCallId) && !SILENT_TOOLS.has(part.name)) {
          items.push({ key: `o${i}`, node: <ToolChip result={part} status={part.isError ? 'error' : 'done'} /> });
        }
        break;
      case 'ui':
        items.push({ key: `u${part.id}`, node: (
          <RetainedStateScope scope="messages">
            <RetainedStateScope scope={message.id}>
              <RetainedStateScope scope="ui">
                <RetainedStateScope scope={part.id}>
                  <BlockList blocks={[part.block]} uiId={part.id} onAction={onAction} live={live} />
                </RetainedStateScope>
              </RetainedStateScope>
            </RetainedStateScope>
          </RetainedStateScope>
        ) });
        break;
      case 'image': {
        const src = imageSrc(part);
        if (src) items.push({ key: `i${i}`, node: <SafeImage className="neo-msg__image" src={src} alt={part.alt ?? t('chat.image_attachment')} /> });
        break;
      }
      default:
        // ui_event and context parts never appear in assistant messages; anything else is ignored.
        break;
    }
  });
  // Confirmations that arrived before their tool_call part.
  for (const c of confirmations) {
    if (!shownConfirmations.has(c.id) && c.messageId === message.id) {
      items.push({ key: `k${c.id}`, node: <ConfirmationCard confirmation={c} assistantName={assistantName} onDecision={onConfirm ? (d) => onConfirm(c.id, d, c) : undefined} /> });
    }
  }

  const hasText = plainText.length > 0;
  const sources = parts.flatMap((part) => part.type === 'sources' ? part.items : []);
  const lastIsTextOrReasoning = parts[lastIndex]?.type === 'text' || parts[lastIndex]?.type === 'reasoning';
  const state: AvatarState = avatarState ?? (streaming ? (hasText && lastIsTextOrReasoning ? 'speaking' : 'thinking') : 'idle');
  const failed = message.status === 'error';
  const cancelled = message.status === 'cancelled';

  return (
    <div className="neo-msg" data-message-id={message.id} data-status={message.status}>
      <div className="neo-msg__avatar" title={modelLabel ? `${assistantName} · ${modelLabel}` : assistantName}>
        <NeoAvatar avatar={assistantAvatar} size={28} animated={streaming} state={streaming ? state : 'idle'} title={assistantName} />
      </div>
      <div className="neo-msg__body">
        {recalled.length > 0 && <RecalledChip recalled={recalled} onOpenMemory={onOpenMemory} />}
        {items.map((item) => (
          <div key={item.key} style={{ minWidth: 0 }}>
            {item.node}
          </div>
        ))}
        <SourcesView sources={sources} />
        {streaming && !lastIsTextOrReasoning && items.length === 0 && (
          <span className="neo-thinking" role="status" aria-label={t('chat.thinking')}>
            <span />
            <span />
            <span />
          </span>
        )}
        {failed && (
          <div className="neo-msg__error" role="alert">
            <Icon name="alert-circle" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t('chat.error_title')}</div>
              <div style={{ color: 'var(--neo-text-muted)' }}>{message.error?.message ?? t('common.error')}</div>
            </div>
            {onRetry && (
              <Button size="sm" variant="secondary" icon="rotate-ccw" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
        {cancelled && (
          <div className="neo-msg__status">
            <Icon name="stop" size={13} />
            <span>{t('chat.stopped')}</span>
            {onRetry && (
              <button type="button" className="neo-link-btn" onClick={onRetry} style={{ color: 'var(--neo-accent-text)' }}>
                {t('common.retry')}
              </button>
            )}
          </div>
        )}
        {!streaming && hasText && (
          <div className="neo-msg__actions">
            <IconButton
              icon={copied ? 'check' : 'copy'}
              label={copied ? t('common.copied') : t('chat.copy_message')}
              size="sm"
              onClick={() => {
                void copyText(plainText).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            />
          </div>
        )}
        {footer}
      </div>
    </div>
  );
}
