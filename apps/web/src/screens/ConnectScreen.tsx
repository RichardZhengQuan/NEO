/**
 * Connect to a NEO server (URL + access token, or a pairing link), and the
 * "can't reach your server" screen that keeps the saved connection and retries.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Button, Icon, IconButton, NeoAvatar, SegmentedControl, TextArea, TextField, useT } from '@neo/ui';
import { connectWith } from '../actions/session.js';
import { credentialsFromInput, verifyCredentials } from '../connection.js';
import { showConnect, useSession } from '../state/session.js';

export function ConnectScreen(): ReactElement {
  const t = useT();
  const hint = useSession((s) => s.connectHint);
  const [mode, setMode] = useState<'manual' | 'link'>('manual');
  const [serverUrl, setServerUrl] = useState(hint?.serverUrl ?? '');
  const [token, setToken] = useState(hint?.token ?? '');
  const [link, setLink] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setServerUrl(hint?.serverUrl ?? '');
    setToken(hint?.token ?? '');
  }, [hint]);

  const submit = async () => {
    setError(null);
    const creds = credentialsFromInput(mode === 'link' ? { link } : { serverUrl, token });
    if (!creds) {
      setError(mode === 'link' ? t('connect.error_link') : t('connect.error_fields'));
      return;
    }
    setBusy(true);
    const result = await verifyCredentials(creds.serverUrl, creds.token);
    if (result === 'ok') {
      await connectWith(creds.serverUrl, creds.token, 'manual');
      return;
    }
    setBusy(false);
    setError(result === 'unauthorized' ? t('connect.error_token') : t('connect.error_unreachable', { url: creds.serverUrl }));
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
      <form
        className="auth-card neo-animate-in"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-labelledby="connect-title"
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <NeoAvatar size={64} shape="squircle" state={busy ? 'thinking' : 'idle'} />
          <h1 id="connect-title" style={{ margin: '0.5rem 0 0', fontSize: '1.375rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
            {t('connect.title')}
          </h1>
          <p className="neo-help" style={{ margin: 0, fontSize: '0.9063rem' }}>
            {t('connect.subtitle')}
          </p>
        </div>

        {notice && (
          <div className="neo-callout" data-tone={notice.tone} style={{ marginBottom: '1rem' }}>
            <span className="neo-callout__icon">
              <Icon name={notice.icon} size={16} />
            </span>
            <p style={{ margin: 0, fontSize: '0.8438rem' }}>{notice.text}</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <SegmentedControl
            label={t('connect.method')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'manual', label: t('connect.method_manual'), icon: 'server' },
              { value: 'link', label: t('connect.method_link'), icon: 'link' },
            ]}
            className="w-full"
          />
          {mode === 'manual' ? (
            <>
              <TextField
                label={t('connect.server_url')}
                value={serverUrl}
                onChange={setServerUrl}
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder="https://neo.example.com"
                required
                autoFocus={!serverUrl}
              />
              <TextField
                label={t('connect.token')}
                value={token}
                onChange={setToken}
                type={showToken ? 'text' : 'password'}
                autoComplete="current-password"
                spellCheck={false}
                placeholder={t('connect.token_placeholder')}
                required
                autoFocus={Boolean(serverUrl) && !token}
                help={t('connect.token_help')}
                addon={<IconButton icon={showToken ? 'eye-off' : 'eye'} label={showToken ? t('provider.hide_key') : t('provider.show_key')} size="sm" onClick={() => setShowToken((v) => !v)} />}
              />
            </>
          ) : (
            <TextArea label={t('connect.link')} value={link} onChange={setLink} rows={3} placeholder="neo://pair?server=…&token=…" help={t('connect.link_help')} autoFocus />
          )}
          {error && (
            <p className="neo-error-text" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" block loading={busy} iconRight="arrow-right">
            {t('connect.submit')}
          </Button>
        </div>
      </form>
      <p className="neo-help" style={{ maxWidth: '26rem', textAlign: 'center', marginTop: '1rem' }}>
        {t('connect.footer')}
      </p>
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
