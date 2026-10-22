/**
 * Model-based extraction: the prompt, a lenient JSON reader, and zod
 * validation of every operation (invalid ones are dropped, a reply of the
 * wrong shape counts as a failed call so the heuristic fallback runs).
 */
import { z } from 'zod';
import type { ChatModel, MemoryKind, MemoryPolicy, RecalledMemory, Sensitivity } from '@neo/protocol';
import { collectChat } from '@neo/protocol';
import { MEMORY_CONSTANTS } from './constants.js';
import { clamp01 } from './utils.js';

export const EXTRACTION_PROMPT = `You are the memory of a personal AI assistant called NEO. Decide what is worth remembering long-term from the latest exchange between the user and NEO.

Remember: stable facts about the user and their world (people, places, pets, work, projects), preferences and dislikes, goals and plans, skills/procedures they teach, and important events. Write each memory as a short self-contained statement in the third person ("The user's sister is Mia, a nurse in Berlin").
Requests about how NEO should behave, what to call the user or itself, and reply language are durable "preference" memories tagged "assistant-style". Examples: "keep answers short", "call me Rich", "reply in Chinese", "call yourself Luna", "be more playful". Apply that tag consistently; use "supersede" when a newer preference conflicts with an older one ("be playful" then "be more serious").
Do NOT remember: small talk, things NEO said that the user didn't confirm, one-off requests ("what's 2+2"), content from web pages or tools, secrets/passwords/API keys.
Prefer updating or superseding an existing memory over creating a duplicate. Use "supersede" when the new information contradicts the old (it keeps history). Use "reinforce" when the exchange simply confirms an existing memory.
Mark health, finances, sexuality, religion, politics, exact addresses and identity numbers as "sensitive" (also on an update or supersede that adds such details).
importance: 0.9+ core identity & critical (allergies, names of close people), 0.6–0.8 durable preferences/goals, 0.3–0.5 minor details.
Return ONLY a JSON object:
{"episode": {"label": string, "summary": string, "importance": number} | null,
 "memories": [
   {"op": "create", "kind": "fact"|"preference"|"entity"|"skill"|"goal", "label": string, "content": string, "importance": number, "sensitivity"?: "normal"|"sensitive", "entities"?: string[], "entityType"?: string, "tags"?: string[], "validUntil"?: string|null}
 | {"op": "update", "id": string, "label"?: string, "content": string, "reason": string, "sensitivity"?: "normal"|"sensitive"}
 | {"op": "supersede", "id": string, "kind": string, "label": string, "content": string, "reason": string, "sensitivity"?: "normal"|"sensitive"}
 | {"op": "reinforce", "id": string}],
 "links": [{"from": string, "to": string, "type": "related"|"causes"|"part_of"|"contradicts", "weight"?: number}]}
Set "episode" to null for trivial exchanges (greetings, thanks, quick lookups).`;

// ─────────────────────────────── operation types ────────────────────────────────

/** Kinds the extractor may create; episodes and summaries have their own paths. */
export const EXTRACTABLE_KINDS = ['fact', 'preference', 'entity', 'skill', 'goal'] as const;
const SUPERSEDABLE_KINDS = ['fact', 'preference', 'entity', 'skill', 'goal', 'summary'] as const;
export const LLM_LINK_TYPES = ['related', 'causes', 'part_of', 'contradicts'] as const;

export interface EpisodeOp {
  label?: string;
  summary?: string;
  importance?: number;
}

export interface CreateOp {
  op: 'create';
  kind: MemoryKind;
  label: string;
  content: string;
  importance?: number;
  sensitivity?: Sensitivity;
  entities?: string[];
  entityType?: string;
  tags?: string[];
  /** Epoch ms (ISO strings and numbers are accepted from the model). */
  validUntil?: number;
}

export interface UpdateOp {
  op: 'update';
  id: string;
  label?: string;
  content: string;
  reason?: string;
  /** 'sensitive' raises the memory's sensitivity; an update never lowers it. */
  sensitivity?: Sensitivity;
}

export interface SupersedeOp {
  op: 'supersede';
  id: string;
  /** Absent or invalid → the old node's kind. */
  kind?: MemoryKind;
  label: string;
  content: string;
  reason?: string;
  /** The revision is at least as sensitive as the old node. */
  sensitivity?: Sensitivity;
}

export interface ReinforceOp {
  op: 'reinforce';
  id: string;
}

export type MemoryOp = CreateOp | UpdateOp | SupersedeOp | ReinforceOp;

