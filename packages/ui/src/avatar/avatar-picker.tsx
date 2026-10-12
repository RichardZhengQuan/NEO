/**
 * AvatarPicker — choose the character and its background, with a live preview.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from 'react';
import {
  AVATAR_BACKGROUNDS, AVATAR_CHARACTERS, AVATAR_STATES, DEFAULT_AVATAR,
  normalizeAvatar, parseAvatar, serializeAvatar,
  type AvatarConfig, type AvatarState,
} from './config.js';
import { useAvatarT } from './i18n.js';
import { AvatarStyles, NeoAvatar } from './neo-avatar.js';
import { useAvatarOrbit } from './use-avatar-orbit.js';

export interface AvatarPickerProps {
  /** A config or a stored `neo-avatar:` string; anything else starts from the default. */
  value: AvatarConfig | string | null | undefined;
  /** Receives the string to store in `persona.avatar`, and the config. */
  onChange: (encoded: string, config: AvatarConfig) => void;
  /** Smaller layout for onboarding: the preview cycles through the states by itself. */
  compact?: boolean;
  /** A large preview that speaks on character picks; takes precedence over compact. */
  size?: 'default' | 'hero';
  /** Character-only orbit controls can be placed around a figure, without a second preview. */
  layout?: 'default' | 'orbit';
  /** The figure frame and the stage sharing the orbit's coordinate space. */
  orbitFrameRef?: RefObject<HTMLElement | null>;
  orbitAreaRef?: RefObject<HTMLElement | null>;
  /** A neighbouring desktop panel the orbit targets must clear by 24px. */
  orbitClearanceRef?: RefObject<HTMLElement | null>;
  reducedMotion?: boolean;
  children?: (slots: AvatarPickerSlots) => ReactNode;
  className?: string;
}

export interface AvatarPickerSlots {
  characters: ReactElement;
}

const CYCLE_MS = 2600;
const SPEAK_MS = 1200;

function toConfig(value: AvatarPickerProps['value']): AvatarConfig {
  if (value && typeof value === 'object') return normalizeAvatar(value);
  return parseAvatar(value) ?? { ...DEFAULT_AVATAR };
}

function nextRadioIndex(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (index + 1) % count;
    case 'ArrowLeft': case 'ArrowUp': return (index + count - 1) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return undefined;
  }
}

/** Entry/exit motion stays inside the node positioned by the orbit frame loop. */
function OrbitVisual({ index, children }: { index: number; children?: ReactNode }): ReactElement {
  return <span className="neo-avp-orbit-visual" aria-hidden="true" style={{ '--neo-avp-orbit-stagger': `${index * 40}ms` } as CSSProperties}>{children}</span>;
}

