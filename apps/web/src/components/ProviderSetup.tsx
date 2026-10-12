/** AI account sign-in, simple key connection, and capability settings. */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { NeoClient } from '@neo/client';
import {
  AI_CAPABILITIES,
  detectApiKeyProvider,
  modelSupportsCapability,
  NeoError,
  OPENROUTER_PRESET,
  PROVIDER_PRESETS,
  type AiCapability,
  type AiSettings,
  type ModelInfo,
  type ModelRef,
  type ProviderView,
  type UpdateProviderRequest,
} from '@neo/protocol';
import { Button, Icon, Select, Spinner, TextField, useT } from '@neo/ui';
import { errorMessage, httpStatus } from '../lib/errors.js';
import { getPlatform } from '../platform/index.js';
import { currentSessionEpoch, isCurrentSession, requireClient, setSettings, updateSettings, useSession } from '../state/session.js';
import { providerLabel } from './ModelLabel.js';
import { ProviderConnectionEditor } from './ProviderConnectionEditor.js';

type KeyProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter';
type ConnectionSummary = { provider: ProviderView; capabilities: AiSettings['capabilities'] | null };
type SignInService = 'openrouter' | 'chatgpt';
type SignInWait = { service: SignInService; state: string; expiresAt: number; providerIds: string[]; client: NeoClient; epoch: number };

export interface ProviderSetupResult {
  provider: ProviderView;
  model: string;
}

