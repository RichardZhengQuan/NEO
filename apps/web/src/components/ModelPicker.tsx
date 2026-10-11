/**
 * Choose a model: providers as groups, their models as options, plus an
 * optional "default" entry. A native <select> keeps it accessible and
 * thumb-friendly on phones.
 */
import { useEffect, useMemo, type ReactElement } from 'react';
import { PROVIDER_PRESETS, type ModelRef, type ProviderView } from '@neo/protocol';
import { Select, useT, type SelectGroup } from '@neo/ui';
import { loadModels, loadProviders, useSession } from '../state/session.js';

export function providerLabel(p: Pick<ProviderView, 'label' | 'kind' | 'id'> | undefined): string {
  if (!p) return '';
  return p.label || PROVIDER_PRESETS[p.kind]?.label || p.id;
}

/** "Anthropic Claude · claude-sonnet-5-5" for a model ref. */
export function useModelLabel(ref: ModelRef | null | undefined): string {
  const providers = useSession((s) => s.providers);
  if (!ref) return '';
  const p = providers?.items.find((x) => x.id === ref.provider);
  return `${p ? providerLabel(p) : ref.provider} · ${ref.model}`;
}

const SEP = '::';
const encode = (ref: ModelRef) => `${ref.provider}${SEP}${ref.model}`;
function decode(value: string): ModelRef | null {
  const i = value.indexOf(SEP);
  return i > 0 ? { provider: value.slice(0, i), model: value.slice(i + SEP.length) } : null;
}

export function ModelPicker(props: {
  value: ModelRef | null;
  onChange: (value: ModelRef | null) => void;
  /** Label for the null option, e.g. "Default (…)"; omit to require a model. */
  defaultLabel?: string;
  label?: string;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  /** Only providers/models usable for embeddings etc. */
  filter?: (p: ProviderView) => boolean;
  help?: string;
  disabled?: boolean;
  className?: string;
}): ReactElement {
  const t = useT();
  const providers = useSession((s) => s.providers);
  const models = useSession((s) => s.models);
  const { value, onChange, defaultLabel, label, ariaLabel, size = 'md', filter, help, disabled, className } = props;

  useEffect(() => {
    if (!providers) void loadProviders().catch(() => undefined);
  }, [providers]);

  const enabled = useMemo(() => (providers?.items ?? []).filter((p) => p.enabled && (!filter || filter(p))), [providers, filter]);

  useEffect(() => {
    for (const p of enabled) if (!models[p.id]) void loadModels(p.id);
  }, [enabled, models]);

  const groups: SelectGroup[] = enabled.map((p) => {
    const ids = new Set<string>([...(models[p.id]?.map((m) => m.id) ?? []), ...(p.models ?? []), ...(p.defaultModel ? [p.defaultModel] : [])]);
    if (value?.provider === p.id) ids.add(value.model);
    return {
      label: providerLabel(p),
      options: [...ids].sort((a, b) => (a === p.defaultModel ? -1 : b === p.defaultModel ? 1 : a.localeCompare(b))).map((id) => ({ value: encode({ provider: p.id, model: id }), label: id })),
    };
  });
  // Keep an unknown current value selectable (e.g. its provider was disabled).
  if (value && !groups.some((g) => g.options.some((o) => o.value === encode(value)))) {
    groups.push({ label: t('model.unavailable'), options: [{ value: encode(value), label: `${value.provider} · ${value.model}` }] });
  }
  const options = defaultLabel !== undefined ? [{ value: 'default', label: defaultLabel }] : value ? [] : [{ value: '', label: t('model.choose'), disabled: true }];

  return (
    <Select
      className={className}
      label={label}
      ariaLabel={ariaLabel ?? label ?? t('model.label')}
      size={size}
      help={help}
      disabled={disabled || !providers}
      value={value ? encode(value) : defaultLabel !== undefined ? 'default' : ''}
      onChange={(v) => onChange(v === 'default' ? null : decode(v))}
      options={options}
      groups={groups}
    />
  );
}
