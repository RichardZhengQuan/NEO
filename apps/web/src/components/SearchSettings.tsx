/** Search preferences live with the advanced Text capability settings. */
import { useEffect, useState, type ReactElement } from 'react';
import type { AiSearch, NeoSettingsPatch, SearchEngine } from '@neo/protocol';
import { Button, Select, TextField, useT } from '@neo/ui';
import { errorMessage } from '../lib/errors.js';
import { currentSessionEpoch, isCurrentSession, requireClient, updateSettings, useSession } from '../state/session.js';

export function SearchSettings({ disabled = false }: { disabled?: boolean }): ReactElement {
  const t = useT();
  const search = useSession((s) => s.settings!.ai.search);
  const text = useSession((s) => s.settings!.ai.capabilities.text);
  const models = useSession((s) => s.models);
  const epoch = useSession((s) => s.sessionEpoch);
  const [provider, setProvider] = useState<SearchEngine['provider'] | ''>(search.engine?.provider ?? '');
  const [baseUrl, setBaseUrl] = useState(search.engine?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = text ? models[text.provider]?.find((model) => model.id === text.model) : undefined;
  const hasSavedKey = search.engine?.provider === provider && search.engine.baseUrl === (baseUrl.trim() || undefined) && search.engine.hasApiKey;

  useEffect(() => {
    setProvider(search.engine?.provider ?? '');
    setBaseUrl(search.engine?.baseUrl ?? '');
    setApiKey('');
  }, [epoch, search.engine?.provider, search.engine?.baseUrl, search.engine?.hasApiKey]);
  useEffect(() => { setSaving(false); setError(null); }, [epoch]);

  const save = async (patch: NonNullable<NonNullable<NeoSettingsPatch['ai']>['search']>) => {
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ ai: { search: patch } });
      if (patch.engine !== undefined && isCurrentSession(sessionEpoch, client)) setApiKey('');
    } catch (err) {
      if (isCurrentSession(sessionEpoch, client)) setError(errorMessage(err, t));
    } finally {
      if (isCurrentSession(sessionEpoch, client)) setSaving(false);
    }
  };
  const saveEngine = () => {
    if (!provider) return save({ engine: null });
    const key = apiKey.trim();
    return save({ engine: { provider, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(key ? { apiKey: key } : {}) } });
  };
  const busy = disabled || saving;

  return (
    <section className="ai-setup__section" aria-label={t('ai.search')}>
      <div className="ai-setup__capability">
        <div>
          <p className="ai-setup__capability-title">{t('ai.search')}</p>
          <p className="neo-help">{t('ai.search_help')}</p>
        </div>
        <Select ariaLabel={t('ai.search')} value={search.mode} onChange={(mode) => void save({ mode: mode as AiSearch['mode'] })} disabled={busy} options={(['auto', 'engine', 'off'] as const).map((mode) => ({ value: mode, label: t(`ai.search_${mode}`) }))} />
      </div>
      {search.mode === 'auto' && selected && !selected.capabilities.nativeWebSearch && <p className="neo-help">{t('ai.search_unavailable')}</p>}
      {search.mode !== 'off' && (
        <div className="neo-card ai-setup__section">
          <Select ariaLabel={t('ai.search_provider')} value={provider} onChange={(value) => { setProvider(value as SearchEngine['provider'] | ''); setBaseUrl(''); setApiKey(''); setError(null); }} disabled={busy} options={[{ value: '', label: t('ai.search_default_engine') }, { value: 'searxng', label: 'SearXNG' }, { value: 'brave', label: 'Brave' }, { value: 'tavily', label: 'Tavily' }]} />
          {!provider && <p className="neo-help">{t('ai.search_default_help')}</p>}
          {provider === 'searxng' && <TextField label={t('ai.search_url')} value={baseUrl} onChange={setBaseUrl} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://search.example.com" disabled={busy} />}
          {(provider === 'brave' || provider === 'tavily') && <TextField label={t('ai.search_key')} value={apiKey} onChange={setApiKey} type="password" autoComplete="off" spellCheck={false} placeholder={hasSavedKey ? t('ai.search_saved_key') : undefined} help={t('ai.search_key_help')} disabled={busy} />}
          <div><Button size="sm" variant="secondary" onClick={() => void saveEngine()} loading={saving} disabled={busy || (provider === 'searxng' && !baseUrl.trim()) || ((provider === 'brave' || provider === 'tavily') && !apiKey.trim() && !hasSavedKey)}>{t('ai.search_save_engine')}</Button></div>
        </div>
      )}
      {error && <p className="neo-error-text" role="alert">{error}</p>}
    </section>
  );
}
