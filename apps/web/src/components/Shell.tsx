/**
 * App frame. ≥ 768 px: a persistent icon rail. Below: the same rail as a
 * drawer plus icon-only bottom tabs. Esc closes the drawer.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
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

function RailButton({ label, ariaLabel, className, current, onClick, children }: {
  label: string;
  ariaLabel?: string;
  className: string;
  current?: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  const hovered = useRef(false);
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  return (
    <div className="side__button" data-current={current || undefined}
      onMouseEnter={() => {
        hovered.current = true;
        clearTimer();
        timer.current = setTimeout(() => setTooltipOpen(true), 300);
      }}
      onMouseLeave={() => {
        hovered.current = false;
        clearTimer();
        if (!focused.current) setTooltipOpen(false);
      }}>
      <button type="button" className={className} aria-label={ariaLabel ?? label} aria-current={current ? 'page' : undefined} onClick={onClick}
        onFocus={() => {
          focused.current = true;
          clearTimer();
          setTooltipOpen(true);
        }}
        onBlur={() => {
          focused.current = false;
          if (!hovered.current) setTooltipOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            clearTimer();
            setTooltipOpen(false);
          }
        }}>
        {children}
      </button>
      {tooltipOpen && <span className="side__tooltip" role="tooltip" aria-hidden="true">{label}</span>}
    </div>
  );
}

function SidePanel({ route }: { route: Route }): ReactElement {
  const t = useT();
  const persona = useSession((s) => s.settings?.persona);
  const wsStatus = useSession((s) => s.wsStatus);
  const badges = useBadges();
  const homeAriaLabel = t('nav.home_label', { name: t('nav.timeline'), status: t(`status.${wsStatus}`) });
  const go = (r: Route) => {
    setDrawer(false);
    navigate(r);
  };
  const itemButton = (item: NavDef) => {
    const count = badges[item.name];
    const ariaLabel = count ? t('nav.badge_label', { name: t(`nav.${item.name}`), count }) : undefined;
    return (
      <RailButton key={item.name} className="nav-item" label={t(`nav.${item.name}`)} ariaLabel={ariaLabel} current={route.name === item.name} onClick={() => go(item.route)}>
        <Icon name={item.icon} size={20} />
        {count ? <span className="nav-item__count" aria-hidden="true">{count > 9 ? '9+' : count}</span> : null}
      </RailButton>
    );
  };
  return (
    <div className="side">
      <div className="side__head">
        <RailButton className="side__brand" label={t('nav.timeline')} ariaLabel={homeAriaLabel} onClick={() => go({ name: 'timeline' })}>
          <span className="side__avatar">
            <NeoAvatar avatar={persona?.avatar ?? null} size={32} animated={false} />
            <StatusDot />
          </span>
        </RailButton>
      </div>
      <nav className="side__nav" aria-label={t('nav.main')}>
        <div className="side__main">{NAV.filter((item) => item.name !== 'settings').map(itemButton)}</div>
        <div className="side__bottom">{NAV.filter((item) => item.name === 'settings').map(itemButton)}</div>
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
      {NAV.map((item) => {
        const count = badges[item.name];
        const ariaLabel = count ? t('nav.badge_label', { name: t(`nav.${item.name}`), count }) : t(`nav.${item.name}`);
        return (
          <button key={item.name} type="button" className="tabbar__item" aria-label={ariaLabel} aria-current={route.name === item.name ? 'page' : undefined} onClick={() => navigate(item.route)}>
            <Icon name={item.icon} size={24} />
            {count ? <span className="tabbar__badge" aria-hidden="true">{count > 9 ? '9+' : count}</span> : null}
          </button>
        );
      })}
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
