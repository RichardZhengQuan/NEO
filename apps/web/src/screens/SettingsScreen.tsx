/**
 * Settings: a section list beside the content on wide screens, a list that
 * drills into each section on phones.
 */
import type { ReactElement } from 'react';
import { Icon, useT } from '@neo/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { navigate, SETTINGS_SECTIONS, type SettingsSection } from '../router.js';
import { AiSection } from './settings/AiSection.js';
import { AppearanceSection } from './settings/AppearanceSection.js';
import { DataSection } from './settings/DataSection.js';
import { DevicesSection } from './settings/DevicesSection.js';
import { MemorySection } from './settings/MemorySection.js';
import { NotificationsSection } from './settings/NotificationsSection.js';
import { AvatarSection } from './settings/PersonaSection.js';
import { ToolsSection } from './settings/ToolsSection.js';

const ICONS: Record<SettingsSection, string> = {
  ai: 'cpu',
  avatar: 'smile',
  memory: 'brain',
  tools: 'wand',
  devices: 'smartphone',
  notifications: 'bell',
  appearance: 'palette',
  data: 'database',
};

function SectionContent({ section }: { section: SettingsSection }): ReactElement {
  switch (section) {
    case 'ai':
      return <AiSection />;
    case 'avatar':
      return <AvatarSection />;
    case 'memory':
      return <MemorySection />;
    case 'tools':
      return <ToolsSection />;
    case 'devices':
      return <DevicesSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'data':
      return <DataSection />;
  }
}

export function SettingsScreen({ section }: { section?: SettingsSection }): ReactElement {
  const t = useT();
  const desktop = useIsDesktop();
  const active = section ?? (desktop ? 'ai' : undefined);

  const nav = (
    <nav className={desktop ? 'settings-nav' : undefined} aria-label={t('nav.settings')} style={desktop ? undefined : { display: 'flex', flexDirection: 'column', gap: 1 }}>
      {SETTINGS_SECTIONS.map((s) => (
        <button
          key={s}
          type="button"
          className="nav-item"
          aria-current={active === s ? 'page' : undefined}
          onClick={() => navigate({ name: 'settings', section: s }, { replace: desktop })}
          style={desktop ? undefined : { minHeight: '3rem' }}
        >
          <Icon name={ICONS[s]} size={17} />
          <span style={{ flex: 1 }}>{t(`settings.${s}`)}</span>
          {!desktop && <Icon name="chevron-right" size={15} />}
        </button>
      ))}
    </nav>
  );

  if (!desktop && !active) {
    return (
      <div className="page">
        <PageHeader title={t('nav.settings')} />
        <div className="page-body">
          <div className="page-inner">{nav}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title={desktop ? t('nav.settings') : t(`settings.${active}`)} back={desktop ? undefined : () => navigate({ name: 'settings' })} />
      <div className="settings-layout">
        {desktop && nav}
        {/* Keyed so each section opens scrolled to the top. */}
        <div className="page-body" key={active}>
          <div className="page-inner" style={{ maxWidth: '46rem' }}>
            <SectionContent key={active} section={active!} />
          </div>
        </div>
      </div>
    </div>
  );
}
