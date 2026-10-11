/**
 * App frame. ≥ 768 px: a persistent sidebar (brand, new chat, navigation,
 * conversations, settings). Below: the same panel as a drawer plus a bottom
 * tab bar. Esc closes the drawer.
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { Button, Icon, IconButton, NeoAvatar, useT } from '@neo/ui';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { navigate, type Route, type RouteName } from '../router.js';
import { useData } from '../state/data.js';
import { useSession } from '../state/session.js';
import { focusComposer, resetDraft, setDrawer, useUi } from '../state/ui.js';
import { ConversationList } from './ConversationList.js';
import { StatusDot } from './StatusDot.js';

interface NavDef {
  name: Exclude<RouteName, 'connect' | 'onboarding' | 'pair'>;
  icon: string;
  route: Route;
}

const NAV: NavDef[] = [
  { name: 'chat', icon: 'message', route: { name: 'chat' } },
  { name: 'memory', icon: 'brain', route: { name: 'memory', tab: 'net' } },
  { name: 'reminders', icon: 'bell', route: { name: 'reminders' } },
  { name: 'tasks', icon: 'list-checks', route: { name: 'tasks' } },
  { name: 'notes', icon: 'note', route: { name: 'notes' } },
];

export function startNewChat(incognito = false): void {
  resetDraft(incognito);
  setDrawer(false);
  navigate({ name: 'chat' });
  focusComposer();
}

function useBadges(): Partial<Record<NavDef['name'], number>> {
  const pending = useData((s) => s.pendingMemories);
  const due = useData((s) => Object.values(s.reminders).filter((r) => r.status === 'fired').length);
  return { memory: pending, reminders: due };
}

function SidePanel({ route }: { route: Route }): ReactElement {
  const t = useT();
  const persona = useSession((s) => s.settings?.persona);
  const badges = useBadges();
  const go = (r: Route) => {
    setDrawer(false);
    navigate(r);
  };
  return (
    <div className="side">
      <div className="side__head">
        <button type="button" className="side__brand" onClick={() => go({ name: 'settings', section: 'persona' })} title={t('nav.persona')}>
          <NeoAvatar avatar={persona?.avatar ?? null} size={30} animated={false} />
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span className="side__name">{persona?.name ?? 'NEO'}</span>
          </span>
        </button>
        <StatusDot />
      </div>
      <div className="side__new">
        <Button variant="soft" icon="message-plus" block onClick={() => startNewChat(false)} title={t('nav.new_chat_hint')}>
          {t('nav.new_chat')}
        </Button>
        <IconButton icon="incognito" label={t('nav.new_incognito')} variant="secondary" onClick={() => startNewChat(true)} />
      </div>
      <nav className="side__nav" aria-label={t('nav.main')}>
        {NAV.map((item) => (
          <button key={item.name} type="button" className="nav-item" aria-current={route.name === item.name ? 'page' : undefined} onClick={() => go(item.route)}>
            <Icon name={item.icon} size={17} />
            {t(`nav.${item.name}`)}
            {badges[item.name] ? <span className="nav-item__count">{badges[item.name]}</span> : null}
          </button>
        ))}
      </nav>
      <div className="side__section">{t('nav.recent')}</div>
      <ConversationList activeId={route.name === 'chat' ? route.conversationId : undefined} />
      <div className="side__foot">
        <button type="button" className="nav-item" style={{ flex: 1 }} aria-current={route.name === 'settings' ? 'page' : undefined} onClick={() => go({ name: 'settings' })}>
          <Icon name="settings" size={17} />
          {t('nav.settings')}
        </button>
      </div>
    </div>
  );
}

function Drawer({ route }: { route: Route }): ReactElement {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-label={t('nav.menu')}>
        <SidePanel route={route} />
      </div>
    </>
  );
}

function TabBar({ route }: { route: Route }): ReactElement {
  const t = useT();
  const badges = useBadges();
  return (
    <nav className="tabbar" aria-label={t('nav.main')}>
      {NAV.map((item) => (
        <button key={item.name} type="button" className="tabbar__item" aria-current={route.name === item.name ? 'page' : undefined} onClick={() => navigate(item.route)}>
          <Icon name={item.icon} size={21} />
          <span>{t(`nav.${item.name}`)}</span>
          {badges[item.name] ? <span className="tabbar__badge">{badges[item.name]}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }): ReactElement {
  const desktop = useIsDesktop();
  const drawerOpen = useUi((s) => s.drawerOpen);

  useEffect(() => {
    if (desktop) setDrawer(false);
  }, [desktop]);

  if (desktop) {
    return (
      <div className="app">
        <SidePanel route={route} />
        <main className="app-main">{children}</main>
      </div>
    );
  }
  return (
    <div className="app" style={{ flexDirection: 'column' }}>
      <main className="app-main">{children}</main>
      <TabBar route={route} />
      {drawerOpen && <Drawer route={route} />}
    </div>
  );
}
