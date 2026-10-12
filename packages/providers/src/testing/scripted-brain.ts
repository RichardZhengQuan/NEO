/**
 * Test-only script for deterministic tool, memory and title integration coverage.
 * Kept outside the production build and injected explicitly by tests.
 */
import type { ChatMessage, ChatRequest, ToolResultPart, UIBlock } from '@neo/protocol';
import type { MockReply, MockScript } from '../index.js';

type Lang = 'en' | 'zh';
type ToolCall = { name: string; input: Record<string, unknown> };

const HAN = /[㐀-鿿]/;
const langOf = (text: string): Lang => (HAN.test(text) ? 'zh' : 'en');

// ───────────────────────────── reading the request ─────────────────────────────

function textOf(msg: ChatMessage | undefined): string {
  if (!msg) return '';
  return msg.parts.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
}

function lastUser(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return messages[i];
  return undefined;
}

interface UserTurn {
  /** What the user typed: context blocks, notices and UI-event wrappers removed. */
  text: string;
  lang: Lang;
  /** Memory statements from the turn's `<neo_context>` block (ids and kinds stripped). */
  memories: string[];
  /** Label of a UI control the user activated, if this turn is a UI event. */
  uiEvent?: string;
  /** The context block says this conversation is incognito (nothing is remembered). */
  incognito: boolean;
}

/**
 * What NEO can say it remembers, best first: knowledge (facts, preferences …)
 * before episodes and summaries, each statement once. An episode whose
 * sentences were all already said adds nothing and is left out.
 */
function rememberedLines(items: { kind?: string; content: string }[]): string[] {
  const key = (s: string) => s.toLowerCase().replace(/[\s.,，。!！?？'’"“”]/g, '');
  const story = (kind?: string) => kind === 'episode' || kind === 'summary';
  const ordered = [...items.filter((m) => !story(m.kind)), ...items.filter((m) => story(m.kind))];
  const said = new Set<string>();
  const out: string[] = [];
  for (const { content } of ordered) {
    const sentences = content.split(/(?<=[.!?。！？])\s*/u).map(key).filter(Boolean);
    if (!sentences.length || sentences.every((x) => said.has(x)) || said.has(key(content))) continue;
    out.push(content);
    said.add(key(content));
    for (const x of sentences) said.add(x);
  }
  return out;
}

/** Parse core's context block (`- [kind] content (id mem_…)` lines under `memories:`). */
function memoriesFrom(raw: string): string[] {
  const blocks = [...raw.matchAll(/<neo_context>([\s\S]*?)<\/neo_context>/g)];
  const block = blocks.map((context) => context[1] ?? '').join('\n');
  const out: { kind?: string; content: string }[] = [];
  let inMemories = false;
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (/^memories:/i.test(trimmed)) {
      inMemories = true;
      continue;
    }
    if (!inMemories) continue;
    if (!trimmed.startsWith('-')) {
      if (/^[a-z]+:/i.test(trimmed)) inMemories = false;
      continue;
    }
    const kind = /^-\s*\[([^\]]*)\]/.exec(trimmed)?.[1]?.trim().toLowerCase();
    const content = trimmed
      .replace(/^-\s*/, '')
      .replace(/^\[[^\]]*\]\s*/, '')
      .replace(/\s*\(id [^)]*\)\s*$/, '')
      .trim();
    if (content) out.push(kind ? { kind, content } : { content });
  }
  return rememberedLines(out);
}

function readTurn(messages: readonly ChatMessage[]): UserTurn {
  const raw = textOf(lastUser(messages));
  const ui = /<ui_event>([\s\S]*?)<\/ui_event>/.exec(raw);
  const uiLabel = ui ? /activated "([^"]+)"/.exec(ui[1] ?? '')?.[1] : undefined;
  const text = raw
    .replace(/<neo_context>[\s\S]*?<\/neo_context>/g, ' ')
    .replace(/<neo_notice>[\s\S]*?<\/neo_notice>/g, ' ')
    .replace(/<ui_event>[\s\S]*?<\/ui_event>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const contexts = [...raw.matchAll(/<neo_context>([\s\S]*?)<\/neo_context>/g)];
  const incognito = contexts.some((context) => /^note:.*(?:incognito|off the record)/im.test(context[1] ?? ''));
  const turn: UserTurn = { text, lang: langOf(text || raw), memories: memoriesFrom(raw), incognito };
  if (uiLabel) turn.uiEvent = uiLabel;
  return turn;
}

function toolSchemaProps(request: ChatRequest, name: string): Record<string, unknown> | null {
  const tool = request.tools?.find((t) => t.name === name);
  if (!tool) return null;
  const props = (tool.inputSchema as { properties?: unknown }).properties;
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
}

const hasTool = (request: ChatRequest, name: string) => toolSchemaProps(request, name) !== null;

/** Add `key: value` only when the tool's schema declares that property. */
function withOptional(request: ChatRequest, tool: string, input: Record<string, unknown>, optional: Record<string, unknown | undefined>): Record<string, unknown> {
  const props = toolSchemaProps(request, tool) ?? {};
  for (const [k, v] of Object.entries(optional)) if (v !== undefined && v !== '' && k in props) input[k] = v;
  return input;
}

// ───────────────────────────── text helpers ─────────────────────────────

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const stripEdges = (s: string) => s.replace(/^[\s,，:：;；]+|[\s.,，。!！?？:：;；]+$/g, '').trim();
const ensurePeriod = (s: string, lang: Lang) => (/[.!?。！？]$/.test(s) ? s : `${s}${lang === 'zh' ? '。' : '.'}`);
const quote = (s: string) => `“${s}”`;

function truncateWords(s: string, maxWords: number, maxChars = 60): string {
  const words = s.split(/\s+/).filter(Boolean).slice(0, maxWords);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxChars) break;
    out = next;
  }
  return out || s.slice(0, maxChars);
}

const MODALS = new Set(['can', 'could', 'will', 'would', 'should', 'must', 'may', 'might', 'shall']);

