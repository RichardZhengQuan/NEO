/**
 * AvatarPicker — choose the character and its background, with a live preview.
 */
import { useEffect, useId, useState, type ReactElement } from 'react';
import {
  AVATAR_BACKGROUNDS, AVATAR_CHARACTERS, AVATAR_STATES, DEFAULT_AVATAR,
  normalizeAvatar, parseAvatar, serializeAvatar,
  type AvatarConfig, type AvatarState,
} from './config.js';
import { useAvatarT } from './i18n.js';
import { AvatarStyles, NeoAvatar } from './neo-avatar.js';

export interface AvatarPickerProps {
  /** A config or a stored `neo-avatar:` string; anything else starts from the default. */
  value: AvatarConfig | string | null | undefined;
  /** Receives the string to store in `persona.avatar`, and the config. */
  onChange: (encoded: string, config: AvatarConfig) => void;
  /** Smaller layout for onboarding: the preview cycles through the states by itself. */
  compact?: boolean;
  className?: string;
}

const CYCLE_MS = 2600;

function toConfig(value: AvatarPickerProps['value']): AvatarConfig {
  if (value && typeof value === 'object') return normalizeAvatar(value);
  return parseAvatar(value) ?? { ...DEFAULT_AVATAR };
}

function Swatches(props: {
  label: string;
  value: string;
  options: readonly string[];
  customLabel?: string;
  onPick: (color: string) => void;
}): ReactElement {
  const { label, value, options, customLabel, onPick } = props;
  const id = useId();
  const current = value.toUpperCase();
  const isCustom = !options.includes(current);
  return (
    <div>
      <div className="neo-avp-label" id={id}>{label}</div>
      <div className="neo-avp-swatches" role="radiogroup" aria-labelledby={id}>
        {options.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === current}
            aria-label={c}
            title={c}
            className="neo-avp-swatch"
            style={{ background: c }}
            onClick={() => onPick(c)}
          />
        ))}
        {customLabel && (
          <label className="neo-avp-swatch neo-avp-custom" data-selected={isCustom} title={customLabel}>
            <span className="neo-avp-custom-mark" style={isCustom ? { background: current } : undefined} />
            <input type="color" aria-label={customLabel} value={current.toLowerCase()} onChange={(e) => onPick(e.target.value)} />
          </label>
        )}
      </div>
    </div>
  );
}

export function AvatarPicker({ value, onChange, compact = false, className }: AvatarPickerProps): ReactElement {
  const t = useAvatarT();
  const config = toConfig(value);
  const kindLabelId = useId();
  const [previewState, setPreviewState] = useState<AvatarState>('idle');

  useEffect(() => {
    if (!compact) return;
    const timer = setInterval(() => {
      setPreviewState((s) => AVATAR_STATES[(AVATAR_STATES.indexOf(s) + 1) % AVATAR_STATES.length]!);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [compact]);

  const update = (patch: Partial<AvatarConfig>) => {
    const next = normalizeAvatar({ ...config, ...patch });
    onChange(serializeAvatar(next), next);
  };

  const cls = ['neo-avp', compact ? 'neo-avp--compact' : '', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <AvatarStyles />
      <div className="neo-avp-stage">
        <NeoAvatar avatar={config} state={previewState} size={compact ? 88 : 128} shape="squircle" title={t('avatar.preview')} />
        {!compact && (
          <div className="neo-avp-states">
            {AVATAR_STATES.map((s) => (
              <button key={s} type="button" className="neo-avp-chip" aria-pressed={previewState === s} onClick={() => setPreviewState(s)}>
                {t(`avatar.state.${s}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="neo-avp-controls">
        <div>
          <div className="neo-avp-label" id={kindLabelId}>{t('avatar.character')}</div>
          <div className="neo-avp-kinds" role="radiogroup" aria-labelledby={kindLabelId}>
            {AVATAR_CHARACTERS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={config.kind === kind}
                className="neo-avp-kind"
                onClick={() => update({ kind })}
              >
                <NeoAvatar avatar={{ ...config, kind }} size={compact ? 40 : 48} animated={false} />
                <span>{t(`avatar.kind.${kind}`)}</span>
              </button>
            ))}
          </div>
        </div>
        <Swatches
          label={t('avatar.background')}
          value={config.bg}
          options={AVATAR_BACKGROUNDS}
          customLabel={t('avatar.custom')}
          onPick={(bg) => update({ bg })}
        />
      </div>
    </div>
  );
}
