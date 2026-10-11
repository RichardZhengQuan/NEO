/**
 * Settings → Appearance & region: theme, language, timezone, and the
 * device-local "load remote images automatically" privacy switch.
 */
import { useMemo, type ReactElement } from 'react';
import type { NeoSettingsPatch } from '@neo/protocol';
import { Button, SegmentedControl, Select, Switch, useT } from '@neo/ui';
import { errorMessage } from '../../lib/errors.js';
import { deviceTimeZone, listTimeZones } from '../../lib/time.js';
import { pushToast } from '../../state/notifications.js';
import { setRemoteImages, usePreferences } from '../../state/preferences.js';
import { updateSettings, useSession } from '../../state/session.js';
import { Section, SettingRow } from './common.js';

export const UI_LANGUAGES = ['auto', 'en', 'zh-CN'];

export function AppearanceSection(): ReactElement {
  const t = useT();
  const settings = useSession((s) => s.settings!);
  const zones = useMemo(() => listTimeZones(), []);
  const device = deviceTimeZone();
  const remoteImages = usePreferences((p) => p.remoteImages);
  const save = (patch: NeoSettingsPatch) => {
    updateSettings(patch).catch((err) => pushToast({ tone: 'error', title: errorMessage(err, t) }));
  };
  return (
    <Section title={t('appearance.title')} description={t('appearance.help')}>
      <div className="neo-card">
        <SettingRow label={t('appearance.theme')} stack>
          <SegmentedControl
            label={t('appearance.theme')}
            value={settings.theme}
            onChange={(v) => save({ theme: v })}
            options={[
              { value: 'system', label: t('appearance.theme_system'), icon: 'monitor' },
              { value: 'light', label: t('appearance.theme_light'), icon: 'sun' },
              { value: 'dark', label: t('appearance.theme_dark'), icon: 'moon' },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('appearance.language')} help={t('appearance.language_help')} stack>
          <Select
            ariaLabel={t('appearance.language')}
            value={UI_LANGUAGES.includes(settings.locale) ? settings.locale : settings.locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'}
            onChange={(v) => save({ locale: v })}
            options={UI_LANGUAGES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
          />
        </SettingRow>
        <SettingRow label={t('appearance.timezone')} help={settings.timezone !== device ? t('appearance.timezone_differs', { device }) : t('appearance.timezone_help')} stack>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <Select ariaLabel={t('appearance.timezone')} value={settings.timezone} onChange={(v) => save({ timezone: v })} options={(zones.includes(settings.timezone) ? zones : [settings.timezone, ...zones]).map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} />
            {settings.timezone !== device && (
              <Button size="sm" variant="secondary" onClick={() => save({ timezone: device })}>
                {t('appearance.use_device', { tz: device })}
              </Button>
            )}
          </div>
        </SettingRow>
      </div>
      <h3 className="group-title">{t('appearance.privacy')}</h3>
      <div className="neo-card">
        <Switch checked={remoteImages} onChange={setRemoteImages} label={t('appearance.remote_images')} description={t('appearance.remote_images_help')} />
      </div>
    </Section>
  );
}
