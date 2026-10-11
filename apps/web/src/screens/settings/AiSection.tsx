/**
 * Settings → AI & models: providers (add, test, enable, edit, remove), the
 * default / memory / embedding models, and agent behaviour.
 */
import { useState, type ReactElement } from 'react';
import { PROVIDER_PRESETS, type AgentSettings, type ModelRef, type ProviderView } from '@neo/protocol';
import { Badge, Button, Icon, Modal, SegmentedControl, Select, Switch, TextField, useConfirm, useT, type TranslateFn } from '@neo/ui';
import { ModelPicker, providerLabel } from '../../components/ModelPicker.js';
import { Menu } from '../../components/Menu.js';
import { PRESET_ICON, ProviderSetup } from '../../components/ProviderSetup.js';
import { errorMessage, httpStatus } from '../../lib/errors.js';
import { pushToast } from '../../state/notifications.js';
import { currentSessionEpoch, isCurrentSession, loadModels, loadProviders, requireClient, updateSettings, useSession } from '../../state/session.js';
import { Section, SettingRow } from './common.js';

function reportProviderError(err: unknown, t: TranslateFn): void {
  pushToast({ tone: 'error', title: httpStatus(err) === 409 ? t('ai.config_file') : errorMessage(err, t) });
}

function ProviderEditor({ provider, onClose }: { provider: ProviderView; onClose: () => void }): ReactElement {
  const t = useT();
  const [label, setLabel] = useState(provider.label ?? '');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const epoch = currentSessionEpoch();
    setSaving(true);
    try {
      await requireClient().providers.update(provider.id, {
        label: label.trim() || undefined,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
      });
      if (!isCurrentSession(epoch)) return;
      await loadProviders();
      if (!isCurrentSession(epoch)) return;
      void loadModels(provider.id, true);
      pushToast({ tone: 'success', title: t('ai.provider_saved') });
      onClose();
    } catch (err) {
      reportProviderError(err, t);
    } finally {
      setSaving(false);
    }
  };
  const editableUrl = provider.kind === 'ollama' || provider.kind === 'openai-compatible' || Boolean(provider.baseUrl);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('ai.edit_provider', { name: providerLabel(provider) })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <TextField label={t('provider.name')} value={label} onChange={setLabel} placeholder={PROVIDER_PRESETS[provider.kind]?.label} maxLength={100} />
        {editableUrl && <TextField label={t('provider.base_url')} value={baseUrl} onChange={setBaseUrl} type="url" spellCheck={false} />}
        {provider.kind !== 'mock' && (
          <TextField
            label={t('ai.replace_key')}
            value={apiKey}
            onChange={setApiKey}
            type="password"
            autoComplete="off"
            help={provider.hasApiKey ? t('ai.key_saved_help') : t('ai.no_key_help')}
          />
        )}
        <TextField label={t('ai.provider_default_model')} value={defaultModel} onChange={setDefaultModel} spellCheck={false} />
      </div>
    </Modal>
  );
}

