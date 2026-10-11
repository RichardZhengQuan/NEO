/**
 * Offline, rule-based extraction used when no model is available or the model
 * call fails. Deliberately conservative: a missed memory costs little, a wrong
 * one ("The user lives in a hurry") makes NEO feel broken.
 */
import type { RememberInput } from '@neo/protocol';
import { MEMORY_CONSTANTS } from './constants.js';
import { cleanLabel } from './text.js';

type Candidate = RememberInput & { kind: NonNullable<RememberInput['kind']>; label: string };

// ─────────────────────────────── statements and questions ────────────────────────────────

const EN_QUESTION_START =
  /^(?:what|what's|whats|who|who's|whom|whose|where|where's|when|why|how|which|do|does|did|don't|doesn't|didn't|can|can't|could|would|will|won't|is|isn't|are|aren't|am|was|wasn't|were|should|shall|may|might|have|has|haven't|hasn't)\b/i;
const ZH_QUESTION = /(?:吗|嗎|么|麼|呢)[\s。.!！~]*$|什么|什麼|谁|誰|哪里|哪裡|哪儿|哪些|怎么|怎麼|为什么|為什麼/u;
const HAN = /\p{Script=Han}/u;

/** A question rather than a statement ("What do you remember about me?", "Do you know my name", "你记得我吗"). */
function isQuestion(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return false;
  if (/[?？]\s*$/.test(s)) return true;
  return HAN.test(s) ? ZH_QUESTION.test(s) : EN_QUESTION_START.test(s);
}

/** An imperative delete/forget request: never extract memories from these ("Forget that I live in Paris"). */
const EN_FORGET_START = /^(?:please\s+)?(?:forget|delete|remove|stop\s+remembering|don't\s+remember|do\s+not\s+remember)\b/i;
const ZH_FORGET_START = /^(?:忘记|删除|不要记|不用记|请忘记|请删除)/u;

function isForgetCommand(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return false;
  return HAN.test(s) ? ZH_FORGET_START.test(s) : EN_FORGET_START.test(s);
}

/** Sentences of a text (split after . ! ? and their CJK forms). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** The statements of a user text, questions and forget commands removed: neither ever becomes a fact. */
function statementsOf(text: string): string {
  return sentences(text)
    .filter((t) => !isQuestion(t) && !isForgetCommand(t))
    .join(' ');
}

// ─────────────────────────────── first person → third person ────────────────────────────────

const MODALS = new Set(['can', 'could', 'will', 'would', 'should', 'must', 'may', 'might', 'shall']);

/** English verb → third-person singular ("like" → "likes", "study" → "studies", "am" → "is"). */
function conjugate(verb: string): string {
  const v = verb.toLowerCase();
  if (MODALS.has(v)) return verb;
  if (v === 'am') return 'is';
  if (v === 'have') return 'has';
  if (v === 'do') return 'does';
  if (v === "don't" || v === 'dont') return 'does not';
  if (v === "didn't") return 'did not';
  if (v === "can't") return 'cannot';
  if (v === "won't") return 'will not';
  if (v === 'was' || v === 'did' || v.endsWith('ed') || v.endsWith('s')) return verb;
  if (/(?:sh|ch|x|z|o)$/.test(v)) return `${verb}es`;
  if (/[^aeiou]y$/.test(v)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "I am vegetarian" → "The user is vegetarian."; "my cat is Luna" → "The user's cat is Luna."; others unchanged. */
function thirdPerson(statement: string): string {
  if (HAN.test(statement)) {
    const zh = statement.replace(/我的/g, '用户的').replace(/我/g, '用户').replace(/[。！!.\s]+$/u, '');
    return `${zh}。`;
  }
  let s = statement.replace(/\bI'm\b/g, 'I am').replace(/\bI've\b/g, 'I have').replace(/\bI'd\b/g, 'I would').replace(/\bI'll\b/g, 'I will');
  s = s.replace(/\bI\s+([A-Za-z']+)/g, (_m, verb: string) => `the user ${conjugate(verb)}`);
  s = s.replace(/\bmy\b/gi, "the user's").replace(/\bmine\b/gi, "the user's").replace(/\bmyself\b/gi, 'themselves').replace(/\bme\b/gi, 'the user');
  s = capitalize(s.replace(/[\s.!?]+$/, ''));
  return `${s}.`;
}

/** Up to `words` words and `max` chars, cut at a word boundary. */
function shorten(text: string, words = 8, max = 60): string {
  let out = '';
  for (const w of text.split(/\s+/).filter(Boolean).slice(0, words)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || text.slice(0, max);
}

/** Short title for a first-person statement: "I am vegetarian" → "Vegetarian", "I prefer window seats" → "Prefers window seats". */
function statementLabel(statement: string): string {
  if (HAN.test(statement)) return cleanLabel(statement.replace(/^我的?/u, '').slice(0, 30));
  let s = statement.trim().replace(/^I'm\b/, 'I am');
  const m = /^I\s+(?:am\s+)?([A-Za-z']+)(.*)$/.exec(s);
  if (m) s = /^I\s+am\s/.test(s) ? `${m[1]}${m[2]}` : `${conjugate(m[1]!)}${m[2]}`;
  else s = s.replace(/^my\s+/i, '');
  return cleanLabel(capitalize(shorten(s)));
}

const CUT_WORDS = /\s+(?:and|but|with|near|since|for|because|where|which|who|that|so|though|although|while|when|as|at|in|on|from|to|of)\b.*$/i;
const PRONOUN_OBJECTS = new Set(['it', 'that', 'this', 'them', 'you', 'him', 'her', 'those', 'these', 'one', 'so', 'too', 'very', 'much', 'the idea', 'that idea']);
const NOT_A_PROFESSION = new Set([
  'bit', 'little', 'lot', 'big', 'huge', 'total', 'complete', 'real', 'good', 'bad', 'great', 'terrible', 'fan', 'mess', 'wreck',
  'kind', 'sort', 'couple', 'few', 'fast', 'slow', 'quick', 'tad', 'person', 'human', 'man', 'woman', 'guy', 'girl', 'boy', 'part',
]);
const GOAL_VERBS = 'learn|become|visit|travel|move|start|build|write|run|finish|improve|lose|save|buy|launch|quit|get better at|master|study|climb|open|create|publish|retire';

/** Trim a captured phrase at sentence punctuation and conjunctions. */
function phrase(raw: string, cutAtPrepositions = true): string {
  let s = raw.split(/[.,;!?\n(]|\s[-–—]\s/)[0] ?? '';
  if (cutAtPrepositions) s = s.replace(CUT_WORDS, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Capitalized name of 1–3 words ("Mia", "Mia Chen", "José Luis"). */
const NAME = "\\p{Lu}[\\p{L}\\p{M}'’-]*(?:\\s+\\p{Lu}[\\p{L}\\p{M}'’-]*){0,2}";

/**
 * Offline rule-based extraction ("my name is…", "I like…", "remember that…").
 * Only statements count: questions ("what do you remember about me?") never
 * create memories. Labels are clean titles, contents third-person statements.
 */
export function heuristicExtract(userText: string): RememberInput[] {
  const text = statementsOf(userText.replace(/<ui_event>[\s\S]*?<\/ui_event>/g, ' ').trim());
  if (!text) return [];
  const out: Candidate[] = [];
  const add = (c: Candidate) => {
    const label = cleanLabel(c.label).slice(0, 300);
    if (label && !out.some((o) => o.label === label)) out.push({ ...c, label, content: c.content.replace(/["“”「」]/g, '').slice(0, 1000) });
  };

  // ── English ──

  // "my name is Richard" / "call me Ishmael" (capitalized), or a single lower-case word after "my name is".
  {
    const m = new RegExp(`\\b(?:[Mm]y name is|[Ii](?:'m| am) called|[Cc]all me)\\s+(${NAME})`, 'u').exec(text)
      ?? /\bmy name is\s+([\p{Ll}][\p{L}'-]{1,30})\b/iu.exec(text);
    const name = m?.[1] ? m[1].trim() : '';
    if (name && !/^(?:not|just|actually|also)$/i.test(name)) {
      const pretty = name.charAt(0).toUpperCase() + name.slice(1);
      add({ kind: 'entity', label: pretty, content: `The user's name is ${pretty}.`, entityType: 'person', importance: 0.9 });
    }
  }

  // "I am 34 years old"
  {
    const m = /\bi(?:'m| am)\s+(\d{1,3})\s+years?\s+old\b/i.exec(text);
    if (m?.[1]) add({ kind: 'fact', label: "User's age", content: `The user is ${m[1]} years old.`, importance: 0.6 });
  }

  // "I live in Berlin" / "I'm from Lisbon" / "I'm based in Oslo"
  {
    const m = /\bi(?: live in|'m from| am from|'m based in| am based in)\s+([^\n]{2,80})/i.exec(text);
    const place = m?.[1] ? phrase(m[1]) : '';
    if (place.length >= 2 && /\p{L}/u.test(place)) {
      add({ kind: 'fact', label: "User's location", content: `The user lives in ${place}.`, importance: 0.6 });
    }
  }

  // "I work at/for Globex" / "I work as a nurse"
  {
    const m = /\bi work (at|for|as)\s+(?:an?\s+)?([^\n]{2,80})/i.exec(text);
    const what = m?.[2] ? phrase(m[2]) : '';
    if (m && what.length >= 2) {
      const content = m[1]!.toLowerCase() === 'as' ? `The user works as ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}.` : `The user works ${m[1]!.toLowerCase()} ${what}.`;
      add({ kind: 'fact', label: "User's work", content, importance: 0.6 });
    }
  }

  // "I'm a nurse" / "I am a software engineer at Google"
  {
    const m = /\bi(?:'m| am)\s+an?\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2})/iu.exec(text);
    const prof = m?.[1] ? phrase(m[1]) : '';
    const first = prof.split(' ')[0]?.toLowerCase() ?? '';
    if (prof.length > 3 && !NOT_A_PROFESSION.has(first)) {
      add({ kind: 'fact', label: "User's profession", content: `The user is ${/^[aeiou]/i.test(prof) ? 'an' : 'a'} ${prof}.`, importance: 0.6 });
    }
  }

  // "I (really) like/love/enjoy/prefer X" (the verb is kept: "Loves hiking", "Prefers window seats")
  {
    const m = /\bi (?:really |also |do )?(like|love|enjoy|prefer|adore|am fond of)\s+([^\n]{2,100})/i.exec(text);
    const thing = m?.[2] ? phrase(m[2], false) : '';
    if (m && thing.length >= 3 && !PRONOUN_OBJECTS.has(thing.toLowerCase())) {
      const verb = /fond/i.test(m[1]!) ? 'likes' : conjugate(m[1]!.toLowerCase());
      add({ kind: 'preference', label: `${capitalize(verb)} ${thing}`.slice(0, 80), content: `The user ${verb} ${thing}.`, importance: 0.5 });
    }
  }

  // "I hate/dislike/can't stand X"
  {
    const m = /\bi (?:really )?(?:hate|dislike|can't stand|cannot stand|don't like|do not like|strongly dislike)\s+([^\n]{2,100})/i.exec(text);
    const thing = m?.[1] ? phrase(m[1], false) : '';
    if (thing.length >= 3 && !PRONOUN_OBJECTS.has(thing.toLowerCase())) {
      add({ kind: 'preference', label: `Dislikes ${thing}`.slice(0, 80), content: `The user dislikes ${thing}.`, importance: 0.5 });
    }
  }

  // "remember that X" / "don't forget that X" / "please note X" → "The user …" with a short title
  {
    const m = /\b(?:(?:please )?remember that|don't forget that|do not forget that|please remember|please note(?: that)?)\s+([^\n]+)/i.exec(text);
    const fact = m?.[1] ? (sentences(m[1])[0] ?? m[1]).trim().replace(/[\s.!?]+$/, '') : '';
    if (fact.length >= 5) add({ kind: 'fact', label: statementLabel(fact), content: thirdPerson(fact), importance: 0.7 });
  }

  // "I'm allergic to X" → sensitive
  {
    const m = /\bi(?:'m| am) (?:severely |very |also )?allergic to\s+([^\n]{2,80})/i.exec(text);
    const allergen = m?.[1] ? phrase(m[1], false) : '';
    if (allergen.length >= 2) {
      add({ kind: 'fact', label: `Allergic to ${allergen}`.slice(0, 80), content: `The user is allergic to ${allergen}.`, importance: 0.9, sensitivity: 'sensitive' });
    }
  }

  // "I have/I've been diagnosed with X" → sensitive
  {
    const m = /\bi(?:'ve| have)(?: been diagnosed with| been treated for)?\s+((?:[\p{L}'-]+\s+){0,3}(?:disease|disorder|syndrome|diabetes|asthma|anxiety|depression|cancer|adhd|epilepsy|migraines?))\b/iu.exec(text);
    const condition = m?.[1]?.trim() ?? '';
    if (condition) {
      add({ kind: 'fact', label: `Health: ${condition}`.slice(0, 80), content: `The user has ${condition}.`, importance: 0.8, sensitivity: 'sensitive' });
    }
  }

  // "my sister is Mia" / "my boss's name is Tom" → a fact about the person, linked to their entity
  {
    const m = new RegExp(
      `\\b[Mm]y (sister|brother|mom|mother|dad|father|wife|husband|partner|girlfriend|boyfriend|son|daughter|friend|best friend|colleague|boss|dog|cat)(?:'s name)? (?:is|is called|is named|named|called)\\s+(${NAME})`,
      'u',
    ).exec(text);
    if (m?.[1] && m[2]) {
      const relation = m[1].toLowerCase();
      const name = m[2].trim();
      const isPet = relation === 'dog' || relation === 'cat';
      add({
        kind: 'fact',
        label: `User's ${relation}`,
        content: `The user's ${relation} is ${name}.`,
        entities: [name],
        entityType: isPet ? 'pet' : 'person',
        importance: 0.8,
      });
    }
  }

  // Goals: explicit intentions only ("I want to know…" is a request, not a goal).
  {
    const m = new RegExp(`\\b(?:my goal is to|i plan to|i'm planning to|i am planning to|i intend to|i'm trying to|i am trying to|i hope to|i want to (?=${GOAL_VERBS}))\\s*([^\\n]{5,200})`, 'i').exec(text);
    const goal = m?.[1] ? phrase(m[1], false) : '';
    if (goal.length >= 5) add({ kind: 'goal', label: goal.slice(0, 80), content: `The user wants to ${goal}.`, importance: 0.6 });
  }

  // ── Chinese ──

  {
    const m = /我(?:叫|的名字是|名叫)\s*([\p{Script=Han}]{1,4}|[A-Za-z][A-Za-z'-]{1,20})/u.exec(text);
    if (m?.[1]) add({ kind: 'entity', label: m[1], content: `用户的名字是${m[1]}。`, entityType: 'person', importance: 0.9 });
  }
  {
    const m = /我(?:很|非常|特别|最)?(?:喜欢|爱|热爱)\s*([^\s，。！？,.!?、]{1,20})/u.exec(text);
    if (m?.[1] && !/^(?:你|他|她|它|这个|那个|这样|那样)$/u.test(m[1])) {
      add({ kind: 'preference', label: `喜欢${m[1]}`, content: `用户喜欢${m[1]}。`, importance: 0.5 });
    }
  }
  {
    const m = /我(?:不喜欢|讨厌|不爱)\s*([^\s，。！？,.!?、]{1,20})/u.exec(text);
    if (m?.[1] && !/^(?:你|他|她|它)$/u.test(m[1])) {
      add({ kind: 'preference', label: `不喜欢${m[1]}`, content: `用户不喜欢${m[1]}。`, importance: 0.5 });
    }
  }
  {
    const m = /我(?:住在|居住在|来自)\s*([^\s，。！？,.!?、]{1,20})/u.exec(text);
    if (m?.[1]) add({ kind: 'fact', label: '用户的位置', content: `用户住在${m[1]}。`, importance: 0.6 });
  }
  {
    const m = /我对\s*([^\s，。！？,.!?、]{1,20})过敏/u.exec(text);
    if (m?.[1]) add({ kind: 'fact', label: `对${m[1]}过敏`, content: `用户对${m[1]}过敏。`, importance: 0.9, sensitivity: 'sensitive' });
  }
  {
    const m = /(?:请记住|记住|别忘了)[，,:：\s]*([^\n]{4,200})/u.exec(text);
    const fact = m?.[1]?.trim().replace(/[。！!.\s]+$/u, '') ?? '';
    if (fact.length >= 4) add({ kind: 'fact', label: statementLabel(fact), content: thirdPerson(fact), importance: 0.7 });
  }

  return out;
}

// ─────────────────────────────── episodes ────────────────────────────────

const CHIT_CHAT =
  /^(?:hi|hello|hey|yo|hiya|howdy|greetings|good\s+(?:morning|afternoon|evening|night)|thanks|thank\s+you|thx|ty|cheers|ok|okay|cool|nice|great|awesome|perfect|bye|goodbye|see\s+you|yes|yeah|yep|no|nope|sure|got\s+it|你好|您好|嗨|哈喽|哈啰|早上好|早安|下午好|晚上好|晚安|谢谢|多谢|感谢|好的|好|行|嗯|哦|再见|拜拜)(?:\s+(?:there|neo|all|everyone|a\s+lot|so\s+much|very\s+much|again))*$/i;

/** The text without the greetings, thanks and acknowledgements around it ("Hi! …", "…, thanks"). */
function withoutChitChat(text: string): string {
  const pieces = text.split(/([,.!?;~，。！？；、]+\s*)/u);
  let out = '';
  for (let i = 0; i < pieces.length; i += 2) {
    const chunk = pieces[i]!.trim();
    if (!chunk || CHIT_CHAT.test(chunk)) continue;
    const join = out && !/[\u3000-\u303f\uff00-\uffef]$/u.test(out) ? ' ' : '';
    out += `${join}${chunk}${(pieces[i + 1] ?? '').trim()}`;
  }
  return out.trim();
}

/** "The user loves hiking." → "Said they love hiking"; "用户喜欢喝茶。" → "说自己喜欢喝茶". */
function saidLabel(content: string): string {
  const s = content.replace(/[.。!！]+$/u, '');
  if (HAN.test(s)) return cleanLabel(`说${s.replace(/^用户的/u, '自己的').replace(/^用户/u, '自己')}`).slice(0, 30);
  const base = (verb: string) => {
    const v = verb.toLowerCase();
    if (v === 'is') return 'are';
    if (v === 'has') return 'have';
    if (v === 'does not') return 'do not';
    if (v === 'was') return 'were';
    if (/(?:ss|sh|ch|x|z|o)es$/.test(v)) return verb.slice(0, -2);
    if (/[^aeiou]ies$/.test(v)) return `${verb.slice(0, -3)}y`;
    if (/[^s]s$/.test(v)) return verb.slice(0, -1);
    return verb;
  };
  const they = s
    .replace(/^The user's\s+/, 'their ')
    .replace(/^The user\s+(does not|did not|cannot|[A-Za-z']+)/, (_m, verb: string) => `they ${base(verb)}`)
    .replace(/^The\b/, 'the');
  return cleanLabel(shorten(`Said ${they}`, 10, 60));
}

/**
 * Episode label for the offline path: a short summary of what the user did
 * ("Introduced themselves", "Said they love hiking", "Asked for a reminder to
 * drink water"), or null for trivial exchanges: greetings, thanks, questions
 * (also "what do you remember about me?") and very short texts.
 */
export function heuristicEpisode(userText: string, extracted: readonly RememberInput[]): string | null {
  const core = withoutChitChat(userText.replace(/<ui_event>[\s\S]*?<\/ui_event>/g, ' ').replace(/\s+/g, ' ').trim());
  if (!core) return null;
  const zh = HAN.test(core);
  if (extracted.length) {
    if (extracted.some((m) => m.kind === 'entity' && m.entityType === 'person' && /name/i.test(m.content) || /名字/.test(m.content))) {
      return zh ? '做了自我介绍' : 'Introduced themselves';
    }
    return saidLabel(extracted[0]!.content);
  }
  const reminder = /\bremind me\s+(?:(?:in|at|on|tomorrow|today|tonight)\b[^,]*?\s+)?(to|about|of)\s+(.+)$/i.exec(core);
  if (reminder) {
    const what = reminder[2]!.replace(/\s+(?:in\s+(?:\d+|an?|one)\s+\w+|at\s+\S+|tomorrow|today|tonight|on\s+\w+)\b.*$/i, '');
    return cleanLabel(`Asked for a reminder ${reminder[1]!.toLowerCase() === 'to' ? 'to' : 'about'} ${shorten(what, 8, 50)}`);
  }
  if (/提醒我/u.test(core)) return '要求提醒';
  const said = statementsOf(core);
  if (!said || said.length < (zh ? MEMORY_CONSTANTS.episodeMinCharsCJK : MEMORY_CONSTANTS.episodeMinChars)) return null;
  return statementLabel(sentences(said)[0] ?? said) || null;
}
