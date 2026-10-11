/**
 * Text helpers shared by the read and write paths: normalization, Unicode-aware
 * term matching (entities, blocked topics), the secret filter, the lexical
 * query builder and the "broad question about me" detector.
 */

/** Normalized form used for `norm_label`, entity lookup and matching: NFKC, lower case, single spaces. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Scripts written without spaces between words; terms in them match as substrings. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

export function hasCJK(text: string): boolean {
  return UNSPACED_SCRIPT.test(text);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * True when `term` occurs in `text` as a whole word (Unicode-aware, so "Zoë"
 * and "C++" work), or as a substring for CJK/kana/hangul terms. Both arguments
 * must already be normalized with {@link normalizeText}. With `plural`, an
 * English plural suffix ("s"/"es") after the term still counts as a match.
 */
export function containsTerm(text: string, term: string, plural = false): boolean {
  if (!term) return false;
  if (hasCJK(term)) return text.includes(term);
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    from = at + 1;
    const before = at > 0 ? text[at - 1] : undefined;
    if (isWordChar(term[0]) && isWordChar(before)) continue;
    let end = at + term.length;
    if (plural) {
      if (text.startsWith('es', end) && !isWordChar(text[end + 2])) end += 2;
      else if (text[end] === 's' && !isWordChar(text[end + 1])) end += 1;
    }
    if (isWordChar(term[term.length - 1]) && isWordChar(text[end])) continue;
    return true;
  }
}

/** Singular variants of an English topic word, so "finances" also blocks "finance". */
function topicVariants(topic: string): string[] {
  const out = [topic];
  if (hasCJK(topic) || topic.includes(' ')) return out;
  if (topic.endsWith('ies') && topic.length > 4) out.push(`${topic.slice(0, -3)}y`);
  else if (/(?:s|x|z|ch|sh)es$/.test(topic)) out.push(topic.slice(0, -2));
  else if (topic.endsWith('s') && !/(?:ss|us|is)$/.test(topic) && topic.length > 4) out.push(topic.slice(0, -1));
  return out;
}

/**
 * True when `text` mentions one of the blocked topics: case-insensitive whole
 * words (plurals included), substrings for CJK. Blank topics are ignored.
 */
export function mentionsBlockedTopic(text: string, blockedTopics: readonly string[]): boolean {
  if (!blockedTopics.length || !text) return false;
  const haystack = normalizeText(text);
  for (const raw of blockedTopics) {
    const topic = normalizeText(raw);
    if (!topic) continue;
    if (topicVariants(topic).some((t) => containsTerm(haystack, t, true))) return true;
  }
  return false;
}

// ─────────────────────────────── secrets ────────────────────────────────

/**
 * Credentials and secrets are never stored, whatever the extractor or caller
 * says (docs/MEMORY.md, write path step 4). Over-blocking is preferred here.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|passcode|passphrase|pwd|pin code)\b\s*(?:is|was|[:=])/i,
  /(?:密码|口令|密碼)\s*(?:是|为|為|[:：=])/,
  /\b(?:api[ _-]?key|secret key|access token|auth token)\b\s*(?:is|[:=])\s*\S{8,}/i,
];

/** Digit runs of 13–19 digits (single spaces/dashes allowed) that look like payment card numbers. */
const DIGIT_RUN = /(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when the text contains something that looks like a credential, key or card number. */
export function hasCredentials(text: string): boolean {
  if (!text) return false;
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 15 && digits.length <= 16) return true;
    if (luhnValid(digits)) return true;
  }
  return false;
}

// ─────────────────────────────── sensitive topics ────────────────────────────────

/**
 * Topics the extraction prompt marks "sensitive" (health, finances, identity
 * documents, exact addresses, sexuality, religion, politics). Over-matching is
 * preferred: a match only keeps the text away from cloud models.
 */
