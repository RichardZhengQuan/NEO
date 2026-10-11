/**
 * Where the animated overlays sit on each portrait, measured on the source
 * art in its own 0–100 coordinates. Eyelids (skin or fur colored, with the
 * closed-eye line) drop over the eyes to blink, the mouth opens below the
 * painted smile while speaking, and the robot's eyes glow. Re-measure these if the art in
 * packages/ui/assets/avatar-art changes.
 */
import type { AvatarCharacter } from './config.js';

export interface EyeArt {
  /** Closed shape covering the open eye. */
  lid: string;
  /** The line of the closed eye. */
  line: string;
}

/**
 * An open mouth, drawn in a local frame placed at (x, y) and rotated by rot,
 * that opens by growing out of the point (0, 0), where the painted mouth
 * lines meet (the cat's "人").
 */
export interface ScaledMouth {
  mode: 'grow';
  x: number;
  y: number;
  rot: number;
  shape: string;
  tongue: string;
}

/**
 * A mouth that opens along the whole painted lip line, corners closed and
 * widest in the middle, shown as anime lip-flap frames: half open, then open.
 */
export interface FlapMouth {
  mode: 'flap';
  lipColor?: string | undefined;
  frames: [MouthFrame, MouthFrame];
}

export interface MouthFrame {
  shape: string;
  tongue: string;
  /** A lower lip below the opening, which moves down as the mouth opens; '' for none. */
  lip: string;
}

export type MouthArt = ScaledMouth | FlapMouth;

type Pt = [number, number];

/** `n` points evenly spaced along a polyline. */
function resample(line: Pt[], n: number): Pt[] {
  const seg = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i]![0], p[1] - line[i]![1]));
  const total = seg.reduce((a, b) => a + b, 0);
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    let d = (total * k) / (n - 1);
    let i = 0;
    while (i < seg.length - 1 && d > seg[i]!) d -= seg[i++]!;
    const t = seg[i] ? Math.min(1, d / seg[i]!) : 0;
    const a = line[i]!;
    const b = line[i + 1]!;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Points offset from the line toward its open side by depth × a bump that is 0 at the corners. */
function offset(pts: Pt[], depth: number): Pt[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const bump = Math.sin((Math.PI * i) / (pts.length - 1));
    return [p[0] + (-dy / len) * depth * bump, p[1] + (dx / len) * depth * bump];
  });
}

function poly(top: Pt[], bottom: Pt[]): string {
  const f = (p: Pt) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  return `M${top.map(f).join(' L')} L${[...bottom].reverse().map(f).join(' L')} Z`;
}

/**
 * Lip-flap frames for a mouth whose painted lip line runs along `line`
 * (left to right, the mouth opening on the right-hand side of that direction,
 * which is below it). `half` and `open` are the depths at the middle.
 * `lip` redraws a painted lower lip in that color below the opening.
 */
function flap(line: Pt[], half: number, open: number, lip?: string): FlapMouth {
  const pts = resample(line, 25);
  const [a, b] = [6, 18];
  const frame = (depth: number, tongue: boolean): MouthFrame => {
    const bottom = offset(pts, depth);
    const lipPath = lip ? poly(bottom, offset(pts, depth + 1.2)) : '';
    if (!tongue) return { shape: poly(pts, bottom), tongue: '', lip: lipPath };
    // A rounded tongue resting on the bottom of the opening, in the middle.
    const lump = bottom.slice(a, b + 1).map((q, k): Pt => {
      const p = pts[a + k]!;
      const lift = 0.55 * Math.sin((Math.PI * k) / (b - a));
      return [q[0] + (p[0] - q[0]) * lift, q[1] + (p[1] - q[1]) * lift];
    });
    return { shape: poly(pts, bottom), tongue: poly(lump, bottom.slice(a, b + 1)), lip: lipPath };
  };
  return { mode: 'flap', lipColor: lip, frames: [frame(half, false), frame(open, true)] };
}

export interface PortraitArt {
  /** Color around the eyes, used for the eyelids. */
  lidColor: string;
  lineColor: string;
  eyes: [EyeArt, EyeArt];
  /** The open mouth while speaking; null when there is no mouth to open. */
  mouth: MouthArt | null;
  /** Glowing eyes (robot): halos over the eyes, which pulse with the state. */
  glow?: { color: string; halos: { cx: number; cy: number; rx: number; ry: number; rot: number }[] };
}

