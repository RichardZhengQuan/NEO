/**
 * Animated avatar config: the character, its background, and how it is stored.
 *
 * The config is saved in `persona.avatar` (a string in @neo/protocol) as
 * `neo-avatar:{"kind":"cat","bg":"#…"}`. Any other value there (an emoji or
 * an image URL) is a legacy avatar, not a config. Strings saved by earlier
 * versions also carried `color` and `skin`; those are ignored now that the
 * characters are drawn portraits.
 */

export type AvatarCharacter = 'robot' | 'cat' | 'dog' | 'boy' | 'girl';
export const AVATAR_CHARACTERS: readonly AvatarCharacter[] = ['robot', 'cat', 'dog', 'boy', 'girl'];

/** What the assistant is doing; drives the animation. */
export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';
export const AVATAR_STATES: readonly AvatarState[] = ['idle', 'listening', 'thinking', 'speaking'];

export interface AvatarConfig {
  kind: AvatarCharacter;
  /** Background behind the portrait (#rrggbb). */
  bg: string;
}

export const DEFAULT_AVATAR: AvatarConfig = { kind: 'robot', bg: '#CDE9FD' };

/**
 * Preset backgrounds: the five the portraits were painted on, soft Morandi
 * tones, and two darks.
 */
export const AVATAR_BACKGROUNDS: readonly string[] = [
  '#CDE9FD', '#DEEAF4', '#D8EFDC', '#C3D5AE', '#DCD0F4',
  '#EEE2DF', '#EFE9DE', '#E7E6E3', '#454A54', '#2C2E35',
];

const PREFIX = 'neo-avatar:';
const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

export function isAvatarString(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function serializeAvatar(config: AvatarConfig): string {
  const c = normalizeAvatar(config);
  return PREFIX + JSON.stringify({ kind: c.kind, bg: c.bg });
}

/**
 * Read a stored avatar. Returns null for anything that isn't a neo-avatar
 * string (null, emoji, image URL). Missing or invalid fields get defaults.
 */
export function parseAvatar(value: string | null | undefined): AvatarConfig | null {
  if (!isAvatarString(value)) return null;
  try {
    return normalizeAvatar(JSON.parse(value.slice(PREFIX.length)) as Partial<AvatarConfig>);
  } catch {
    return { ...DEFAULT_AVATAR };
  }
}

export function normalizeAvatar(input: Partial<AvatarConfig> | null | undefined): AvatarConfig {
  const v = input ?? {};
  return {
    kind: AVATAR_CHARACTERS.includes(v.kind as AvatarCharacter) ? (v.kind as AvatarCharacter) : DEFAULT_AVATAR.kind,
    bg: isHexColor(v.bg) ? v.bg.toUpperCase() : DEFAULT_AVATAR.bg,
  };
}

/** Relative luminance, 0 (black) – 1 (white). */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