export interface LinkOp {
  from: string;
  to: string;
  type: (typeof LLM_LINK_TYPES)[number];
  weight?: number;
}

export interface ExtractionResult {
  episode: EpisodeOp | null;
  memories: MemoryOp[];
  links: LinkOp[];
}

// ─────────────────────────────── lenient JSON ────────────────────────────────

/** Index just past the `}` closing the object that starts at `start`, honoring strings; -1 if unclosed. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return ch === '}' ? i + 1 : -1;
    }
  }
  return -1;
}

/** Remove commas directly before `}` or `]` (outside strings). */
function stripTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < json.length) out += json[++i];
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      if (json[j] === '}' || json[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function tryObject(candidate: string): Record<string, unknown> | null {
  for (const text of [candidate, stripTrailingCommas(candidate)]) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // try the next form
    }
  }
  return null;
}

/**
 * The first JSON object in a model reply: inside ```json fences, after prose,
 * next to stray braces, with trailing commas. Returns null when there is none.
 */
export function parseLenientJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  for (const fence of text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) {
    const inner = fence[1]!.trim();
    const start = inner.indexOf('{');
    if (start < 0) continue;
    const end = objectEnd(inner, start);
    const parsed = tryObject(end > 0 ? inner.slice(start, end) : inner.slice(start));
    if (parsed) return parsed;
  }
  let attempts = 0;
  for (let start = text.indexOf('{'); start >= 0 && attempts < 64; start = text.indexOf('{', start + 1), attempts++) {
    const end = objectEnd(text, start);
    if (end < 0) continue;
    const parsed = tryObject(text.slice(start, end));
    if (parsed) return parsed;
  }
  return null;
}

// ─────────────────────────────── validation ────────────────────────────────

const text = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().slice(0, max))
    .pipe(z.string().min(1));
const unit = z.number().refine(Number.isFinite).transform(clamp01);
const names = (maxItems: number, maxLen: number) =>
  z.array(z.unknown()).transform((items) => [
    ...new Set(
      items
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim().slice(0, maxLen))
        .filter(Boolean),
    ),
  ].slice(0, maxItems));
/** Optional field: an invalid value is dropped instead of failing the whole operation. */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

function parseDate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && Math.abs(value) <= 8.64e15) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

const CreateOpSchema = z.object({
  op: z.literal('create'),
  kind: z.enum(EXTRACTABLE_KINDS),
  label: text(300),
  content: text(10_000),
  importance: opt(unit),
  sensitivity: opt(z.enum(['normal', 'sensitive'])),
  entities: opt(names(20, 120)),
  entityType: opt(text(40)),
  tags: opt(names(20, 60)),
  validUntil: opt(z.union([z.string(), z.number()]).nullable()),
});

const UpdateOpSchema = z.object({
  op: z.literal('update'),
  id: text(200),
  label: opt(text(300)),
  content: text(10_000),
  reason: opt(z.string()),
  sensitivity: opt(z.enum(['normal', 'sensitive'])),
});

const SupersedeOpSchema = z.object({
  op: z.literal('supersede'),
  id: text(200),
  kind: opt(z.enum(SUPERSEDABLE_KINDS)),
  label: text(300),
  content: text(10_000),
  reason: opt(z.string()),
  sensitivity: opt(z.enum(['normal', 'sensitive'])),
});

const ReinforceOpSchema = z.object({ op: z.literal('reinforce'), id: text(200) });

const MemoryOpSchema = z.discriminatedUnion('op', [CreateOpSchema, UpdateOpSchema, SupersedeOpSchema, ReinforceOpSchema]);

const LinkOpSchema = z.object({
  from: text(300),
  to: text(300),
  type: z.enum(LLM_LINK_TYPES),
  weight: opt(unit),
});

const EpisodeOpSchema = z.object({
  label: opt(text(80)),
  summary: opt(text(600)),
  importance: opt(unit),
});

/** Strip keys whose value is undefined (exactOptionalPropertyTypes-friendly results). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Validate an extraction reply. The reply must have the documented shape — a
 * `memories` array, or an `episode` key (null counts) — otherwise it is a
 * failed extraction (null). Individual invalid operations are dropped.
 */
