/** Messages follow streaming output until the reader scrolls back in time. */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { NeoError, type ConfirmationDecision, type Message, type UIAction } from '@neo/protocol';
import { Button, MessageView, Spinner, useLocale, useT, type AvatarState, type LiveData } from '@neo/ui';
import { Menu } from '../../components/Menu.js';
import { recalledForMessage } from '../../lib/context.js';
import { errorMessage } from '../../lib/errors.js';
import { toDateInputValue, wallTimeOf } from '../../lib/time.js';
import { useSession } from '../../state/session.js';
import type { TimelineEntry } from '../../state/timeline.js';
import { MemoryNoticeCard } from './MemoryNotice.js';

const STICK_THRESHOLD = 96;

export interface MessageListProps {
  entry: TimelineEntry;
  assistantAvatar: string | null;
  avatarState: AvatarState;
  live: LiveData;
  modelLabel: (m: Message) => string | undefined;
  onConfirm: (confirmationId: string, decision: ConfirmationDecision) => Promise<void>;
  onUiAction: (input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> }) => Promise<void>;
  onRetry: (message: Message) => void;
  onDelete: (message: Message) => void;
  onOpenMemory: (id: string) => void;
  onLoadOlder: () => Promise<void>;
  onLatest: () => Promise<void>;
  stickToken: number;
  jump?: { messageId: string; token: number };
  dock: (jump: ReactNode) => ReactNode;
}