const SENSITIVE_TOPICS: readonly RegExp[] = [
  /\b(?:diagnos\w*|allerg\w*|asthma|diabet\w*|cancer|tumou?rs?|chemo\w*|depress\w*|anxiety|bipolar|adhd|autis\w*|epilep\w*|migraines?|lupus|hiv|aids|pregnan\w*|miscarriage|therap(?:y|ist)|psychiatr\w*|medicat\w*|prescri\w*|surgery|disease|disorder|syndrome|symptoms?|illness|insulin|blood pressure|my doctor)\b/i,
  /\b(?:salary|income|debts?|loans?|mortgage|bankrupt\w*|credit (?:score|card)|bank account|tax(?:es)? return|net worth|savings|pension|paycheck)\b/i,
  /\b(?:passport|social security|ssn|driver'?s licen[cs]e|national id|home address|my address|i live at \d)/i,
  /\b(?:gay|lesbian|bisexual|transgender|queer|sexual\w*|religio\w*|church|mosque|synagogue|pray\w*|voted|voting|democrat\w*|republican\w*|politic\w*)\b/i,
  /病|诊断|診斷|过敏|過敏|哮喘|糖尿|癌|抑郁|抑鬱|焦虑|焦慮|怀孕|懷孕|吃药|吃藥|手术|手術|看医生|看醫生|治疗|治療|工资|工資|收入|贷款|貸款|欠债|欠債|存款|房贷|房貸|身份证|身份證|护照|護照|住址|宗教|信仰|政治|投票|性取向/u,
];

/** True when the text touches a topic that is sensitive (see {@link SENSITIVE_TOPICS}). */
export function looksSensitive(text: string): boolean {
  return !!text && SENSITIVE_TOPICS.some((re) => re.test(text));
}

// ─────────────────────────────── lexical query ────────────────────────────────

/**
 * Function words (and words every memory contains, like "user") carry no
 * meaning for lexical seeding: with FTS rank-based seeds, "the" would make
 * every "The user …" memory a seed of every question.
 */
const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at by for with from into onto over under about above below up down out off ' +
    'as is am are was were be been being do does did doing done have has had having will would shall should can could may might must ' +
    'i me my mine myself you your yours yourself we us our ours he him his she her hers it its they them their theirs this that these those ' +
    'what which who whom whose when where why how there here not no nor so too very just also only than such some any all each every ' +
    'own same other again once more most much many few both either neither ' +
    "i'm i've i'd i'll you're you've it's that's what's there's don't doesn't didn't isn't aren't wasn't can't won't let's " +
    'please hey hi hello ok okay yes yeah thanks thank tell know remember recall think say said get got user users neo'
  ).split(' '),
);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Lower-cased word tokens (letters/numbers), as FTS5 sees them. */
export function wordTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_']+/u)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter((t) => t.length > 1);
}

/**
 * FTS5 MATCH expression for the meaningful words of `text` (every token
 * quoted, OR-ed), or null when nothing meaningful is left.
 */
export function lexicalQuery(text: string, extraStopwords?: ReadonlySet<string>): string | null {
  const seen = new Set<string>();
  for (const raw of wordTokens(text)) {
    for (const t of raw.split("'")) {
      if (t.length > 1 && !STOPWORDS.has(t) && !extraStopwords?.has(t)) seen.add(t);
    }
  }
  const tokens = [...seen].slice(0, 32);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// ─────────────────────────────── recall keywords ────────────────────────────────

/**
 * Words that say how the user relates to something or when, not what it is
 * about. Recall-only (search keeps them, a user may well search for "likes"):
 * "I like tea" must not make every "Likes …" preference a keyword match.
 */
const RECALL_EXTRA_STOPWORDS = new Set(
  (
    'like likes liked liking love loves loved loving enjoy enjoys enjoyed prefer prefers preferred hate hates dislike dislikes ' +
    'want wants wanted need needs needed wish hope try trying going gonna wanna gotta make makes made take takes give gives ' +
    'come comes came see saw look looks feel feels felt keep keeps put let lets mean means call ' +
    'really actually maybe probably perhaps still even ever never always often sometimes usually already soon later ' +
    'well quite pretty rather lot lots bit thing things stuff something anything everything nothing someone anyone everyone ' +
    'kind sort way ways good great nice cool fine sure right ' +
    'today tonight tomorrow yesterday now morning afternoon evening night time times ' +
    'second seconds minute minutes min mins hour hours hrs day days week weeks month months year years ' +
    'question answer help thanks'
  ).split(' '),
);

/**
 * CJK characters that are grammar or chit-chat rather than content (pronouns,
 * particles, 的/了/是/好/吗 …). All hiragana is treated the same way: in
 * Japanese it is mostly particles and inflection, the content is in kanji/katakana.
 */
const CJK_STOP_CHARS = new Set([...'我你您他她它们們的地得了着著是吗嗎呢吧啊呀么麼嗯哦哈也都就还還很这這那和与與在请請把被给給让讓又才再呃嘛啦喔哇好个個些爱愛']);
const HIRAGANA = /\p{Script=Hiragana}/u;
/** Common two-character words that carry no topic (like, know, what, today, user …). */
const CJK_STOP_WORDS = new Set(
  (
    '喜欢 喜歡 知道 记得 記得 记住 記住 什么 什麼 怎么 怎麼 为什 為什 一下 一个 一個 一些 一点 一點 一起 可以 能够 能夠 需要 想要 觉得 覺得 ' +
    '告诉 告訴 关于 關於 用户 用戶 现在 現在 今天 明天 昨天 时候 時候 东西 東西 事情 没有 沒有 不是 就是 还是 還是 但是 因为 因為 ' +
    '所以 如果 然后 然後 已经 已經 应该 應該 非常 特别 特別 真的 有点 有點 帮我 幫我 谢谢 謝謝 不要 不用 一直 其实 其實 自己'
  ).split(' '),
);
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々]+/gu;

