/**
 * ANSI terminal helpers.
 * All styling is a no-op when `stdout.isTTY` is false or `NO_COLOR` is set.
 */

export function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
}

const esc = (code: string) => (s: string) => useColor() ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = esc('1');
export const dim = esc('2');
export const italic = esc('3');
export const red = esc('31');
export const green = esc('32');
export const yellow = esc('33');
export const blue = esc('34');
export const magenta = esc('35');
export const cyan = esc('36');
export const white = esc('37');

/** Clear the current line (for streaming overwrites). */
export const clearLine = () => (useColor() ? '\x1b[2K\r' : '\n');

/** Move cursor up n lines. */
export const cursorUp = (n: number) => (useColor() ? `\x1b[${n}A` : '');

/** Hide / show the cursor. */
export const hideCursor = () => (useColor() ? '\x1b[?25l' : '');
export const showCursor = () => (useColor() ? '\x1b[?25h' : '');

/**
 * Strip terminal control sequences from model-authored text before writing to
 * stdout. Keeps printable ASCII, newlines (\n) and tabs (\t); removes C0/C1
 * control bytes, ANSI/VT escape sequences, and OSC 8 hyperlinks (keeping the
 * visible link text).
 *
 * Rules applied in order:
 *  1. Replace OSC 8 hyperlink pairs with their visible link text.
 *  2. Strip remaining ESC-introduced sequences (CSI, OSC, DCS, PM, APC, SOS).
 *  3. Strip lone ESC bytes.
 *  4. Strip C0 control bytes except \n (\x0a) and \t (\x09).
 *  5. Strip C1 control bytes.
 */
// OSC 8 hyperlink: ESC ] 8 ; params ; uri <BEL|ST> visible-text ESC ] 8 ;; <BEL|ST>
/* eslint-disable-next-line no-control-regex */
const OSC8_RE = /\x1b]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)([\s\S]*?)\x1b]8;;(?:\x07|\x1b\\)/g;
// ESC-introduced sequences: CSI, OSC/DCS/PM/APC/SOS (BEL or ST terminated), or single-char
/* eslint-disable-next-line no-control-regex */
const ESC_SEQ_RE = /\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]|[PX^_\]][^\x07\x1b]*(?:\x07|\x1b\\)|[\x20-\x7e])/g;
// Lone ESC not consumed by ESC_SEQ_RE
/* eslint-disable-next-line no-control-regex */
const LONE_ESC_RE = /\x1b/g;
// C0 bytes except \t (\x09) and \n (\x0a)
/* eslint-disable-next-line no-control-regex */
const C0_RE = /[\x00-\x08\x0b-\x1f]/g;
// C1 bytes
/* eslint-disable-next-line no-control-regex */
const C1_RE = /[\x80-\x9f]/g;

export function stripModelText(text: string): string {
  return text
    .replace(OSC8_RE, '$1')     // 1. keep visible text of OSC 8 hyperlinks
    .replace(ESC_SEQ_RE, '')    // 2. strip ESC-introduced sequences
    .replace(LONE_ESC_RE, '')   // 3. strip lone ESC bytes
    .replace(C0_RE, '')         // 4. strip C0 except \n and \t
    .replace(C1_RE, '');        // 5. strip C1
}
