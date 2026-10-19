import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';
import {
  DEFAULT_AVATAR, normalizeAvatar, parseAvatar,
  type AvatarCharacter, type AvatarConfig,
} from './config.js';
import { useAvatarT } from './i18n.js';
import { NeoAvatar } from './neo-avatar.js';

export type NeoFigureVariant = 'color' | 'ink' | 'glitch';

const FIGURE_URLS: Record<AvatarCharacter, Record<'color' | 'ink', string>> = {
  robot: {
    color: new URL('../../assets/avatar-figures/robot.webp', import.meta.url).href,
    ink: new URL('../../assets/avatar-figures/robot-ink.webp', import.meta.url).href,
  },
  cat: {
    color: new URL('../../assets/avatar-figures/cat.webp', import.meta.url).href,
    ink: new URL('../../assets/avatar-figures/cat-ink.webp', import.meta.url).href,
  },
  dog: {
    color: new URL('../../assets/avatar-figures/dog.webp', import.meta.url).href,
    ink: new URL('../../assets/avatar-figures/dog-ink.webp', import.meta.url).href,
  },
  boy: {
    color: new URL('../../assets/avatar-figures/boy.webp', import.meta.url).href,
    ink: new URL('../../assets/avatar-figures/boy-ink.webp', import.meta.url).href,
  },
  girl: {
    color: new URL('../../assets/avatar-figures/girl.webp', import.meta.url).href,
    ink: new URL('../../assets/avatar-figures/girl-ink.webp', import.meta.url).href,
  },
};

const BURST_MS = 480;
/** Delays before re-requesting a figure that failed to load; the last one repeats. */
const RETRY_MS = [1000, 3000, 10000, 30000];

const FIGURE_CSS = `
.neo-avfig{position:relative;display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;line-height:0;vertical-align:middle}
.neo-avfig>img{display:block;width:100%;height:100%;object-fit:contain}
.neo-avfig>img[hidden]{display:none}
.neo-avfig>.neo-avfig__ink{position:absolute;inset:0;opacity:0;pointer-events:none}
.neo-avfig>.neo-av{width:min(100%,22rem)!important;height:auto!important;aspect-ratio:1}
.neo-avfig[data-glitch]{animation:neo-avfig-shake ${BURST_MS}ms steps(1,end)}
.neo-avfig[data-glitch]>.neo-avfig__ink{animation:neo-avfig-slices ${BURST_MS}ms steps(1,end)}
.neo-avfig[data-glitch]::after{content:'';position:absolute;inset:0;opacity:0;pointer-events:none;background:#E5504A;mask:var(--neo-avfig-ink) center/contain no-repeat;animation:neo-avfig-register ${BURST_MS}ms steps(1,end)}
@keyframes neo-avfig-shake{
  0%,92%,100%{transform:none}
  8%,42%{transform:translate(-3px,1px)}
  18%,66%{transform:translate(3px,-2px)}
  30%,78%{transform:translate(-2px,-1px)}
  54%,86%{transform:translate(2px,2px)}
}
@keyframes neo-avfig-slices{
  0%,92%,100%{opacity:0;transform:none;clip-path:inset(0)}
  8%,54%{opacity:1;transform:translateX(3px);clip-path:polygon(0 12%,100% 12%,100% 22%,0 22%,0 44%,100% 44%,100% 54%,0 54%,0 74%,100% 74%,100% 83%,0 83%)}
  18%,78%{opacity:1;transform:translateX(-4px);clip-path:polygon(0 6%,100% 6%,100% 14%,0 14%,0 32%,100% 32%,100% 42%,0 42%,0 60%,100% 60%,100% 67%,0 67%,0 88%,100% 88%,100% 94%,0 94%)}
  30%,86%{opacity:1;transform:translateX(2px);clip-path:polygon(0 24%,100% 24%,100% 36%,0 36%,0 64%,100% 64%,100% 76%,0 76%)}
  42%,66%{opacity:1;transform:none;clip-path:inset(0)}
}
@keyframes neo-avfig-register{
  0%,18%,42%,66%,86%,100%{opacity:0;transform:none}
  8%,54%{opacity:.7;transform:translate(3px,2px)}
  30%,78%{opacity:.6;transform:translate(-3px,-2px)}
}
@media(prefers-reduced-motion:reduce){
  .neo-avfig[data-glitch]{animation:none}
  .neo-avfig[data-glitch]>.neo-avfig__ink,.neo-avfig[data-glitch]::after{animation:none;opacity:0}
}
`;

