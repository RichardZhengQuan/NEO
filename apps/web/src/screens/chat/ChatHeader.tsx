/**
 * Chat header: editable title, incognito badge, per-conversation model picker
 * and the conversation menu.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Conversation, ModelRef } from '@neo/protocol';
import { Badge, NeoAvatar, useConfirm, useT, type AvatarState } from '@neo/ui';
import { deleteConversation, renameConversation, setConversationFlags, setConversationModel } from '../../actions/chat.js';
import { Menu } from '../../components/Menu.js';
import { ModelPicker, useModelLabel } from '../../components/ModelPicker.js';
import { PageHeader } from '../../components/PageHeader.js';
import { startNewChat } from '../../components/Shell.js';
import { useIsDesktop } from '../../hooks/useMediaQuery.js';
import { navigate } from '../../router.js';
import { requireClient, useSession } from '../../state/session.js';
import { useUi } from '../../state/ui.js';

function TitleEditor({ conversation }: { conversation: Conversation }): ReactElement {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(conversation.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(conversation.title), [conversation.title]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = () => {
    setEditing(false);
    const next = value.trim().slice(0, 200);
    if (next && next !== conversation.title) void renameConversation(requireClient(), conversation.id, next, t);
    else setValue(conversation.title);
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="title-input"
        value={value}
        aria-label={t('chat.rename')}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setValue(conversation.title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button type="button" className="title-btn" onClick={() => setEditing(true)} title={t('chat.rename')}>
      {conversation.title || t('chat.untitled')}
    </button>
  );
}

export function ChatHeader({ conversation, avatarState }: { conversation: Conversation | null; avatarState: AvatarState }): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const desktop = useIsDesktop();
  const settings = useSession((s) => s.settings);
  const draft = useUi((s) => s.draft);
  const defaultLabel = useModelLabel(settings?.defaultModel);
  const incognito = conversation ? conversation.incognito : draft.incognito;
  const model = conversation ? conversation.model : draft.model;

  const onModel = (ref: ModelRef | null) => {
    if (conversation) void setConversationModel(requireClient(), conversation.id, ref, t);
    else useUi.setState((s) => ({ draft: { ...s.draft, model: ref } }));
  };

  return (
    <PageHeader>
      {desktop && <NeoAvatar avatar={settings?.persona.avatar ?? null} size={28} state={avatarState} animated={avatarState !== 'idle'} />}
      {conversation ? <TitleEditor conversation={conversation} /> : <h1 className="page-header__title">{incognito ? t('chat.new_incognito') : t('chat.new_chat')}</h1>}
      {incognito && (
        <span title={t('chat.incognito_hint')}>
          <Badge tone="neutral" icon="incognito">
            {desktop ? t('chat.incognito') : ''}
          </Badge>
        </span>
      )}
      <ModelPicker
        value={model}
        onChange={onModel}
        size="sm"
        ariaLabel={t('chat.model')}
        defaultLabel={defaultLabel ? t('chat.model_default', { model: defaultLabel }) : t('chat.model_default_none')}
        className="model-picker"
      />
      {conversation ? (
        <Menu
          label={t('chat.conversation_menu')}
          items={[
            { label: conversation.pinned ? t('common.unpin') : t('common.pin'), icon: conversation.pinned ? 'pin-off' : 'pin', onSelect: () => void setConversationFlags(requireClient(), conversation.id, { pinned: !conversation.pinned }, t) },
            {
              label: conversation.archived ? t('chat.unarchive') : t('common.archive'),
              icon: conversation.archived ? 'archive-restore' : 'archive',
              onSelect: () => void setConversationFlags(requireClient(), conversation.id, { archived: !conversation.archived }, t),
            },
            { label: t('nav.new_incognito'), icon: 'incognito', onSelect: () => startNewChat(true) },
            {
              label: t('common.delete'),
              icon: 'trash',
              danger: true,
              separated: true,
              onSelect: () => {
                void confirm({ title: t('chat.delete_title'), message: t('chat.delete_message', { title: conversation.title || t('chat.untitled') }), confirmLabel: t('common.delete'), danger: true }).then(async (ok) => {
                  if (ok && (await deleteConversation(requireClient(), conversation.id, t))) navigate({ name: 'chat' }, { replace: true });
                });
              },
            },
          ]}
        />
      ) : (
        <Menu
          label={t('chat.conversation_menu')}
          items={[
            incognito
              ? { label: t('nav.new_chat'), icon: 'message-plus', onSelect: () => startNewChat(false) }
              : { label: t('nav.new_incognito'), icon: 'incognito', onSelect: () => startNewChat(true) },
          ]}
        />
      )}
    </PageHeader>
  );
}