export const PORTRAIT_ART: Record<AvatarCharacter, PortraitArt> = {
  boy: {
    lidColor: '#FBCEA2',
    lineColor: '#2A2023',
    eyes: [
      { lid: 'M29.2 48.6 C30.5 44.2 41.5 42.6 44.6 46.4 C44 50.6 40 53 36.8 52.9 C33.2 52.8 30.2 51.2 29.2 48.6 Z', line: 'M30 49.2 Q37 52.4 44 47.6' },
      { lid: 'M55.4 45.6 C56.4 40 67.4 36.4 72.2 39.4 C71.4 44.2 68 47.2 64.6 47.2 C60.6 47.2 57.2 46.8 55.4 45.6 Z', line: 'M56.2 45.4 Q64.4 46.4 71.6 40.2' },
    ],
    // The painted smirk, from its left corner to its right.
    mouth: flap([[46.8, 65.9], [50, 65.2], [54, 64.2], [58, 63.3], [61.2, 62.5], [62.6, 62.2]], 1.4, 3),
  },
  girl: {
    lidColor: '#FDCFB0',
    lineColor: '#2A2023',
    eyes: [
      { lid: 'M42.8 48.4 C44 41.8 57.6 39.6 60.8 47.4 C59.6 51.8 55 53.8 51 53.8 C47 53.8 43.8 51.6 42.8 48.4 Z', line: 'M43.4 48.6 Q51.5 53 60.2 48' },
      { lid: 'M71.4 49 C71.4 42 76.2 36.4 83.2 41.6 C82.8 46.6 80.2 50.8 76.8 51 C74.6 51.1 72.6 50.4 71.4 49 Z', line: 'M72 48.8 Q78.4 49.6 82.6 43' },
    ],
    // Her lip line, from the left corner to the upturned right one, with the pink lower lip under it.
    mouth: flap([[60.6, 65.55], [62, 65.85], [64, 65.75], [66, 65.55], [68, 65.3], [69.5, 64.8], [71, 63.95], [71.8, 63.6]], 1.3, 2.6, '#F7B899'),
  },
  cat: {
    lidColor: '#FEFDF9',
    lineColor: '#2B2A2E',
    eyes: [
      { lid: 'M25.8 50.4 C27.4 43.2 40.4 41.8 46.6 54.4 C43.6 57.6 40 58.2 36.8 58 C31.6 57.6 27.4 54.6 25.8 50.4 Z', line: 'M26.6 50.8 Q36 57.4 45.8 54.4' },
      { lid: 'M59.6 50.4 C59.2 44 59.8 38.6 62 36 C65.4 32.8 71.8 33.2 75.2 35.4 C74.6 41.4 70.6 47.6 66 49.6 C63.6 50.6 61.4 50.8 59.6 50.4 Z', line: 'M60.4 49.6 Q68.6 47.2 74.6 36.4' },
    ],
    mouth: {
      x: 56.3, y: 64.75, rot: 0, mode: 'grow',
      shape: 'M0 0 L2.4 0.6 Q2.1 3 -0.2 3.1 Q-1.3 2.5 -1.2 1.45 Z',
      tongue: 'M-0.9 2.3 Q0.5 1.5 1.9 2 Q1.2 3 -0.2 3.05 Q-0.8 2.8 -0.9 2.3 Z',
    },
  },
  dog: {
    lidColor: '#F7BA62',
    lineColor: '#4A2E1E',
    eyes: [
      { lid: 'M33.2 25.6 C33.8 20.8 41.6 19.8 44.6 26.6 C44.8 29.8 42.4 31.4 39.6 31.2 C36.4 31 33.4 28.8 33.2 25.6 Z', line: 'M34 26.4 Q39 30.6 44 27.4' },
      { lid: 'M61.6 37.4 C62.4 31 70.4 28.6 73.6 36.6 C74 39.8 72.4 41.4 69.4 41.4 C66 41.4 62.6 40.2 61.6 37.4 Z', line: 'M62.4 37.6 Q67.6 41 73 37.4' },
    ],
    // The "ω" under the nose: the left lip in to the point under the nose,
    // then down the front of the right lip. The lower jaw sits below it.
    mouth: flap([[33.5, 60.3], [36, 60.6], [39, 60.2], [42, 59.7], [43.5, 60.8], [45, 62.3], [46.5, 63.9], [48, 65.3]], 2, 4),
  },
  robot: {
    lidColor: '#3A3C3F',
    lineColor: '#4FA9BC',
    eyes: [
      { lid: 'M21.6 49.4 C24.6 47.8 29.4 49.8 31.2 53.4 C29 55 25.4 54.6 22.6 52.6 C21.6 51.8 21.2 50.4 21.6 49.4 Z', line: 'M22.4 50.2 Q26.8 52.4 30.4 53.4' },
      { lid: 'M46.8 51.4 C49.6 46 56.6 42.6 61.8 42.8 C61.4 46.8 57.2 50.6 52.2 51.6 C50 52 48 51.9 46.8 51.4 Z', line: 'M47.6 51 Q55 49.4 61 43.6' },
    ],
    mouth: null,
    glow: {
      color: '#8BE9FF',
      halos: [
        { cx: 26.4, cy: 51.4, rx: 6, ry: 3.8, rot: 22 },
        { cx: 54.3, cy: 47.2, rx: 8.8, ry: 4.4, rot: -25 },
      ],
    },
  },
};
