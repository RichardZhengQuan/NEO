import { useEffect, useState, type ReactElement } from 'react';
import type { UpdatePhoneAccessRequest } from '@neo/protocol';
import { Button, Select, Skeleton, Switch, TextField, useT } from '@neo/ui';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage, httpStatus } from '../../lib/errors.js';
import { getPlatform } from '../../platform/index.js';
import { useSession } from '../../state/session.js';
import { SettingRow } from './common.js';

type RelayChoice = 'default' | 'none' | 'custom';
const RELAY_DOCS = 'https://github.com/RichardZhengQuan/NEO/blob/main/docs/DEPLOYMENT.md#self-hosting-a-relay';

function validRelayUrl(value: string): boolean {
  if (!value || value.length > 500 || value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** Phone access is managed by the owner; paired devices can read its status. */
export function PhoneAccessCard({ refresh }: { refresh: number }): ReactElement {
  const t = useT();
  const client = useSession((s) => s.client);
  const savedRelayUrl = useSession((s) => s.settings?.phoneAccess.relayUrl);
  const loader = useLoader(async () => {
    if (!client) throw new Error(t('error.network'));
    return { client, status: await client.phoneAccess.status() };
  }, [client, refresh]);
  const [busy, setBusy] = useState(false);
  const [ownerOnly, setOwnerOnly] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [choice, setChoice] = useState<RelayChoice>('default');
  const [customUrl, setCustomUrl] = useState('');
  const [validate, setValidate] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setOwnerOnly(false); setError(null); setSaved(false); setBusy(false); }, [client]);
  useEffect(() => {
    setChoice(savedRelayUrl == null ? 'default' : savedRelayUrl === '' ? 'none' : 'custom');
    setCustomUrl(savedRelayUrl ?? '');
    setValidate(false);
  }, [client, savedRelayUrl]);

  const status = loader.data?.client === client ? loader.data.status : undefined;
  useEffect(() => {
    if (!status?.enabled || !status.relay.url) return;
    const timer = setInterval(() => { void loader.reload(); }, 5000);
    return () => clearInterval(timer);
  }, [client, status?.enabled, status?.relay.url, loader.reload]);

  const update = async (patch: UpdatePhoneAccessRequest) => {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const status = await client.phoneAccess.update(patch);
      if (useSession.getState().client !== client) return;
      loader.setData(() => ({ client, status }));
      const settings = useSession.getState().settings;
      if (settings) useSession.setState({ settings: { ...settings, phoneAccess: { ...settings.phoneAccess, ...patch, enabled: status.enabled } } });
      if ('relayUrl' in patch) setSaved(true);
      await loader.reload();
    } catch (err) {
      if (useSession.getState().client !== client) return;
      if (httpStatus(err) === 403) setOwnerOnly(true);
      else setError(err);
    } finally {
      if (useSession.getState().client === client) setBusy(false);
    }
  };

  const saveRelay = () => {
    if (!client || !status || busy) return;
    setValidate(true);
    const relayUrl = choice === 'default' ? null : choice === 'none' ? '' : customUrl.trim();
    if (choice === 'custom' && !validRelayUrl(relayUrl!)) return;
    if (choice === 'default' && !status?.defaultRelayUrl) return;
    void update({ relayUrl });
  };
  const relayMessage = !status?.relay.url ? t('phoneAccess.relay_not_set')
    : status.relay.status === 'connected' ? t('phoneAccess.relay_connected')
    : status.relay.status === 'connecting' ? t('phoneAccess.relay_connecting')
    : status.relay.status === 'error' ? t('phoneAccess.relay_error', { message: status.relay.error ?? t('common.error') })
    : t('phoneAccess.off');

  return (
    <div className="neo-card" style={{ marginBottom: '1rem' }} aria-busy={busy || loader.loading}>
      <SettingRow label={t('phoneAccess.title')}>
        <Switch checked={status?.enabled ?? false} onChange={(enabled) => void update({ enabled })} disabled={!status || busy || ownerOnly} ariaLabel={t('phoneAccess.title')} />
      </SettingRow>
      {status ? (
        <p className="neo-help" role="status" style={{ margin: '0.75rem 0', overflowWrap: 'anywhere' }}>
          {status.lan.error ?? (status.lan.listening && status.lan.addresses.length ? t('phoneAccess.network', { addresses: status.lan.addresses.join(', ') }) : t('phoneAccess.off'))}
        </p>
      ) : loader.error ? (
        <Button size="sm" variant="ghost" onClick={() => void loader.reload()}>{t('common.retry')}</Button>
      ) : <Skeleton height={20} />}
      {status && (
        <div style={{ display: 'grid', gap: '0.75rem', margin: '1rem 0' }}>
          <div className="setting-row__label">{t('phoneAccess.away')}</div>
          <p className="neo-help" aria-live="polite" aria-atomic="true" style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {relayMessage}{status.relay.url && <> — {status.relay.url}</>}
          </p>
          <p className="neo-help" style={{ margin: 0 }}>{t('phoneAccess.relay_privacy')}</p>
          {!ownerOnly && (
            <form onSubmit={(event) => { event.preventDefault(); saveRelay(); }} style={{ display: 'grid', gap: '0.75rem' }}>
              <Select
                label={t('phoneAccess.relay_choice')}
                value={choice}
                onChange={(value) => { setChoice(value as RelayChoice); setValidate(false); setSaved(false); }}
                disabled={busy}
                options={[
                  { value: 'default', label: t('phoneAccess.relay_default'), disabled: !status.defaultRelayUrl },
                  { value: 'none', label: t('phoneAccess.relay_none') },
                  { value: 'custom', label: t('phoneAccess.relay_custom') },
                ]}
              />
              <p className="neo-help" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                {status.defaultRelayUrl ? t('phoneAccess.relay_default_url', { url: status.defaultRelayUrl }) : t('phoneAccess.relay_no_public')}
              </p>
              {choice === 'custom' && (
                <TextField
                  label={t('phoneAccess.relay_url')}
                  value={customUrl}
                  onChange={(value) => { setCustomUrl(value); setSaved(false); }}
                  placeholder="wss://"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={500}
                  disabled={busy}
                  required
                  help={t('phoneAccess.relay_url_help')}
                  error={validate && !validRelayUrl(customUrl.trim()) ? t('phoneAccess.relay_url_invalid') : null}
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Button type="submit" size="sm" loading={busy} disabled={busy || (choice === 'default' && !status.defaultRelayUrl)}>{t('common.save')}</Button>
                {saved && <span className="neo-help" aria-live="polite">{t('phoneAccess.relay_saved')}</span>}
              </div>
            </form>
          )}
          <div>
            <button type="button" className="neo-link-btn" onClick={() => getPlatform().openExternal(RELAY_DOCS)}>{t('phoneAccess.relay_docs')}</button>
          </div>
        </div>
      )}
      {Boolean(ownerOnly || error || loader.error) && <p className="neo-error-text" role="alert">{ownerOnly ? t('devices.owner_only') : errorMessage(error ?? loader.error, t)}</p>}
      <p className="neo-help" style={{ margin: 0 }}>{t('phoneAccess.availability')}</p>
    </div>
  );
}
