/**
 * Embedders: offline HashingEmbedder (FNV-1a feature hashing) and
 * createProviderEmbedder (wraps a provider's embeddings endpoint).
 */
import type { Embedder, ProviderAdapter } from '@neo/protocol';
import { NeoError } from '@neo/protocol';

// ─────────────────────────────── helpers ────────────────────────────────

/** FNV-1a 32-bit hash of a string's UTF-8 bytes (by code point, so supplementary-plane characters are 4 bytes). */
function fnv1a(s: string): number {
  let hash = 2166136261;
  const byte = (b: number) => {
    hash ^= b;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      byte(code);
    } else if (code < 0x800) {
      byte((code >> 6) | 0xc0);
      byte((code & 0x3f) | 0x80);
    } else if (code < 0x10000) {
      byte((code >> 12) | 0xe0);
      byte(((code >> 6) & 0x3f) | 0x80);
      byte((code & 0x3f) | 0x80);
    } else {
      byte((code >> 18) | 0xf0);
      byte(((code >> 12) & 0x3f) | 0x80);
      byte(((code >> 6) & 0x3f) | 0x80);
      byte((code & 0x3f) | 0x80);
    }
  }
  return hash >>> 0;
}

/**
 * Scripts written without spaces between words (as in text.ts: Han, Hiragana,
 * Katakana, Hangul, plus the prolonged sound mark ー and CJK symbols and
 * punctuation): each character is a token, and adjacent pairs are tokens too.
 */
const UNSPACED_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\u30fc]$/u;

function isCJK(ch: string): boolean {
  return UNSPACED_CHAR.test(ch);
}

/**
 * Tokens of a text with their counts, in first-occurrence order: NFKC, lower
 * case, split on whitespace, punctuation and symbols; within a segment every
 * unspaced-script character is a token (plus a pair token with the previous
 * one), every other run is a word. Iterates by code point, so a pair never
 * splits a surrogate pair. Exported for tests.
 */
export function hashingTokens(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  const add = (token: string) => freq.set(token, (freq.get(token) ?? 0) + 1);
  for (const seg of text.normalize('NFKC').toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    if (!seg) continue;
    let word = '';
    let prev: string | null = null; // previous character, when it was CJK
    for (const ch of seg) {
      if (isCJK(ch)) {
        if (word) add(word);
        word = '';
        add(ch);
        if (prev !== null) add(prev + ch);
        prev = ch;
      } else {
        prev = null;
        word += ch;
      }
    }
    if (word) add(word);
  }
  return freq;
}

/** Character trigrams of a token, by code point (a token shorter than 3 characters is used whole). */
function charTrigrams(token: string): string[] {
  const chars = [...token];
  if (chars.length < 3) return [token];
  const out: string[] = [];
  for (let i = 0; i <= chars.length - 3; i++) out.push(chars[i]! + chars[i + 1]! + chars[i + 2]!);
  return out;
}

/** L2-normalize a Float32Array in place. Returns the array. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  if (sum === 0) return v;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

// ─────────────────────────────── HashingEmbedder ────────────────────────────────

/**
 * Offline embedder: feature hashing of word unigrams/bigrams + char trigrams.
 * FNV-1a hash → signed bucket, log-scaled TF, L2-normalized.
 * Handles CJK, kana and hangul: individual characters and adjacent pairs are tokens.
 *
 * The id carries a version (`hash2-<dims>`): when the features change, a new id
 * makes the stale-vector logic re-embed every stored vector automatically.
 */
export const HASHING_EMBEDDER_VERSION = 'hash2';