function ProviderRow({ provider }: { provider: ProviderView }): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      const r = await requireClient().providers.test(provider.id);
      pushToast(r.ok ? { tone: 'success', title: t('provider.test_ok'), body: t('provider.test_ok_detail', { ms: r.latencyMs, n: r.models?.length ?? 0 }) } : { tone: 'error', title: t('provider.test_failed'), body: r.error });
    } catch (err) {
      reportProviderError(err, t);
    } finally {
      setTesting(false);
    }
  };
  const setEnabled = async (enabled: boolean) => {
    const epoch = currentSessionEpoch();
    try {
      await requireClient().providers.update(provider.id, { enabled });
      if (isCurrentSession(epoch)) await loadProviders();
    } catch (err) {
      reportProviderError(err, t);
    }
  };
  const remove = async () => {
    const epoch = currentSessionEpoch();
    const ok = await confirm({ title: t('ai.remove_title'), message: t('ai.remove_text', { name: providerLabel(provider) }), confirmLabel: t('common.remove'), danger: true });
    if (!ok || !isCurrentSession(epoch)) return;
    try {
      await requireClient().providers.delete(provider.id);
      if (!isCurrentSession(epoch)) return;
      await loadProviders();
      if (!isCurrentSession(epoch)) return;
      const settings = await requireClient().settings.get();
      if (isCurrentSession(epoch)) useSession.setState({ settings });
    } catch (err) {
      reportProviderError(err, t);
    }
  };
  return (
    <li className="row">
      <span className="neo-card__icon">
        <Icon name={PRESET_ICON[provider.kind] ?? 'server'} size={17} />
      </span>
      <div className="row__main">
        <div className="row__title">{providerLabel(provider)}</div>
        <div className="row__meta">
          <span style={{ fontFamily: 'var(--neo-font-mono)', fontSize: '0.75rem' }}>{provider.id}</span>
          {provider.defaultModel && <span>{provider.defaultModel}</span>}
          {provider.isLocal && <Badge tone="success" icon="lock">{t('provider.badge_local')}</Badge>}
          {provider.hasApiKey && <Badge tone="neutral" icon="key">{t('ai.key_saved')}</Badge>}
        </div>
      </div>
      <Switch checked={provider.enabled} onChange={(v) => void setEnabled(v)} ariaLabel={t('ai.enabled', { name: providerLabel(provider) })} />
      <Menu
        label={t('ai.provider_actions', { name: providerLabel(provider) })}
        items={[
          { label: testing ? t('provider.testing') : t('provider.test'), icon: 'activity', onSelect: () => void test() },
          { label: t('common.edit'), icon: 'edit', onSelect: () => setEditing(true) },
          { label: t('common.remove'), icon: 'trash', danger: true, separated: true, onSelect: () => void remove() },
        ]}
      />
      {editing && <ProviderEditor provider={provider} onClose={() => setEditing(false)} />}
    </li>
  );
}

const EMBEDDING_KINDS = new Set(['openai', 'gemini', 'ollama', 'openai-compatible']);

