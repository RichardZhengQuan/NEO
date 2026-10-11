/**
 * Automatic conversation titles: one short, tool-less model call after the
 * first completed turn, with a deterministic fallback (the first six words of
 * the user's message). Model output is sanitized: one line, no quotes or
 * Markdown, at most TITLE_MAX_CHARS characters.
 */
import type { ChatModel } from '@neo/protocol';

import { abortable } from './abort.js';

export const TITLE_MAX_CHARS = 60;
const TITLE_MAX_TOKENS = 30;
const TITLE_TIMEOUT_MS = 30_000;
const FALLBACK_WORDS = 6;

/** Titles that mean "not named yet" (the @neo/storage default is "New conversation"). */
const UNNAMED_TITLES = new Set(['', 'new conversation']);

export function isUnnamedTitle(title: string): boolean {
  return UNNAMED_TITLES.has(title.trim().toLowerCase());
}

const DOUBLE_QUOTES = /["“”„«»「」『』]/g;

/** Clean a model-written (or fallback) title. Returns '' when nothing usable is left. */
export function sanitizeTitle(raw: string): string {
  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*#+\s*/, '').replace(/[*`]+/g, '').replace(DOUBLE_QUOTES, '').trim())
      .find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '';
  let title = line
    .replace(/^\s*(?:title|标题)\s*[:：]\s*/iu, '')
    .replace(/^[\s>•–—-]+/u, '')
    .replace(/^['‘’]+|['‘’]+$/gu, '')
    .replace(/[\s.。!！,，;；:：]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...title];
  if (chars.length > TITLE_MAX_CHARS) {
    let cut = chars.slice(0, TITLE_MAX_CHARS - 1).join('');
    const space = cut.lastIndexOf(' ');
    if (space >= TITLE_MAX_CHARS / 2) cut = cut.slice(0, space);
    title = `${cut.replace(/[\s.,;:!?–—-]+$/u, '')}…`;
  }
  return title;
}

/** The first six words of the user's message. */
export function fallbackTitle(userText: string): string {
  return sanitizeTitle(userText.trim().split(/\s+/).slice(0, FALLBACK_WORDS).join(' '));
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Ask the model for a title; falls back to the user's first words. Never throws. */
export async function generateTitle(model: ChatModel, modelName: string, userText: string, assistantText: string): Promise<string> {
  const prompt = [
    'Write a short title (3 to 6 words) for this conversation, in the language of the conversation.',
    'Reply with the title only: no quotes, no trailing punctuation, no explanation.',
    '',
    `User: ${clip(userText.trim(), 500)}`,
    `Assistant: ${clip(assistantText.trim(), 500)}`,
  ].join('\n');
  let text = '';
  try {
    const signal = AbortSignal.timeout(TITLE_TIMEOUT_MS);
    const stream = model.chat({
      model: modelName,
      messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      maxTokens: TITLE_MAX_TOKENS,
      reasoning: 'off',
      metadata: { purpose: 'title' },
      signal,
    });
    for await (const event of abortable(stream, signal)) if (event.type === 'text') text += event.text;
  } catch {
    text = '';
  }
  return sanitizeTitle(text) || fallbackTitle(userText);
}
