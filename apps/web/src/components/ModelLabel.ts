/** Shared provider and model labels for setup screens. */
import { PROVIDER_PRESETS, type ModelRef, type ProviderView } from '@neo/protocol';
import { useSession } from '../state/session.js';

export function providerLabel(p: Pick<ProviderView, 'label' | 'kind' | 'id'> | undefined): string {
  if (!p) return '';
  return p.label || PROVIDER_PRESETS[p.kind]?.label || p.id;
}

/** "Anthropic Claude · claude-sonnet-5-5" for a model ref. */
export function useModelLabel(ref: ModelRef | null | undefined): string {
  const providers = useSession((s) => s.providers);
  if (!ref) return '';
  const p = providers?.items.find((x) => x.id === ref.provider);
  if (p?.kind === 'mock') return '';
  return `${p ? providerLabel(p) : ref.provider} · ${ref.model}`;
}