export function ProviderSetup(props: {
  existing: ProviderView[];
  onDone: (result: ProviderSetupResult) => void | Promise<void>;
  onCancel?: () => void;
  /** Use Continue for onboarding instead of dismissing the connection summary. */
  offerExisting?: boolean;
}): ReactElement {
  const t = useT();
  const id = useId();
  const { existing, onDone, onCancel, offerExisting = false } = props;
  const settings = useSession((s) => s.settings);
  const models = useSession((s) => s.models);
  const epoch = useSession((s) => s.sessionEpoch);
  const local = useSession((s) => s.health?.mode === 'local');
  const [advanced, setAdvanced] = useState(settings?.ai.mode === 'advanced');
  const [apiKey, setApiKey] = useState('');
  const [unknownProvider, setUnknownProvider] = useState<KeyProvider | ''>('');
  const [custom, setCustom] = useState(false);
  const [editing, setEditing] = useState<ProviderView | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [rowProviders, setRowProviders] = useState<Partial<Record<AiCapability, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ConnectionSummary | null>(null);
  const [waiting, setWaiting] = useState<SignInWait | null>(null);
  const mounted = useRef(true);
  const operation = useRef(0);
  const pendingSignIn = useRef<SignInWait | null>(null);
  const modelRequests = useRef(new Map<string, Promise<ModelInfo[]>>());
  const connected = existing.filter((p) => p.kind !== 'mock');
  const usable = connected.filter((p) => p.enabled && !p.needsReauthorization);
  const detected = detectApiKeyProvider(apiKey);
  const keyProvider = detected === 'unknown' ? unknownProvider : detected;
  const busy = saving || waiting !== null;
  const providerIds = usable.map((p) => p.id).join('\n');

  const active = (sessionEpoch: number, client: NeoClient, op = operation.current) => mounted.current && operation.current === op && isCurrentSession(sessionEpoch, client);
  const cancelSignIn = (pending: SignInWait) => pending.service === 'chatgpt' ? pending.client.auth.chatgptCancel(pending.state) : pending.client.auth.openrouterCancel(pending.state);
  const cancelPendingSignIn = () => {
    const pending = pendingSignIn.current;
    pendingSignIn.current = null;
    if (pending) void cancelSignIn(pending).catch(() => undefined);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      cancelPendingSignIn();
    };
  }, []);

  useEffect(() => {
    operation.current += 1;
    cancelPendingSignIn();
    setApiKey('');
    setCustomKey('');
    setEditing(null);
    setRowProviders({});
    setModelErrors({});
    modelRequests.current.clear();
    setSummary(null);
    setWaiting(null);
    setSaving(false);
    setError(null);
  }, [epoch]);

  useEffect(() => { setAdvanced(settings?.ai.mode === 'advanced'); }, [settings?.ai.mode]);

  const loadModelList = (providerId: string, force = false): Promise<ModelInfo[]> => {
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    if (!force && models[providerId]) return Promise.resolve(models[providerId]);
    const requestKey = `${sessionEpoch}:${providerId}`;
    const pending = modelRequests.current.get(requestKey);
    if (pending) return pending;
    const request = client.providers.models(providerId).then((response) => {
      if (mounted.current && isCurrentSession(sessionEpoch, client)) {
        useSession.setState((s) => ({ models: { ...s.models, [providerId]: response.items } }));
        setModelErrors((errors) => { const next = { ...errors }; delete next[providerId]; return next; });
      }
      return response.items;
    }).catch((err: unknown) => {
      if (mounted.current && isCurrentSession(sessionEpoch, client)) setModelErrors((errors) => ({ ...errors, [providerId]: errorMessage(err, t) }));
      const details = err instanceof NeoError ? err.details : undefined;
      const reason = typeof details === 'object' && details !== null && 'reason' in details ? details.reason : undefined;
      if ((reason === 'subscription_sharing_invalid_user' || reason === 'invalid_grant') && mounted.current && isCurrentSession(sessionEpoch, client)) {
        void client.providers.list().then((providers) => {
          if (mounted.current && isCurrentSession(sessionEpoch, client)) useSession.setState({ providers });
        }).catch(() => undefined);
      }
      throw err;
    }).finally(() => { modelRequests.current.delete(requestKey); });
    modelRequests.current.set(requestKey, request);
    return request;
  };

  useEffect(() => {
    if (!advanced) return;
    for (const providerId of providerIds.split('\n').filter(Boolean)) void loadModelList(providerId).catch(() => undefined);
  }, [advanced, providerIds, epoch]);

  useEffect(() => {
    if (!waiting) return;
    let running = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => running && active(waiting.epoch, waiting.client) && pendingSignIn.current?.state === waiting.state;
    const poll = async () => {
      if (!current()) return;
      if (Date.now() >= waiting.expiresAt) {
        cancelPendingSignIn();
        setWaiting(null);
        setError(t('provider.signin_expired', { name: waiting.service === 'chatgpt' ? 'ChatGPT' : 'OpenRouter' }));
        return;
      }
      try {
        const status = waiting.service === 'chatgpt' ? await waiting.client.auth.chatgptStatus(waiting.state) : null;
        if (!current()) return;
        if (status?.status === 'failed' || status?.status === 'cancelled') {
          pendingSignIn.current = null;
          setWaiting(null);
          if (status.error) setError(errorMessage(NeoError.fromShape(status.error), t));
          else if (status.status === 'failed') setError(t('provider.test_failed'));
          return;
        }
        if (status?.status === 'waiting') {
          if (current()) timer = setTimeout(() => void poll(), 1500);
          return;
        }
        const providers = await waiting.client.providers.list();
        if (!current()) return;
        const provider = status?.provider ?? providers.items.find((p) => p.enabled && p.kind === 'openai-compatible' && p.baseUrl?.replace(/\/$/, '') === OPENROUTER_PRESET.baseUrl && !waiting.providerIds.includes(p.id));
        if (provider) {
          const next = await waiting.client.settings.get();
          if (!current()) return;
          useSession.setState({ providers });
          setSettings(next);
          setSummary({ provider, capabilities: next.ai.mode === 'simple' ? next.ai.capabilities : null });
          pendingSignIn.current = null;
          setWaiting(null);
          return;
        }
      } catch (err) {
        if (waiting.service === 'chatgpt' && err instanceof NeoError && err.code !== 'provider_error' && err.code !== 'timeout' && current()) {
          cancelPendingSignIn();
          setWaiting(null);
          setError(errorMessage(err, t));
          return;
        }
        // A temporary connection failure can recover while the sign-in is open.
      }
      if (current()) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { running = false; if (timer) clearTimeout(timer); };
  }, [waiting, t]);

  const refreshConnection = async (provider: ProviderView, client: NeoClient, sessionEpoch: number, op: number, simple = true) => {
    const [providers, next] = await Promise.all([client.providers.list(), client.settings.get()]);
    if (!active(sessionEpoch, client, op)) return;
    useSession.setState({ providers });
    setSettings(next);
    setSummary({ provider, capabilities: simple ? next.ai.capabilities : null });
  };

  const connectKey = async () => {
    if (!keyProvider || !apiKey.trim()) return;
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setSaving(true);
    setError(null);
    try {
      const preset = keyProvider === 'openrouter' ? OPENROUTER_PRESET : PROVIDER_PRESETS[keyProvider];
      const draft = { kind: preset.kind, apiKey: apiKey.trim(), ...(keyProvider === 'openrouter' ? { baseUrl: preset.baseUrl } : {}) };
      if (advanced) {
        const result = await client.providers.testDraft(draft);
        if (!active(sessionEpoch, client, op)) return;
        if (!result.ok) throw new Error(result.error || t('provider.test_failed'));
      }
      const provider = await client.providers.create({ ...draft, label: preset.label, simple: !advanced });
      if (!active(sessionEpoch, client, op)) return;
      setApiKey('');
      await refreshConnection(provider, client, sessionEpoch, op, !advanced);
      if (advanced && active(sessionEpoch, client, op)) await loadModelList(provider.id, true).catch(() => undefined);
    } catch (err) {
      if (active(sessionEpoch, client, op)) setError(errorMessage(err, t));
    } finally {
      if (active(sessionEpoch, client, op)) setSaving(false);
    }
  };

  const signIn = async (service: SignInService, providerId?: string) => {
    if (service === 'chatgpt' && !local) return;
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setSaving(true);
    setError(null);
    try {
      const result = service === 'chatgpt' ? await client.auth.chatgptStart(providerId) : await client.auth.openrouterStart();
      if (!active(sessionEpoch, client, op)) {
        void cancelSignIn({ service, ...result, providerIds: [], client, epoch: sessionEpoch }).catch(() => undefined);
        return;
      }
      const pending = { service, state: result.state, expiresAt: result.expiresAt, providerIds: connected.map((p) => p.id), client, epoch: sessionEpoch };
      pendingSignIn.current = pending;
      getPlatform().openExternal(result.url);
      setWaiting(pending);
    } catch (err) {
      cancelPendingSignIn();
      if (active(sessionEpoch, client, op)) setError(errorMessage(err, t));
    } finally {
      if (active(sessionEpoch, client, op)) setSaving(false);
    }
  };

  const setMode = async (value: boolean) => {
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setAdvanced(value);
    setSaving(true);
    setError(null);
    try { await updateSettings({ ai: { mode: value ? 'advanced' : 'simple' } }); }
    catch (err) { if (active(sessionEpoch, client, op)) { setAdvanced(!value); setError(errorMessage(err, t)); } }
    finally { if (active(sessionEpoch, client, op)) setSaving(false); }
  };

  const assign = async (capability: AiCapability, providerId: string, model?: string) => {
    if (capability !== 'text' && connected.some((provider) => provider.id === providerId && provider.kind === 'chatgpt')) return;
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setSaving(true);
    setError(null);
    const previous = rowProviders[capability];
    setRowProviders((rows) => ({ ...rows, [capability]: providerId }));
    try {
      const list = providerId ? await loadModelList(providerId) : [];
      if (!active(sessionEpoch, client, op)) return;
      const modelId = model ?? list.find((m) => modelSupportsCapability(m, capability))?.id;
      const ref: ModelRef | null = providerId && modelId ? { provider: providerId, model: modelId } : null;
      await updateSettings({ ai: { mode: 'advanced', capabilities: { [capability]: ref } } });
    } catch (err) {
      if (active(sessionEpoch, client, op)) {
        setRowProviders((rows) => ({ ...rows, [capability]: previous }));
        setError(errorMessage(err, t));
      }
    } finally { if (active(sessionEpoch, client, op)) setSaving(false); }
  };

  const connectCustom = async () => {
    if (!baseUrl.trim()) return;
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setSaving(true);
    setError(null);
    try {
      const draft = { kind: 'openai-compatible' as const, baseUrl: baseUrl.trim(), ...(customKey.trim() ? { apiKey: customKey.trim() } : {}) };
      const result = await client.providers.testDraft(draft);
      if (!active(sessionEpoch, client, op)) return;
      if (!result.ok) throw new Error(result.error || t('provider.test_failed'));
      const provider = await client.providers.create({ ...draft, label: t('provider.custom_label'), simple: false });
      if (!active(sessionEpoch, client, op)) return;
      setCustomKey('');
      await refreshConnection(provider, client, sessionEpoch, op, false);
      if (!active(sessionEpoch, client, op)) return;
      await loadModelList(provider.id, true).catch(() => undefined);
      if (active(sessionEpoch, client, op)) setCustom(false);
    } catch (err) { if (active(sessionEpoch, client, op)) setError(errorMessage(err, t)); }
    finally { if (active(sessionEpoch, client, op)) setSaving(false); }
  };

  const disconnect = async (provider: ProviderView) => {
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setSaving(true);
    setError(null);
    try {
      await client.providers.delete(provider.id);
      if (!active(sessionEpoch, client, op)) return;
      const [providers, next] = await Promise.all([client.providers.list(), client.settings.get()]);
      if (!active(sessionEpoch, client, op)) return;
      useSession.setState({ providers });
      setSettings(next);
      setRowProviders({});
      setSummary(null);
    } catch (err) { if (active(sessionEpoch, client, op)) setError(httpStatus(err) === 409 ? t('ai.config_file') : errorMessage(err, t)); }
    finally { if (active(sessionEpoch, client, op)) setSaving(false); }
  };

  const updateConnection = async (provider: ProviderView, patch: UpdateProviderRequest) => {
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setSaving(true);
    setError(null);
    try {
      await client.providers.update(provider.id, patch);
      if (!active(sessionEpoch, client, op)) return;
      const providers = await client.providers.list();
      if (!active(sessionEpoch, client, op)) return;
      useSession.setState((s) => {
        const nextModels = { ...s.models };
        delete nextModels[provider.id];
        return { providers, models: nextModels };
      });
      setEditing(null);
      if (advanced && patch.enabled !== false) void loadModelList(provider.id, true).catch(() => undefined);
    } catch (err) {
      if (active(sessionEpoch, client, op)) setError(httpStatus(err) === 409 ? t('ai.config_file') : errorMessage(err, t));
      throw err;
    } finally { if (active(sessionEpoch, client, op)) setSaving(false); }
  };

  const finish = async () => {
    const ref = settings?.ai.capabilities.text;
    const provider = usable.find((p) => p.id === ref?.provider);
    if (!ref || !provider) return;
    const client = requireClient();
    const sessionEpoch = currentSessionEpoch();
    const op = ++operation.current;
    setSaving(true);
    setError(null);
    try {
      await onDone({ provider, model: ref.model });
      if (active(sessionEpoch, client, op)) setSummary(null);
    } catch (err) { if (active(sessionEpoch, client, op)) setError(errorMessage(err, t)); }
    finally { if (active(sessionEpoch, client, op)) setSaving(false); }
  };

  return (
    <div className="ai-setup">
      <section className="ai-setup__section" aria-label={t('provider.sign_in')}>
        <h3 className="group-title">{t('provider.sign_in')}</h3>
        <div className="ai-setup__accounts">
          <div className="ai-setup__account">
            <Button block size="lg" icon="log-in" onClick={() => void signIn('chatgpt')} disabled={busy || !local} aria-describedby={`${id}-chatgpt-help`}>{t('provider.signin_chatgpt')}</Button>
            <p id={`${id}-chatgpt-help`} className="neo-help">{t(local ? 'provider.chatgpt_help' : 'provider.chatgpt_remote')}</p>
          </div>
          <div className="ai-setup__account">
            <Button block size="lg" icon="log-in" onClick={() => void signIn('openrouter')} disabled={busy} aria-describedby={`${id}-openrouter-help`}>{t('provider.signin_openrouter')}</Button>
            <p id={`${id}-openrouter-help`} className="neo-help">{t('provider.openrouter_help')}</p>
          </div>
        </div>
        {waiting && (
          <div className="neo-callout" role="status">
            <Spinner size={17} />
            <div className="ai-setup__wait">
              <p className="neo-callout__title">{t('provider.waiting', { name: waiting.service === 'chatgpt' ? 'ChatGPT' : 'OpenRouter' })}</p>
              <p className="neo-help">{t('provider.waiting_help')}</p>
              <Button size="sm" variant="ghost" onClick={() => { operation.current += 1; cancelPendingSignIn(); setWaiting(null); }}>{t('common.cancel')}</Button>
            </div>
          </div>
        )}
      </section>

      <section className="ai-setup__section" aria-label={t('provider.use_key')}>
        <h3 className="group-title">{t('provider.use_key')}</h3>
        <TextField label={t('provider.api_key')} value={apiKey} onChange={(value) => { setApiKey(value); setError(null); }} type="password" autoComplete="off" spellCheck={false} disabled={busy} help={t(advanced ? 'provider.advanced_key_help' : 'provider.simple_help')} />
        {apiKey.trim() && <p className="neo-help" role="status">{detected === 'unknown' ? t('provider.unknown_key') : t('provider.detected', { name: t(`provider.${detected}.label`) })}</p>}
        {apiKey.trim() && detected === 'unknown' && <Select label={t('provider.key_service')} value={unknownProvider} onChange={(value) => setUnknownProvider(value as KeyProvider | '')} disabled={busy} options={[{ value: '', label: t('provider.choose_service') }, ...(['anthropic', 'openai', 'gemini', 'openrouter'] as const).map((value) => ({ value, label: t(`provider.${value}.label`) }))]} />}
        <div><Button variant="primary" icon="key" onClick={() => void connectKey()} loading={saving && !advanced} disabled={busy || !apiKey.trim() || !keyProvider}>{t('provider.connect')}</Button></div>
      </section>

      {summary && (
        <section className="neo-callout ai-setup__summary" data-tone="success" role="status">
          <Icon name="check-circle" size={18} />
          <div>
            <p className="neo-callout__title">{t('provider.connected', { name: providerLabel(summary.provider) })}</p>
            <p className="neo-help">{t(summary.capabilities ? 'provider.defaults_help' : 'provider.advanced_connected_help')}</p>
            {summary.capabilities && (
              <dl className="ai-setup__models">
                {AI_CAPABILITIES.map((capability) => (
                  <div key={capability}>
                    <dt>{t(`provider.capability.${capability}`)}</dt>
                    <dd>{summary.capabilities?.[capability]?.model ?? t(capability === 'embedding' ? 'provider.local_memory' : 'provider.not_configured')}</dd>
                  </div>
                ))}
              </dl>
            )}
            {settings?.ai.capabilities.text && <Button size="sm" variant="primary" onClick={() => void finish()} disabled={busy}>{t(offerExisting ? 'common.continue' : 'common.done')}</Button>}
          </div>
        </section>
      )}
      {error && <p className="neo-error-text" role="alert">{error}</p>}

      <section className="ai-setup__section">
        <button type="button" className="neo-link-btn ai-setup__advanced-toggle" aria-expanded={advanced} aria-controls={`${id}-capabilities`} disabled={busy} onClick={() => void setMode(!advanced)}><Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={16} />{t('provider.advanced')}</button>
        {advanced && (
          <div id={`${id}-capabilities`} className="ai-setup__section">
            <p className="neo-help">{t('provider.advanced_help')}</p>
            {Object.entries(modelErrors).filter(([providerId]) => usable.some((provider) => provider.id === providerId)).map(([providerId, message]) => (
              <div className="neo-callout" data-tone="danger" key={providerId}>
                <div>
                  <p className="neo-callout__title">{t('provider.models_failed', { name: providerLabel(usable.find((provider) => provider.id === providerId)) })}</p>
                  <p className="neo-help">{message}</p>
                  <Button size="sm" onClick={() => void loadModelList(providerId, true).catch(() => undefined)} disabled={busy}>{t('common.retry')}</Button>
                </div>
              </div>
            ))}
            {AI_CAPABILITIES.map((capability) => {
              const ref = settings?.ai.capabilities[capability];
              const providerId = rowProviders[capability] ?? ref?.provider ?? '';
              const textOnly = connected.some((provider) => provider.id === providerId && provider.kind === 'chatgpt');
              const available = [...(textOnly && capability !== 'text' ? [] : models[providerId] ?? [])].sort((a, b) => Number(modelSupportsCapability(b, capability)) - Number(modelSupportsCapability(a, capability)));
              const selected = ref?.provider === providerId ? ref.model : '';
              const options = available.map((model) => ({ value: model.id, label: model.label ?? model.id }));
              if (selected && !options.some((model) => model.value === selected)) options.unshift({ value: selected, label: selected });
              return (
                <div key={capability} className="ai-setup__capability">
                  <div>
                    <p className="ai-setup__capability-title">{t(`provider.capability.${capability}`)}</p>
                    <p className="neo-help">{t(`provider.capability_help.${capability}`)}</p>
                  </div>
                  <div className="ai-setup__choices">
                    <Select ariaLabel={t('provider.capability_provider', { capability: t(`provider.capability.${capability}`) })} value={providerId} onChange={(id) => void assign(capability, id)} disabled={busy} options={[{ value: '', label: t(capability === 'embedding' ? 'provider.local_memory' : 'provider.not_configured') }, ...usable.filter((provider) => capability === 'text' || provider.kind !== 'chatgpt').map((provider) => ({ value: provider.id, label: providerLabel(provider) }))]} />
                    <Select ariaLabel={t('provider.capability_model', { capability: t(`provider.capability.${capability}`) })} value={selected} onChange={(model) => void assign(capability, providerId, model)} disabled={busy || !providerId || (textOnly && capability !== 'text')} options={[{ value: '', label: t(providerId && !available.length ? 'provider.no_capability_models' : 'provider.choose_model') }, ...options]} />
                  </div>
                </div>
              );
            })}
            <div><Button size="sm" variant="secondary" icon="plus" onClick={() => setCustom(!custom)} disabled={busy}>{t('provider.add_custom')}</Button></div>
            {custom && (
              <div className="neo-card ai-setup__section">
                <p className="ai-setup__capability-title">{t('provider.custom')}</p>
                <p className="neo-help">{t('provider.custom_help')}</p>
                <TextField label={t('provider.base_url')} value={baseUrl} onChange={setBaseUrl} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:1234/v1" disabled={busy} help={t('provider.compatible_help')} />
                <TextField label={t('provider.api_key_optional')} value={customKey} onChange={setCustomKey} type="password" autoComplete="off" spellCheck={false} disabled={busy} />
                <div><Button variant="primary" onClick={() => void connectCustom()} loading={saving} disabled={busy || !baseUrl.trim()}>{t('provider.connect_custom')}</Button></div>
              </div>
            )}
          </div>
        )}
      </section>

      {connected.length > 0 && (
        <section className="ai-setup__section" aria-label={t('provider.already_set_up')}>
          <h3 className="group-title">{t('provider.already_set_up')}</h3>
          <ul className="ai-setup__connected">
            {connected.map((provider) => (
              <li key={provider.id}>
                <div>
                  <span>{provider.label || (provider.kind === 'openai-compatible' ? t('provider.custom_label') : providerLabel(provider))}</span>
                  <p className="neo-help">{t(provider.needsReauthorization ? 'provider.chatgpt_disconnected' : !provider.enabled ? 'provider.disabled' : provider.kind === 'chatgpt' ? 'provider.saved_account' : provider.hasApiKey ? 'provider.saved_key' : 'provider.saved_endpoint')}</p>
                </div>
                <div className="ai-setup__connection-actions">
                  {provider.kind === 'chatgpt' && provider.needsReauthorization && <Button size="sm" disabled={busy || !local} onClick={() => void signIn('chatgpt', provider.id)} aria-label={t('provider.signin_again_name', { name: providerLabel(provider) })}>{t('provider.signin_again')}</Button>}
                  {advanced && (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void updateConnection(provider, { enabled: !provider.enabled }).catch(() => undefined)} aria-label={t(provider.enabled ? 'provider.disable_name' : 'provider.enable_name', { name: providerLabel(provider) })}>
                        {t(provider.enabled ? 'provider.disable' : 'provider.enable')}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(provider)} aria-label={t('provider.edit_connection', { name: providerLabel(provider) })}>
                        {t('common.edit')}
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect(provider)} aria-label={t('provider.disconnect_name', { name: providerLabel(provider) })}>
                    {t('provider.disconnect')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {editing && <ProviderConnectionEditor provider={editing} onSave={(patch) => updateConnection(editing, patch)} onClose={() => setEditing(null)} />}
      {onCancel && <div><Button variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button></div>}
    </div>
  );
}
