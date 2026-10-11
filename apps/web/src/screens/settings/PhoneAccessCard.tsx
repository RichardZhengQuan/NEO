import { useEffect, useState, type ReactElement } from 'react';
import { Button, Skeleton, Switch, useT } from '@neo/ui';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage, httpStatus } from '../../lib/errors.js';
import { useSession } from '../../state/session.js';
import { SettingRow } from './common.js';

/** Phone access is managed by the owner; paired devices can read its status. */
export function PhoneAccessCard({ refresh }: { refresh: number }): ReactElement {
  const t = useT();
  const client = useSession((s) => s.client);
  const loader = useLoader(async () => {
    if (!client) throw new Error(t('error.network'));
    return client.phoneAccess.status();
  }, [client, refresh]);
  const [busy, setBusy] = useState(false);
  const [ownerOnly, setOwnerOnly] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => { setOwnerOnly(false); setError(null); }, [client]);

  const toggle = async (enabled: boolean) => {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await client.phoneAccess.update({ enabled });
      if (useSession.getState().client !== client) return;
      loader.setData(() => status);
      const settings = useSession.getState().settings;
      if (settings) useSession.setState({ settings: { ...settings, phoneAccess: { ...settings.phoneAccess, enabled: status.enabled } } });
      await loader.reload();
    } catch (err) {
      if (useSession.getState().client !== client) return;
      if (httpStatus(err) === 403) setOwnerOnly(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  const status = loader.data;
  return (
    <div className="neo-card" style={{ marginBottom: '1rem' }} aria-busy={busy || loader.loading}>
      <SettingRow label={t('phoneAccess.title')}>
        <Switch checked={status?.enabled ?? false} onChange={(enabled) => void toggle(enabled)} disabled={!status || busy || ownerOnly} ariaLabel={t('phoneAccess.title')} />
      </SettingRow>
      {status ? (
        <p className="neo-help" role="status" style={{ margin: '0.75rem 0', overflowWrap: 'anywhere' }}>
          {status.lan.error ?? (status.lan.listening && status.lan.addresses.length ? t('phoneAccess.network', { addresses: status.lan.addresses.join(', ') }) : t('phoneAccess.off'))}
        </p>
      ) : loader.error ? (
        <Button size="sm" variant="ghost" onClick={() => void loader.reload()}>{t('common.retry')}</Button>
      ) : <Skeleton height={20} />}
      {Boolean(ownerOnly || error || loader.error) && <p className="neo-error-text" role="alert">{ownerOnly ? t('devices.owner_only') : errorMessage(error ?? loader.error, t)}</p>}
      <p className="neo-help" style={{ margin: 0 }}>{t('phoneAccess.availability')}</p>
    </div>
  );
}
