/**
 * Chat: the conversation on screen (or a new-chat draft), its streaming
 * messages, the composer, and the avatar that reacts to what's happening.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ConfirmationDecision, ImagePart, Message, UIAction } from '@neo/protocol';
import { textOf } from '@neo/protocol';
import { Badge, Composer, EmptyState, Button, useAvatarState, useT, useUiActionConfirm, type ComposerHandle, type LiveData } from '@neo/ui';
import {
  cancelTurn,
  composeBody,
  createConversation,
  respondToConfirmation,
  retryTurn,
  runUiAction,
  sendMessage,
} from '../actions/chat.js';
import { openLink } from '../actions/links.js';
import { useCoarsePointer } from '../hooks/useMediaQuery.js';
import { httpStatus } from '../lib/errors.js';
import { navigate } from '../router.js';
import { emptyEntry, prependOlder, setEntry, useConversations } from '../state/conversations.js';
import { loadConversation } from '../state/connection.js';
import { useData } from '../state/data.js';
import { pushToast } from '../state/notifications.js';
import { currentSessionEpoch, isCurrentSession, requireClient, useSession } from '../state/session.js';
import { registerComposer, useUi } from '../state/ui.js';
import { ChatHeader } from './chat/ChatHeader.js';
import { EmptyChat } from './chat/EmptyChat.js';
import { MessageList } from './chat/MessageList.js';
import { useModelLabel } from '../components/ModelPicker.js';

const EMPTY = emptyEntry();

export function ChatScreen({ conversationId }: { conversationId?: string }): ReactElement {
  const t = useT();
  const coarse = useCoarsePointer();
  const conversation = useConversations((s) => (conversationId ? s.conversations[conversationId] ?? null : null));
  const entry = useConversations((s) => (conversationId ? s.entries[conversationId] : undefined)) ?? EMPTY;
  const persona = useSession((s) => s.settings?.persona);
  const providers = useSession((s) => s.providers);
  const draft = useUi((s) => s.draft);
  const reminders = useData((s) => s.reminders);
  const tasks = useData((s) => s.tasks);
  const [composerText, setComposerText] = useState('');
  const [stickToken, setStickToken] = useState(0);
  const [missing, setMissing] = useState(false);
  const [sending, setSending] = useState(false);
  const composer = useRef<ComposerHandle | null>(null);
  const defaultModelLabel = useModelLabel(useSession((s) => s.settings?.defaultModel));

  // Load (or refresh) the conversation when it opens.
  useEffect(() => {
    setMissing(false);
    if (!conversationId) return;
    const current = useConversations.getState().entries[conversationId];
    if (current?.loaded) return;
    loadConversation(requireClient(), conversationId).catch((err) => {
      if (httpStatus(err) === 404) setMissing(true);
      else pushToast({ tone: 'error', title: t('chat.load_failed') });
    });
  }, [conversationId, t]);

  const setComposer = useCallback((h: ComposerHandle | null) => {
    composer.current = h;
    registerComposer(h);
  }, []);

  const busy = entry.turn !== null;
  const streamingMessage = entry.turn ? entry.messages.find((m) => m.id === entry.turn!.assistantMessageId) : undefined;
  const streamingText = streamingMessage ? textOf(streamingMessage.parts) : '';
  const avatarState = useAvatarState({ busy, text: streamingText, typing: composerText.trim() !== '' });

  const live: LiveData = useMemo(() => ({ reminders, tasks }), [reminders, tasks]);

  const modelLabel = (m: Message): string | undefined => {
    if (!m.model) return undefined;
    const p = providers?.items.find((x) => x.id === m.model!.provider);
    return `${p?.label ?? m.model.provider} · ${m.model.model}`;
  };

  const send = async (text: string, images: ImagePart[]) => {
    const body = composeBody(text, images);
    if (!body.text && !body.parts) return;
    const client = requireClient();
    const epoch = currentSessionEpoch();
    setSending(true);
    try {
      let id = conversationId;
      if (!id) {
        const conv = await createConversation(client, { incognito: draft.incognito, model: draft.model });
        if (!isCurrentSession(epoch, client)) return;
        id = conv.id;
        setEntry(id, (e) => ({ ...e, loaded: true }));
        navigate({ name: 'chat', conversationId: id }, { replace: true });
      }
      setStickToken((n) => n + 1);
      await sendMessage(client, id, body, t);
    } catch {
      // sendMessage already reported it; keep the text so nothing is lost.
      if (text) composer.current?.setText(text);
    } finally {
      setSending(false);
    }
  };

  // Tool confirmations are answered by their server nonce (`ToolConfirmation.id`).
  const onConfirm = (confirmationId: string, decision: ConfirmationDecision) => respondToConfirmation(requireClient(), conversationId!, confirmationId, decision, t);
  const askUiActionConfirm = useUiActionConfirm();
  const onUiAction = (input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> }) =>
    runUiAction(requireClient(), conversationId!, input, t, askUiActionConfirm);
  const onLoadOlder = async () => {
    const first = entry.messages[0];
    if (!conversationId || !first) return;
    const client = requireClient();
    const epoch = currentSessionEpoch();
    const data = await client.conversations.get(conversationId, { limit: 50, before: first.createdAt });
    if (isCurrentSession(epoch, client)) setEntry(conversationId, (e) => prependOlder(e, data));
  };

  const composerEl = (
    <Composer
      handleRef={setComposer}
      onSend={(text, images) => void send(text, images)}
      onCancel={() => void cancelTurn(requireClient(), conversationId!, t)}
      busy={busy || sending}
      onDraftChange={setComposerText}
      enterToSend={!coarse}
      placeholder={t('chat.placeholder', { name: persona?.name ?? 'NEO' })}
      autoFocus={!coarse}
    />
  );

  if (missing) {
    return (
      <div className="page">
        <ChatHeader conversation={null} avatarState="idle" />
        <EmptyState icon="message" title={t('chat.not_found')} description={t('chat.not_found_hint')} action={<Button variant="primary" onClick={() => navigate({ name: 'chat' }, { replace: true })}>{t('nav.new_chat')}</Button>} />
      </div>
    );
  }

  const empty = !conversationId || (entry.loaded && entry.messages.length === 0);
  const incognito = conversation ? conversation.incognito : draft.incognito;

  return (
    <div className="page">
      <ChatHeader conversation={conversation} avatarState={avatarState} />
      {empty ? (
        <>
          <div className="chat-scroll" style={{ display: 'flex' }}>
            <EmptyChat avatarState={avatarState} incognito={incognito} onSuggestion={(text) => void send(text, [])} />
          </div>
          <div className="chat-dock">
            {composerEl}
            {!defaultModelLabel && !(conversation?.model ?? draft.model) && providers && (
              <p className="neo-help" style={{ textAlign: 'center', margin: '0.5rem 0 0' }}>
                <button type="button" className="neo-link-btn" style={{ color: 'var(--neo-accent-text)' }} onClick={() => openLink('neo://settings/ai')}>
                  {t('chat.no_model')}
                </button>
              </p>
            )}
          </div>
        </>
      ) : (
        <MessageList
          conversationId={conversationId!}
          entry={entry}
          assistantName={persona?.name ?? 'NEO'}
          assistantAvatar={persona?.avatar ?? null}
          avatarState={avatarState}
          live={live}
          modelLabel={modelLabel}
          onConfirm={onConfirm}
          onUiAction={onUiAction}
          onRetry={(m) => void retryTurn(requireClient(), conversationId!, m, t)}
          onOpenMemory={(id) => openLink(`neo://memory/${id}`)}
          onLoadOlder={onLoadOlder}
          stickToken={stickToken}
          dock={(jump) => (
            <div className="chat-dock">
              {jump}
              {incognito && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.5rem' }}>
                  <Badge tone="neutral" icon="incognito">
                    {t('chat.incognito_hint')}
                  </Badge>
                </div>
              )}
              {composerEl}
            </div>
          )}
        />
      )}
    </div>
  );
}
