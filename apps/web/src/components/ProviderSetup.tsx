/**
 * "Choose your AI": pick a preset, enter a key / base URL, test the draft,
 * create the provider, then pick a model. Used by onboarding and Settings.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { PROVIDER_PRESETS, type ProviderKind, type ProviderTestResult, type ProviderView } from '@neo/protocol';
import { Badge, Button, Icon, IconButton, Select, Spinner, TextField, useT } from '@neo/ui';
import { errorMessage } from '../lib/errors.js';
import { openLink } from '../actions/links.js';
import { currentSessionEpoch, isCurrentSession, loadModels, loadProviders, requireClient } from '../state/session.js';
import { providerLabel } from './ModelPicker.js';

export const PRESET_ORDER: ProviderKind[] = ['anthropic', 'openai', 'gemini', 'ollama', 'openai-compatible', 'mock'];

export const PRESET_ICON: Record<ProviderKind, string> = {
  anthropic: 'sparkles',
  openai: 'zap',
  gemini: 'star',
  ollama: 'laptop',
  'openai-compatible': 'server',
  mock: 'play',
};

type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'done'; result: ProviderTestResult };

export interface ProviderSetupResult {
  provider: ProviderView;
  model: string;
}

function PresetCard({ kind, selected, onSelect }: { kind: ProviderKind; selected: boolean; onSelect: () => void }): ReactElement {
  const t = useT();
  const preset = PROVIDER_PRESETS[kind];
  return (
    <button type="button" className="option-card" aria-pressed={selected} onClick={onSelect}>
      <span className="option-card__icon">
        <Icon name={PRESET_ICON[kind]} size={18} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="option-card__title">{t(`provider.${kind}.label`)}</span>
        <span className="option-card__text">{t(`provider.${kind}.description`)}</span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.375rem' }}>
          {preset.local && <Badge tone="success" icon="lock">{t('provider.badge_local')}</Badge>}
          {preset.needsKey && <Badge tone="neutral" icon="key">{t('provider.badge_key')}</Badge>}
          {kind === 'mock' && <Badge tone="accent">{t('provider.badge_offline')}</Badge>}
        </span>
      </span>
    </button>
  );
}

export function ProviderSetup(props: {
  existing: ProviderView[];
  onDone: (result: ProviderSetupResult) => void | Promise<void>;
  onCancel?: () => void;
  /** Show already-configured providers as choices (onboarding). */
  offerExisting?: boolean;
}): ReactElement {
  const t = useT();
  const { existing, onDone, onCancel, offerExisting = false } = props;
  const [kind, setKind] = useState<ProviderKind | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState('');

  const preset = kind ? PROVIDER_PRESETS[kind] : null;
  const needsBaseUrl = kind === 'ollama' || kind === 'openai-compatible';
  const usable = existing.filter((p) => p.enabled);

  useEffect(() => {
    setApiKey('');
    setShowKey(false);
    setBaseUrl(kind && (kind === 'ollama' || kind === 'openai-compatible') ? (PROVIDER_PRESETS[kind].baseUrl ?? '') : '');
    setLabel('');
    setTest({ state: 'idle' });
    setError(null);
  }, [kind]);

  const draft = useMemo(() => {
    if (!kind) return null;
    const d: { kind: ProviderKind; baseUrl?: string; apiKey?: string } = { kind };
    if (needsBaseUrl && baseUrl.trim()) d.baseUrl = baseUrl.trim();
    if (apiKey.trim()) d.apiKey = apiKey.trim();
    return d;
  }, [kind, needsBaseUrl, baseUrl, apiKey]);

  const missing = !!preset && ((preset.needsKey && !apiKey.trim()) || (needsBaseUrl && !baseUrl.trim()));

  const runTest = async () => {
    if (!draft) return;
    setTest({ state: 'testing' });
    try {
      setTest({ state: 'done', result: await requireClient().providers.testDraft(draft) });
    } catch (err) {
      setTest({ state: 'done', result: { ok: false, latencyMs: 0, error: errorMessage(err, t) } });
    }
  };

  const chooseModel = async (p: ProviderView) => {
    setProvider(p);
    setModels(null);
    const presetModels = PROVIDER_PRESETS[p.kind]?.suggestedModels ?? [];
    let ids: string[] = [];
    try {
      ids = (await loadModels(p.id, true)).filter((m) => !m.capabilities.embeddings || m.capabilities.tools).map((m) => m.id);
    } catch {
      ids = [];
    }
    const all = [...new Set([...(p.defaultModel ? [p.defaultModel] : []), ...ids, ...(ids.length ? [] : presetModels)])];
    setModels(all);
    setModel(p.defaultModel && all.includes(p.defaultModel) ? p.defaultModel : (all[0] ?? ''));
  };

  const create = async () => {
    const epoch = currentSessionEpoch();
    if (!kind || !preset) return;
    setSaving(true);
    setError(null);
    try {
      const existingMock = kind === 'mock' ? existing.find((p) => p.kind === 'mock') : undefined;
      let p: ProviderView;
      if (existingMock) {
        p = existingMock.enabled ? existingMock : await requireClient().providers.update(existingMock.id, { enabled: true });
      } else {
        p = await requireClient().providers.create({
          kind,
          label: label.trim() || preset.label,
          enabled: true,
          ...(needsBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
        });
      }
      if (!isCurrentSession(epoch)) return;
      await loadProviders().catch(() => undefined);
      if (!isCurrentSession(epoch)) return;
      await chooseModel(p);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    const epoch = currentSessionEpoch();
    if (!provider || !model) return;
    setSaving(true);
    try {
      if (provider.defaultModel !== model) {
        await requireClient()
          .providers.update(provider.id, { defaultModel: model })
          .catch(() => undefined);
      }
      if (isCurrentSession(epoch)) await onDone({ provider, model });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  // ── step 3: pick a model ──
  if (provider) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div className="neo-callout" data-tone="success">
          <span className="neo-callout__icon">
            <Icon name="check-circle" size={17} />
          </span>
          <div>
            <p className="neo-callout__title">{t('provider.connected', { name: providerLabel(provider) })}</p>
            <p className="neo-help" style={{ margin: 0 }}>
              {t('provider.pick_model')}
            </p>
          </div>
        </div>
        {models === null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--neo-text-muted)' }}>
            <Spinner size={16} /> {t('provider.loading_models')}
          </div>
        ) : models.length === 0 ? (
          <TextField label={t('provider.model_id')} value={model} onChange={setModel} placeholder="model-name" help={t('provider.model_id_help')} />
        ) : models.length <= 6 ? (
          <div role="radiogroup" aria-label={t('provider.model')} style={{ display: 'grid', gap: '0.5rem' }}>
            {models.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={m === model} className="option-card" onClick={() => setModel(m)} style={{ alignItems: 'center' }}>
                <span className="option-card__icon">
                  <Icon name="cpu" size={16} />
                </span>
                <span className="option-card__title" style={{ fontFamily: 'var(--neo-font-mono)', fontSize: '0.875rem' }}>
                  {m}
                </span>
                {m === provider.defaultModel && <Badge tone="accent">{t('provider.recommended')}</Badge>}
                {m === model && <Icon name="check" size={16} className="option-check" />}
              </button>
            ))}
          </div>
        ) : (
          <Select label={t('provider.model')} value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: m }))} />
        )}
        {error && <p className="neo-error-text" role="alert">{error}</p>}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button variant="primary" icon="check" onClick={() => void finish()} loading={saving} disabled={!model.trim()}>
            {t('provider.use_model')}
          </Button>
          <Button variant="ghost" icon="arrow-left" onClick={() => setProvider(null)} disabled={saving}>
            {t('provider.change')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {offerExisting && usable.length > 0 && (
        <div>
          <p className="group-title">{t('provider.already_set_up')}</p>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {usable.map((p) => (
              <button key={p.id} type="button" className="option-card" onClick={() => void chooseModel(p)} style={{ alignItems: 'center' }}>
                <span className="option-card__icon">
                  <Icon name={PRESET_ICON[p.kind] ?? 'server'} size={18} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="option-card__title">{providerLabel(p)}</span>
                  <span className="option-card__text">{p.defaultModel ?? p.kind}</span>
                </span>
                {p.isLocal && <Badge tone="success" icon="lock">{t('provider.badge_local')}</Badge>}
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
          </div>
          <p className="group-title" style={{ marginTop: '1.25rem' }}>
            {t('provider.add_another')}
          </p>
        </div>
      )}
      <div className="preset-grid" role="list">
        {PRESET_ORDER.map((k) => (
          <div role="listitem" key={k}>
            <PresetCard kind={k} selected={kind === k} onSelect={() => setKind(kind === k ? null : k)} />
          </div>
        ))}
      </div>

      {kind && preset && (
        <section className="neo-card neo-animate-in" aria-label={t(`provider.${kind}.label`)} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {kind === 'mock' ? (
            <p className="neo-help" style={{ margin: 0, fontSize: '0.875rem' }}>
              {t('provider.mock_hint')}
            </p>
          ) : (
            <>
              {kind === 'openai-compatible' && <TextField label={t('provider.name')} value={label} onChange={setLabel} placeholder="LM Studio, OpenRouter…" />}
              {needsBaseUrl && (
                <TextField
                  label={t('provider.base_url')}
                  value={baseUrl}
                  onChange={setBaseUrl}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={preset.baseUrl}
                  help={kind === 'ollama' ? t('provider.ollama_help') : t('provider.compatible_help')}
                />
              )}
              {(preset.needsKey || kind === 'openai-compatible') && (
                <TextField
                  label={preset.needsKey ? t('provider.api_key') : t('provider.api_key_optional')}
                  value={apiKey}
                  onChange={setApiKey}
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={kind === 'anthropic' ? 'sk-ant-…' : kind === 'openai' ? 'sk-…' : ''}
                  help={
                    <>
                      {t('provider.key_private')}
                      {preset.keyUrl && (
                        <>
                          {' '}
                          <button type="button" className="neo-link-btn" style={{ color: 'var(--neo-accent-text)' }} onClick={() => openLink(preset.keyUrl!)}>
                            {t('provider.get_key')}
                          </button>
                        </>
                      )}
                    </>
                  }
                  addon={<IconButton icon={showKey ? 'eye-off' : 'eye'} label={showKey ? t('provider.hide_key') : t('provider.show_key')} size="sm" onClick={() => setShowKey((v) => !v)} />}
                />
              )}
            </>
          )}

          {test.state === 'done' && (
            <div className="neo-callout" data-tone={test.result.ok ? 'success' : 'danger'} role="status">
              <span className="neo-callout__icon">
                <Icon name={test.result.ok ? 'check-circle' : 'alert-circle'} size={17} />
              </span>
              <div>
                <p className="neo-callout__title">{test.result.ok ? t('provider.test_ok') : t('provider.test_failed')}</p>
                <p className="neo-help" style={{ margin: 0 }}>
                  {test.result.ok
                    ? t('provider.test_ok_detail', { ms: test.result.latencyMs, n: test.result.models?.length ?? 0 })
                    : test.result.error ?? t('common.error')}
                </p>
              </div>
            </div>
          )}
          {error && <p className="neo-error-text" role="alert">{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {kind !== 'mock' && (
              <Button variant="secondary" icon="activity" onClick={() => void runTest()} loading={test.state === 'testing'} disabled={missing}>
                {t('provider.test')}
              </Button>
            )}
            <Button variant="primary" iconRight="arrow-right" onClick={() => void create()} loading={saving} disabled={missing}>
              {kind === 'mock' ? t('provider.use_demo') : t('provider.connect')}
            </Button>
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </section>
      )}
      {!kind && onCancel && (
        <div>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