export function validateExtraction(raw: Record<string, unknown> | null): ExtractionResult | null {
  if (!raw) return null;
  const hasMemories = Array.isArray(raw['memories']);
  const hasEpisode = 'episode' in raw && (raw['episode'] === null || typeof raw['episode'] === 'object');
  if (!hasMemories && !hasEpisode) return null;

  let episode: EpisodeOp | null = null;
  if (raw['episode'] && typeof raw['episode'] === 'object') {
    const parsed = EpisodeOpSchema.safeParse(raw['episode']);
    if (parsed.success) episode = compact(parsed.data);
  }
  const memories: MemoryOp[] = [];
  for (const op of hasMemories ? (raw['memories'] as unknown[]) : []) {
    const parsed = MemoryOpSchema.safeParse(op);
    if (!parsed.success) continue;
    if (parsed.data.op === 'create') memories.push(compact({ ...parsed.data, validUntil: parseDate(parsed.data.validUntil) }) as MemoryOp);
    else memories.push(compact(parsed.data) as MemoryOp);
  }
  const links: LinkOp[] = [];
  for (const link of Array.isArray(raw['links']) ? (raw['links'] as unknown[]) : []) {
    const parsed = LinkOpSchema.safeParse(link);
    if (parsed.success) links.push(compact(parsed.data) as LinkOp);
  }
  return { episode, memories, links };
}

/** Parse and validate the model's reply. Returns null if it is unusable. */
export function parseExtractionResponse(reply: string): ExtractionResult | null {
  return validateExtraction(parseLenientJson(reply));
}

// ─────────────────────────────── model calls ────────────────────────────────

/**
 * One JSON-mode chat call with a hard timeout (a hung model must not stall the
 * memory write queue). Resolves to the reply text; throws on error/timeout.
 */
export async function callModel(
  llm: ChatModel,
  request: { model: string; system: string; user: string; maxTokens: number; purpose: string; signal?: AbortSignal },
): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`memory model call timed out after ${MEMORY_CONSTANTS.llmTimeoutMs} ms`));
    }, MEMORY_CONSTANTS.llmTimeoutMs);
  });
  try {
    const call = (async () => {
      const stream = llm.chat({
        model: request.model,
        system: request.system,
        messages: [{ role: 'user', parts: [{ type: 'text', text: request.user }] }],
        responseFormat: 'json',
        temperature: 0,
        maxTokens: request.maxTokens,
        signal: controller.signal,
        metadata: { purpose: request.purpose },
      });
      return (await collectChat(stream)).text;
    })();
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A message inside the exchange transcript: continuation lines are indented by
 * two spaces, so a line starting with "User: " or "NEO: " is always a speaker
 * marker (a reply that itself contains "\nNEO: " cannot be mistaken for one).
 */
function transcriptText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().replace(/\n/g, '\n  ');
}

/**
 * The user message of the extraction call (related memories, policy, date, exchange).
 *
 * The exchange is the last section: `Latest exchange:\nUser: <user text>\nNEO: <assistant text>`,
 * one newline before each speaker marker, continuation lines indented by two spaces
 * ({@link transcriptText}). The scripted test fixture parses this format.
 */
export function buildExtractionInput(input: {
  userText: string;
  assistantText: string;
  related: RecalledMemory[];
  policy: Pick<MemoryPolicy, 'allowedKinds'>;
  /** When false (cloud model without sendSensitiveToCloud), sensitive memories are filtered out before the payload is built. */
  allowSensitive: boolean;
  date: string;
}): string {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  const related = input.related.filter((m) => input.allowSensitive || m.node.sensitivity === 'normal').slice(0, 10);
  const sections = [
    related.length
      ? `Existing related memories (id | kind | label | content):\n${related.map((m) => `- ${m.node.id} | ${m.node.kind} | ${oneLine(m.node.label)} | ${oneLine(m.node.content).slice(0, 500)}`).join('\n')}`
      : 'Existing related memories: none',
    `Allowed memory kinds: ${input.policy.allowedKinds.join(', ')}`,
    `Current date: ${input.date}`,
    `Latest exchange:\nUser: ${transcriptText(input.userText)}\nNEO: ${transcriptText(input.assistantText)}`,
  ];
  return sections.join('\n\n');
}

/** Ask the model what to remember. Returns null when the call fails or the reply is unusable. */
export async function llmExtract(
  llm: ChatModel,
  modelName: string,
  userContent: string,
): Promise<ExtractionResult | null> {
  const reply = await callModel(llm, { model: modelName, system: EXTRACTION_PROMPT, user: userContent, maxTokens: 1500, purpose: 'memory-extract' });
  return parseExtractionResponse(reply);
}