/** Keyword terms of a recall query: whole words (FTS tokens) and CJK character bigrams. */
export interface RecallTerms {
  /** Lower-cased words, stopwords and fragments removed. Matched as whole FTS tokens (with plural forms). */
  words: string[];
  /** CJK bigrams (or isolated content characters). Matched as substrings. */
  cjk: string[];
}

/** A word worth matching: not a stopword; ≥ 3 letters, a 2-letter acronym ("AI"), or a number of ≥ 4 digits (a year). */
function meaningfulWord(word: string, original: string): boolean {
  if (STOPWORDS.has(word) || RECALL_EXTRA_STOPWORDS.has(word)) return false;
  if (/^\d+$/.test(word)) return word.length >= 4;
  return word.length >= 3 || (word.length === 2 && /^\p{Lu}{2}$/u.test(original));
}

/**
 * The meaningful keywords of what the user said, for lexical recall seeds.
 *
 * FTS5's unicode61 tokenizer keeps a whole CJK run as ONE token ("我喜欢喝茶"),
 * so CJK text is matched by character bigrams instead: stop characters
 * (我/你/的/了/是/好/吗 …, all hiragana) and stop words (喜欢/知道/今天 …) split
 * a run, the remaining stretches give bigrams ("喝茶"), and an isolated content
 * character stands alone ("我的猫" → "猫").
 */