function subscribeReducedMotion(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function readReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

function useFigureGlitch(kind: AvatarCharacter, mode: boolean, ready: boolean, glitchTrigger?: number): { glitching: boolean; trigger: () => void } {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
  const [glitching, setGlitching] = useState(false);
  const previousKind = useRef(kind);
  const previousTrigger = useRef(glitchTrigger);
  const pending = useRef(false);
  const burst = useRef(() => {});

  useEffect(() => {
    if (previousKind.current !== kind) {
      previousKind.current = kind;
      pending.current = true;
    }
    burst.current = () => {};
    setGlitching(false);
    if (!mode || reducedMotion) {
      pending.current = false;
      return;
    }
    if (!ready) {
      burst.current = () => { if (!document.hidden) pending.current = true; };
      return;
    }

    let nextTimer: ReturnType<typeof setTimeout> | undefined;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(nextTimer);
      clearTimeout(endTimer);
      nextTimer = endTimer = undefined;
    };
    const schedule = () => { nextTimer = setTimeout(start, 4000 + Math.random() * 4000); };
    const start = () => {
      if (document.hidden || endTimer !== undefined) return;
      clearTimeout(nextTimer);
      pending.current = false;
      setGlitching(true);
      endTimer = setTimeout(() => {
        endTimer = undefined;
        setGlitching(false);
      }, BURST_MS);
      schedule();
    };
    const visibility = () => {
      clear();
      setGlitching(false);
      if (!document.hidden) {
        if (pending.current) start();
        else schedule();
      }
    };
    burst.current = start;
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => {
      clear();
      burst.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [kind, mode, ready, reducedMotion]);

  useEffect(() => {
    if (previousTrigger.current === glitchTrigger) return;
    previousTrigger.current = glitchTrigger;
    if (glitchTrigger !== undefined) burst.current();
  }, [glitchTrigger]);

  return { glitching: mode && ready && !reducedMotion && glitching, trigger: () => burst.current() };
}

export interface NeoFigureProps {
  /** Overrides the character in avatar, retaining its portrait background. */
  kind?: AvatarCharacter;
  /** A config or stored avatar string; anything else uses the default robot. */
  avatar?: AvatarConfig | string | null;
  /** Flat ink artwork, or colour with occasional ink glitch bursts. */
  variant?: NeoFigureVariant;
  /** Changing this value requests one burst, after the artwork is ready. */
  glitchTrigger?: number;
  className?: string;
  style?: CSSProperties;
}

function FigureImage({ avatar, title, variant, onReady, onUnavailable }: {
  avatar: AvatarConfig;
  title: string;
  variant: NeoFigureVariant;
  onReady: () => void;
  onUnavailable: () => void;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [inkFailed, setInkFailed] = useState(false);
  const [retries, setRetries] = useState(0);
  const [probing, setProbing] = useState(false);
  const src = FIGURE_URLS[avatar.kind][variant === 'ink' ? 'ink' : 'color'];

  // A failed load is often transient (a rebuild replacing the asset, a dropped
  // connection), so keep probing in the background and return to the figure.
  useEffect(() => {
    if (!failed || probing) return;
    const probe = () => setProbing(true);
    const timer = setTimeout(probe, RETRY_MS[retries] ?? RETRY_MS[RETRY_MS.length - 1]);
    window.addEventListener('online', probe);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', probe);
    };
  }, [failed, probing, retries]);

  if (failed) return (
    <>
      <NeoAvatar avatar={avatar} title={title} animated={false} shape="squircle" className="neo-avfig__portrait" />
      {probing && (
        <img
          key={retries}
          src={src}
          alt=""
          hidden
          aria-hidden="true"
          loading="eager"
          decoding="async"
          onLoad={() => { setProbing(false); setRetries(0); setFailed(false); }}
          onError={() => { setProbing(false); setRetries((n) => n + 1); }}
        />
      )}
    </>
  );
  return (
    <>
      <img
        src={src}
        alt={title}
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => { setFailed(true); onUnavailable(); }}
      />
      {variant === 'glitch' && loaded && !inkFailed && (
        <img
          className="neo-avfig__ink"
          src={FIGURE_URLS[avatar.kind].ink}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
          draggable={false}
          onLoad={onReady}
          onError={() => { setInkFailed(true); onUnavailable(); }}
        />
      )}
    </>
  );
}

export function NeoFigure({ kind, avatar, variant = 'color', glitchTrigger, className, style }: NeoFigureProps): ReactElement {
  const t = useAvatarT();
  const stored = typeof avatar === 'object' && avatar
    ? normalizeAvatar(avatar)
    : parseAvatar(avatar) ?? DEFAULT_AVATAR;
  const config = normalizeAvatar({ ...stored, ...(kind ? { kind } : {}) });
  const imageKey = `${config.kind}-${variant}`;
  const image = useMemo(() => ({ key: imageKey }), [imageKey]);
  const [readyFor, setReadyFor] = useState<typeof image | null>(null);
  const onReady = useCallback(() => setReadyFor(image), [image]);
  const onUnavailable = useCallback(() => setReadyFor(null), []);
  const { glitching, trigger } = useFigureGlitch(config.kind, variant === 'glitch', readyFor === image, glitchTrigger);
  const figureStyle = variant === 'glitch'
    ? { ...style, '--neo-avfig-ink': `url("${FIGURE_URLS[config.kind].ink}")` } as CSSProperties
    : style;
  return (
    <span
      className={['neo-avfig', className].filter(Boolean).join(' ')}
      style={figureStyle}
      data-kind={config.kind}
      data-variant={variant}
      data-glitch={glitching ? 'true' : undefined}
      onMouseEnter={variant === 'glitch' ? trigger : undefined}
      onPointerDown={variant === 'glitch' ? trigger : undefined}
    >
      <style href="neo-avfig" precedence="neo">{FIGURE_CSS}</style>
      <FigureImage key={imageKey} avatar={config} title={t(`avatar.kind.${config.kind}`)} variant={variant} onReady={onReady} onUnavailable={onUnavailable} />
    </span>
  );
}
