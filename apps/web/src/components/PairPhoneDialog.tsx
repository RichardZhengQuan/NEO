import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Device, PairingSession } from '@neo/protocol';
import { Button, CopyButton, Icon, Modal, Skeleton, useT } from '@neo/ui';
import { errorMessage, httpStatus } from '../lib/errors.js';
import { onServerEvent } from '../state/events.js';
import { requireClient } from '../state/session.js';
import { QrCode } from './QrCode.js';

/** A short-lived, single-use code; leaving the dialog cancels an unclaimed code. */
export function PairPhoneDialog({ onClose, onPaired }: { onClose: () => void; onPaired: (device: Device) => void }): ReactElement {
  const t = useT();
  const [client] = useState(() => requireClient());
  const [session, setSession] = useState<PairingSession | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const request = useRef(0);
  const active = useRef<PairingSession | null>(null);
  const paired = useRef<Device | null>(null);
  const finished = useRef(false);
  const callbacks = useRef({ onClose, onPaired });
  callbacks.current = { onClose, onPaired };

  const cancel = (id: string) => void client.pairing.cancel(id).catch(() => undefined);
  const create = async () => {
    const generation = ++request.current;
    if (active.current) cancel(active.current.id);
    active.current = null;
    setSession(null);
    setError(null);
    setBusy(true);
    try {
      const next = await client.pairing.create();
      if (!mounted.current || generation !== request.current) {
        cancel(next.id);
        return;
      }
      active.current = next;
      setNow(Date.now());
      setSession(next);
    } catch (err) {
      if (mounted.current && generation === request.current) setError(err);
    } finally {
      if (mounted.current && generation === request.current) setBusy(false);
    }
  };
  const close = () => {
    if (finished.current) return;
    finished.current = true;
    ++request.current;
    if (paired.current) callbacks.current.onPaired(paired.current);
    else if (active.current) cancel(active.current.id);
    active.current = null;
    callbacks.current.onClose();
  };

  useEffect(() => {
    mounted.current = true;
    const off = onServerEvent((event) => {
      if (event.type !== 'device.paired' || event.pairingId !== active.current?.id || paired.current) return;
      paired.current = event.device;
      setDevice(event.device);
    });
    void create();
    return () => {
      mounted.current = false;
      ++request.current;
      off();
      if (active.current && !paired.current) cancel(active.current.id);
      active.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!session || device) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= session.expiresAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [session, device]);

  useEffect(() => {
    if (!device) return;
    const timer = setTimeout(close, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  const remaining = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000)) : 0;
  const expired = Boolean(session) && remaining === 0;
  const status = device ? t('pairing.connected', { name: device.name }) : expired ? t('pairing.expired') : busy ? t('pairing.creating') : error ? '' : t('pairing.ready');

  return (
    <Modal open onClose={close} title={t('devices.pair')} size="md" footer={<Button variant="ghost" onClick={close}>{t('common.close')}</Button>}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', textAlign: 'center' }}>
        <p role="status" style={{ margin: 0 }} className={device ? 'pairing-success' : 'neo-help'}>
          {device && <Icon name="check-circle" size={20} />}
          {status}
        </p>
        {busy ? (
          <Skeleton width={240} height={240} />
        ) : device ? null : error ? (
          <>
            <p className="neo-error-text" role="alert" style={{ margin: 0 }}>{httpStatus(error) === 403 ? t('devices.owner_only') : errorMessage(error, t)}</p>
            <Button variant="primary" icon="refresh" onClick={() => void create()}>{t('common.retry')}</Button>
          </>
        ) : expired ? (
          <Button variant="primary" icon="refresh" onClick={() => void create()}>{t('pairing.refresh')}</Button>
        ) : session ? (
          <>
            <h3 style={{ margin: 0, fontSize: '1.125rem' }}>{t('pairing.scan_title')}</h3>
            <QrCode value={session.pairingUrl} size={240} label={t('devices.qr_label')} />
            <ol style={{ textAlign: 'left', margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', lineHeight: 1.6, color: 'var(--neo-text-muted)' }}>
              <li>{t('pairing.step1')}</li>
              <li>{t('pairing.step2')}</li>
            </ol>
            <p aria-live="off" style={{ margin: 0, fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem' }}>{t('pairing.expires', { time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` })}</p>
            <p className="neo-help" style={{ margin: 0 }}>{t('pairing.availability')}</p>
            <details className="pairing-disclosure" style={{ width: '100%', textAlign: 'left' }}>
              <summary>{t('pairing.copy_help')}</summary>
              <div className="neo-code" style={{ marginTop: '0.75rem' }}>
                <div className="neo-code__head">
                  <span>{t('devices.link')}</span>
                  <CopyButton text={session.pairingUrl} label={t('devices.copy_link')} />
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{session.pairingUrl}</pre>
              </div>
            </details>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
