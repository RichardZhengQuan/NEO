/**
 * Identifiers. Every NEO id is `<prefix>_<time36><random>`: globally unique,
 * roughly time-sortable and self-describing in logs and URLs.
 */
export const ID_PREFIXES = [
  'conv', // conversation
  'msg', // message
  'turn', // agent turn
  'tc', // tool call (when the provider gives none)
  'ui', // generative UI part
  'mem', // memory node
  'edge', // memory edge
  'cons', // consolidation report
  'rem', // reminder
  'task', // task
  'list', // task list
  'note', // note
  'ntf', // notification
  'dev', // device
  'push', // push subscription
  'cnf', // confirmation (single-use approval nonce)
  'pair', // pairing session (one-time phone pairing code)
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Create a new id such as `mem_lq2k8x0a3f9s1z0c4hb7`. */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${now.toString(36).padStart(9, '0')}${randomChars(12)}`;
}

/** True when `id` looks like an id created by {@link newId} with this prefix. */
export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`) && id.length > prefix.length + 1;
}

/** Random url-safe secret (used for auth tokens). 32 bytes → 43 chars. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
