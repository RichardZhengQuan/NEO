/**
 * Sidebar conversation list: search (instant local filter + server search),
 * pinned and date groups, live-turn indicator, and pin / archive / delete.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Conversation } from '@neo/protocol';
import { Icon, Spinner, TextField, dayKey, useConfirm, useT } from '@neo/ui';
import { deleteConversation, setConversationFlags } from '../actions/chat.js';
import { useDebounced } from '../hooks/useLoader.js';
import { navigate } from '../router.js';
import { sortConversations, upsertConversations, useConversations } from '../state/conversations.js';
import { currentSessionEpoch, isCurrentSession, requireClient, useSession } from '../state/session.js';
import { setDrawer } from '../state/ui.js';
import { Menu } from './Menu.js';

type Group = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';

export function groupOf(conv: Conversation, now: number, timeZone?: string): Group {
  if (conv.pinned) return 'pinned';
  const at = conv.lastMessageAt ?? conv.updatedAt;
  const today = dayKey(now, timeZone);
  if (dayKey(at, timeZone) === today) return 'today';
  if (dayKey(at, timeZone) === dayKey(now - 86_400_000, timeZone)) return 'yesterday';
  if (now - at < 7 * 86_400_000) return 'week';
  return 'older';
}

function ConversationItem({ conv, active }: { conv: Conversation; active: boolean }): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const live = useConversations((s) => s.entries[conv.id]?.turn != null);
  const open = () => {
    setDrawer(false);
    navigate({ name: 'chat', conversationId: conv.id });
  };
  return (
    <li className="conv-item" aria-current={active ? 'page' : undefined}>
      <button type="button" className="conv-item__link" onClick={open}>
        <span className="conv-item__title">
          {conv.incognito && <Icon name="incognito" size={13} label={t('chat.incognito')} />}
          {conv.pinned && <Icon name="pin" size={12} style={{ color: 'var(--neo-text-subtle)' }} />}
          <span>{conv.title || t('chat.untitled')}</span>
          {live && <span className="live-dot" title={t('chat.replying')} />}
        </span>
        {conv.preview && <span className="conv-item__preview">{conv.preview}</span>}
      </button>
      <Menu
        className="conv-item__menu"
        label={t('chat.conversation_actions', { title: conv.title || t('chat.untitled') })}
        items={[
          { label: conv.pinned ? t('common.unpin') : t('common.pin'), icon: conv.pinned ? 'pin-off' : 'pin', onSelect: () => void setConversationFlags(requireClient(), conv.id, { pinned: !conv.pinned }, t) },
          { label: conv.archived ? t('chat.unarchive') : t('common.archive'), icon: conv.archived ? 'archive-restore' : 'archive', onSelect: () => void setConversationFlags(requireClient(), conv.id, { archived: !conv.archived }, t) },
          {
            label: t('common.delete'),
            icon: 'trash',
            danger: true,
            separated: true,
            onSelect: () => {
              void confirm({ title: t('chat.delete_title'), message: t('chat.delete_message', { title: conv.title || t('chat.untitled') }), confirmLabel: t('common.delete'), danger: true }).then(async (ok) => {
                if (!ok) return;
                const deleted = await deleteConversation(requireClient(), conv.id, t);
                if (deleted && active) navigate({ name: 'chat' }, { replace: true });
              });
            },
          },
        ]}
      />
    </li>
  );
}

export function ConversationList({ activeId }: { activeId: string | undefined }): ReactElement {
  const t = useT();
  const conversations = useConversations((s) => s.conversations);
  const listLoaded = useConversations((s) => s.listLoaded);
  const archivedLoaded = useConversations((s) => s.archivedLoaded);
  const timeZone = useSession((s) => s.settings?.timezone);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [searching, setSearching] = useState(false);
  const [remote, setRemote] = useState<string[] | null>(null);
  const debounced = useDebounced(query.trim(), 250);

  useEffect(() => {
    if (!debounced) {
      setRemote(null);
      return;
    }
    const epoch = currentSessionEpoch();
    let cancelled = false;
    setSearching(true);
    requireClient()
      .conversations.list({ query: debounced, limit: 50 })
      .then(({ items }) => {
        if (cancelled || !isCurrentSession(epoch)) return;
        upsertConversations(items);
        setRemote(items.map((c) => c.id));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  useEffect(() => {
    if (!showArchived || archivedLoaded) return;
    const epoch = currentSessionEpoch();
    requireClient()
      .conversations.list({ archived: true, limit: 200 })
      .then(({ items }) => { if (isCurrentSession(epoch)) upsertConversations(items, { archivedLoaded: true }); })
      .catch(() => undefined);
  }, [showArchived, archivedLoaded]);

  const all = useMemo(() => sortConversations(Object.values(conversations)), [conversations]);
  const q = query.trim().toLowerCase();
  const visible = q
    ? all.filter((c) => (remote?.includes(c.id) ?? false) || c.title.toLowerCase().includes(q) || (c.preview ?? '').toLowerCase().includes(q))
    : all.filter((c) => c.archived === showArchived);

  const now = Date.now();
  const groups = new Map<Group, Conversation[]>();
  if (!q && !showArchived) for (const c of visible) groups.set(groupOf(c, now, timeZone), [...(groups.get(groupOf(c, now, timeZone)) ?? []), c]);
  const order: Group[] = ['pinned', 'today', 'yesterday', 'week', 'older'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ padding: '0 0.875rem 0.5rem' }}>
        <TextField
          size="sm"
          icon="search"
          type="search"
          value={query}
          onChange={setQuery}
          ariaLabel={t('chat.search')}
          placeholder={t('chat.search')}
          addon={searching ? <Spinner size={14} /> : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>
      <nav className="side__list" aria-label={t('chat.conversations')}>
        {!listLoaded && all.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
            <Spinner size={18} />
          </div>
        ) : visible.length === 0 ? (
          <p className="neo-help" style={{ padding: '0.5rem 0.625rem' }}>
            {q ? t('chat.search_empty') : showArchived ? t('chat.archived_empty') : t('chat.list_empty')}
          </p>
        ) : q || showArchived ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visible.map((c) => (
              <ConversationItem key={c.id} conv={c} active={c.id === activeId} />
            ))}
          </ul>
        ) : (
          order
            .filter((g) => groups.get(g)?.length)
            .map((g) => (
              <section key={g} aria-label={t(`chat.group.${g}`)}>
                <h2 className="side__section" style={{ margin: 0, paddingLeft: '0.625rem' }}>
                  {t(`chat.group.${g}`)}
                </h2>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {groups.get(g)!.map((c) => (
                    <ConversationItem key={c.id} conv={c} active={c.id === activeId} />
                  ))}
                </ul>
              </section>
            ))
        )}
        {!q && (
          <button type="button" className="nav-item" style={{ width: '100%', marginTop: '0.5rem' }} aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <Icon name={showArchived ? 'arrow-left' : 'archive'} size={15} />
            {showArchived ? t('chat.back_to_recent') : t('chat.show_archived')}
          </button>
        )}
      </nav>
    </div>
  );
}
