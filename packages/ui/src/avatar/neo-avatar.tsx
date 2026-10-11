/**
 * NeoAvatar — the assistant's animated character: a painted portrait on the
 * chosen background, brought to life with SVG overlays and CSS (breathing,
 * blinking, leaning in, a talking mouth, thought bubble and alert marks).
 */
import type { CSSProperties, ReactElement } from 'react';
import { PORTRAIT_ART, type FlapMouth } from './art.js';
import {
  DEFAULT_AVATAR, luminance, normalizeAvatar, parseAvatar,
  type AvatarConfig, type AvatarState,
} from './config.js';
import { PORTRAITS } from './portraits.data.js';
import { AVATAR_CSS } from './styles.js';

export type AvatarShape = 'circle' | 'squircle' | 'square';

export interface NeoAvatarProps {
  /**
   * A config, a stored `neo-avatar:` string, a legacy emoji or image URL, or
   * null/undefined for the default robot.
   */
  avatar?: AvatarConfig | string | null;
  state?: AvatarState;
  /** Pixels, or any CSS length. */
  size?: number | string;
  shape?: AvatarShape;
  /** false renders a still frame (the state still shows as a pose). */
  animated?: boolean;
  /** Accessible name; without it the avatar is decorative. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/** Injects the avatar stylesheet once; React hoists and de-duplicates it. */
export function AvatarStyles(): ReactElement {
  return <style href="neo-avatar" precedence="neo">{AVATAR_CSS}</style>;
}

function isImageUrl(v: string): boolean {
  return /^(https?:|data:image\/|blob:|\/)/i.test(v);
}

const INK = '#2E3038';
const BUBBLE = '#FBFAF7';
const MOUTH = '#5E2A2F';
const TONGUE = '#D9787B';

/** Alert marks (listening) and a thought bubble (thinking), over the top-right corner. */
function StateMarks({ bg }: { bg: string }): ReactElement {
  const light = luminance(bg) > 0.3;
  const marks = 'M77 21 L79.4 14.8 M82 25.6 L87.6 22 M84 32 L90.6 31.4';
  return (
    <g>
      {/* Outlined so the marks read over hair and fur as well as the background. */}
      <g className="neo-av-alert" strokeLinecap="round" fill="none">
        <path d={marks} stroke={light ? BUBBLE : '#2C2E35'} strokeWidth={3.6} />
        <path d={marks} stroke={light ? '#3B3440' : '#EEEAE4'} strokeWidth={2} />
      </g>
      <g className="neo-av-thought" stroke="#3B3440" strokeWidth={1}>
        <circle cx={66} cy={25.5} r={1.8} fill={BUBBLE} />
        <circle cx={69.5} cy={21.5} r={2.6} fill={BUBBLE} />
        <rect x={67} y={8} width={22} height={12} rx={6} fill={BUBBLE} />
        <g stroke="none" fill={INK}>
          <circle className="neo-av-dot neo-av-dot1" cx={72.5} cy={14} r={1.6} />
          <circle className="neo-av-dot neo-av-dot2" cx={78} cy={14} r={1.6} />
          <circle className="neo-av-dot neo-av-dot3" cx={83.5} cy={14} r={1.6} />
        </g>
      </g>
    </g>
  );
}

/** Lip-flap frames over the painted mouth; the stylesheet shows one at a time while speaking. */
function FlapMouthView({ mouth }: { mouth: FlapMouth }): ReactElement {
  return (
    <g className="neo-av-mouth-open neo-av-mouth--flap">
      {mouth.frames.map((frame, i) => (
        <g key={i} className={`neo-av-flap neo-av-flap-${i ? 'open' : 'half'}`}>
          {frame.lip && <path d={frame.lip} fill={mouth.lipColor} />}
          <path d={frame.shape} fill={MOUTH} />
          {frame.tongue && <path d={frame.tongue} fill={TONGUE} />}
        </g>
      ))}
    </g>
  );
}

export function NeoAvatar(props: NeoAvatarProps): ReactElement {
  const { avatar, state = 'idle', size = 40, shape = 'circle', animated = true, title, className, style } = props;

  const legacy = typeof avatar === 'string' && !parseAvatar(avatar) && avatar.trim() ? avatar.trim() : null;
  const { kind, bg } = typeof avatar === 'object' && avatar
    ? normalizeAvatar(avatar)
    : parseAvatar(typeof avatar === 'string' ? avatar : null) ?? DEFAULT_AVATAR;
  const art = PORTRAIT_ART[kind];

  const cls = ['neo-av', `neo-av--${shape}`, animated ? '' : 'neo-av--still', className ?? ''].filter(Boolean).join(' ');
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
  const box: CSSProperties = { width: size, height: size, ...style };

  if (legacy) {
    return (
      <span className={cls} style={{ ...box, background: DEFAULT_AVATAR.bg }} {...a11y}>
        <AvatarStyles />
        {isImageUrl(legacy)
          ? <img src={legacy} alt="" draggable={false} />
          : <span className="neo-av-emoji" style={{ fontSize: typeof size === 'number' ? size * 0.56 : '1.4em' }}>{legacy}</span>}
      </span>
    );
  }

  return (
    <span className={cls} style={box} data-kind={kind} data-state={state} {...a11y}>
      <AvatarStyles />
      <svg viewBox="0 0 100 100" focusable="false" aria-hidden="true">
        <rect width={100} height={100} fill={bg} />
        <g className="neo-av-bob"><g className="neo-av-head"><g className="neo-av-nod">
          {/* Drawn 6% oversize so tilting and breathing never reveal an edge. */}
          <g transform="translate(-3 -3) scale(1.06)">
            <image href={PORTRAITS[kind]} width={100} height={100} />
            {art.glow?.halos.map((h, i) => (
              <ellipse key={i} className="neo-av-halo" cx={h.cx} cy={h.cy} rx={h.rx} ry={h.ry} fill={art.glow!.color} transform={`rotate(${h.rot} ${h.cx} ${h.cy})`} />
            ))}
            {art.eyes.map((eye, i) => (
              <g key={i} className="neo-av-lid">
                <path d={eye.lid} fill={art.lidColor} />
                <path d={eye.line} fill="none" stroke={art.lineColor} strokeWidth={1} strokeLinecap="round" />
              </g>
            ))}
            {art.mouth?.mode === 'flap' && <FlapMouthView mouth={art.mouth} />}
            {art.mouth && art.mouth.mode !== 'flap' && (
              <g transform={`translate(${art.mouth.x} ${art.mouth.y}) rotate(${art.mouth.rot})`}>
                <g className={`neo-av-mouth-open neo-av-mouth--${art.mouth.mode}`}>
                  <path d={art.mouth.shape} fill={MOUTH} />
                  <path d={art.mouth.tongue} fill={TONGUE} />
                </g>
              </g>
            )}
          </g>
        </g></g></g>
        <StateMarks bg={bg} />
      </svg>
    </span>
  );
}