export function MessageList(props: MessageListProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const timezone = useSession((s) => s.settings?.timezone);
  const { entry, live, stickToken, jump } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const stick = useRef(!jump);
  const loading = useRef(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [atBottom, setAtBottom] = useState(!jump);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useLayoutEffect(() => {
    if (jump) return;
    stick.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [stickToken, scrollToBottom]);

  useLayoutEffect(() => {
    if (!jump) return;
    const row = rows.current.get(jump.messageId);
    if (!row) return;
    stick.current = false;
    setAtBottom(false);
    row.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    setHighlight(jump.messageId);
    const timer = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(timer);
  }, [jump?.token, jump?.messageId]);

  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (stick.current && !loading.current) scrollToBottom(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  const last = entry.messages.at(-1);
  const lastText = last?.parts.reduce((n, p) => n + (p.type === 'text' || p.type === 'reasoning' ? p.text.length : 0), 0) ?? 0;
  const signature = `${entry.messages.length}:${last?.parts.length ?? 0}:${last?.status ?? ''}:${lastText}:${entry.confirmations.length}:${Object.keys(entry.notices).length}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && anchor.current) {
      el.scrollTop = anchor.current.top + el.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else if (stick.current && !loading.current) scrollToBottom();
  }, [entry.messages, signature, scrollToBottom]);

  const loadOlder = async () => {
    if (loading.current || !entry.nextCursor) return;
    const el = scroller.current;
    anchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    stick.current = false;
    loading.current = true;
    setLoadingOlder(true);
    setLoadError(false);
    try { await props.onLoadOlder(); }
    catch { setLoadError(true); anchor.current = null; }
    finally { loading.current = false; setLoadingOlder(false); }
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    if (!loading.current) stick.current = bottom;
    setAtBottom(bottom);
    if (el.scrollTop <= 64 && entry.loaded && !loadError) void loadOlder();
  };
  const today = toDateInputValue(Date.now(), timezone);
  const now = wallTimeOf(Date.now(), timezone);
  const yesterday = new Date(Date.UTC(now.year, now.month - 1, now.day - 1)).toISOString().slice(0, 10);
  const dayLabel = (at: number) => {
    const day = toDateInputValue(at, timezone);
    return day === today ? t('timeline.today') : day === yesterday ? t('timeline.yesterday') : new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'long' }).format(at);
  };
  const jumpButton = !atBottom || entry.viewAround ? (
    <Button className="jump-latest" size="sm" variant="secondary" icon="arrow-down" onClick={() => {
      void props.onLatest().then(() => { stick.current = true; setAtBottom(true); scrollToBottom(true); }).catch(() => setLoadError(true));
    }}>{entry.turn ? t('chat.jump_streaming') : t('chat.jump_latest')}</Button>
  ) : null;

  return (
    <>
      <div ref={scroller} className="chat-scroll" onScroll={onScroll} data-testid="timeline-scroll">
        <div ref={content} className="chat-thread" role="log" aria-live="polite" aria-relevant="additions" aria-busy={Boolean(entry.turn) || undefined}>
          {entry.nextCursor && <div className="timeline-load"><Button size="sm" variant="ghost" icon="arrow-up" loading={loadingOlder} onClick={() => void loadOlder()}>{t('chat.load_older')}</Button></div>}
          {loadError && <p className="neo-help" role="alert">{t('timeline.load_error')}</p>}
          {!entry.loaded && entry.messages.length === 0 && <div className="timeline-load"><Spinner size={22} /></div>}
          {entry.messages.map((message, index) => {
            const previous = entry.messages[index - 1];
            const episodeId = message.episodeId ?? message.conversationId;
            const episode = entry.episodes[episodeId];
            const boundary = episode?.firstMessageId === message.id && episode;
            const day = !previous || toDateInputValue(message.createdAt, timezone) !== toDateInputValue(previous.createdAt, timezone);
            const streaming = message.role === 'assistant' && message.status === 'streaming' && entry.turn?.assistantMessageId === message.id;
            const recalled = message.role === 'assistant' ? (message.turnId ? entry.recalled[message.turnId] : undefined) ?? recalledForMessage(entry.messages, message) : undefined;
            const notice = message.role === 'assistant' && message.turnId ? entry.notices[message.turnId] : undefined;
            const confirmations = message.role === 'assistant' ? entry.confirmations.filter((c) => c.messageId === message.id || (streaming && c.turnId === entry.turn?.turnId)) : undefined;
            return (
              <Fragment key={message.id}>
                {day && <div className="timeline-day" role="separator" aria-label={dayLabel(message.createdAt)}>{dayLabel(message.createdAt)}</div>}
                {boundary && <div className="timeline-episode" role="separator" aria-label={t('timeline.episode_time', { time: new Intl.DateTimeFormat(locale, { timeZone: timezone, timeStyle: 'short' }).format(boundary.startedAt) })}><time dateTime={new Date(boundary.startedAt).toISOString()}>{new Intl.DateTimeFormat(locale, { timeZone: timezone, timeStyle: 'short' }).format(boundary.startedAt)}</time></div>}
                <div ref={(el) => { if (el) rows.current.set(message.id, el); else rows.current.delete(message.id); }} className="timeline-message" data-timeline-message={message.id} data-highlight={highlight === message.id || undefined} data-off-record={episode?.offRecord || undefined}>
                  <div className="timeline-message-actions"><Menu label={t('timeline.message_actions')} items={[{ label: t('common.delete'), icon: 'trash', danger: true, onSelect: () => props.onDelete(message) }]} /></div>
                  <MessageView
                    timezone={timezone}
                    message={message.error ? { ...message, error: { ...message.error, message: errorMessage(NeoError.fromShape(message.error), t) } } : message}
                    streaming={streaming} confirmations={confirmations} onConfirm={props.onConfirm} onUiAction={props.onUiAction}
                    recalled={recalled} assistantName="NEO" assistantAvatar={props.assistantAvatar} avatarState={streaming ? props.avatarState : undefined}
                    live={live} modelLabel={message.role === 'assistant' ? props.modelLabel(message) : undefined}
                    onRetry={message.role === 'assistant' && (message.status === 'error' || message.status === 'cancelled') && !entry.turn ? () => props.onRetry(message) : undefined}
                    onOpenMemory={props.onOpenMemory} footer={notice ? <MemoryNoticeCard notice={notice} /> : undefined}
                  />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
      {props.dock(jumpButton)}
    </>
  );
}
