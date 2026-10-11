/**
 * Pair with the computer by scanning or pasting a link; manual credentials
 * remain available under the advanced disclosure. Offline keeps its connection.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Icon, IconButton, NeoAvatar, TextArea, TextField, useLocale, useT } from '@neo/ui';
import { pairWithLink, pairingOutcomeKey } from '../actions/pairing.js';
import { connectWith } from '../actions/session.js';
import { credentialsFromInput, verifyCredentials } from '../connection.js';
import { getPlatform } from '../platform/index.js';
import { showConnect, useSession } from '../state/session.js';

export function ConnectScreen(): ReactElement {
  const t = useT();
  const locale = useLocale();
  const platform = getPlatform();
  const mobile = platform.kind === 'capacitor';
  const hint = useSession((s) => s.connectHint);
  const [serverUrl, setServerUrl] = useState(hint?.serverUrl ?? '');
  const [token, setToken] = useState(hint?.token ?? '');
  const [link, setLink] = useState('');
  const [paste, setPaste] = useState(!mobile);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => platform.setLocale(locale), [platform, locale]);

  useEffect(() => {
    setServerUrl(hint?.serverUrl ?? '');
    setToken(hint?.token ?? '');
  }, [hint]);

  const pair = async (url?: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const input = url ?? await platform.scanQrCode?.();
      if (!input || !mounted.current) return;
      const result = await pairWithLink(input);
      if (mounted.current && result !== 'ok') setError(t(pairingOutcomeKey(result)));
    } catch {
      if (mounted.current) setError(t('pairing.unreachable'));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    const off = platform.watchPairLinks?.((url) => void pair(url));
    return () => {
      mounted.current = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, t]);

  const submitManual = async () => {
    if (pending.current) return;
    setError(null);
    const creds = credentialsFromInput({ serverUrl, token });
    if (!creds) {
      setError(t('connect.error_fields'));
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const result = await verifyCredentials(creds.serverUrl, creds.token);
      if (!mounted.current) return;
      if (result === 'ok') await connectWith(creds.serverUrl, creds.token, 'manual');
      else setError(result === 'unauthorized' ? t('connect.error_token') : t('connect.error_unreachable', { url: creds.serverUrl }));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const notice =
    hint?.reason === 'unauthorized'
      ? { tone: 'warning', icon: 'key', text: t('connect.hint_unauthorized') }
      : hint?.reason === 'pair-failed'
        ? { tone: 'warning', icon: 'alert-triangle', text: t('connect.hint_pair_failed') }
        : hint?.reason === 'same-origin'
          ? { tone: 'info', icon: 'server', text: t('connect.hint_same_origin') }
          : null;

  return (
    <main className="center-screen">
      <div className="auth-card neo-animate-in" aria-labelledby="connect-title" aria-busy={busy}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <NeoAvatar size={64} shape="squircle" state={busy ? 'thinking' : 'idle'} />
          <h1 id="connect-title" style={{ margin: '0.5rem 0 0', fontSize: '1.375rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
            {mobile ? t('connect.scan_title') : t('connect.paste_title')}
          </h1>
          <p className="neo-help" style={{ margin: 0, fontSize: '0.9063rem' }}>{t('connect.pair_lead')}</p>
        </div>

        {notice && (
          <div className="neo-callout" data-tone={notice.tone} style={{ marginBottom: '1rem' }}>
            <span className="neo-callout__icon"><Icon name={notice.icon} size={16} /></span>
            <p style={{ margin: 0, fontSize: '0.8438rem' }}>{notice.text}</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {mobile && (
            <>
              <Button variant="primary" size="lg" block icon="qr-code" loading={busy} disabled={!platform.scanQrCode} onClick={() => void pair()}>{t('connect.scan')}</Button>
              <Button variant="ghost" block disabled={busy} onClick={() => setPaste((value) => !value)}>{t('connect.paste_instead')}</Button>
            </>
          )}
          {paste && (
            <form onSubmit={(e) => { e.preventDefault(); void pair(link); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <TextArea label={t('connect.link')} value={link} onChange={setLink} rows={3} placeholder="neo://pair?v=2&code=…" help={t('connect.link_help')} autoFocus={!mobile} required disabled={busy} />
              <Button type="submit" variant={mobile ? 'secondary' : 'primary'} size="lg" block loading={busy} iconRight="arrow-right">{t('connect.submit')}</Button>
            </form>
          )}
          {busy && <p role="status" className="neo-help" style={{ margin: 0 }}>{t('connect.pairing')}</p>}
          {error && <p className="neo-error-text" role="alert" style={{ margin: 0 }}>{error}</p>}
          {/* Open when the hint is about the manual form (a server found here, or prefilled details). */}
          <details className="pairing-disclosure" open={hint?.reason === 'same-origin' || Boolean(hint?.token) || undefined}>
            <summary>{t('connect.advanced')}</summary>
            <form onSubmit={(e) => { e.preventDefault(); void submitManual(); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginTop: '1rem' }}>
              <TextField label={t('connect.server_url')} value={serverUrl} onChange={setServerUrl} type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://neo.example.com" required disabled={busy} />
              <TextField
                label={t('connect.token')}
                value={token}
                onChange={setToken}
                type={showToken ? 'text' : 'password'}
                autoComplete="current-password"
                spellCheck={false}
                placeholder={t('connect.token_placeholder')}
                required
                disabled={busy}
                help={t('connect.token_help')}
                addon={<IconButton icon={showToken ? 'eye-off' : 'eye'} label={showToken ? t('provider.hide_key') : t('provider.show_key')} size="sm" onClick={() => setShowToken((value) => !value)} />}
              />
              <Button type="submit" variant="secondary" block loading={busy} iconRight="arrow-right">{t('connect.submit')}</Button>
            </form>
          </details>
        </div>
      </div>
      <p className="neo-help" style={{ maxWidth: '26rem', textAlign: 'center', marginTop: '1rem' }}>{t('connect.footer')}</p>
    </main>
  );
}

export function OfflineScreen(): ReactElement {
  const t = useT();
  const hint = useSession((s) => s.connectHint);
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    if (!hint?.serverUrl || !hint.token) return;
    setBusy(true);
    const result = await verifyCredentials(hint.serverUrl, hint.token);
    if (result === 'ok') await connectWith(hint.serverUrl, hint.token, 'saved');
    else if (result === 'unauthorized') showConnect({ reason: 'unauthorized', serverUrl: hint.serverUrl });
    setBusy(false);
  };

  useEffect(() => {
    const onOnline = () => void retry();
    window.addEventListener('online', onOnline);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void retry();
    }, 15_000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hint]);

  return (
    <main className="center-screen">
      <div className="auth-card neo-animate-in" style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <NeoAvatar size={64} shape="squircle" state={busy ? 'thinking' : 'idle'} />
        </div>
        <h1 style={{ margin: '1rem 0 0.375rem', fontSize: '1.25rem', fontWeight: 700 }}>{t('offline.title')}</h1>
        <p className="neo-help" style={{ fontSize: '0.9063rem', margin: '0 0 0.25rem' }}>
          {t('offline.text')}
        </p>
        <p style={{ margin: '0 0 1.25rem', fontFamily: 'var(--neo-font-mono)', fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{hint?.serverUrl}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <Button variant="primary" icon="refresh" block loading={busy} onClick={() => void retry()}>
            {t('offline.retry')}
          </Button>
          <Button variant="ghost" block onClick={() => showConnect({ reason: 'manual', serverUrl: hint?.serverUrl })}>
            {t('offline.change')}
          </Button>
        </div>
      </div>
    </main>
  );
}
