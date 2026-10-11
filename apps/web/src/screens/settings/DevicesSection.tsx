/**
 * Settings → Devices: everything that can talk to this server, pairing a new
 * phone/computer with a QR code or link, and revoking access.
 */
import { useState, type ReactElement } from 'react';
import type { CreateDeviceResponse, Device } from '@neo/protocol';
import { Badge, Button, CopyButton, EmptyState, Icon, IconButton, Modal, Select, Skeleton, TextField, formatRelative, useConfirm, useLocale, useT } from '@neo/ui';
import { QrCode } from '../../components/QrCode.js';
import { PairPhoneDialog } from '../../components/PairPhoneDialog.js';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage, httpStatus } from '../../lib/errors.js';
import { getPlatform } from '../../platform/index.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient } from '../../state/session.js';
import { Section } from './common.js';

const PLATFORM_ICON: Record<Device['platform'], string> = { web: 'globe', desktop: 'laptop', ios: 'smartphone', android: 'smartphone', cli: 'terminal', other: 'cpu' };
const PLATFORMS: Device['platform'][] = ['ios', 'android', 'desktop', 'web', 'cli', 'other'];

function AccessTokenDialog({ onClose, onPaired }: { onClose: () => void; onPaired: () => void }): ReactElement {
  const t = useT();
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<Device['platform']>('ios');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateDeviceResponse | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      setResult(await requireClient().devices.create(name.trim(), platform));
      onPaired();
    } catch (err) {
      pushToast({ tone: 'error', title: httpStatus(err) === 403 ? t('devices.owner_only') : errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={result ? t('devices.scan_title', { name: result.device.name }) : t('devices.access_token')}
      size="md"
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon="qr-code" onClick={() => void create()} loading={busy} disabled={!name.trim()}>
              {t('devices.create')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', textAlign: 'center' }}>
          <QrCode value={result.pairingUrl} label={t('devices.qr_label')} />
          <ol style={{ textAlign: 'left', margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', lineHeight: 1.6, color: 'var(--neo-text-muted)' }}>
            <li>{t('devices.step1')}</li>
            <li>{t('devices.step2')}</li>
            <li>{t('devices.step3')}</li>
          </ol>
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="neo-code" style={{ textAlign: 'left' }}>
              <div className="neo-code__head">
                <span>{t('devices.link')}</span>
                <CopyButton text={result.pairingUrl} label={t('devices.copy_link')} />
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{result.pairingUrl}</pre>
            </div>
            <div className="neo-code" style={{ textAlign: 'left' }}>
              <div className="neo-code__head">
                <span>{t('devices.token')}</span>
                <CopyButton text={result.token} label={t('devices.copy_token')} />
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{result.token}</pre>
            </div>
          </div>
          <p className="neo-help" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', margin: 0 }}>
            <Icon name="lock" size={13} />
            {t('devices.shown_once')}
          </p>
        </div>
      ) : (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <p className="neo-help" style={{ margin: 0, fontSize: '0.875rem' }}>
            {t('devices.pair_help')}
          </p>
          <TextField label={t('devices.name')} value={name} onChange={setName} maxLength={100} placeholder={t('devices.name_placeholder')} autoFocus required />
          <Select label={t('devices.platform')} value={platform} onChange={(v) => setPlatform(v as Device['platform'])} options={PLATFORMS.map((p) => ({ value: p, label: t(`devices.platform_${p}`) }))} />
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

export function DevicesSection(): ReactElement {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const loader = useLoader(async () => (await requireClient().devices.list()).items, []);
  const [pairing, setPairing] = useState(false);
  const [accessToken, setAccessToken] = useState(false);
  const devices = loader.data;

  const revoke = async (device: Device) => {
    const ok = await confirm({ title: t('devices.revoke_title'), message: t('devices.revoke_text', { name: device.name }), confirmLabel: t('devices.revoke'), danger: true });
    if (!ok) return;
    try {
      await requireClient().devices.revoke(device.id);
      loader.setData((prev) => prev?.filter((d) => d.id !== device.id));
      pushToast({ tone: 'success', title: t('devices.revoked', { name: device.name }) });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  return (
    <Section
      title={t('devices.title')}
      description={t('devices.help')}
      actions={
        getPlatform().kind !== 'capacitor' ? (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button size="sm" variant="primary" icon="qr-code" onClick={() => setPairing(true)}>
              {t('devices.pair')}
            </Button>
            <Button size="sm" variant="ghost" icon="key" onClick={() => setAccessToken(true)}>
              {t('devices.access_token')}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!devices ? (
        loader.error ? (
          <EmptyState icon="alert-circle" title={t('common.error')} />
        ) : (
          <Skeleton height={120} />
        )
      ) : (
        <ul className="row-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {[...devices]
            .sort((a, b) => Number(b.owner) - Number(a.owner) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
            .map((d) => (
              <li key={d.id} className="row">
                <span className="neo-card__icon">
                  <Icon name={PLATFORM_ICON[d.platform]} size={17} />
                </span>
                <div className="row__main">
                  <div className="row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {d.name}
                    {d.owner && <Badge tone="accent">{t('devices.owner')}</Badge>}
                  </div>
                  <div className="row__meta">
                    <span>{t(`devices.platform_${d.platform}`)}</span>
                    <span>{d.lastSeenAt ? t('devices.last_seen', { when: formatRelative(d.lastSeenAt, locale) }) : t('devices.never_seen')}</span>
                  </div>
                </div>
                {!d.owner && <IconButton icon="trash" label={t('devices.revoke_named', { name: d.name })} onClick={() => void revoke(d)} />}
              </li>
            ))}
        </ul>
      )}
      {pairing && <PairPhoneDialog onClose={() => setPairing(false)} onPaired={() => void loader.reload()} />}
      {accessToken && <AccessTokenDialog onClose={() => setAccessToken(false)} onPaired={() => void loader.reload()} />}
    </Section>
  );
}
