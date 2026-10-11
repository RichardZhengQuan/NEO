/**
 * Settings → Notifications: how reminders reach this device (Web Push, the
 * desktop app's system notifications, or on-device scheduling on phones).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Badge, Button, Icon, Spinner, useT } from '@neo/ui';
import { errorMessage } from '../../lib/errors.js';
import { getPlatform, type NotificationStatus } from '../../platform/index.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient } from '../../state/session.js';
import { notificationCopy } from '../OnboardingScreen.js';
import { Section, SettingRow } from './common.js';

export function NotificationsSection(): ReactElement {
  const t = useT();
  const platform = getPlatform();
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void platform.notificationStatus(requireClient()).then(setStatus).catch(() => undefined);
  }, [platform]);

  const run = async (fn: () => Promise<NotificationStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  };

  const copy = notificationCopy(t, platform.kind, status);
  return (
    <Section title={t('notifySettings.title')} description={t('notifySettings.help')}>
      <div className="neo-card">
        <SettingRow label={copy.title} help={copy.problem ?? copy.text} stack>
          {status === null ? (
            <Spinner size={16} />
          ) : platform.kind === 'electron' ? (
            <Badge tone="success" icon="check">
              {t('notify.os_managed')}
            </Badge>
          ) : status.enabled ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Badge tone="success" icon="check">
                {t('notify.enabled')}
              </Badge>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => platform.disableNotifications(requireClient()))}>
                {t('notify.disable')}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="primary" icon="bell" loading={busy} disabled={status.permission === 'unsupported' || status.permission === 'denied' || Boolean(status.reason)} onClick={() => void run(() => platform.enableNotifications(requireClient()))}>
              {t('notify.enable')}
            </Button>
          )}
        </SettingRow>
        {platform.kind === 'capacitor' && status?.enabled && (
          <SettingRow label={t('notifySettings.resync')} help={t('notifySettings.resync_help')}>
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await platform.syncReminders(requireClient());
                  pushToast({ tone: 'success', title: t('notifySettings.resynced') });
                  return platform.notificationStatus(requireClient());
                })
              }
            >
              {t('notifySettings.resync_now')}
            </Button>
          </SettingRow>
        )}
        <SettingRow label={t('notifySettings.in_app')} help={t('notifySettings.in_app_help')}>
          <Icon name="check" size={16} style={{ color: 'var(--neo-tone-success-text)' }} />
        </SettingRow>
      </div>
    </Section>
  );
}
