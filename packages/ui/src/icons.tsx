/**
 * Icon — a small line-icon set drawn on a 24×24 grid with 2px strokes
 * (lucide-style shapes, original path data, MIT-compatible).
 *
 * `name` is a kebab-case icon name or a single emoji (models may use either in
 * generative UI). Unknown names render a neutral dot instead of a misleading
 * glyph.
 */
import type { CSSProperties, ReactElement } from 'react';

/** Path for a circle (as two arcs) so every icon is a list of `d` strings. */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

/** Path for a rounded rectangle. */
function rect(x: number, y: number, w: number, h: number, rx = 0): string {
  if (!rx) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return (
    `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${rx} 0 0 1 ${rx} ${rx}v${h - 2 * rx}a${rx} ${rx} 0 0 1 ${-rx} ${rx}` +
    `h${-(w - 2 * rx)}a${rx} ${rx} 0 0 1 ${-rx} ${-rx}v${-(h - 2 * rx)}a${rx} ${rx} 0 0 1 ${rx} ${-rx}Z`
  );
}

const ICONS: Record<string, readonly string[]> = {
  // ── actions ──
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  trash: ['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6'],
  copy: [rect(9, 9, 13, 13, 2), 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  search: [circle(11, 11, 7), 'M21 21l-4.35-4.35'],
  filter: ['M22 3H2l8 9.46V19l4 2v-8.54Z'],
  refresh: ['M21 12a9 9 0 0 1-15.36 6.36L3 16', 'M3 12a9 9 0 0 1 15.36-6.36L21 8', 'M21 3v5h-5', 'M3 21v-5h5'],
  'rotate-ccw': ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4Z'],
  stop: [rect(6, 6, 12, 12, 2)],
  play: ['M6 4l14 8-14 8Z'],
  pause: [rect(6, 4, 4, 16, 1), rect(14, 4, 4, 16, 1)],
  'external-link': ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  unlink: ['M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71', 'M8 2v3', 'M2 8h3', 'M16 22v-3', 'M22 16h-3'],
  'log-out': ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  'log-in': ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l5-5-5-5', 'M15 12H3'],
  paperclip: ['M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  'zoom-in': [circle(11, 11, 7), 'M21 21l-4.35-4.35', 'M11 8v6', 'M8 11h6'],
  'zoom-out': [circle(11, 11, 7), 'M21 21l-4.35-4.35', 'M8 11h6'],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  crosshair: [circle(12, 12, 9), 'M22 12h-4', 'M6 12H2', 'M12 6V2', 'M12 22v-4'],
  'more-horizontal': [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)],
  'more-vertical': [circle(12, 5, 1), circle(12, 12, 1), circle(12, 19, 1)],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  grip: [circle(9, 6, 1), circle(15, 6, 1), circle(9, 12, 1), circle(15, 12, 1), circle(9, 18, 1), circle(15, 18, 1)],

  // ── arrows & chevrons ──
  'chevron-up': ['M18 15l-6-6-6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevrons-up-down': ['M7 15l5 5 5-5', 'M7 9l5-5 5 5'],
  'arrow-up': ['M12 19V5', 'M5 12l7-7 7 7'],
  'arrow-down': ['M12 5v14', 'M19 12l-7 7-7-7'],
  'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
  'arrow-right': ['M5 12h14', 'M12 5l7 7-7 7'],
  'corner-down-left': ['M9 10l-5 5 5 5', 'M20 4v7a4 4 0 0 1-4 4H4'],

  // ── status ──
  'check-circle': [circle(12, 12, 10), 'M8 12.5l2.5 2.5L16 9.5'],
  'x-circle': [circle(12, 12, 10), 'M15 9l-6 6', 'M9 9l6 6'],
  circle: [circle(12, 12, 9)],
  'circle-dot': [circle(12, 12, 9), circle(12, 12, 1)],
  info: [circle(12, 12, 10), 'M12 16v-4', 'M12 8h.01'],
  'alert-circle': [circle(12, 12, 10), 'M12 8v4', 'M12 16h.01'],
  'alert-triangle': ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z', 'M12 9v4', 'M12 17h.01'],
  'help-circle': [circle(12, 12, 10), 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  loader: ['M12 2v4', 'M12 18v4', 'M4.93 4.93l2.83 2.83', 'M16.24 16.24l2.83 2.83', 'M2 12h4', 'M18 12h4', 'M4.93 19.07l2.83-2.83', 'M16.24 7.76l2.83-2.83'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8Z'],
  sparkles: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z', 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z', 'M5 3v4', 'M3 5h4'],
  wand: ['M15 4V2', 'M15 16v-2', 'M8 9h2', 'M20 9h2', 'M17.8 11.8 19 13', 'M15 9h.01', 'M17.8 6.2 19 5', 'M3 21l9-9', 'M12.2 6.2 11 5'],
  star: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z'],
  heart: ['M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z', 'M4 22v-7'],
  target: [circle(12, 12, 10), circle(12, 12, 6), circle(12, 12, 2)],
  lightbulb: ['M9 18h6', 'M10 22h4', 'M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14'],
  award: [circle(12, 8, 6), 'M15.48 12.89 17 22l-5-3-5 3 1.52-9.11'],
  trophy: ['M6 9H4.5a2.5 2.5 0 0 1 0-5H6', 'M18 9h1.5a2.5 2.5 0 0 0 0-5H18', 'M4 22h16', 'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22', 'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22', 'M18 2H6v7a6 6 0 0 0 12 0Z'],

  // ── communication ──
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'],
  'message-plus': ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z', 'M12 7v6', 'M9 10h6'],
  'message-circle': ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  mail: [rect(2, 4, 20, 16, 2), 'M22 7l-10 6L2 7'],
  phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z'],
  'at-sign': [circle(12, 12, 4), 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'],
  quote: ['M3 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2H4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .01-1 1.03V20c0 1 0 1 1 1Z', 'M15 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2h-4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1Z'],
  bot: [rect(4, 8, 16, 12, 3), 'M12 8V4', 'M8 4h8', 'M2 14h2', 'M20 14h2', 'M9 13v2', 'M15 13v2'],

  // ── productivity ──
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  'bell-off': ['M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5', 'M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7', 'M10.3 21a1.94 1.94 0 0 0 3.4 0', 'M2 2l20 20'],
  'bell-ring': ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0', 'M4 2C2.8 3.7 2 5.7 2 8', 'M22 8c0-2.3-.8-4.3-2-6'],
  'alarm-clock': [circle(12, 13, 8), 'M12 9v4l2 2', 'M5 3 2 6', 'M22 6l-3-3', 'M6.38 18.7 4 21', 'M17.64 18.67 20 21'],
  calendar: [rect(3, 4, 18, 18, 2), 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  'calendar-clock': ['M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5', 'M16 2v4', 'M8 2v4', 'M3 10h5', circle(16, 16, 6), 'M16 14v2.2l1.6 1'],
  clock: [circle(12, 12, 10), 'M12 6v6l4 2'],
  timer: ['M10 2h4', 'M12 14l3-3', circle(12, 14, 8)],
  repeat: ['M17 2l4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  'list-checks': ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M3 6l1 1 2-2', 'M3 12l1 1 2-2', 'M3 18l1 1 2-2'],
  'check-square': [rect(3, 3, 18, 18, 3), 'M8 12l3 3 5-6'],
  square: [rect(3, 3, 18, 18, 3)],
  note: ['M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5Z', 'M15 3v4a2 2 0 0 0 2 2h4', 'M7 13h6', 'M7 17h9'],
  'file-text': ['M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z'],
  'book-open': ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z'],
  archive: [rect(2, 3, 20, 5, 1), 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8', 'M10 12h4'],
  'archive-restore': [rect(2, 3, 20, 5, 1), 'M4 8v11a2 2 0 0 0 2 2h2', 'M20 8v11a2 2 0 0 1-2 2h-2', 'M9 15l3-3 3 3', 'M12 12v9'],
  tag: ['M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42Z', 'M7.5 7.5h.01'],
  hash: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],
  pin: ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1Z'],
  'pin-off': ['M12 17v5', 'M15 9.34V6h1a2 2 0 0 0 0-4H7.89', 'M2 2l20 20', 'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12'],
  bookmark: ['M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z'],

  // ── memory & mind ──
  brain: [
    'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z',
    'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z',
    'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
    'M12 5v13',
  ],
  network: [circle(12, 5, 2.5), circle(5, 18, 2.5), circle(19, 18, 2.5), circle(12, 13, 1.5), 'M12 7.5v4', 'M10.8 13.9 6.9 16.4', 'M13.2 13.9l3.9 2.5', 'M7.5 18h9'],
  layers: ['M12 2 2 7l10 5 10-5Z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  'moon-star': ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z', 'M19 3v4', 'M21 5h-4'],
  film: [rect(3, 3, 18, 18, 2), 'M7 3v18', 'M17 3v18', 'M3 7.5h4', 'M3 12h18', 'M3 16.5h4', 'M17 7.5h4', 'M17 16.5h4'],
  incognito: ['M2 11h20', 'M5 11l1.5-6.5a1 1 0 0 1 1.3-.7L12 5l4.2-1.2a1 1 0 0 1 1.3.7L19 11', circle(7, 16.5, 3), circle(17, 16.5, 3), 'M10 16.5a2 2 0 0 1 4 0'],
  eye: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z', circle(12, 12, 3)],
  'eye-off': ['M9.88 9.88a3 3 0 1 0 4.24 4.24', 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68', 'M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61', 'M2 2l20 20'],

  // ── people & places ──
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', circle(12, 7, 4)],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', circle(9, 7, 4), 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  smile: [circle(12, 12, 10), 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  'map-pin': ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z', circle(12, 10, 3)],
  home: ['M3 9.5 12 3l9 6.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 22V12h6v10'],
  globe: [circle(12, 12, 10), 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z'],
  languages: ['M5 8l6 6', 'M4 14l6-6 2-3', 'M2 5h12', 'M7 2h1', 'M22 22l-5-10-5 10', 'M14 18h6'],
  briefcase: [rect(2, 7, 20, 14, 2), 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'],
  coffee: ['M17 8h1a4 4 0 1 1 0 8h-1', 'M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z', 'M6 2v2', 'M10 2v2', 'M14 2v2'],
  utensils: ['M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2', 'M7 2v20', 'M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7'],
  plane: ['M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z'],
  'shopping-cart': [circle(8, 21, 1), circle(19, 21, 1), 'M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12'],
  music: ['M9 18V5l12-2v13', circle(6, 18, 3), circle(18, 16, 3)],
  dumbbell: ['M14.4 14.4 9.6 9.6', 'M18.66 21.51a2 2 0 1 1-2.83-2.83l-1.77 1.77a2 2 0 1 1-2.83-2.83l6.37-6.37a2 2 0 1 1 2.83 2.83l-1.77 1.77a2 2 0 1 1 2.83 2.83Z', 'M21.5 21.5l-1.4-1.4', 'M3.9 3.9 2.5 2.5', 'M6.4 12.77a2 2 0 1 1-2.83-2.83l1.77-1.77a2 2 0 1 1-2.83-2.83l2.83-2.83a2 2 0 1 1 2.83 2.83l1.77-1.77a2 2 0 1 1 2.83 2.83Z'],
  gift: [rect(3, 8, 18, 4, 1), 'M12 8v13', 'M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7', 'M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5'],
  'dollar-sign': ['M12 2v20', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],

  // ── data & charts ──
  chart: ['M3 3v18h18', 'M8 17V11', 'M13 17V7', 'M18 17v-4'],
  'bar-chart': ['M3 3v18h18', 'M8 17V11', 'M13 17V7', 'M18 17v-4'],
  'line-chart': ['M3 3v18h18', 'M7 15l4-5 4 3 5-7'],
  'pie-chart': ['M21.21 15.89A10 10 0 1 1 8 2.83', 'M22 12A10 10 0 0 0 12 2v10Z'],
  'trending-up': ['M22 7 13.5 15.5 8.5 10.5 2 17', 'M16 7h6v6'],
  'trending-down': ['M22 17l-8.5-8.5-5 5L2 7', 'M16 17h6v-6'],
  table: [rect(3, 3, 18, 18, 2), 'M3 9h18', 'M3 15h18', 'M9 3v18'],
  database: ['M3 5c0 1.66 4 3 9 3s9-1.34 9-3-4-3-9-3-9 1.34-9 3Z', 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5', 'M3 12c0 1.66 4 3 9 3s9-1.34 9-3'],
  code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
  image: [rect(3, 3, 18, 18, 2), circle(9, 9, 2), 'M21 15l-3.09-3.09a2 2 0 0 0-2.82 0L6 21'],
  'qr-code': [rect(3, 3, 7, 7, 1), rect(14, 3, 7, 7, 1), rect(3, 14, 7, 7, 1), 'M14 14h3v3h-3Z', 'M21 14v.01', 'M17 21h4v-4', 'M14 21v.01'],

  // ── devices & system ──
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z',
    circle(12, 12, 3),
  ],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  palette: [circle(13.5, 6.5, 0.5), circle(17.5, 10.5, 0.5), circle(8.5, 7.5, 0.5), circle(6.5, 12.5, 0.5), 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2Z'],
  sun: [circle(12, 12, 4), 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M6.34 17.66l-1.41 1.41', 'M19.07 4.93l-1.41 1.41'],
  monitor: [rect(2, 3, 20, 14, 2), 'M8 21h8', 'M12 17v4'],
  laptop: ['M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9', 'M2 19.5A1.5 1.5 0 0 0 3.5 21h17a1.5 1.5 0 0 0 1.5-1.5L20 16H4Z'],
  smartphone: [rect(5, 2, 14, 20, 2), 'M12 18h.01'],
  tablet: [rect(4, 2, 16, 20, 2), 'M12 18h.01'],
  terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
  server: [rect(2, 2, 20, 8, 2), rect(2, 14, 20, 8, 2), 'M6 6h.01', 'M6 18h.01'],
  cpu: [rect(4, 4, 16, 16, 2), rect(9, 9, 6, 6, 1), 'M15 2v2', 'M15 20v2', 'M2 15h2', 'M2 9h2', 'M20 15h2', 'M20 9h2', 'M9 2v2', 'M9 20v2'],
  cloud: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'],
  'cloud-sun': ['M12 2v2', 'M4.93 4.93l1.41 1.41', 'M20 12h2', 'M19.07 4.93l-1.41 1.41', 'M15.95 12.65a4 4 0 0 0-5.93-4.97', 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z'],
  wifi: ['M5 12.55a11 11 0 0 1 14.08 0', 'M1.42 9a16 16 0 0 1 21.16 0', 'M8.53 16.11a6 6 0 0 1 6.95 0', 'M12 20h.01'],
  'wifi-off': ['M12 20h.01', 'M8.5 16.43a5 5 0 0 1 7 0', 'M2 8.82a15 15 0 0 1 4.17-2.65', 'M10.66 5c4.01-.36 8.14.9 11.34 3.76', 'M16.85 11.25a10 10 0 0 1 2.22 1.68', 'M5 13a10 10 0 0 1 5.24-2.76', 'M2 2l20 20'],
  lock: [rect(3, 11, 18, 11, 2), 'M7 11V7a5 5 0 0 1 10 0v4'],
  unlock: [rect(3, 11, 18, 11, 2), 'M7 11V7a5 5 0 0 1 9.9-1'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z'],
  'shield-check': ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'M9 12l2 2 4-4'],
  key: [circle(7.5, 15.5, 5.5), 'M21 2l-9.6 9.6', 'M15.5 7.5l3 3L22 7l-3-3'],
  plug: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z'],
  command: ['M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3'],
  'panel-left': [rect(3, 3, 18, 18, 2), 'M9 3v18'],
};

/** Aliases so models (and older code) can use common synonyms. */
const ALIASES: Record<string, string> = {
  gear: 'settings',
  cog: 'settings',
  'message-square': 'message',
  chat: 'message',
  pencil: 'edit',
  'trash-2': 'trash',
  delete: 'trash',
  close: 'x',
  done: 'check',
  'check-circle-2': 'check-circle',
  warning: 'alert-triangle',
  error: 'x-circle',
  success: 'check-circle',
  alert: 'alert-circle',
  question: 'help-circle',
  'calendar-days': 'calendar',
  date: 'calendar',
  time: 'clock',
  alarm: 'alarm-clock',
  reminder: 'bell',
  task: 'check-square',
  tasks: 'list-checks',
  todo: 'list-checks',
  notes: 'note',
  'sticky-note': 'note',
  memory: 'brain',
  idea: 'lightbulb',
  location: 'map-pin',
  place: 'map-pin',
  person: 'user',
  people: 'users',
  weather: 'cloud-sun',
  money: 'dollar-sign',
  finance: 'dollar-sign',
  food: 'utensils',
  travel: 'plane',
  work: 'briefcase',
  goal: 'target',
  fitness: 'dumbbell',
  health: 'heart',
  stats: 'bar-chart',
  analytics: 'line-chart',
  'refresh-cw': 'refresh',
  undo: 'rotate-ccw',
  retry: 'rotate-ccw',
  attach: 'paperclip',
  photo: 'image',
  picture: 'image',
  web: 'globe',
  website: 'globe',
  url: 'link',
  email: 'mail',
  robot: 'bot',
  ai: 'sparkles',
  magic: 'wand',
};

/** True for names that look like icon identifiers (kebab-case ASCII). */
function isIconName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/** All known icon names (for docs, pickers and tests). */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

/** Resolve a name or alias to path data; null when unknown. */
export function iconPaths(name: string): readonly string[] | null {
  return ICONS[name] ?? ICONS[ALIASES[name] ?? ''] ?? null;
}

const FALLBACK: readonly string[] = [circle(12, 12, 2.5)];

export function Icon(props: {
  name: string;
  size?: number;
  className?: string;
  /** Accessible name; without it the icon is decorative (aria-hidden). */
  label?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}): ReactElement {
  const { name, size = 16, className, label, strokeWidth = 2, style } = props;
  const trimmed = name.trim();

  if (!isIconName(trimmed)) {
    // A single emoji (or short text): render it as text, sized like an icon.
    return (
      <span
        className={className}
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        style={{ fontSize: size * 0.95, lineHeight: 1, display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center', ...style }}
      >
        {trimmed.slice(0, 8)}
      </span>
    );
  }

  const paths = iconPaths(trimmed) ?? FALLBACK;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-icon={trimmed}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
