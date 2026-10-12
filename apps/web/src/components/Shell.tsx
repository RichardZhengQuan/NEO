/**
 * App frame. ≥ 768 px: a persistent sidebar with app navigation. Below:
 * the same panel as a drawer plus a bottom tab bar. Esc closes the drawer.
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { Icon, NeoAvatar, useT } from '@neo/ui';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { navigate, type Route, type RouteName } from '../router.js';
import { useData } from '../state/data.js';
import { useSession } from '../state/session.js';
import { setDrawer, useUi } from '../state/ui.js';
import { StatusDot } from './StatusDot.js';

interface NavDef {
  name: Exclude<RouteName, 'connect' | 'onboarding' | 'pair'>;
  icon: string;
  route: Route;
}

const NAV: NavDef[] = [
  { name: 'timeline', icon: 'message', route: { name: 'timeline' } },
  { name: 'memory', icon: 'brain', route: { name: 'memory', tab: 'net' } },
  { name: 'reminders', icon: 'bell', route: { name: 'reminders' } },
  { name: 'tasks', icon: 'list-checks', route: { name: 'tasks' } },
  { name: 'notes', icon: 'note', route: { name: 'notes' } },
  { name: 'settings', icon: 'settings', route: { name: 'settings' } },
];

function useBadges(): Partial<Record<NavDef['name'], number>> {
  const due = useData((s) => Object.values(s.reminders).filter((r) => r.status === 'fired').length);
  return { reminders: due };
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
        <button type="button" className="side__brand" onClick={() => go({ name: 'timeline' })} aria-label={t('nav.timeline')}>
          <NeoAvatar avatar={persona?.avatar ?? null} size={30} animated={false} />
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span className="side__name">NEO</span>
          </span>
        </button>
        <StatusDot />
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
