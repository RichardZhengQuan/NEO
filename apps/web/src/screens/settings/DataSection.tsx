/**
 * Settings → Data & about: the server this app talks to, your data, setup,
 * shortcuts, and disconnecting this device.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Badge, Button, Select, TextField, useConfirm, useT } from '@neo/ui';
import { openLink } from '../../actions/links.js';
import { disconnect } from '../../actions/session.js';
import { deleteRange } from '../../actions/timeline.js';
import { deviceTimeZone, fromLocalInputValue, instantOf, wallTimeOf } from '../../lib/time.js';
import { getPlatform } from '../../platform/index.js';
import { navigate } from '../../router.js';
import { isCurrentSession, useSession } from '../../state/session.js';
import { Section, SettingRow } from './common.js';

export function DataSection(): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const serverUrl = useSession((s) => s.serverUrl);
  const health = useSession((s) => s.health);
  const source = useSession((s) => s.source);
  const client = useSession((s) => s.client);
  const epoch = useSession((s) => s.sessionEpoch);
  const timeZone = useSession((s) => s.settings?.timezone) ?? deviceTimeZone();
  const [range, setRange] = useState('last_hour');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [invalidRange, setInvalidRange] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const tunnel = useSession((s) => s.credentials?.tunnel);
  const desktop = getPlatform().kind === 'electron';
  const mac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent);
  const mod = mac ? '⌘' : 'Ctrl';
  useEffect(() => {
    setDeleting(false);
    setInvalidRange(false);
    setFrom('');
    setTo('');
  }, [epoch]);
  const removeRange = async () => {
    if (!client || deleting) return;
    const now = new Date();
    let start: Date;
    let end = now;
    if (range === 'last_hour') start = new Date(now.getTime() - 60 * 60 * 1000);
    else if (range === 'today') {
      const wall = wallTimeOf(now.getTime(), timeZone);
      start = new Date(instantOf(wall.year, wall.month, wall.day, 0, 0, timeZone));
    } else {
      const fromMs = fromLocalInputValue(from, timeZone);
      const toMs = fromLocalInputValue(to, timeZone);
      if (fromMs === null || toMs === null || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
        setInvalidRange(true);
        return;
      }
      start = new Date(fromMs);
      end = new Date(toMs);
    }
    setInvalidRange(false);
    setDeleting(true);
    try {
      await deleteRange(client, { from: start.toISOString(), to: end.toISOString() }, t, confirm);
    } catch {
      // The action reports errors for the current session.
    } finally {
      if (isCurrentSession(epoch, client)) setDeleting(false);
    }
  };
  return (
    <>
      <Section title={t('dataSettings.server')} description={desktop ? t('dataSettings.on_device') : t('dataSettings.server_help')}>
        <div className="neo-card">
          <SettingRow label={t('dataSettings.address')}>
            <span style={{ fontFamily: 'var(--neo-font-mono)', fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{tunnel ? t('dataSettings.source_tunnel') : serverUrl}</span>
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
              <span>{t(tunnel ? 'dataSettings.source_tunnel' : `dataSettings.source_${source}`)}</span>
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

      <Section title={t('dataSettings.delete_timeline')} description={t('dataSettings.delete_timeline_help')}>
        <div className="neo-card">
          <SettingRow label={t('dataSettings.range')} help={t('dataSettings.range_timezone', { timezone: timeZone })} stack>
            <Select
              ariaLabel={t('dataSettings.range')}
              value={range}
              disabled={deleting}
              onChange={(value) => { setRange(value); setInvalidRange(false); }}
              options={['last_hour', 'today', 'custom'].map((value) => ({ value, label: t(`dataSettings.${value}`) }))}
            />
          </SettingRow>
          {range === 'custom' && (
            <>
              <SettingRow label={t('dataSettings.from')} stack>
                <TextField ariaLabel={t('dataSettings.from')} type="datetime-local" value={from} disabled={deleting} onChange={(value) => { setFrom(value); setInvalidRange(false); }} />
              </SettingRow>
              <SettingRow label={t('dataSettings.to')} stack>
                <TextField ariaLabel={t('dataSettings.to')} type="datetime-local" value={to} disabled={deleting} onChange={(value) => { setTo(value); setInvalidRange(false); }} />
              </SettingRow>
            </>
          )}
          {invalidRange && <p className="neo-error-text" role="alert">{t('dataSettings.invalid_range')}</p>}
          <Button size="sm" variant="danger" icon="trash" disabled={!client || deleting} onClick={() => void removeRange()}>
            {deleting ? t('dataSettings.deleting') : t('dataSettings.delete_range')}
          </Button>
        </div>
      </Section>

      <Section title={t('dataSettings.shortcuts')}>
        <div className="neo-card">
          <SettingRow label={t('dataSettings.shortcut_search')}>
            <span className="kbd">{mod} K</span>
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