function Swatches(props: {
  label: string;
  value: string;
  options: readonly string[];
  customLabel?: string;
  hero?: boolean;
  onPick: (color: string) => void;
}): ReactElement {
  const { label, value, options, customLabel, hero, onPick } = props;
  const id = useId();
  const current = value.toUpperCase();
  const isCustom = !options.includes(current);
  const [customSelected, setCustomSelected] = useState(isCustom);
  const managed = hero;
  const selectedCustom = isCustom || customSelected;
  useEffect(() => { setCustomSelected(!options.includes(current)); }, [current, options]);

  const pick = (index: number) => {
    const custom = index === options.length;
    setCustomSelected(custom);
    onPick(custom ? current : options[index]!);
  };

  return (
    <div className="neo-avp-color-choices">
      <div className="neo-avp-label" id={id}>{label}</div>
      <div
        className="neo-avp-swatches"
        role="radiogroup"
        aria-labelledby={id}
        style={hero ? { gap: 12 } : undefined}
        onKeyDown={managed ? (e) => {
          const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
          const index = Array.from(radios).indexOf(e.target as HTMLElement);
          if (index < 0) return;
          const nextIndex = nextRadioIndex(e.key, index, radios.length);
          if (nextIndex === undefined) return;
          e.preventDefault();
          pick(nextIndex);
          radios[nextIndex]?.focus();
        } : undefined}
      >
        {options.map((c, index) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === current && !selectedCustom}
            aria-label={c}
            title={c}
            className="neo-avp-swatch"
            tabIndex={managed ? c === current && !selectedCustom ? 0 : -1 : undefined}
            style={{ background: c, ...(hero ? { width: 32, height: 32 } : {}) }}
            onClick={() => pick(index)}
          />
        ))}
        {customLabel && (
          <label className="neo-avp-swatch neo-avp-custom" data-selected={selectedCustom} title={customLabel} style={hero ? { width: 32, height: 32 } : undefined}>
            <span className="neo-avp-custom-mark" style={selectedCustom ? { background: current } : undefined} />
            <input
              type="color"
              role="radio"
              aria-checked={selectedCustom}
              aria-label={customLabel}
              title={customLabel}
              tabIndex={managed ? selectedCustom ? 0 : -1 : undefined}
              value={current.toLowerCase()}
              onClick={() => { setCustomSelected(true); }}
              onChange={(e) => { setCustomSelected(true); onPick(e.target.value); }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

export function AvatarPicker({ value, onChange, compact = false, size = 'default', layout = 'default', orbitFrameRef, orbitAreaRef, orbitClearanceRef, reducedMotion, children, className }: AvatarPickerProps): ReactElement {
  const t = useAvatarT();
  const config = toConfig(value);
  const kindLabelId = useId();
  const hero = size === 'hero';
  const orbit = layout === 'orbit';
  const { rootRef, selectOrbit } = useAvatarOrbit({ enabled: orbit, frameRef: orbitFrameRef, areaRef: orbitAreaRef, clearanceRef: orbitClearanceRef, reducedMotion });
  const [previewState, setPreviewState] = useState<AvatarState>('idle');
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!compact || hero || orbit) return;
    const timer = setInterval(() => {
      setPreviewState((s) => AVATAR_STATES[(AVATAR_STATES.indexOf(s) + 1) % AVATAR_STATES.length]!);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [compact, hero, orbit]);

  useEffect(() => () => {
    if (speakTimer.current !== null) clearTimeout(speakTimer.current);
  }, []);

  const update = (patch: Partial<AvatarConfig>) => {
    const next = normalizeAvatar({ ...config, ...patch });
    if (hero && !orbit && next.kind !== config.kind) {
      if (speakTimer.current !== null) clearTimeout(speakTimer.current);
      setPreviewState('speaking');
      speakTimer.current = setTimeout(() => {
        setPreviewState('idle');
        speakTimer.current = null;
      }, SPEAK_MS);
    }
    onChange(serializeAvatar(next), next);
  };

  const characters = (
    <div className="neo-avp-character-choices">
      <div className="neo-avp-label" id={kindLabelId}>{t('avatar.character')}</div>
      <div className="neo-avp-kinds" role="radiogroup" aria-labelledby={kindLabelId} style={hero && !orbit ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: 10 } : undefined}>
        {AVATAR_CHARACTERS.map((kind, index) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={config.kind === kind}
            aria-label={hero || orbit ? t(`avatar.kind.${kind}`) : undefined}
            title={hero || orbit ? t(`avatar.kind.${kind}`) : undefined}
            tabIndex={hero || orbit ? config.kind === kind ? 0 : -1 : undefined}
            className={orbit ? 'neo-avp-kind neo-avp-orbit-node neo-avp-orbit-circle' : 'neo-avp-kind'}
            data-orbit={orbit ? 'portrait' : undefined}
            data-orbit-index={orbit ? index : undefined}
            data-orbit-shape={orbit ? 'circle' : undefined}
            style={hero && !orbit ? { padding: 8, borderRadius: 20 } : undefined}
            onClick={() => { if (orbit) selectOrbit(index); update({ kind }); }}
            onKeyDown={hero || orbit ? (e) => {
              if (orbit && e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
                return;
              }
              const nextIndex = nextRadioIndex(e.key, index, AVATAR_CHARACTERS.length);
              if (nextIndex === undefined) return;
              e.preventDefault();
              if (orbit) selectOrbit(nextIndex);
              update({ kind: AVATAR_CHARACTERS[nextIndex]! });
              e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
            } : undefined}
          >
            {orbit ? (
              <OrbitVisual index={index}>
                <NeoAvatar avatar={{ ...config, kind }} size={60} animated={false} />
              </OrbitVisual>
            ) : <NeoAvatar avatar={{ ...config, kind }} size={hero ? 64 : compact ? 40 : 48} animated={false} />}
            {!hero && !orbit && <span>{t(`avatar.kind.${kind}`)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
  const colors = (
    <Swatches
      label={t('avatar.background')}
      value={config.bg}
      options={AVATAR_BACKGROUNDS}
      customLabel={t('avatar.custom')}
      hero={hero}
      onPick={(bg) => update({ bg })}
    />
  );
  const cls = ['neo-avp', orbit ? 'neo-avp--orbit' : compact && !hero ? 'neo-avp--compact' : '', className ?? ''].filter(Boolean).join(' ');

  if (orbit) return (
    <div className={cls} ref={rootRef}>
      <AvatarStyles />
      <div className="neo-avp-orbit-area" data-orbit-area="" aria-hidden="true" />
      {(['back', 'front'] as const).map((half) => (
        <svg key={half} className={`neo-avp-orbit-path neo-avp-orbit-path--${half}`} data-orbit-path={`portrait-${half}`} aria-hidden="true" focusable="false"><path /></svg>
      ))}
      {children ? children({ characters }) : characters}
    </div>
  );

  return (
    <div className={cls} style={hero ? { flexDirection: 'column', alignItems: 'stretch', gap: 24 } : undefined}>
      <AvatarStyles />
      <div className="neo-avp-stage">
        <NeoAvatar avatar={config} state={previewState} size={hero ? 176 : compact ? 88 : 128} shape="squircle" title={t('avatar.preview')} />
        {!compact && !hero && (
          <div className="neo-avp-states">
            {AVATAR_STATES.map((s) => (
              <button key={s} type="button" className="neo-avp-chip" aria-pressed={previewState === s} onClick={() => setPreviewState(s)}>
                {t(`avatar.state.${s}`)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="neo-avp-controls" style={hero ? { flex: 'none', gap: 18 } : undefined}>
        {characters}
        {colors}
      </div>
    </div>
  );
}
