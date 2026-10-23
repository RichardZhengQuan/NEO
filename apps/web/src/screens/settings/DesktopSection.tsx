import { useState, type ReactElement } from 'react';
import { Button, EmptyState, Skeleton, useConfirm, useT } from '@neo/ui';
import { clearCredentials } from '../../connection.js';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage } from '../../lib/errors.js';
import { getPlatform } from '../../platform/index.js';
import { pushToast } from '../../state/notifications.js';
import { Section, SettingRow } from './common.js';

function DesktopModeSettings(): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const loader = useLoader(async () => await window.neoDesktop?.getMode?.() ?? { kind: 'local' } as const, []);
  const [busy, setBusy] = useState(false);
  const mode = loader.data;

  const switchMode = async (target: 'local' | 'remote') => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await confirm({
        title: t(`desktop.confirm_title_to_${target}`),
        message: t(`desktop.confirm_body_to_${target}`),
        confirmLabel: t('desktop.switch'),
      });
      if (ok) {
        if (target === 'remote') clearCredentials();
        await window.neoDesktop?.switchMode?.(target);
      }
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('desktop.title')} description={t('desktop.help')}>
      {!mode ? (
        loader.error ? <EmptyState icon="alert-circle" title={t('common.error')} /> : <Skeleton height={120} />
      ) : (
        <>
          <SettingRow label={t('desktop.current')}>
            <span style={{ overflowWrap: 'anywhere' }}>
              {mode.kind === 'local' ? t('desktop.this_mac') : mode.serverUrl ? t('desktop.remote_at', { url: mode.serverUrl }) : t('desktop.remote_unpaired')}
            </span>
          </SettingRow>
          <div className="neo-card">
            <SettingRow label={t('desktop.switch')} stack>
              <Button size="sm" variant="secondary" disabled={busy || !window.neoDesktop?.switchMode} onClick={() => void switchMode(mode.kind === 'local' ? 'remote' : 'local')}>
                {t(mode.kind === 'local' ? 'desktop.switch_to_remote' : 'desktop.switch_to_local')}
              </Button>
            </SettingRow>
          </div>
        </>
      )}
    </Section>
  );
}

export function DesktopSection(): ReactElement | null {
  return getPlatform().kind === 'electron' ? <DesktopModeSettings /> : null;
}
