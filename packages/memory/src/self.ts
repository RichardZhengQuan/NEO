/**
 * The user's own node (SELF_MEMORY_ID): the centre of the net. Every episode,
 * and every other memory written about the user, hangs on it with an `about`
 * edge, so the net holds together the way a person's memories do around
 * their sense of self, even when the episodes a fact came from fade.
 *
 * It only shapes the net: recall never seeds, spreads through or returns it
 * (it would connect everything to everything), and it is created with the
 * first memory about the user and removed with the last one.
 */
import { SELF_MEMORY_ID, type MemoryNode } from '@neo/protocol';
import type { NeoDatabase } from '@neo/storage';
import { addEdge, deleteNodes, getNode, insertNode, updateNode } from './db-helpers.js';
import { normalizeText } from './text.js';
import { initialStability } from './utils.js';

/** Background structure: lighter than a link to a named entity (0.8). */
export const SELF_LINK_WEIGHT = 0.3;

/** Entity names an extractor may use for the user: they mean the self node, never a new entity. */
const SELF_NAMES = new Set(['user', 'the user', 'me', 'myself', 'i', 'self', '用户', '我', '我自己', 'ユーザー', '사용자']);

/** Third-person references to the user, as extraction writes them ("The user's sister …", "用户喜欢…"). */
const USER_REFERENCE = /\b(?:the\s+)?users?(?:'s|’s|')?\b|用户|ユーザー|사용자/iu;
/** First-person references, for memories the user wrote themselves in the memory UI. */
const FIRST_PERSON = /\b(?:i|i'm|i’m|i've|i’ve|me|my|mine|myself)\b|我/iu;

export function isSelfName(name: string): boolean {
  return SELF_NAMES.has(normalizeText(name));
}

/** Memories that hang on the self node: every episode, and other non-entity memories about the user. */
export function isAboutSelf(node: Pick<MemoryNode, 'id' | 'kind' | 'label' | 'content' | 'source'>): boolean {
  if (node.id === SELF_MEMORY_ID || node.kind === 'entity') return false;
  if (node.kind === 'episode') return true;
  const text = `${node.label}\n${node.content}`;
  return USER_REFERENCE.test(text) || (node.source.by === 'user' && FIRST_PERSON.test(text));
}

/** The self node, created (or restored) on demand. The label is a placeholder: the UI shows it as "You". */
export function ensureSelf(db: NeoDatabase, now: number): MemoryNode {
  const existing = getNode(db, SELF_MEMORY_ID);
  if (existing) return existing.status === 'active' ? existing : updateNode(db, SELF_MEMORY_ID, { status: 'active' }, now)!;
  const node: MemoryNode = {
    id: SELF_MEMORY_ID,
    kind: 'entity',
    label: 'You',
    content: '',
    entityType: 'person',
    aliases: [],
    tags: [],
    importance: 1,
    confidence: 1,
    stability: initialStability('entity', 1),
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    pinned: true,
    sensitivity: 'normal',
    source: { by: 'assistant', note: 'The user: the centre of the memory net' },
  };
  insertNode(db, node);
  return node;
}

/** Hang `node` on the self node when it is about the user. Returns whether an edge was added. */
export function linkSelf(db: NeoDatabase, node: MemoryNode, now: number): boolean {
  if (!isAboutSelf(node)) return false;
  ensureSelf(db, now);
  return addEdge(db, node.id, SELF_MEMORY_ID, 'about', SELF_LINK_WEIGHT, now) !== null;
}

/** Remove the self node once nothing hangs on it any more (after a forget). Returns whether it was removed. */
export function dropLonelySelf(db: NeoDatabase): boolean {
  if (!getNode(db, SELF_MEMORY_ID)) return false;
  const linked = db.prepare('SELECT 1 AS x FROM memory_edges WHERE src = ? OR dst = ? LIMIT 1').get(SELF_MEMORY_ID, SELF_MEMORY_ID);
  return !linked && deleteNodes(db, [SELF_MEMORY_ID]).length > 0;
}

/** Migration backfill: hang every active or archived memory about the user on the self node. */
export function backfillSelf(db: NeoDatabase, now: number): number {
  const rows = db.prepare(`SELECT id FROM memory_nodes WHERE status IN ('active', 'archived') AND kind != 'entity' AND id != ? ORDER BY created_at, id`).all(SELF_MEMORY_ID) as { id: string }[];
  let linked = 0;
  for (const { id } of rows) {
    const node = getNode(db, id);
    if (node && linkSelf(db, node, now)) linked++;
  }
  return linked;
}
