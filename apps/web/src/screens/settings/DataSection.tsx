/**
 * Settings → Data & about: the server this app talks to, your data, setup,
 * shortcuts, and disconnecting this device.
 */
import type { ReactElement } from 'react';
import { Badge, Button, useConfirm, useT } from '@neo/ui';
import { openLink } from '../../actions/links.js';
import { disconnect } from '../../actions/session.js';
import { getPlatform } from '../../platform/index.js';
import { navigate } from '../../router.js';
import { useSession } from '../../state/session.js';
import { Section, SettingRow } from './common.js';

export function DataSection(): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const serverUrl = useSession((s) => s.serverUrl);
  const health = useSession((s) => s.health);
  const source = useSession((s) => s.source);
  const desktop = getPlatform().kind === 'electron';
  const mac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent);
  const mod = mac ? '⌘' : 'Ctrl';
  return (
    <>
      <Section title={t('dataSettings.server')} description={desktop ? t('dataSettings.on_device') : t('dataSettings.server_help')}>
        <div className="neo-card">
          <SettingRow label={t('dataSettings.address')}>
            <span style={{ fontFamily: 'var(--neo-font-mono)', fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{serverUrl}</span>
          </SettingRow>
          {health && (
            <SettingRow label={t('dataSettings.version')}>
              <span style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                <span>NEO {health.version}</span>
                <Badge tone={health.mode === 'local' ? 'success' : 'info'}>{t(`dataSettings.mode_${health.mode}`)}</Badge>
              </span>
            </SettingRow>
          )}
          {source && (
            <SettingRow label={t('dataSettings.connected_via')}>
              <span>{t(`dataSettings.source_${source}`)}</span>
            </SettingRow>
          )}
        </div>
      </Section>

      <Section title={t('dataSettings.your_data')} description={t('dataSettings.your_data_help')}>
        <div className="neo-card">
          <SettingRow label={t('dataSettings.memory_data')} help={t('dataSettings.memory_data_help')}>
            <Button size="sm" variant="secondary" icon="database" onClick={() => navigate({ name: 'memory', tab: 'data' })}>
              {t('dataSettings.open')}
            </Button>
          </SettingRow>
          <SettingRow label={t('dataSettings.setup')} help={t('dataSettings.setup_help')}>
            <Button size="sm" variant="secondary" icon="sparkles" onClick={() => navigate({ name: 'onboarding' })}>
              {t('dataSettings.run_setup')}
            </Button>
          </SettingRow>
          {!desktop && (
            <SettingRow label={t('dataSettings.disconnect')} help={t('dataSettings.disconnect_help')}>
              <Button
                size="sm"
                variant="danger"
                icon="log-out"
                onClick={() =>
                  void confirm({ title: t('dataSettings.disconnect_title'), message: t('dataSettings.disconnect_text'), confirmLabel: t('dataSettings.disconnect'), danger: true }).then((ok) => {
                    if (ok) disconnect();
                  })
                }
              >
                {t('dataSettings.disconnect')}
              </Button>
            </SettingRow>
          )}
        </div>
      </Section>

      <Section title={t('dataSettings.shortcuts')}>
        <div className="neo-card">
          <SettingRow label={t('dataSettings.shortcut_new')}>
            <span className="kbd">{mod} K</span>
          </SettingRow>
          <SettingRow label={t('dataSettings.shortcut_incognito')}>
            <span className="kbd">{mod} ⇧ K</span>
          </SettingRow>
          <SettingRow label={t('dataSettings.shortcut_focus')}>
            <span className="kbd">{mod} /</span>
          </SettingRow>
          <SettingRow label={t('dataSettings.shortcut_close')}>
            <span className="kbd">Esc</span>
          </SettingRow>
        </div>
      </Section>

      <Section title={t('dataSettings.about')}>
        <div className="neo-card">
          <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.6, color: 'var(--neo-text-muted)' }}>{t('dataSettings.about_text')}</p>
          <div style={{ marginTop: '0.75rem' }}>
            <Button size="sm" variant="ghost" icon="external-link" onClick={() => openLink('https://github.com/RichardZhengQuan/NEO')}>
              {t('dataSettings.source_code')}
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