export class HashingEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  /** Runs in-process: text never leaves the device. */
  readonly isLocal = true;

  constructor(dimensions = 512) {
    this.dimensions = dimensions;
    this.id = `${HASHING_EMBEDDER_VERSION}-${dimensions}`;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((text) => this._hashEmbed(text)));
  }

  private _hashEmbed(text: string): Float32Array {
    const dims = this.dimensions;
    const v = new Float32Array(dims);

    const freq = hashingTokens(text);
    const tokens = Array.from(freq.keys());

    // Word unigrams
    for (const tok of tokens) {
      const count = freq.get(tok)!;
      const weight = Math.log(1 + count);
      this._addFeature(v, tok, weight);

      // Char trigrams for words (not CJK) of at least 2 characters
      if ([...tok].length >= 2 && !isCJK(String.fromCodePoint(tok.codePointAt(0) ?? 0))) {
        for (const tri of charTrigrams(tok)) {
          this._addFeature(v, `#${tri}`, weight * 0.5);
        }
      }
    }

    // Word bigrams
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i]!;
      const b = tokens[i + 1]!;
      if (!isCJK(String.fromCodePoint(a.codePointAt(0) ?? 0)) && !isCJK(String.fromCodePoint(b.codePointAt(0) ?? 0))) {
        const bigram = `${a}_${b}`;
        const weight = Math.log(1 + Math.min(freq.get(a) ?? 1, freq.get(b) ?? 1)) * 0.7;
        this._addFeature(v, bigram, weight);
      }
    }

    return l2Normalize(v);
  }

  private _addFeature(v: Float32Array, feature: string, weight: number): void {
    const h = fnv1a(feature);
    const bucket = h % this.dimensions;
    // Sign: use a different hash bit
    const sign = ((h >> 16) & 1) === 0 ? 1 : -1;
    v[bucket] = (v[bucket] ?? 0) + sign * weight;
  }
}

// ─────────────────────────────── ProviderEmbedder ────────────────────────────────

const EMBED_BATCH_SIZE = 64;

/** Embedder backed by a provider's embed() method. Batches of 64, L2-normalizes, validates the response. */
export function createProviderEmbedder(adapter: ProviderAdapter, model: string): Embedder & { readonly isLocal: boolean; readonly settingsFingerprint: string } {
  if (!adapter.embed) {
    throw new NeoError('config_error', `Provider "${adapter.id}" does not support embeddings.`);
  }
  const embedFn = adapter.embed.bind(adapter);
  const id = `${adapter.id}:${model}`;
  const settingsFingerprint = JSON.stringify({
    kind: adapter.kind,
    baseUrl: adapter.config?.baseUrl,
    options: adapter.config?.options,
    headers: adapter.config?.headers,
  }, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]]));
    }
    return value;
  });
  // Unknown until the first response; vectors are stored with their own length.
  let dimensions = 0;

  return {
    id,
    settingsFingerprint,
    /** Text only stays on the device when the provider runs on the user's own infrastructure. */
    isLocal: adapter.isLocal === true,
    get dimensions(): number {
      return dimensions;
    },

    async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
      const results: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
        const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
        const raw = await embedFn({ model, texts: batch, signal });
        if (!Array.isArray(raw) || raw.length !== batch.length) {
          throw new NeoError('provider_error', `Embedding model ${id} returned ${Array.isArray(raw) ? raw.length : 'no'} vectors for ${batch.length} texts.`);
        }
        for (const values of raw) {
          const vec = Float32Array.from(values);
          if (vec.length === 0 || vec.some((x) => !Number.isFinite(x))) {
            throw new NeoError('provider_error', `Embedding model ${id} returned an invalid vector.`);
          }
          if (dimensions && vec.length !== dimensions) {
            throw new NeoError('provider_error', `Embedding model ${id} changed dimensions (${dimensions} → ${vec.length}).`);
          }
          dimensions = vec.length;
          results.push(l2Normalize(vec));
        }
      }
      return results;
    },
  };
}

/** Build the embedding text for a memory node. */
export function nodeEmbedText(kind: string, label: string, content: string, aliases: string[]): string {
  let text = `${kind}: ${label}. ${content}`;
  if (aliases.length > 0) {
    text += ` Also known as: ${aliases.join(', ')}`;
  }
  return text;
}

/**
 * True when an embedder runs on the user's own device or infrastructure (it says
 * so with `isLocal: true`). Embedders that don't say are treated as remote.
 */
export function isLocalEmbedder(embedder: Embedder): boolean {
  return (embedder as { isLocal?: unknown }).isLocal === true;
}

/**
 * The on-device embedder for text that must not leave the device while the main
 * embedder is remote (docs/MEMORY.md, privacy). Its own model id keeps its
 * vectors apart from the main model's.
 */
export class LocalFallbackEmbedder implements Embedder {
  readonly isLocal = true;
  readonly id: string;
  readonly dimensions: number;
  private readonly inner: HashingEmbedder;

  constructor(dimensions = 512) {
    this.inner = new HashingEmbedder(dimensions);
    this.id = `local-${this.inner.id}`;
    this.dimensions = dimensions;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return this.inner.embed(texts);
  }
}
