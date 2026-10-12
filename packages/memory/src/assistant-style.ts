/** Durable preferences for how NEO speaks and addresses the user. */
export const ASSISTANT_STYLE_TAG = 'assistant-style';

export type AssistantStyleAspect = 'length' | 'language' | 'user-name' | 'assistant-name' | 'tone';

/** Recognize the aspect in both user requests and the extractor's third-person statements. */
export function assistantStyleAspect(text: string): AssistantStyleAspect | null {
  const value = text.normalize('NFKC').toLowerCase();
  if (/\bcall (?:me|the user)\b|\b(?:address|refer to) the user as\b|\buser(?:'s)? (?:preferred name|wants to be called)\b|称呼(?:我|用户)|叫我/u.test(value)) return 'user-name';
  if (/\bcall yourself\b|\b(?:calls? (?:me|the assistant|neo)|assistant(?:'s)? name)\b|\byour name (?:is|should be)\b|称呼(?:你|助手)|你叫/u.test(value)) return 'assistant-name';
  if (/\b(?:reply|replies|respond|responds|responses?|answer|answers|speak|speaks|write|writes)\b.*\b(?:in|language)\b|\b(?:reply|response|preferred) language\b|(?:用|使用).{1,12}(?:回答|回复|交流)|(?:回复|回答)语言/u.test(value)) return 'language';
  if (/\b(?:short|brief|concise|long|detailed|succinct|verbose)\b.*\b(?:answers?|replies|responses?)\b|\b(?:answers?|replies|responses?)\b.*\b(?:short|brief|concise|long|detailed|succinct|verbose)\b|(?:回答|回复).{0,6}(?:简短|簡短|详细|詳細)|(?:简短|簡短|详细|詳細).{0,6}(?:回答|回复)/u.test(value)) return 'length';
  if (/\b(?:assistant|neo|you|yourself|be)\b.*\b(?:playful|serious|formal|casual|warm|direct|gentle|friendly|humorous|professional|respectful)\b|\b(?:playful|serious|formal|casual|warm|direct|gentle|friendly|humorous|professional|respectful)\b.*\b(?:tone|style|assistant|neo)\b|(?:活泼|活潑|严肃|嚴肅|幽默|正式|温暖|溫暖).{0,6}(?:语气|語氣|风格|風格)|(?:更|请|請).{0,6}(?:活泼|活潑|严肃|嚴肅|幽默|正式)/u.test(value)) return 'tone';
  return null;
}

export function assistantStyleTags(text: string, tags: readonly string[] = []): string[] {
  const aspect = tags.includes(`${ASSISTANT_STYLE_TAG}:traits`) ? null : assistantStyleAspect(text);
  const style = aspect !== null || tags.some((tag) => tag.toLowerCase() === ASSISTANT_STYLE_TAG);
  if (!style) return [...tags];
  return [...new Set([ASSISTANT_STYLE_TAG, ...(aspect ? [`${ASSISTANT_STYLE_TAG}:${aspect}`] : []), ...tags])].slice(0, 20);
}

/** Revise only conflicting preferences; compatible tones can grow together. */
export function assistantStyleConflict(previous: { content: string; tags: readonly string[] }, next: { content: string; tags: readonly string[] }): boolean {
  const aspect = assistantStyleAspect(previous.content);
  if (!aspect || aspect !== assistantStyleAspect(next.content)) return false;
  const old = previous.content.normalize('NFKC').toLowerCase();
  const value = next.content.normalize('NFKC').toLowerCase();
  if (old === value) return false;
  if (aspect === 'length') {
    const short = /\b(?:short|brief|concise|succinct)\b|简短|簡短/u;
    const long = /\b(?:long|detailed|verbose)\b|详细|詳細/u;
    return (short.test(old) && long.test(value)) || (long.test(old) && short.test(value));
  }
  if (aspect !== 'tone') return true;
  const playful = /\b(?:playful|humorous)\b|活泼|活潑|幽默/u;
  const serious = /\bserious\b|严肃|嚴肅/u;
  const formal = /\bformal\b|正式/u;
  const casual = /\bcasual\b|随意|隨意/u;
  if ((playful.test(old) && serious.test(value)) || (serious.test(old) && playful.test(value)) || (formal.test(old) && casual.test(value)) || (casual.test(old) && formal.test(value))) return true;
  const tones = ['playful', 'serious', 'formal', 'casual', 'warm', 'direct', 'gentle', 'friendly', 'humorous', 'professional', 'respectful'];
  return tones.some((tone) => old.includes(tone) && value.includes(tone) && /\b(?:less|not|never)\b/.test(old) !== /\b(?:less|not|never)\b/.test(value));
}
