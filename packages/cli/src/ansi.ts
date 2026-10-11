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