export function recallTerms(text: string, limit = 32): RecallTerms {
  const norm = text.normalize('NFKC');
  const words = new Set<string>();
  for (const raw of norm.replace(CJK_RUN, ' ').split(/[^\p{L}\p{M}\p{N}_'’]+/u)) {
    const original = raw.replace(/’/g, "'").replace(/^'+|'+$/g, '');
    if (!original) continue;
    const lower = original.toLowerCase();
    if (STOPWORDS.has(lower)) continue; // whole contractions: "don't", "i'm"
    const base = lower.replace(/'s$/, '');
    const pieces = base.split("'");
    pieces.forEach((piece, i) => {
      if (meaningfulWord(piece, i === 0 ? original.slice(0, piece.length) : piece)) words.add(piece);
    });
  }
  const cjk = new Set<string>();
  for (const m of norm.toLowerCase().matchAll(CJK_RUN)) {
    const chars = [...m[0]];
    const stop = chars.map((ch) => CJK_STOP_CHARS.has(ch) || HIRAGANA.test(ch));
    for (let i = 0; i + 1 < chars.length; i++) {
      if (!stop[i] && !stop[i + 1] && CJK_STOP_WORDS.has(chars[i]! + chars[i + 1]!)) stop[i] = stop[i + 1] = true;
    }
    for (let i = 0; i < chars.length; i++) {
      if (stop[i]) continue;
      const nextFree = i + 1 < chars.length && !stop[i + 1];
      if (nextFree) cjk.add(chars[i]! + chars[i + 1]!);
      else if (i === 0 || stop[i - 1]) cjk.add(chars[i]!); // isolated content character
    }
  }
  return { words: [...words].slice(0, limit), cjk: [...cjk].slice(0, limit) };
}

/** FTS5 MATCH expression for one recall word and its simple English plural/singular forms. */
export function wordMatchExpression(word: string): string {
  const forms = new Set([word]);
  if (/^[a-z]+$/.test(word)) {
    if (/(?:s|x|z|ch|sh)$/.test(word)) forms.add(`${word}es`);
    else if (/[^aeiou]y$/.test(word)) forms.add(`${word.slice(0, -1)}ies`);
    else forms.add(`${word}s`);
    if (word.endsWith('ies') && word.length > 4) forms.add(`${word.slice(0, -3)}y`);
    else if (/(?:ss|x|z|ch|sh)es$/.test(word)) forms.add(word.slice(0, -2));
    else if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word) && word.length > 3) forms.add(word.slice(0, -1));
  }
  return [...forms].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// ─────────────────────────────── "about me" questions ────────────────────────────────

const SELF_WORDS = new Set(['i', 'me', 'my', 'mine', 'myself', "i'm", 'im', "i've", "i'd"]);
const PROFILE_FILLER = new Set(
  (
    'what whats what\'s which who whom how much many do does did done you your yours u ya know knew known remember remembered ' +
    'recall recalled think thought tell telling say said told about regarding on of so far yet already anything everything something ' +
    'all else stuff things thing can could would will please us we our is are am was were be been the a an have has had to and or in ' +
    'for with at by it that this there here now really just ok okay hey hi hello neo describe summarize summarise summary sum up ' +
    'profile like likes love loves enjoy enjoys prefer prefers hate hates dislike dislikes learned learnt kind sort person ' +
    'info information details facts memories memory hobbies interests preferences goals plans habits'
  ).split(' '),
);
const USER_WORDS = new Set(['user', "user's", 'users', "users'"]);
const USER_QUERY_FILLER = new Set(['personal', 'overview', 'general', 'background']);
const CJK_USER_QUERY = /^(?:关于|關於)?用[户戶](?:的)?(?:信息|资料|資料|情况|情況|偏好|喜好|档案|檔案)?$/u;
const CJK_SELF = /我|自己|私|僕|俺|나|저/u;
const CJK_FILLER =
  /你们|你|您|我们|我|自己|的|记得|記得|记住|知道|了解|什么|什麼|关于|關於|告诉|告訴|说说|說說|讲讲|講講|一下|吗|嗎|呢|吧|了|是|谁|誰|哪些|有|都|还|還|些|喜欢|喜歡|情况|情況|信息|资料|資料|多少|怎么|怎麼|样|樣|对|對|能|可以|请|請|介绍|介紹|私|僕|俺|について|何|覚えて|知って|いる|います|ますか|ですか|の|こと|を|は|が|か|教えて|ください|나|저|에|대해|뭘|무엇을|기억|알아|알고|있어|있니|있나요|요|[\s\p{P}\p{S}]/gu;

/** Words that make it a request to recall ("what…", "tell me…", "remember…"), not a statement like "I like it". */
const RECALL_INTENT = new Set(['what', 'whats', "what's", 'who', 'how', 'which', 'tell', 'describe', 'remember', 'recall', 'know', 'summarize', 'summarise', 'profile']);
const CJK_INTENT = /记得|記得|知道|了解|什么|什麼|谁|誰|介绍|介紹|说说|說說|讲讲|講講|哪些|吗|嗎|覚えて|知って|何|教えて|기억|알아|알고|뭘|무엇/u;

/**
 * True for broad questions about the user themselves ("what do you remember
 * about me?", "who am I", "你记得我什么"): self-referential, phrased as a
 * question or recall request, and with no other content word — so neither
 * vectors nor keywords can find anything specific.
 */
export function isBroadSelfQuery(text: string): boolean {
  const norm = normalizeText(text);
  if (!norm) return false;
  const question = /[?？]/.test(norm);
  if (hasCJK(norm)) {
    // A recall-tool query naming the user in the third person ("用户", "关于用户的信息").
    if (CJK_USER_QUERY.test(norm.replace(/[\s\p{P}\p{S}]/gu, ''))) return true;
    if (!CJK_SELF.test(norm) || !(question || CJK_INTENT.test(norm))) return false;
    return norm.replace(CJK_FILLER, '').length === 0;
  }
  const tokens = norm.split(/[^\p{L}\p{N}_']+/u).filter(Boolean);
  // A recall-tool query naming the user in the third person ("the user", "user preferences",
  // "what does the user like?"): models phrase "what do you remember about me?" this way.
  if (tokens.some((t) => USER_WORDS.has(t)) && tokens.every((t) => USER_WORDS.has(t) || USER_QUERY_FILLER.has(t) || PROFILE_FILLER.has(t))) return true;
  if (!tokens.some((t) => SELF_WORDS.has(t))) return false;
  if (!question && !tokens.some((t) => RECALL_INTENT.has(t))) return false;
  return tokens.every((t) => SELF_WORDS.has(t) || PROFILE_FILLER.has(t));
}

// ─────────────────────────────── misc ────────────────────────────────

/** Rough token count estimate (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LABEL_QUOTES = /["“”„‟«»「」『』]/g;

/**
 * A memory label is a title: one line, no double quotes, no punctuation at
 * either end ("“Prefers window seats”." → "Prefers window seats"). Empty when
 * nothing is left.
 */
export function cleanLabel(label: string): string {
  return label
    .replace(LABEL_QUOTES, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—•*·:;,.!?…、，。：；！？]+/u, '')
    .replace(/[\s\-–—•*·:;,.!?…、，。：；！？]+$/u, '')
    .trim();
}

/** A short label from free text: first line, cut at a word boundary, ≤ `max` chars. */
export function deriveLabel(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
