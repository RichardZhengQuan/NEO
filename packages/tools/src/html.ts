/**
 * htmlToText: readable plain text from untrusted HTML, in one linear pass (no
 * regex backtracking over the whole document, so hostile markup can't stall
 * the event loop).
 *
 * - Keeps the <title>, headings (as "# "), list items ("- "), paragraphs,
 *   table cells ("a | b"), <pre> blocks verbatim and link URLs ("text (https://…)").
 * - Drops comments, script/style/noscript/template, and nav/footer/svg/iframe… subtrees.
 * - Decodes named and numeric entities exactly once and collapses whitespace.
 */

const RAW_TEXT = new Set(['script', 'style', 'noscript', 'title', 'textarea', 'xmp']);
const SKIP_SUBTREE = new Set(['nav', 'footer', 'svg', 'math', 'template', 'iframe', 'object', 'select', 'canvas', 'dialog']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'form', 'header', 'main', 'ol', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'ul', 'center',
]);
const MAX_TITLE_CHARS = 300;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  shy: '­', zwj: '‍', zwnj: '‌', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  bull: '•', middot: '·', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', times: '×', divide: '÷',
  plusmn: '±', minus: '−', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', harr: '↔', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', dagger: '†', iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', ccedil: 'ç', agrave: 'à', egrave: 'è', ecirc: 'ê', acirc: 'â', ocirc: 'ô', aring: 'å',
};
/** Entities commonly written without the trailing semicolon. */
const LEGACY_NO_SEMICOLON = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);

const ENTITY = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}))(;?)/g;

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (match, dec: string | undefined, hex: string | undefined, name: string | undefined, semi: string) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? Number(dec) : parseInt(hex as string, 16);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const value = NAMED_ENTITIES[name as string];
    if (value === undefined || (!semi && !LEGACY_NO_SEMICOLON.has(name as string))) return match;
    return value;
  });
}

const TAG_NAME = /[A-Za-z][A-Za-z0-9:-]*/y;
function extractHref(attrs: string): string | null {
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && /[\s/]/.test(attrs.charAt(i))) i++;
    const nameStart = i;
    while (i < attrs.length && !/[=\s/>]/.test(attrs.charAt(i))) i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = attrs.slice(nameStart, i).toLowerCase();
    while (i < attrs.length && /\s/.test(attrs.charAt(i))) i++;
    if (attrs.charAt(i) !== '=') continue;
    i++;
    while (i < attrs.length && /\s/.test(attrs.charAt(i))) i++;
    const quote = attrs.charAt(i);
    let value: string;
    if (quote === '"' || quote === "'") {
      const valueStart = ++i;
      while (i < attrs.length && attrs.charAt(i) !== quote) i++;
      value = attrs.slice(valueStart, i);
      if (i < attrs.length) i++;
    } else {
      const valueStart = i;
      while (i < attrs.length && !/[\s>]/.test(attrs.charAt(i))) i++;
      value = attrs.slice(valueStart, i);
    }
    if (name === 'href') return value;
  }
  return null;
}

const closingTagRe = new Map<string, RegExp>();
function closingTag(name: string): RegExp {
  let re = closingTagRe.get(name);
  if (!re) {
    re = new RegExp(`</${name}\\s*>`, 'gi');
    closingTagRe.set(name, re);
  }
  return re;
}

