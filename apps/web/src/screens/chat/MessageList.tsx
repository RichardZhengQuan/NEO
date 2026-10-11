/**
 * The message thread. Sticks to the bottom while new content streams in,
 * stops following as soon as the user scrolls up (a "Jump to latest" button
 * appears), and loads older pages at the top without jumping.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { ConfirmationDecision, Message, UIAction } from '@neo/protocol';
import { Button, MessageView, Spinner, useT, type AvatarState, type LiveData } from '@neo/ui';
import { recalledForMessage } from '../../lib/context.js';
import type { ConversationEntry } from '../../state/conversations.js';
import { MemoryNoticeCard } from './MemoryNotice.js';

const STICK_THRESHOLD = 96;

export interface MessageListProps {
  conversationId: string;
  entry: ConversationEntry;
  assistantName: string;
  assistantAvatar: string | null;
  avatarState: AvatarState;
  live: LiveData;
  modelLabel: (m: Message) => string | undefined;
  /** Answers by the confirmation's server nonce (`ToolConfirmation.id`). */
  onConfirm: (confirmationId: string, decision: ConfirmationDecision) => Promise<void>;
  onUiAction: (input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> }) => Promise<void>;
  onRetry: (message: Message) => void;
  onOpenMemory: (id: string) => void;
  onLoadOlder: () => Promise<void>;
  /** Bumped by the parent to force-scroll (after sending). */
  stickToken: number;
  /** Rendered after the messages (e.g. the empty-state hero). */
  children?: ReactNode;
  /** Rendered over the bottom edge (jump button anchor). */
  dock: (jump: ReactNode) => ReactNode;
}

export function MessageList(props: MessageListProps): ReactElement {
  const t = useT();
  const { conversationId, entry, live, stickToken } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // New conversation or explicit request: jump to the end and follow again.
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [conversationId, stickToken, scrollToBottom]);

  // Keep following while content grows (streamed text, images, widgets).
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  // Anything that can grow the thread: new messages/parts, streamed text,
  // confirmations and memory notices. (ResizeObserver covers late layout like
  // images; this covers React updates synchronously.)
  const last = entry.messages[entry.messages.length - 1];
  const lastText = last ? last.parts.reduce((n, p) => n + (p.type === 'text' || p.type === 'reasoning' ? p.text.length : 0), 0) : 0;
  const signature = `${entry.messages.length}:${last?.parts.length ?? 0}:${last?.status ?? ''}:${lastText}:${entry.confirmations.length}:${Object.keys(entry.notices).length}`;
  useLayoutEffect(() => {
    if (stick.current) scrollToBottom();
  }, [signature, scrollToBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };

  const loadOlder = async () => {
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    setLoadingOlder(true);
    try {
      await props.onLoadOlder();
    } finally {
      setLoadingOlder(false);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    }
  };

  const turn = entry.turn;
  const jump = !atBottom ? (
    <Button
      className="jump-latest"
      size="sm"
      variant="secondary"
      icon="arrow-down"
      onClick={() => {
        stick.current = true;
        setAtBottom(true);
        scrollToBottom(true);
      }}
    >
      {turn ? t('chat.jump_streaming') : t('chat.jump_latest')}
    </Button>
  ) : null;

  return (
    <>
      <div ref={scroller} className="chat-scroll" onScroll={onScroll}>
        <div ref={content} className="chat-thread" role="log" aria-live="polite" aria-relevant="additions" aria-busy={turn ? true : undefined}>
          {entry.hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Button size="sm" variant="ghost" icon="arrow-up" loading={loadingOlder} onClick={() => void loadOlder()}>
                {t('chat.load_older')}
              </Button>
            </div>
          )}
          {!entry.loaded && entry.messages.length === 0 && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <Spinner size={22} />
            </div>
          )}
          {entry.messages.map((m) => {
            const streaming = m.role === 'assistant' && m.status === 'streaming' && turn?.assistantMessageId === m.id;
            const recalled = m.role === 'assistant' ? (m.turnId ? entry.recalled[m.turnId] : undefined) ?? recalledForMessage(entry.messages, m) : undefined;
            const notice = m.role === 'assistant' && m.turnId ? entry.notices[m.turnId] : undefined;
            const confirmations = m.role === 'assistant' ? entry.confirmations.filter((c) => c.messageId === m.id || (streaming && c.turnId === turn?.turnId)) : undefined;
            return (
              <MessageView
                key={m.id}
                message={m}
                streaming={streaming}
                confirmations={confirmations}
                onConfirm={props.onConfirm}
                onUiAction={props.onUiAction}
                recalled={recalled}
                assistantName={props.assistantName}
                assistantAvatar={props.assistantAvatar}
                avatarState={streaming ? props.avatarState : undefined}
                live={live}
                modelLabel={m.role === 'assistant' ? props.modelLabel(m) : undefined}
                onRetry={m.role === 'assistant' && (m.status === 'error' || m.status === 'cancelled') && !turn ? () => props.onRetry(m) : undefined}
                onOpenMemory={props.onOpenMemory}
                footer={notice ? <MemoryNoticeCard conversationId={conversationId} notice={notice} /> : undefined}
              />
            );
          })}
          {props.children}
        </div>
      </div>
      {props.dock(jump)}
    </>
  );
}