function EmbeddingSetting(): ReactElement {
  const t = useT();
  const providers = useSession((s) => s.providers);
  const current = useSession((s) => s.settings?.embedding ?? null);
  const candidates = (providers?.items ?? []).filter((p) => p.enabled && EMBEDDING_KINDS.has(p.kind));
  const [provider, setProvider] = useState(current?.provider ?? 'builtin');
  const [model, setModel] = useState(current?.model ?? '');
  const [saving, setSaving] = useState(false);
  const selected = candidates.find((p) => p.id === provider);
  const dirty = (current?.provider ?? 'builtin') !== provider || (current?.model ?? '') !== model;
  const save = async () => {
    setSaving(true);
    try {
      await updateSettings({ embedding: provider === 'builtin' ? null : { provider, model: model.trim() } });
      pushToast({ tone: 'success', title: t('ai.embedding_saved') });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
        <Select
          label={t('ai.embedding_provider')}
          value={provider}
          onChange={(v) => {
            setProvider(v);
            const p = candidates.find((x) => x.id === v);
            setModel(p ? (PROVIDER_PRESETS[p.kind]?.embeddingModel ?? '') : '');
          }}
          options={[{ value: 'builtin', label: t('ai.embedding_builtin') }, ...candidates.map((p) => ({ value: p.id, label: providerLabel(p) }))]}
        />
        {selected && <TextField label={t('ai.embedding_model')} value={model} onChange={setModel} spellCheck={false} placeholder={PROVIDER_PRESETS[selected.kind]?.embeddingModel} />}
      </div>
      <p className="neo-help" style={{ margin: 0 }}>
        {t('ai.embedding_help')}
      </p>
      {dirty && (
        <div>
          <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={provider !== 'builtin' && !model.trim()}>
            {t('ai.embedding_apply')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function AiSection(): ReactElement {
  const t = useT();
  const providers = useSession((s) => s.providers);
  const settings = useSession((s) => s.settings!);
  const [adding, setAdding] = useState(false);

  const setModel = async (key: 'defaultModel' | 'memoryModel', ref: ModelRef | null) => {
    try {
      await updateSettings({ [key]: ref });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };
  const setAgent = async (patch: Partial<AgentSettings>) => {
    try {
      await updateSettings({ agent: patch });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  return (
    <>
      <Section
        title={t('ai.providers')}
        description={t('ai.providers_help')}
        actions={
          <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
            {t('ai.add_provider')}
          </Button>
        }
      >
        {providers && providers.items.length > 0 ? (
          <ul className="row-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {providers.items.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </ul>
        ) : (
          <p className="neo-help">{t('ai.no_providers')}</p>
        )}
      </Section>

      <Section title={t('ai.models')} description={t('ai.models_help')}>
        <div className="neo-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <ModelPicker label={t('ai.default_model')} value={settings.defaultModel} onChange={(v) => void setModel('defaultModel', v)} help={t('ai.default_model_help')} />
          <ModelPicker label={t('ai.memory_model')} value={settings.memoryModel} onChange={(v) => void setModel('memoryModel', v)} defaultLabel={t('ai.same_as_default')} help={t('ai.memory_model_help')} />
          <div>
            <div className="neo-label" style={{ marginBottom: '0.5rem' }}>
              {t('ai.embedding')}
            </div>
            <EmbeddingSetting />
          </div>
        </div>
      </Section>

      <Section title={t('ai.behaviour')} description={t('ai.behaviour_help')}>
        <div className="neo-card">
          <SettingRow label={t('ai.reasoning')} help={t('ai.reasoning_help')} stack>
            <SegmentedControl
              label={t('ai.reasoning')}
              value={settings.agent.reasoning}
              onChange={(v) => void setAgent({ reasoning: v })}
              options={(['off', 'low', 'medium', 'high'] as const).map((v) => ({ value: v, label: t(`ai.reasoning_${v}`) }))}
            />
          </SettingRow>
          <SettingRow label={t('ai.max_steps')} help={t('ai.max_steps_help')}>
            <Select size="sm" ariaLabel={t('ai.max_steps')} value={String(settings.agent.maxSteps)} onChange={(v) => void setAgent({ maxSteps: Number(v) })} options={[4, 8, 12, 16, 24, 32].map((n) => ({ value: String(n), label: String(n) }))} />
          </SettingRow>
          <SettingRow label={t('ai.confirm_timeout')} help={t('ai.confirm_timeout_help')}>
            <Select
              size="sm"
              ariaLabel={t('ai.confirm_timeout')}
              value={String(settings.agent.confirmationTimeoutSec)}
              onChange={(v) => void setAgent({ confirmationTimeoutSec: Number(v) })}
              options={[60, 120, 300, 900, 3600].map((s) => ({ value: String(s), label: t('ai.minutes', { n: Math.round(s / 60) }) }))}
            />
          </SettingRow>
          <SettingRow label={t('ai.auto_title')} help={t('ai.auto_title_help')}>
            <Switch checked={settings.agent.autoTitle} onChange={(v) => void setAgent({ autoTitle: v })} ariaLabel={t('ai.auto_title')} />
          </SettingRow>
        </div>
      </Section>

      <Modal open={adding} onClose={() => setAdding(false)} title={t('ai.add_provider')} size="lg">
        {adding && (
          <ProviderSetup
            existing={providers?.items ?? []}
            onCancel={() => setAdding(false)}
            onDone={async ({ provider, model }) => {
              if (!settings.defaultModel) await updateSettings({ defaultModel: { provider: provider.id, model } });
              pushToast({ tone: 'success', title: t('onboarding.ai.saved', { name: providerLabel(provider) }) });
              setAdding(false);
            }}
          />
        )}
      </Modal>
    </>
  );
}