function absoluteHttpUrl(href: string, base: string | undefined): string | null {
  const h = decodeEntities(href).trim();
  if (!h || h.startsWith('#')) return null;
  try {
    const url = base ? new URL(h, base) : new URL(h);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Convert HTML to readable text. `baseUrl` resolves relative link URLs. */
export function htmlToText(html: string, baseUrl?: string): { title: string; text: string; titleTruncated?: true } {
  const src = html.includes('\u0000') ? html.replace(/\u0000/g, '') : html;
  const n = src.length;
  const out: string[] = [];
  const preBlocks: string[] = [];
  let title = '';
  let titleTruncated = false;
  let pre = 0;
  const skip: { name: string; depth: number }[] = [];
  const anchors: { href: string | null; start: number }[] = [];
  let cells = 0;

  // Whitespace is normalized while emitting (never by a regex over the whole
  // output, which could backtrack quadratically on long runs of spaces).
  let started = false;
  let pendingBreak = 0;
  let endsWithSpace = false;
  const emit = (piece: string) => {
    let s = piece;
    if (!started || pendingBreak || endsWithSpace) s = s.replace(/^ +/, '');
    if (!s) return;
    if (pendingBreak && started) {
      const last = out.length - 1;
      out[last] = (out[last] as string).replace(/ +$/, '');
      out.push(pendingBreak >= 2 ? '\n\n' : '\n');
    }
    pendingBreak = 0;
    started = true;
    out.push(s);
    endsWithSpace = s.endsWith(' ');
  };
  const text = (raw: string) => {
    if (!raw) return;
    if (pre > 0) {
      preBlocks.push(decodeEntities(raw));
      emit(`\u0000${preBlocks.length - 1}\u0000`);
    } else {
      emit(decodeEntities(raw).replace(/[\s\u00a0]+/g, ' '));
    }
  };
  const breakLine = (count = 1) => {
    pendingBreak = Math.max(pendingBreak, count);
  };

  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (!skip.length) text(src.slice(i));
      break;
    }
    if (lt > i && !skip.length) text(src.slice(i, lt));
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = src.charAt(i + 1);
    if (next === '!' || next === '?') {
      const end = src.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const closing = next === '/';
    TAG_NAME.lastIndex = i + (closing ? 2 : 1);
    const m = TAG_NAME.exec(src);
    if (!m) {
      if (!skip.length) text('<');
      i += 1;
      continue;
    }
    const name = m[0].toLowerCase();

    // Find the end of the tag; quotes only delimit attribute values right after "=".
    let j = TAG_NAME.lastIndex;
    let quote = 0;
    let afterEquals = false;
    for (; j < n; j++) {
      const c = src.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
        continue;
      }
      if (c === 62 /* > */) break;
      if ((c === 34 || c === 39) && afterEquals) quote = c;
      else if (c === 61 /* = */) afterEquals = true;
      else if (c !== 32 && c !== 9 && c !== 10 && c !== 13) afterEquals = false;
    }
    if (j >= n) break; // unterminated tag: nothing readable follows
    const attrs = src.slice(TAG_NAME.lastIndex, j);
    const selfClosing = attrs.endsWith('/') || VOID.has(name);
    i = j + 1;

    // Raw-text elements: their content is not markup; jump to the closing tag.
    if (!closing && RAW_TEXT.has(name) && !selfClosing) {
      const re = closingTag(name);
      re.lastIndex = i;
      const close = re.exec(src);
      const content = src.slice(i, close ? close.index : n);
      i = close ? close.index + close[0].length : n;
      if (!skip.length) {
        if (name === 'title' && !title) {
          const decoded = decodeEntities(content).replace(/[\s ]+/g, ' ').trim();
          titleTruncated = decoded.length > MAX_TITLE_CHARS;
          title = decoded.slice(0, MAX_TITLE_CHARS);
          if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
        }
        else if (name === 'textarea' || name === 'xmp') text(content);
      }
      continue;
    }

    // Inside a dropped subtree: only track nesting of the same element.
    const top = skip[skip.length - 1];
    if (top) {
      if (name === top.name && !selfClosing) {
        if (closing) {
          if (--top.depth === 0) skip.pop();
        } else top.depth++;
      } else if (!closing && SKIP_SUBTREE.has(name) && !selfClosing) skip.push({ name, depth: 1 });
      continue;
    }
    if (!closing && SKIP_SUBTREE.has(name) && !selfClosing) {
      skip.push({ name, depth: 1 });
      continue;
    }

    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      breakLine(2);
      if (!closing) emit(`${'#'.repeat(Number(heading[1]))} `);
      continue;
    }
    switch (name) {
      case 'br':
        breakLine();
        break;
      case 'hr':
      case 'p':
        breakLine(2);
        break;
      case 'li':
        if (!closing) {
          breakLine();
          emit('- ');
        }
        break;
      case 'tr':
        if (!closing) breakLine();
        cells = 0;
        break;
      case 'td':
      case 'th':
        if (!closing && cells++ > 0) emit(' | ');
        break;
      case 'pre':
        breakLine(2);
        pre = closing ? Math.max(0, pre - 1) : pre + 1;
        break;
      case 'a':
        if (!closing) {
          if (anchors.length < 1000) anchors.push({ href: extractHref(attrs), start: out.length });
        } else {
          const a = anchors.pop();
          const url = a?.href ? absoluteHttpUrl(a.href, baseUrl) : null;
          if (a && url) {
            const label = out.slice(a.start).join('').trim();
            if (label && label !== url && !label.includes(url)) emit(` (${url})`);
          }
        }
        break;
      default:
        if (BLOCK.has(name)) breakLine();
    }
  }

  let result = out.join('').trim();
  if (preBlocks.length) result = result.replace(/\u0000(\d+)\u0000/g, (_m, k: string) => preBlocks[Number(k)] ?? '');
  return { title, text: result, ...(titleTruncated ? { titleTruncated: true } : {}) };
}