/** English verb → third-person singular ("like" → "likes", "study" → "studies"). */
function conjugate(verb: string): string {
  const v = verb.toLowerCase();
  if (MODALS.has(v)) return verb;
  if (v === 'am' || v === "'m") return 'is';
  if (v === 'have' || v === "'ve") return 'has';
  if (v === 'do') return 'does';
  if (v === "don't" || v === 'dont') return 'does not';
  if (v === "didn't") return 'did not';
  if (v === "can't") return 'cannot';
  if (v === 'was' || v === 'did' || v.endsWith('ed')) return verb;
  if (/(s|sh|ch|x|z|o)$/.test(v)) return `${verb}es`;
  if (/[^aeiou]y$/.test(v)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}

/** First-person English statement → a self-contained third-person one ("I prefer X" → "The user prefers X."). */
function thirdPersonEn(statement: string): string {
  let s = stripEdges(statement);
  s = s.replace(/\bI'm\b/g, 'I am').replace(/\bI've\b/g, 'I have');
  s = s.replace(/\bI\s+([A-Za-z']+)/g, (_m, verb: string) => `the user ${conjugate(verb)}`);
  s = s.replace(/\bmy\b/gi, "the user's").replace(/\bmine\b/gi, "the user's").replace(/\bmyself\b/gi, 'themselves').replace(/\bme\b/gi, 'the user');
  return ensurePeriod(capitalize(s), 'en');
}

/** Short label for a first-person statement ("I am allergic to peanuts" → "Allergic to peanuts"). */
function labelEn(statement: string): string {
  let s = stripEdges(statement).replace(/\bI'm\b/, 'I am');
  const m = /^I\s+(?:am\s+)?([A-Za-z']+)(.*)$/.exec(s);
  if (m) s = /^I\s+am\s/.test(s) ? `${m[1]}${m[2]}` : `${conjugate(m[1]!)}${m[2]}`;
  else s = s.replace(/^my\s+/i, '');
  return capitalize(truncateWords(s, 8));
}

function thirdPersonZh(statement: string): string {
  const s = stripEdges(statement).replace(new RegExp(`我(?=${ZH_RELATIONS})`, 'g'), '用户的');
  return ensurePeriod(s.replace(/我的/g, '用户的').replace(/我/g, '用户'), 'zh');
}

const labelZh = (statement: string) => stripEdges(statement).replace(/^我的?/, '').slice(0, 30);

const ZH_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "8", "十", "十二", "二十五", "两" → number. */
function zhNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? ZH_DIGITS[m[1]]! : 1) * 10 + (m[2] ? ZH_DIGITS[m[2]]! : 0);
  return s.length === 1 && s in ZH_DIGITS ? ZH_DIGITS[s]! : null;
}

// ───────────────────────────── time phrases ─────────────────────────────

interface TimePhrase {
  when: string;
  /** The matched text, removed from the reminder title. */
  match: string;
}

const EN_TIME = String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midnight)`;
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const DAY_PARTS: Record<string, string> = { morning: '9:00', afternoon: '15:00', evening: '19:00', night: '21:00' };

function unitWord(unit: string, n: number): string {
  const u = unit.toLowerCase();
  const base = /^m/.test(u) ? 'minute' : /^h/.test(u) ? 'hour' : /^d/.test(u) ? 'day' : 'week';
  return n === 1 ? base : `${base}s`;
}

function findTimeEn(text: string): TimePhrase | null {
  let m = /\bin\s+(half an?\s+hour)\b/i.exec(text);
  if (m) return { when: 'in 30 minutes', match: m[0] };
  m = /\bin\s+(\d+(?:\.\d+)?|an?|one)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i.exec(text);
  if (m) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : 1;
    return { when: `in ${n} ${unitWord(m[2]!, n)}`, match: m[0] };
  }
  m = new RegExp(String.raw`\b(today|tonight|tomorrow)(?:\s+(morning|afternoon|evening|night))?(?:\s+(at)?\s*${EN_TIME})?\b`, 'i').exec(text);
  if (m) {
    const day = m[1]!.toLowerCase();
    if (m[4]) return { when: `${day}${m[3] ? ' at' : ''} ${m[4].replace(/\s+/g, '').toLowerCase()}`, match: m[0] };
    if (m[2] && day !== 'tonight') return { when: `${day} ${DAY_PARTS[m[2].toLowerCase()]}`, match: m[0] };
    return { when: day === 'tomorrow' ? 'tomorrow 9:00' : day === 'tonight' ? 'tonight' : 'in 1 hour', match: m[0] };
  }
  m = new RegExp(String.raw`\b(?:(on|next|this)\s+)?(${WEEKDAYS})(?:\s+(at)?\s*${EN_TIME})?\b`, 'i').exec(text);
  if (m) {
    const when = [m[1]?.toLowerCase() === 'next' ? 'next' : '', m[2]!.toLowerCase(), m[4] ? `${m[3] ? 'at ' : ''}${m[4].replace(/\s+/g, '').toLowerCase()}` : '']
      .filter(Boolean)
      .join(' ');
    return { when, match: m[0] };
  }
  m = new RegExp(String.raw`\bat\s+${EN_TIME}`, 'i').exec(text);
  if (m) return { when: `at ${m[1]!.replace(/\s+/g, '').toLowerCase()}`, match: m[0] };
  return null;
}

const ZH_NUM = '(\\d+|[零一二两三四五六七八九十]+)';

function findTimeZh(text: string): TimePhrase | null {
  let m = /半(?:个)?小时(?:后|以后|之后)/.exec(text);
  if (m) return { when: 'in 30 minutes', match: m[0] };
  m = new RegExp(`${ZH_NUM}\\s*(?:个)?(分钟|小时|天|周|星期)(?:后|以后|之后)`).exec(text);
  if (m) {
    const n = zhNumber(m[1]!) ?? 1;
    const unit = m[2] === '分钟' ? 'minute' : m[2] === '小时' ? 'hour' : m[2] === '天' ? 'day' : 'week';
    return { when: `in ${n} ${n === 1 ? unit : `${unit}s`}`, match: m[0] };
  }
  m = new RegExp(`(今天|今晚|明天|明早|明晚)(早上|上午|中午|下午|傍晚|晚上)?(?:${ZH_NUM}点(半|${ZH_NUM}分)?)?`).exec(text);
  if (m && m[0]) {
    const dayWord = m[1]!;
    const day = dayWord.startsWith('明') ? 'tomorrow' : 'today';
    const part = m[2] ?? (dayWord === '今晚' || dayWord === '明晚' ? '晚上' : dayWord === '明早' ? '早上' : undefined);
    if (m[3]) {
      let hour = zhNumber(m[3]) ?? 9;
      if ((part === '下午' || part === '傍晚' || part === '晚上') && hour < 12) hour += 12;
      const minute = m[4] === '半' ? 30 : m[5] ? (zhNumber(m[5]) ?? 0) : 0;
      return { when: `${day} ${hour}:${String(minute).padStart(2, '0')}`, match: m[0] };
    }
    if (dayWord === '今晚') return { when: 'tonight', match: m[0] };
    const defaults: Record<string, string> = { 早上: '8:00', 上午: '9:00', 中午: '12:00', 下午: '15:00', 傍晚: '18:00', 晚上: '20:00' };
    return { when: `${day} ${part ? defaults[part] : '9:00'}`, match: m[0] };
  }
  return null;
}

// ───────────────────────────── intents ─────────────────────────────

type Intent = (turn: UserTurn, request: ChatRequest) => ToolCall | null;

interface ReminderRequest {
  title: string;
  when: string;
  /** How the user phrased what to be reminded of ("to drink water", "about the meeting"). */
  connector: 'to' | 'about' | null;
  lang: Lang;
}

/** "Remind me to drink water in 2 minutes" / "提醒我10分钟后喝水" → title, time phrase and phrasing. */
function parseReminder(text: string): ReminderRequest | null {
  if (/提醒我/.test(text)) {
    const time = findTimeZh(text);
    let title = text.replace(time?.match ?? '', '').replace(/(?:请|麻烦|帮我)?提醒我(?:一下)?/, '');
    title = stripEdges(title.replace(/^(?:要|记得|该)/, ''));
    return { title: title || '提醒', when: time?.when ?? 'in 10 minutes', connector: null, lang: 'zh' };
  }
  const m = /\bremind me\b/i.exec(text);
  if (!m) return null;
  const time = findTimeEn(text);
  let rest = text.slice(m.index + m[0].length);
  if (time) rest = rest.replace(time.match, ' ');
  rest = rest.replace(/\s+/g, ' ').trim();
  const lead = /^(to|about|that|of)\s+/i.exec(stripEdges(rest))?.[1]?.toLowerCase();
  rest = stripEdges(rest.replace(/^(?:to|about|that|of)\s+/i, '').replace(/\s*\b(?:please|thanks|thank you)\b\s*$/i, ''));
  rest = stripEdges(rest.replace(/^(?:to|about|that|of)\s+/i, ''));
  const connector = lead === 'to' ? 'to' : lead ? 'about' : null;
  return { title: rest || 'Reminder', when: time?.when ?? 'in 10 minutes', connector, lang: 'en' };
}

const reminderIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'create_reminder')) return null;
  const reminder = parseReminder(turn.text);
  return reminder ? { name: 'create_reminder', input: { title: reminder.title, when: reminder.when } } : null;
};

const GENERIC_LISTS = new Set(['todo', 'to-do', 'to do', 'task', 'tasks', 'my']);

/** "Add oat milk to my shopping list" / "Task: pay rent" / "添加任务：交房租" → title (+ list). */
function parseTask(text: string): { title: string; list?: string } | null {
  let title: string | undefined;
  let list: string | undefined;
  let m = /^(?:please\s+)?add\s+(.+?)\s+to\s+(?:my|the|our)\s+(?:(.+?)\s+)?(?:list|to-?do list|to-?dos|tasks?)\b/i.exec(text);
  if (m) {
    title = m[1];
    const qualifier = m[2]?.toLowerCase().trim();
    if (qualifier && !GENERIC_LISTS.has(qualifier)) list = capitalize(qualifier);
  }
  m ??= /^(?:new\s+)?(?:todo|to-do|task)\s*[:：]\s*(.+)$/i.exec(text) ?? /^(?:please\s+)?add\s+(?:a\s+)?(?:new\s+)?(?:task|to-?do)\s*(?:to\s+|[:：]\s*)?(.+)$/i.exec(text);
  m ??= /^(?:please\s+)?remember\s+to\s+(.+)$/i.exec(text);
  m ??= /^(?:请)?(?:帮我)?(?:添加|新建|加个?|记个?)(?:一个)?(?:任务|待办)\s*[:：]?\s*(.+)$/.exec(text) ?? /^待办\s*[:：]\s*(.+)$/.exec(text);
  if (!m) return null;
  title = stripEdges(title ?? m[1] ?? '');
  if (!title) return null;
  return list ? { title, list } : { title };
}

const taskIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'create_task')) return null;
  const task = parseTask(turn.text);
  return task ? { name: 'create_task', input: withOptional(request, 'create_task', { title: task.title }, { list: task.list }) } : null;
};

const listTasksIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'list_tasks')) return null;
  const { text } = turn;
  const en = /\b(?:my|the)\s+(?:tasks|to-?dos|to-?do list|task list)\b/i.test(text) && !/^\s*(?:please\s+)?add\b/i.test(text);
  const zh = /我的(?:任务|待办)|(?:看看|查看|列出)(?:任务|待办)|待办(?:事项)?(?:列表|清单)/.test(text);
  return en || zh ? { name: 'list_tasks', input: {} } : null;
};

const recallIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'recall')) return null;
  const { text } = turn;
  let about: string | undefined;
  let m = /\bwhat\s+(?:do|did)\s+you\s+(?:remember|know|recall)(?:\s+about)?\s*(.*)$/i.exec(text) ?? /\bdo\s+you\s+(?:remember|know)\s+(?:anything\s+about\s+)?(.+)$/i.exec(text);
  if (m) about = stripEdges(m[1] ?? '');
  else {
    m = /你(?:还)?(?:记得|知道)(.*?)(?:吗|么|嘛)?[?？]*$/.exec(text);
    if (!m) return null;
    about = stripEdges((m[1] ?? '').replace(/^关于/, '').replace(/的(?:事|事情)?$/, ''));
  }
  const query = !about || /^(?:me|myself|about me|我|我自己)$/i.test(about) ? 'the user' : about;
  return { name: 'recall', input: { query } };
};

/** "Forget that I live in Paris" / "忘掉我住在巴黎" → what to forget. */
function parseForget(text: string): string | null {
  const m = /^(?:please\s+)?forget\s+(?:that\s+|about\s+)?(.+)$/i.exec(text) ?? /^(?:请)?(?:忘掉|忘记|删掉关于)\s*[:：]?\s*(.+)$/.exec(text);
  return stripEdges(m?.[1] ?? '') || null;
}

const forgetIntent: Intent = (turn, request) => {
  const props = toolSchemaProps(request, 'forget');
  if (!props) return null;
  const what = parseForget(turn.text);
  if (!what) return null;
  // The spec names the field `query`; the built-in tool calls it `findQuery`. Use what the schema offers.
  const key = 'findQuery' in props && !('query' in props) ? 'findQuery' : 'query';
  return { name: 'forget', input: { [key]: what } };
};

const rememberIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'remember')) return null;
  const { text, lang } = turn;
  let fact: string | undefined;
  let m = /^(?:please\s+)?(?:remember|don't forget|keep in mind|note that)(?:\s+that)?[\s,:]+(.+)$/i.exec(text);
  if (m && !/^to\s/i.test(m[1]!)) fact = m[1];
  if (!fact) {
    m = /^(?:请)?(?:帮我)?(?:记住|记一下)\s*[:：,，]?\s*(.+)$/.exec(text);
    if (m) fact = m[1];
  }
  if (!fact && (m = /^(?:please\s+)?remember\s+(to\s+.+)$/i.exec(text))) fact = `I want to remember ${m[1]}`;
  if (!fact || !stripEdges(fact)) return null;
  const zh = lang === 'zh' && HAN.test(fact);
  const content = cleanContent(zh ? thirdPersonZh(fact) : thirdPersonEn(fact));
  const label = cleanLabel(zh ? labelZh(fact) : labelEn(fact));
  return { name: 'remember', input: withOptional(request, 'remember', { content }, { label: label || undefined }) };
};

/** "Note: buy milk" / "take a note that …" / "记笔记：…" → the note text. */
function parseNote(text: string): string | null {
  const m =
    /^(?:(?:take|make|new|write)\s+a\s+)?note\s*[:：]\s*(.+)$/i.exec(text) ??
    /^(?:take|make|write)\s+a\s+note(?:\s+that|\s+about)?\s+(.+)$/i.exec(text) ??
    /^jot\s+down\s*:?\s*(.+)$/i.exec(text) ??
    /^(?:记个?笔记|笔记|备忘)\s*[:：]?\s*(.+)$/.exec(text);
  return m?.[1]?.trim() || null;
}

const noteIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'create_note')) return null;
  const content = parseNote(turn.text);
  if (!content) return null;
  const title = turn.lang === 'zh' ? stripEdges(content).slice(0, 20) : truncateWords(stripEdges(content), 8, 50);
  return { name: 'create_note', input: withOptional(request, 'create_note', { content }, { title }) };
};

const DATETIME_EN = /\bwhat(?:'s|\s+is)?\s+(?:the\s+)?(?:time|date|day)\b|\bwhat\s+time\b|\bwhat\s+day\s+is\s+(?:it|today)\b|\btoday'?s\s+date\b|\bcurrent\s+(?:time|date)\b/i;
const DATETIME_ZH = /几点|什么时间|现在时间|今天几号|几月几[号日]|星期几|周几|礼拜几|今天是什么日子/;

const datetimeIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'get_datetime')) return null;
  return DATETIME_EN.test(turn.text) || DATETIME_ZH.test(turn.text) ? { name: 'get_datetime', input: {} } : null;
};

const calculateIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'calculate')) return null;
  const normalized = turn.text.replace(/×/g, '*').replace(/÷/g, '/').replace(/＝/g, '=').replace(/（/g, '(').replace(/）/g, ')');
  const m =
    /^(?:(?:what(?:'s|\s+is)|calculate|compute|how\s+much\s+is|evaluate)\s+)?([-+*/^%().\d\s]+|(?:sqrt|abs|ln|log|sin|cos|tan)\s*\([-+*/^%().\d\s]+\)[-+*/^%().\d\s]*)\s*=?\s*[?？]?$/i.exec(
      normalized,
    ) ?? /^(?:请|帮我)?(?:算一下|计算|算算)?\s*([-+*/^%().\d\s]+)\s*(?:=|等于)?\s*(?:多少|几)?\s*[?？]?$/.exec(normalized);
  const expression = m?.[1]?.replace(/\s+/g, ' ').trim();
  // A real operation between operands (not a lone number, date or phone number in prose).
  if (!expression || !/(\d|\))\s*[-+*/^%]\s*[\d(]|^[a-z]+\s*\(/i.test(expression)) return null;
  return { name: 'calculate', input: { expression } };
};

const SHOWCASE_EN = /\b(?:show|give)\s+me\s+(?:a\s+|the\s+|some\s+|your\s+)?(?:demo|tour|showcase|dashboard|widgets?|ui|charts?)\b|\bshow\s+me\s+what\s+you\s+can\s+do\b|^(?:demo|showcase)[.!]?$/i;
const SHOWCASE_ZH = /演示|展示一下|给我看看你能做什么/;
const HELP = /\bwhat\s+can\s+you\s+do\b|^(?:help|\/help)\b|\bhow\s+do(?:es)?\s+(?:this|you|neo)\s+work\b|你能做什么|你会什么|帮助/i;

const showcaseIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'render_ui')) return null;
  if (!SHOWCASE_EN.test(turn.text) && !SHOWCASE_ZH.test(turn.text)) return null;
  return {
    name: 'render_ui',
    input: withOptional(request, 'render_ui', { blocks: showcaseBlocks(turn.lang) }, { summary: turn.lang === 'zh' ? 'NEO 组件演示' : 'A tour of NEO widgets' }),
  };
};

const webFetchIntent: Intent = (turn, request) => {
  if (!hasTool(request, 'web_fetch')) return null;
  const m = /https?:\/\/[^\s<>"'`]+/i.exec(turn.text);
  if (!m) return null;
  let url = m[0].replace(/[.,;:!?'"\]}]+$/, '');
  if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { name: 'web_fetch', input: { url } };
};

/** Order matters: the more specific requests first. */
const INTENTS: Intent[] = [reminderIntent, taskIntent, listTasksIntent, recallIntent, forgetIntent, rememberIntent, noteIntent, calculateIntent, datetimeIntent, showcaseIntent, webFetchIntent];

// ───────────────────────────── the showcase ─────────────────────────────

function showcaseBlocks(lang: Lang): UIBlock[] {
  const zh = lang === 'zh';
  return [
    {
      type: 'card',
      title: zh ? '欢迎来到 NEO' : 'Welcome to NEO',
      subtitle: zh ? '测试模式：一切都在本机离线运行' : 'Test mode: everything here runs offline',
      icon: 'sparkles',
      tone: 'accent',
      children: [
        { type: 'text', text: zh ? 'NEO 用实时组件回答，而不是一大段文字。来看看：' : 'NEO answers with live widgets instead of walls of text. A taste:' },
        {
          type: 'grid',
          columns: 3,
          children: [
            { type: 'stat', label: zh ? '提醒' : 'Reminders', value: 3, icon: 'bell', caption: zh ? '下一个：15:00 伸展' : 'Next: stretch at 15:00' },
            { type: 'stat', label: zh ? '已完成任务' : 'Tasks done', value: 12, delta: 4, deltaLabel: zh ? '本周' : 'this week', tone: 'success', icon: 'check-circle' },
            { type: 'stat', label: zh ? '记忆' : 'Memories', value: 27, icon: 'brain', caption: zh ? '聊得越多越懂你' : 'Grows as you chat' },
          ],
        },
        {
          type: 'chart',
          kind: 'bar',
          title: zh ? '本周专注时长' : 'Focus hours this week',
          unit: 'h',
          series: [
            {
              name: zh ? '专注' : 'Focus',
              data: (zh ? ['周一', '周二', '周三', '周四', '周五'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).map((x, i) => ({ x, y: [3, 5, 2, 6, 4][i]! })),
            },
          ],
        },
        { type: 'progress', label: zh ? '每周目标' : 'Weekly goal', value: 0.7, caption: zh ? '10 次锻炼完成 7 次' : '7 of 10 workouts', tone: 'success' },
        {
          type: 'tags',
          items: [
            { label: zh ? '提醒' : 'Reminders', icon: 'bell' },
            { label: zh ? '任务' : 'Tasks', icon: 'list-checks' },
            { label: zh ? '笔记' : 'Notes', icon: 'notebook' },
            { label: zh ? '记忆网络' : 'Memory net', icon: 'brain', tone: 'accent' },
          ],
        },
      ],
      actions: [
        { id: 'test_reminder', kind: 'message', label: zh ? '10 分钟后提醒我' : 'Remind me in 10 min', text: zh ? '提醒我10分钟后伸展一下' : 'Remind me to stretch in 10 minutes', style: 'primary', icon: 'bell' },
        { id: 'test_task', kind: 'message', label: zh ? '添加任务' : 'Add a task', text: zh ? '添加任务：买燕麦奶' : 'Add oat milk to my shopping list', icon: 'list-checks' },
        { id: 'test_memory', kind: 'message', label: zh ? '教我一件事' : 'Teach me something', text: zh ? '记住我喜欢靠窗的座位' : 'Remember that I prefer window seats', icon: 'brain' },
      ],
      footer: zh ? '在 设置 → 模型 中连接 AI 模型，即可畅聊。' : 'Connect an AI model in Settings → Providers for full conversations.',
    },
  ];
}

// ───────────────────────────── tool follow-ups ─────────────────────────────

/** Tool outputs arrive as objects, JSON strings, or `<untrusted_content>`-wrapped JSON. */
function readOutput(output: unknown): Record<string, unknown> {
  let value = output;
  if (typeof value === 'string') {
    const inner = /^<untrusted_content[^>]*>\n?([\s\S]*?)\n?<\/untrusted_content>$/.exec(value.trim());
    const text = inner ? inner[1]! : value;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { text };
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** "2026-10-10T20:17:00" → { date: "2026-10-10", time: "20:17" }. */
function splitLocal(local: unknown): { date: string; time: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(local ?? ''));
  return m ? { date: m[1]!, time: m[2]! } : null;
}

const ZH_WEEKDAYS: Record<string, string> = { Monday: '星期一', Tuesday: '星期二', Wednesday: '星期三', Thursday: '星期四', Friday: '星期五', Saturday: '星期六', Sunday: '星期日' };

function followUp(result: ToolResultPart, lang: Lang): string {
  const zh = lang === 'zh';
  const out = readOutput(result.output);
  if (result.isError) {
    const msg = str(out['error']) ?? str(out['text']) ?? str(out['message']) ?? (zh ? '未知错误' : 'unknown error');
    return zh ? `没能完成：${msg}` : `That didn't work: ${msg}`;
  }
  switch (result.name) {
    case 'create_reminder': {
      const r = readOutput(out['reminder']);
      const title = str(r['title']) ?? (zh ? '提醒' : 'your reminder');
      const at = splitLocal(r['dueLocal']);
      const repeat = str(r['recurrence']);
      if (zh) return `好的！我会${at ? `在 ${at.date} ${at.time} ` : ''}提醒你：${quote(title)}${repeat ? `（${repeat}）` : ''}。`;
      return `Done! I'll remind you: ${quote(title)}${at ? ` at ${at.time} on ${at.date}` : ''}${repeat ? ` (${repeat})` : ''}.`;
    }
    case 'create_task': {
      const title = str(readOutput(out['task'])['title']);
      if (zh) return title ? `已添加任务：${quote(title)}。` : '任务已添加。';
      return title ? `Added ${quote(title)} to your tasks.` : 'Task added.';
    }
    case 'list_tasks': {
      const tasks = Array.isArray(out['tasks']) ? (out['tasks'] as Record<string, unknown>[]) : [];
      if (!tasks.length) return zh ? '你还没有任务。试试说“添加任务：交房租”。' : 'You have no tasks yet. Try “Add oat milk to my shopping list”.';
      const done = tasks.filter((t) => t['done'] === true).length;
      const open = tasks.length - done;
      if (zh) return `这是你的任务：${open} 个未完成${done ? `，${done} 个已完成` : ''}。`;
      return `Here are your tasks — ${open} open${done ? `, ${done} done` : ''}.`;
    }
    case 'remember': {
      const pending = out['status'] === 'pending';
      if (zh) return pending ? '收到！你在“记忆 → 待确认”里批准后，我就会记住它。' : '记住了！';
      return pending ? "Got it — I'll remember that once you approve it (Memory → Pending)." : "Got it — I'll remember that.";
    }
    case 'recall': {
      const items = Array.isArray(out['memories']) ? (out['memories'] as Record<string, unknown>[]) : [];
      const found = items.flatMap((m) => {
        const content = str(m['content']) ?? str(m['label']);
        const kind = str(m['kind']);
        return content ? [kind ? { kind, content } : { content }] : [];
      });
      const lines = rememberedLines(found).slice(0, 5);
      if (!lines.length) return zh ? '关于这个我还什么都不记得。' : "I don't remember anything about that yet.";
      return `${zh ? '我记得：' : "Here's what I remember:"}\n${lines.map((l) => `- ${l}`).join('\n')}`;
    }
    case 'forget': {
      const n = typeof out['deleted'] === 'number' ? out['deleted'] : Array.isArray(out['forgotten']) ? out['forgotten'].length : 0;
      if (!n) return zh ? '没有找到可以忘记的相关记忆。' : "I couldn't find anything like that to forget.";
      return zh ? `好的，已忘记 ${n} 条记忆。` : `Done — I forgot ${n} ${n === 1 ? 'memory' : 'memories'}.`;
    }
    case 'create_note': {
      const title = str(readOutput(out['note'])['title']);
      if (zh) return title ? `笔记已保存：${quote(title)}。` : '笔记已保存。';
      return title ? `Saved your note ${quote(title)}.` : 'Saved your note.';
    }
    case 'get_datetime': {
      const at = splitLocal(out['local']);
      const tz = str(out['timezone']);
      const weekday = str(out['weekday']);
      if (!at) return zh ? '这是当前时间。' : "Here's the current time.";
      if (zh) return `现在是 ${at.date} ${weekday ? `${ZH_WEEKDAYS[weekday] ?? weekday} ` : ''}${at.time}${tz ? `（${tz}）` : ''}。`;
      return `It's ${at.time}${weekday ? ` on ${weekday}` : ''}, ${at.date}${tz ? ` (${tz})` : ''}.`;
    }
    case 'calculate': {
      const expr = str(out['expression']);
      const value = out['result'] ?? out['value'];
      return value === undefined ? (zh ? '算好了。' : 'Done.') : `${expr ? `${expr} = ` : ''}${String(value)}`;
    }
    case 'render_ui':
      return zh ? '给你看看 NEO 能展示的内容——点下面的按钮试试吧。' : 'Here you go — a quick tour of what NEO can show. Tap a button to try it.';
    case 'web_fetch': {
      const title = str(out['title']);
      const url = str(out['url']);
      const page = title ? quote(title.slice(0, 120)) : (url ?? (zh ? '这个页面' : 'the page'));
      return zh
        ? `我已经打开了 ${page}。测试模式下我没法阅读或总结网页——在 设置 → 模型 中连接 AI 模型即可。`
        : `I fetched ${page}. In test mode I can't read or summarize pages — connect an AI model in Settings → Providers for that.`;
    }
    default:
      return zh ? '完成！' : 'Done!';
  }
}

// ───────────────────────────── conversation ─────────────────────────────

const SUGGESTIONS: { tool: string; en: string; zh: string }[] = [
  { tool: 'create_reminder', en: 'Remind me to stretch in 10 minutes', zh: '提醒我10分钟后喝水' },
  { tool: 'create_task', en: 'Add oat milk to my shopping list', zh: '添加任务：交房租' },
  { tool: 'remember', en: 'Remember that I prefer window seats', zh: '记住我喜欢靠窗的座位' },
  { tool: 'render_ui', en: 'Show me a demo', zh: '给我演示一下' },
];

function conversation(turn: UserTurn, request: ChatRequest): string {
  const zh = turn.lang === 'zh';
  const parts: string[] = [];
  const greeting = /^(?:hi|hello|hey|yo|hiya|good\s+(?:morning|afternoon|evening))\b|^(?:你好|您好|嗨|哈喽|早上好|晚上好)/i.test(turn.text);
  const help = HELP.test(turn.text);
  const facts = dedupeFacts(findFacts(statements(turn.text)));
  const gist = turn.text.length > 80 ? `${turn.text.slice(0, 79)}…` : turn.text;

  if (turn.uiEvent) {
    parts.push(zh ? `你点击了${quote(turn.uiEvent)}。测试模式下我只能处理简单的请求。` : `You tapped ${quote(turn.uiEvent)}. In test mode I can only handle simple requests.`);
  } else if (help) {
    parts.push(
      zh
        ? '测试模式下我可以：设置提醒、管理任务和笔记、记住关于你的事情、计算、报时，还能展示 NEO 的界面组件。'
        : 'In test mode I can set reminders, keep tasks and notes, remember things about you, do quick math, tell the time and show off NEO’s widgets.',
    );
  } else if ((greeting && !facts.length) || !gist) {
    parts.push(zh ? '你好！我是 NEO，现在处于测试模式，还没有连接 AI 模型。' : "Hi! I'm NEO, running in test mode — there's no AI model connected yet.");
  } else if (facts.length && turn.incognito) {
    parts.push(zh ? '谢谢告诉我！这是无痕对话，所以我不会记住它。' : "Thanks for telling me! This is an incognito conversation, so I won't remember it.");
  } else if (facts.length) {
    const said = facts.map((f) => f.content.replace(/[.。]$/, '')).join(zh ? '；' : '; ');
    const hi = greeting ? (zh ? '你好！' : 'Hi! ') : '';
    parts.push(zh ? `${hi}很高兴知道！我会记在心里：${said}。` : `${hi}Nice to know! I'll keep that in mind: ${said}.`);
  } else {
    parts.push(zh ? `我现在处于测试模式，还不能真正聊${quote(gist)}。` : `I'm in test mode, so I can't really chat about ${quote(gist)} yet.`);
  }

  const memories = turn.memories.slice(0, 2).map((m) => m.replace(/[.。]$/, ''));
  if (memories.length) parts.push(zh ? `不过我记得：${memories.join('；')}。` : `I do remember: ${memories.join('; ')}.`);

  const tries = SUGGESTIONS.filter((s) => hasTool(request, s.tool)).map((s) => quote(zh ? s.zh : s.en));
  if (tries.length) parts.push(zh ? `可以试试：${tries.join('、')}。` : `Things you can try: ${tries.join(', ')}.`);
  parts.push(zh ? '在 设置 → 模型 中连接 AI 模型，就能真正对话。' : 'Connect an AI model in Settings → Providers for real conversations.');
  return parts.join(zh ? '' : ' ');
}

// ───────────────────────────── memory extraction ─────────────────────────────

interface CreateOp {
  op: 'create';
  kind: 'fact' | 'preference';
  label: string;
  content: string;
  importance: number;
  sensitivity?: 'sensitive';
  entities?: string[];
  entityType?: string;
}

interface Found {
  index: number;
  op: CreateOp;
}

/** Double quotes never belong in a memory: labels are titles and contents are plain statements. */
const QUOTES = /["“”„‟«»「」『』]/g;

/** A clean memory label: one line, no quotes, no punctuation at either end ("Prefers window seats"). */
function cleanLabel(s: string): string {
  return stripEdges(s.replace(QUOTES, ' ').replace(/\s+/g, ' '))
    .replace(/[\s.。…、,，;；:：!！?？]+$/u, '')
    .trim();
}

/** A clean memory statement: one line, no quotes. */
function cleanContent(s: string): string {
  return s
    .replace(QUOTES, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?。，；：！？])/gu, '$1')
    .trim();
}

const EN_QUESTION =
  /^(?:what|what's|whats|who|who's|whom|whose|where|where's|when|why|how|which|do|does|did|don't|doesn't|can|could|would|will|won't|is|isn't|are|aren't|am|was|were|should|shall|may|might|have|has)\b/i;
const ZH_QUESTION = /(?:吗|嗎|么|麼|呢)[\s。.!！~]*$|什么|什麼|谁|誰|哪里|哪裡|哪儿|哪些|怎么|怎麼|为什么|為什麼/;

/** A question rather than a statement: "What do you remember about me?", "Do you know my name", "你记得我吗". */
function isQuestion(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return false;
  if (/[?？]\s*$/.test(s)) return true;
  return HAN.test(s) ? ZH_QUESTION.test(s) : EN_QUESTION.test(s);
}

/** The statements in a text, questions removed: a question never teaches NEO a fact about the user. */
function statements(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*/u)
    .filter((s) => s.trim() && !isQuestion(s))
    .join(' ')
    .trim();
}

const CHIT_CHAT =
  /^(?:hi|hello|hey|yo|hiya|howdy|greetings|good\s+(?:morning|afternoon|evening|night)|thanks|thank\s+you|thx|ty|cheers|ok|okay|cool|nice|great|awesome|perfect|bye|goodbye|see\s+you|yes|yeah|yep|no|nope|sure|got\s+it|你好|您好|嗨|哈喽|哈啰|早上好|早安|下午好|晚上好|晚安|谢谢|多谢|感谢|好的|好|行|嗯|哦|再见|拜拜)(?:\s+(?:there|neo|all|everyone|a\s+lot|so\s+much|very\s+much|again))*$/i;

/** The text without the greetings, thanks and acknowledgements around it ("Hi! …", "…, thanks"). */
function withoutChitChat(text: string): string {
  const pieces = text.split(/([,.!?;~，。！？；、]+\s*)/u);
  let out = '';
  for (let i = 0; i < pieces.length; i += 2) {
    const chunk = pieces[i]!.trim();
    if (!chunk || CHIT_CHAT.test(chunk)) continue;
    const join = out && !/[　-〿＀-￯]$/u.test(out) ? ' ' : '';
    out += `${join}${chunk}${(pieces[i + 1] ?? '').trim()}`;
  }
  return out.trim();
}

const RELATIONS = 'best friend|wife|husband|partner|girlfriend|boyfriend|sister|brother|mom|mother|mum|dad|father|son|daughter|friend|boss|manager|colleague|coworker|roommate|dog|cat|pet';
const PETS = new Set(['dog', 'cat', 'pet']);
const NAME = String.raw`([\p{L}][\p{L}'’-]*)(?:\s+([\p{L}][\p{L}'’-]*))?`;
/** Clause tails that end a place / organization / object phrase. */
const cutClause = (s: string) => stripEdges(s.split(/\s+(?:and|but|with|since|because|so)\s+/i)[0] ?? s);

/** "Richard" / "Mia Chen"; a lowercase second word ("Mia and …") is not part of the name. */
function nameFrom(first: string, second: string | undefined): string {
  return capitalize(second && /^\p{Lu}/u.test(second) ? `${first} ${second}` : first);
}

/** A found statement with a clean label and content (dropped when nothing is left of the label). */
function adder(found: Found[]): (index: number, op: CreateOp) => void {
  return (index, op) => {
    const label = cleanLabel(op.label);
    if (label) found.push({ index, op: { ...op, label, content: cleanContent(op.content) } });
  };
}

function extractEn(text: string): Found[] {
  const found: Found[] = [];
  const add = adder(found);

  for (const m of text.matchAll(new RegExp(String.raw`\b(?:my name is|call me|i'm called|i am called)\s+${NAME}`, 'giu'))) {
    const name = nameFrom(m[1]!, m[2]);
    add(m.index, { op: 'create', kind: 'fact', label: `Name: ${name}`, content: `The user's name is ${name}.`, importance: 0.95 });
  }
  // "I'm Tom" (a capitalized word that ends the clause; "I'm tired" is not a name).
  for (const m of text.matchAll(/\bI(?:'m|’m| am)\s+(\p{Lu}[\p{L}'’-]+)(?=\s*(?:[,.!?;]|$))/gu)) {
    add(m.index, { op: 'create', kind: 'fact', label: `Name: ${m[1]}`, content: `The user's name is ${m[1]}.`, importance: 0.95 });
  }
  for (const m of text.matchAll(/\bi\s+(?:really\s+|just\s+)?(?:don'?t|do\s+not)\s+(?:like|love|enjoy)\s+([^.!?,;]+)|\bi\s+(?:hate|dislike|can'?t\s+stand)\s+([^.!?,;]+)/gi)) {
    const what = stripEdges(m[1] ?? m[2] ?? '');
    if (what) add(m.index, { op: 'create', kind: 'preference', label: `Dislikes ${what}`, content: `The user does not like ${what}.`, importance: 0.6 });
  }
  for (const m of text.matchAll(/\bi\s+(?:really\s+|also\s+|just\s+|absolutely\s+)?(like|love|enjoy|adore|prefer)\s+([^.!?,;]+)/gi)) {
    const verb = conjugate(m[1]!.toLowerCase());
    const what = stripEdges(m[2]!);
    if (what) add(m.index, { op: 'create', kind: 'preference', label: `${capitalize(verb)} ${what}`, content: `The user ${verb} ${what}.`, importance: 0.7 });
  }
  for (const m of text.matchAll(/(?:^|[.!?]\s+|\bplease\s+)remember(?:\s+that)?[\s,:]+(?!to\s)([^.!?]+)/gi)) {
    const fact = stripEdges(m[1]!);
    if (fact) add(m.index, { op: 'create', kind: 'fact', label: labelEn(fact), content: thirdPersonEn(fact), importance: 0.8 });
  }
  for (const m of text.matchAll(new RegExp(String.raw`\bmy\s+(${RELATIONS})(?:'s\s+name)?\s+is\s+(?:called\s+|named\s+)?${NAME}`, 'giu'))) {
    if (!/^\p{Lu}/u.test(m[2]!)) continue; // "my dog is cute" is not a name
    const relation = m[1]!.toLowerCase();
    const name = nameFrom(m[2]!, m[3]);
    add(m.index, {
      op: 'create',
      kind: 'fact',
      label: `${capitalize(relation)}: ${name}`,
      content: `The user's ${relation} is ${name}.`,
      importance: 0.9,
      entities: [name],
      entityType: PETS.has(relation) ? 'pet' : 'person',
    });
  }
  for (const m of text.matchAll(/\bi\s+(?:live|am\s+living|'m\s+living)\s+in\s+([^.!?,;]+)/gi)) {
    const place = cutClause(m[1]!);
    if (place) add(m.index, { op: 'create', kind: 'fact', label: `Lives in ${place}`, content: `The user lives in ${place}.`, importance: 0.8, entities: [place], entityType: 'place' });
  }
  for (const m of text.matchAll(/\bi\s+work\s+(?:at|for)\s+([^.!?,;]+)/gi)) {
    const org = cutClause(m[1]!);
    if (org) add(m.index, { op: 'create', kind: 'fact', label: `Works at ${org}`, content: `The user works at ${org}.`, importance: 0.8, entities: [org], entityType: 'organization' });
  }
  for (const m of text.matchAll(/\bi(?:'m|\s+am)\s+allergic\s+to\s+([^.!?,;]+)/gi)) {
    const what = cutClause(m[1]!);
    if (what) add(m.index, { op: 'create', kind: 'fact', label: `Allergic to ${what}`, content: `The user is allergic to ${what}.`, importance: 0.95, sensitivity: 'sensitive' });
  }
  return found;
}

const ZH_END = '(?=[，。！？,.!?；;\\s]|$)';
const ZH_RELATIONS = '妹妹|姐姐|哥哥|弟弟|妈妈|母亲|爸爸|父亲|老婆|老公|妻子|丈夫|女朋友|男朋友|儿子|女儿|朋友|老板|同事|室友|狗|猫';

function extractZh(text: string): Found[] {
  const found: Found[] = [];
  const add = adder(found);
  for (const m of text.matchAll(new RegExp(`(?:我叫|我的名字是|我的名字叫)(.{1,12}?)${ZH_END}`, 'g'))) {
    add(m.index, { op: 'create', kind: 'fact', label: `名字：${m[1]}`, content: `用户的名字是${m[1]}。`, importance: 0.95 });
  }
  for (const m of text.matchAll(new RegExp(`我(?:很|也|特别|真的)?不喜欢(.+?)${ZH_END}`, 'g'))) {
    add(m.index, { op: 'create', kind: 'preference', label: `不喜欢${m[1]}`, content: `用户不喜欢${m[1]}。`, importance: 0.6 });
  }
  for (const m of text.matchAll(new RegExp(`我(?:很|也|超|特别|最|真的)?(喜欢|爱)(.+?)${ZH_END}`, 'g'))) {
    add(m.index, { op: 'create', kind: 'preference', label: `${m[1]}${m[2]}`, content: `用户${m[1]}${m[2]}。`, importance: 0.7 });
  }
  // "记住…" / "记一下…" / "别忘了…" (not "记得", which usually asks whether NEO remembers).
  for (const m of text.matchAll(new RegExp(`(?:记住|记一下|别忘了)[:：,，]?(.+?)(?=[。！？!?]|$)`, 'g'))) {
    const fact = stripEdges(m[1]!);
    if (fact) add(m.index, { op: 'create', kind: 'fact', label: labelZh(fact), content: thirdPersonZh(fact), importance: 0.8 });
  }
  for (const m of text.matchAll(new RegExp(`我的?(${ZH_RELATIONS})(叫|是)(.+?)${ZH_END}`, 'g'))) {
    add(m.index, {
      op: 'create',
      kind: 'fact',
      label: `${m[1]}：${m[3]}`,
      content: `用户的${m[1]}${m[2]}${m[3]}。`,
      importance: 0.9,
      entities: [m[3]!],
      entityType: m[1] === '狗' || m[1] === '猫' ? 'pet' : 'person',
    });
  }
  for (const m of text.matchAll(new RegExp(`我住在(.+?)${ZH_END}`, 'g'))) {
    add(m.index, { op: 'create', kind: 'fact', label: `住在${m[1]}`, content: `用户住在${m[1]}。`, importance: 0.8, entities: [m[1]!], entityType: 'place' });
  }
  for (const m of text.matchAll(/我在(.+?)(?:工作|上班)/g)) {
    add(m.index, { op: 'create', kind: 'fact', label: `在${m[1]}工作`, content: `用户在${m[1]}工作。`, importance: 0.8, entities: [m[1]!], entityType: 'organization' });
  }
  return found;
}

const normalizeFact = (s: string) => s.toLowerCase().replace(/[\s.,，。!！?？'’"“”]/g, '');

/** Every fact the test script can recognize in a text, English and Chinese. */
function findFacts(text: string): Found[] {
  return [...extractEn(text), ...extractZh(text)];
}

/** Facts in text order; a repeated statement keeps the first op, enriched with the other's entities. */
function dedupeFacts(found: Found[]): CreateOp[] {
  const byKey = new Map<string, CreateOp>();
  for (const { op } of [...found].sort((a, b) => a.index - b.index)) {
    const key = normalizeFact(op.content);
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, { ...op });
      continue;
    }
    kept.importance = Math.max(kept.importance, op.importance);
    if (!kept.entities && op.entities) {
      kept.entities = op.entities;
      if (op.entityType) kept.entityType = op.entityType;
    }
  }
  return [...byKey.values()];
}

interface RelatedMemory {
  id: string;
  kind: string;
  label: string;
  content: string;
}

/**
 * Read memory's extraction prompt (`buildExtractionInput` in packages/memory/src/extract.ts):
 * "Existing related memories (id | kind | label | content):\n- <id> | <kind> | <label> | <content>",
 * policy lines, and last "Latest exchange:\nUser: <text>\nNEO: <text>" with continuation lines
 * indented by two spaces. Returns the related memories and ONLY the user's words: the exchange is
 * cut at the last "\nNEO: " after the "User: " marker (a blank line before it is tolerated too),
 * so NEO's own reply never teaches NEO anything about the user.
 */
function splitExchange(prompt: string): { user: string; related: RelatedMemory[] } {
  const anchor = prompt.indexOf('Latest exchange:');
  const from = Math.max(0, anchor);
  const marker = /(?:^|\n)User: /.exec(prompt.slice(from));
  const related: RelatedMemory[] = [];
  const head = marker ? prompt.slice(0, from + marker.index) : prompt;
  for (const line of head.split('\n')) {
    const m = /^-\s*(\S+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.+)$/.exec(line.trim());
    if (m) related.push({ id: m[1]!, kind: m[2]!, label: m[3]!, content: m[4]! });
  }
  if (!marker) return { user: '', related };
  let user = prompt.slice(from + marker.index + marker[0].length);
  const neo = user.lastIndexOf('\nNEO: ');
  if (neo >= 0) user = user.slice(0, neo);
  return { user: user.replace(/\n {2}/g, '\n').trim(), related };
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

const BASE_VERBS: Record<string, string> = { is: 'are', was: 'were', has: 'have', does: 'do', 'does not': 'do not' };

/** Third-person singular → plural form, for "they …" ("loves" → "love", "is" → "are"). */
function baseVerb(verb: string): string {
  const v = verb.toLowerCase();
  if (BASE_VERBS[v]) return BASE_VERBS[v];
  if (/(?:ss|sh|ch|x|z|o)es$/.test(v)) return verb.slice(0, -2);
  if (/[^aeiou]ies$/.test(v)) return `${verb.slice(0, -3)}y`;
  if (/[^s]s$/.test(v)) return verb.slice(0, -1);
  return verb;
}

/** Episode label for a turn that taught a fact: "The user loves hiking." → "Said they love hiking". */
function saidLabel(op: CreateOp): string {
  const s = op.content.replace(/[.。!！]+$/u, '');
  if (HAN.test(s)) return cleanLabel(`说${s.replace(/^用户的/, '自己的').replace(/^用户/, '自己')}`).slice(0, 30);
  const they = s
    .replace(/^The user's\s+/, 'their ')
    .replace(/^The user\s+(does not|did not|cannot|[A-Za-z']+)/, (_m, verb: string) => `they ${baseVerb(verb)}`)
    .replace(/^The\b/, 'the');
  return cleanLabel(capitalize(truncateWords(`Said ${they}`, 10, 60)));
}

/** Episode label for a request NEO handled with a tool ("Asked for a reminder to drink water"). */
function requestLabel(text: string): string | null {
  const reminder = parseReminder(text);
  if (reminder) {
    if (reminder.lang === 'zh') return cleanLabel(`要求提醒${reminder.title}`).slice(0, 30);
    const what = truncateWords(reminder.title, 8, 50);
    const how = reminder.connector === 'to' ? ` to ${what}` : reminder.connector ? ` about ${what}` : `: ${what}`;
    return cleanLabel(`Asked for a reminder${how}`);
  }
  const task = parseTask(text);
  if (task) return cleanLabel(HAN.test(task.title) ? `添加了待办${task.title}`.slice(0, 30) : `Added a task: ${truncateWords(task.title, 8, 50)}`);
  const note = parseNote(text);
  if (note) return HAN.test(note) ? '记了一条笔记' : cleanLabel(`Took a note about ${truncateWords(stripEdges(note), 6, 40)}`);
  const forget = parseForget(text);
  if (forget) return cleanLabel(HAN.test(forget) ? `要求忘掉${forget}`.slice(0, 30) : `Asked to forget ${truncateWords(forget, 8, 50)}`);
  return null;
}

const MEMORY_QUESTION = /\b(?:what|tell|show)\b.*\b(?:remember|know|recall)\b|你(?:还)?(?:记得|知道)/i;
const ARITHMETIC = /^[-+*/^%().\d\s=×÷]+$|^(?:what(?:'s|\s+is)|calculate|compute|how\s+much\s+is)\s+[-+*/^%().\d\s]+/i;

/** Quick lookups and app actions that leave nothing worth remembering (time, math, a showcase, help). */
function isLookup(text: string): boolean {
  return [DATETIME_EN, DATETIME_ZH, SHOWCASE_EN, SHOWCASE_ZH, HELP, MEMORY_QUESTION, ARITHMETIC].some((re) => re.test(text));
}

interface TestEpisode {
  label: string;
  summary: string;
  importance: number;
}

/**
 * The episode of an exchange, labelled with a short summary of what the user did
 * ("Introduced themselves", "Asked for a reminder to drink water"), or null for
 * trivial exchanges: greetings, thanks, questions (also about memory) and quick lookups.
 */
function testEpisode(text: string, facts: CreateOp[], lang: Lang): TestEpisode | null {
  const core = withoutChitChat(text);
  if (!core) return null;
  const zh = lang === 'zh';
  if (facts.length) {
    const intro = facts.some((f) => /^(?:Name|名字)[:：]/.test(f.label));
    const label = intro ? (zh ? '做了自我介绍' : 'Introduced themselves') : saidLabel(facts[0]!);
    return { label, summary: facts.map((f) => f.content).join(zh ? '' : ' '), importance: 0.5 };
  }
  const request = requestLabel(core);
  if (request) return { label: request, summary: zh ? `用户${request}。` : `The user ${lowerFirst(request)}.`, importance: 0.3 };
  const said = statements(core);
  if (!said || isLookup(core) || said.length < (zh ? 6 : 15)) return null;
  const first = said.split(zh ? /[，。！？,.!?；;]/u : /[.!?;](?:\s|$)/)[0] ?? said;
  const label = cleanLabel(zh ? labelZh(first).slice(0, 20) : labelEn(first));
  if (!label) return null;
  const summary = cleanContent(clip(zh ? thirdPersonZh(said) : thirdPersonEn(said), 300));
  return { label, summary, importance: 0.3 };
}

function memoryExtract(request: ChatRequest): string {
  const { user, related } = splitExchange(textOf(lastUser(request.messages)));
  const text = user
    .replace(/<neo_context>[\s\S]*?<\/neo_context>/g, ' ')
    .replace(/<ui_event>[\s\S]*?<\/ui_event>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Only the user's statements: questions ("what do you remember about me?") teach nothing.
  const facts = dedupeFacts(findFacts(statements(text)));

  const memories: (CreateOp | { op: 'reinforce'; id: string })[] = [];
  for (const op of facts) {
    const existing = related.find(
      (r) => normalizeFact(r.content) === normalizeFact(op.content) || (r.kind === op.kind && normalizeFact(r.label) === normalizeFact(op.label)),
    );
    memories.push(existing ? { op: 'reinforce', id: existing.id } : op);
  }
  return JSON.stringify({ episode: testEpisode(text, facts, langOf(text)), memories, links: [] });
}

/** memory's consolidation prompt lists "Episodes:\n- <label>: <content>" lines. */
function memoryConsolidate(request: ChatRequest): string {
  const prompt = textOf(lastUser(request.messages));
  const section = /Episodes:\s*\n([\s\S]*?)(?:\n\s*\n|$)/.exec(prompt)?.[1] ?? '';
  const labels = section
    .split('\n')
    .map((l) => /^\s*-\s*(.+?)(?::\s|$)/.exec(l)?.[1]?.trim())
    .filter((l): l is string => Boolean(l));
  if (!labels.length) return JSON.stringify({ summary: null, facts: [] });
  const zh = HAN.test(labels.join(''));
  const first = labels[0]!;
  const label = zh
    ? `回顾：${first}${labels.length > 1 ? ` 等 ${labels.length} 段对话` : ''}`
    : `Recap: ${first}${labels.length > 1 ? ` (+${labels.length - 1} more)` : ''}`;
  const content = zh ? `最近的对话涉及：${labels.join('；')}。` : `Recent conversations covered: ${labels.join('; ')}.`;
  return JSON.stringify({ summary: { label: label.slice(0, 120), content, importance: 0.5 }, facts: [] });
}

/** core's title prompt ends with "User: <text>\nAssistant: <text>". */
function title(request: ChatRequest): string {
  const prompt = textOf(lastUser(request.messages));
  const m = /(?:^|\n)User: ([\s\S]*?)(?:\nAssistant:[\s\S]*)?$/.exec(prompt);
  let text = (m ? m[1]! : readTurn(request.messages).text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (HAN.test(text)) {
    text = stripEdges(text.split(/[，。！？,.!?\n]/)[0] ?? text).slice(0, 15);
    return text || '新对话';
  }
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = stripEdges(text.replace(/\s*\b(?:please|pls|thanks|thank you)\s*$/i, ''));
  }
  return capitalize(truncateWords(text, 8, 48)) || 'New conversation';
}

// ───────────────────────────── the script ─────────────────────────────

export const scriptedMockScript: MockScript = (request: ChatRequest): MockReply => {
  switch (request.metadata?.['purpose']) {
    case 'memory-extract':
      return { text: memoryExtract(request) };
    case 'memory-consolidate':
      return { text: memoryConsolidate(request) };
    case 'title':
      return { text: title(request) };
  }

  const last = request.messages[request.messages.length - 1];
  if (last?.role === 'tool') {
    // After a tool round: always answer with text, never another call.
    const lang = langOf(readTurn(request.messages).text);
    const results = last.parts.filter((p): p is ToolResultPart => p.type === 'tool_result');
    return { text: results.length ? results.map((r) => followUp(r, lang)).join('\n') : lang === 'zh' ? '完成！' : 'Done!' };
  }

  const turn = readTurn(request.messages);
  if (turn.text && !turn.uiEvent) {
    for (const intent of INTENTS) {
      const call = intent(turn, request);
      if (call) return { toolCalls: [call] };
    }
  }
  return { text: conversation(turn, request) };
};
