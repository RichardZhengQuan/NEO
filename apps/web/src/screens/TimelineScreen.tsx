/** The continuous relationship: one stream, one composer, no chat selection. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { textOf, type ConfirmationDecision, type ImagePart, type Message, type UIAction } from '@neo/protocol';
import { Button, Composer, Icon, Spinner, useAvatarState, useConfirm, useT, useUiActionConfirm, type ComposerHandle, type LiveData } from '@neo/ui';
import { cancelTurn, composeBody, deleteMessage, respondToConfirmation, retryTurn, runUiAction, sendMessage, setOffRecord } from '../actions/timeline.js';
import { openLink } from '../actions/links.js';
import { useCoarsePointer } from '../hooks/useMediaQuery.js';
import { navigate } from '../router.js';
import { loadOffRecord, loadTimeline } from '../state/connection.js';
import { useData } from '../state/data.js';
import { pushToast } from '../state/notifications.js';
import { currentSessionEpoch, isCurrentSession, requireClient, useSession } from '../state/session.js';
import { prependOlder, setTimeline, useTimeline } from '../state/timeline.js';
import { consumeTimelineSearch, registerComposer, useUi } from '../state/ui.js';
import { EmptyTimeline } from './timeline/EmptyTimeline.js';
import { JumpToDate } from './timeline/JumpToDate.js';
import { MessageList } from './timeline/MessageList.js';
import { TimelineHeader } from './timeline/TimelineHeader.js';
import { TimelineSearch } from './timeline/TimelineSearch.js';

export function TimelineScreen({ messageId }: { messageId?: string }): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const coarse = useCoarsePointer();
  const entry = useTimeline();
  const client = useSession((s) => s.client);
  useEffect(() => {
    if (!client) return;
    const epoch = currentSessionEpoch();
    const refresh = () => {
      if (!isCurrentSession(epoch, client)) return;
      void loadOffRecord(client).catch(() => {
        if (isCurrentSession(epoch, client)) pushToast({ tone: 'error', title: t('timeline.off_record_load_error'),
          actions: [{ label: t('common.retry'), onClick: refresh }] });
      });
    };
    refresh();
  }, [client, t]);
  const persona = useSession((s) => s.settings?.persona);
  const providers = useSession((s) => s.providers);
  const selectedModel = useSession((s) => s.settings?.ai.capabilities.text);
  const reminders = useData((s) => s.reminders);
  const tasks = useData((s) => s.tasks);
  const searchRequested = useUi((s) => s.timelineSearchRequested);
  const [overlay, setOverlay] = useState<'search' | 'date' | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [stickToken, setStickToken] = useState(0);
  const [jump, setJump] = useState<{ messageId: string; token: number }>();
  const composer = useRef<ComposerHandle | null>(null);
  const jumpSequence = useRef(0);
  const skipHomeLoad = useRef(false);
  const enabled = providers?.items.filter((p) => p.enabled && !p.needsReauthorization && p.kind !== 'mock') ?? [];
  const noProvider = providers !== null && (enabled.length === 0 || (!selectedModel && !enabled.some((p) => p.defaultModel?.trim())));
  const openAiSettings = () => navigate({ name: 'settings', section: 'ai' });

  useEffect(() => { setOverlay(null); setJump(undefined); }, [client]);
  useEffect(() => { if (searchRequested) { setOverlay('search'); consumeTimelineSearch(); } }, [searchRequested]);
  useEffect(() => {
    if (!client) return;
    if (!messageId && skipHomeLoad.current) { skipHomeLoad.current = false; return; }
    const current = useTimeline.getState();
    const epoch = currentSessionEpoch();
    const sequence = ++jumpSequence.current;
    setLoadFailed(false);
    const loading = current.loaded && current.viewAround === messageId ? Promise.resolve() : loadTimeline(client, messageId);
    void loading.then(() => {
      if (!isCurrentSession(epoch, client) || sequence !== jumpSequence.current) return;
      if (messageId && useTimeline.getState().messages.some((m) => m.id === messageId)) setJump({ messageId, token: sequence });
      else if (messageId) pushToast({ tone: 'info', title: t('timeline.message_missing') });
      else { setJump(undefined); setStickToken((n) => n + 1); }
    }).catch(() => {
      if (isCurrentSession(epoch, client) && sequence === jumpSequence.current) setLoadFailed(true);
    });
  }, [client, messageId, t, reloadToken]);

  const loadAnchor = async (around: string, isMessage: boolean) => {
    const active = requireClient();
    const epoch = currentSessionEpoch();
    const sequence = ++jumpSequence.current;
    await loadTimeline(active, around);
    if (!isCurrentSession(epoch, active) || sequence !== jumpSequence.current) return;
    const messages = useTimeline.getState().messages;
    const target = isMessage ? messages.find((m) => m.id === around) : messages.find((m) => m.createdAt >= Date.parse(around)) ?? messages[0];
    if (isMessage && !target) throw new Error(t('timeline.message_missing'));
    if (target) setJump({ messageId: target.id, token: sequence });
    if (isMessage) navigate({ name: 'timeline', messageId: around }, { replace: true });
    else if (messageId) { skipHomeLoad.current = true; navigate({ name: 'timeline' }, { replace: true }); }
  };
  const latest = async () => {
    const active = requireClient();
    const epoch = currentSessionEpoch();
    if (useTimeline.getState().viewAround) await loadTimeline(active);
    if (!isCurrentSession(epoch, active)) return;
    setJump(undefined);
    setStickToken((n) => n + 1);
    if (messageId) { skipHomeLoad.current = true; navigate({ name: 'timeline' }, { replace: true }); }
  };
  const setComposer = useCallback((handle: ComposerHandle | null) => { composer.current = handle; registerComposer(handle); }, []);
  const privacyBusy = entry.startingOffRecord || entry.endingOffRecord;
  const busy = entry.turn !== null;
  const streamingMessage = entry.turn ? entry.messages.find((m) => m.id === entry.turn!.assistantMessageId) : undefined;
  const avatarState = useAvatarState({ busy, text: streamingMessage ? textOf(streamingMessage.parts) : '', typing: composerText.trim() !== '' });
  const live: LiveData = useMemo(() => ({ reminders, tasks }), [reminders, tasks]);
  const modelLabel = (message: Message): string | undefined => {
    if (!message.model) return undefined;
    const provider = providers?.items.find((p) => p.id === message.model!.provider);
    return `${provider?.label ?? message.model.provider} · ${message.model.model}`;
  };
  const send = async (text: string, images: ImagePart[]) => {
    const body = composeBody(text, images);
    if ((!body.text && !body.parts) || noProvider || privacyBusy || !entry.offRecordLoaded) return;
    const active = requireClient();
    const epoch = currentSessionEpoch();
    setSending(true);
    try {
      await latest();
      if (!isCurrentSession(epoch, active)) return;
      await sendMessage(active, body, t);
    } catch {
      // Failed sends restore the draft; the action already reported the error.
      if (text && isCurrentSession(epoch, active)) composer.current?.setText(text);
    } finally { setSending(false); }
  };
  const onConfirm = (id: string, decision: ConfirmationDecision) => respondToConfirmation(requireClient(), id, decision, t);
  const askUiActionConfirm = useUiActionConfirm();
  const onUiAction = (input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> }) => runUiAction(requireClient(), input, t, askUiActionConfirm);
  const loadOlder = async () => {
    const current = useTimeline.getState();
    if (!current.nextCursor) return;
    const active = requireClient();
    const epoch = currentSessionEpoch();
    const data = await active.timeline.list({ limit: 50, before: current.nextCursor });
    if (isCurrentSession(epoch, active) && useTimeline.getState().viewAround === current.viewAround && useTimeline.getState().nextCursor === current.nextCursor) setTimeline((state) => prependOlder(state, data));
  };
  const dock = (jumpButton: ReactNode) => (
    <div className="chat-dock" data-off-record={entry.offRecord || undefined}>
      {jumpButton}
      {entry.offRecord && <div className="timeline-private-banner" role="status"><Icon name="eye-off" size={16} />{t('timeline.off_record_banner')}</div>}
      <div className="timeline-composer">
        <Composer handleRef={setComposer} onSend={(text, images) => void send(text, images)} onCancel={() => void cancelTurn(requireClient(), t)}
          busy={busy || sending} disabled={noProvider || privacyBusy || !entry.offRecordLoaded} onDraftChange={setComposerText} enterToSend={!coarse}
          placeholder={noProvider ? t('chat.connect_ai') : t('chat.placeholder')} autoFocus={!coarse && !noProvider} />
        <button type="button" className={`neo-btn neo-btn--sm neo-btn--${entry.offRecord ? 'secondary' : 'ghost'} timeline-off-record`} aria-pressed={entry.offRecord}
          title={t('timeline.off_record')} aria-busy={privacyBusy || undefined} disabled={!client || sending || privacyBusy || !entry.offRecordLoaded} onClick={() => void setOffRecord(requireClient(), !entry.offRecord, t).catch(() => undefined)}>
          {privacyBusy ? <Spinner size={14} /> : <Icon name="eye-off" size={14} />}{t('timeline.off_record')}
        </button>
      </div>
      {noProvider && <div className="timeline-connect"><p className="neo-help">{t('chat.connect_ai')}</p><Button size="sm" variant="secondary" icon="settings" onClick={openAiSettings}>{t('chat.open_ai_settings')}</Button></div>}
    </div>
  );
  return (
    <div className="page timeline-page">
      <TimelineHeader avatarState={avatarState} onSearch={() => setOverlay('search')} onDate={() => setOverlay('date')} />
      {loadFailed && <div className="timeline-load-error" role="alert"><span>{t('timeline.load_error')}</span><Button size="sm" onClick={() => setReloadToken((n) => n + 1)}>{t('common.retry')}</Button></div>}
      {entry.loaded && entry.messages.length === 0 ? <><div className="chat-scroll timeline-empty"><EmptyTimeline avatarState={avatarState} noProvider={noProvider} onSuggestion={(text) => void send(text, [])} onConnect={openAiSettings} /></div>{dock(null)}</> : (
        <MessageList entry={entry} assistantAvatar={persona?.avatar ?? null} avatarState={avatarState} live={live} modelLabel={modelLabel}
          onConfirm={onConfirm} onUiAction={onUiAction} onRetry={(message) => void retryTurn(requireClient(), message, t)}
          onDelete={(message) => void deleteMessage(requireClient(), message.id, t, confirm).catch(() => undefined)} onOpenMemory={(id) => openLink(`neo://memory/${id}`)}
          onLoadOlder={loadOlder} onLatest={latest} stickToken={stickToken} jump={jump} dock={dock} />
      )}
      {overlay === 'search' && <TimelineSearch onClose={() => setOverlay(null)} onJump={(id) => loadAnchor(id, true)} />}
      {overlay === 'date' && <JumpToDate onClose={() => setOverlay(null)} onJump={(date) => loadAnchor(date, false)} />}
    </div>
  );
}
