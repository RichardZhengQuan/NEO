/**
 * Memory math: retention, stability, edge decay and vector similarity.
 */
import type { EdgeType, MemoryKind, MemoryNode } from '@neo/protocol';
import { STRUCTURAL_EDGE_TYPES } from '@neo/protocol';
import { BASE_STABILITY_DAYS, MEMORY_CONSTANTS } from './constants.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

// ─────────────────────────────── retention ────────────────────────────────

/** Retention R = exp(-Δt/S) with Δt in days since last access (or creation). Pinned → 1. */
export function retention(
  node: Pick<MemoryNode, 'stability' | 'lastAccessedAt' | 'createdAt' | 'pinned'>,
  now: number,
): number {
  if (node.pinned) return 1;
  const last = node.lastAccessedAt ?? node.createdAt;
  const deltaDays = Math.max(0, now - last) / DAY_MS;
  if (!(node.stability > 0)) return deltaDays > 0 ? 0 : 1;
  return Math.exp(-deltaDays / node.stability);
}

// ─────────────────────────────── stability ────────────────────────────────

/** Initial stability S₀ = BASE_STABILITY_DAYS[kind] × (0.5 + importance). */
export function initialStability(kind: MemoryKind, importance: number): number {
  return BASE_STABILITY_DAYS[kind] * (0.5 + clamp01(importance));
}

/** Reinforcement: S ← min(max, S × (1 + gain × (1 − R)) + ε). */
export function reinforceStability(stability: number, R: number, gain: number, epsilon: number, maxDays: number): number {
  return Math.min(maxDays, stability * (1 + gain * (1 - R)) + epsilon);
}

/** The node fields that change when a memory is used (recall, re-mention, duplicate remember). */
export function reinforcedFields(
  node: Pick<MemoryNode, 'stability' | 'lastAccessedAt' | 'createdAt' | 'pinned' | 'accessCount'>,
  now: number,
): Pick<MemoryNode, 'stability' | 'accessCount' | 'lastAccessedAt'> {
  const C = MEMORY_CONSTANTS;
  return {
    stability: reinforceStability(node.stability, retention(node, now), C.stabilityGain, C.stabilityEpsilonDays, C.maxStabilityDays),
    accessCount: node.accessCount + 1,
    lastAccessedAt: Math.max(now, node.lastAccessedAt ?? 0),
  };
}

// ─────────────────────────────── edges ────────────────────────────────

const STRUCTURAL = new Set<string>(STRUCTURAL_EDGE_TYPES);

export function isStructural(type: string): boolean {
  return STRUCTURAL.has(type);
}

/** Associations without a direction of meaning (Hebbian links, similarity, conflicts). */
export function isSymmetric(type: string): boolean {
  return type === 'related' || type === 'similar' || type === 'contradicts';
}

/** Effective weight w × 0.5^(Δt / halfLife) since last reinforcement. Structural types don't decay. */
export function effectiveEdgeWeight(type: EdgeType | string, weight: number, lastReinforcedAt: number, now: number): number {
  if (isStructural(type)) return weight;
  const deltaDays = Math.max(0, now - lastReinforcedAt) / DAY_MS;
  return weight * Math.pow(0.5, deltaDays / MEMORY_CONSTANTS.edgeHalfLifeDays);
}

// ─────────────────────────────── vectors ────────────────────────────────

/** Cosine similarity of two (not necessarily normalized) vectors; 0 when either is zero or lengths differ. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(magA * magB)));
}

/** Dot product of two L2-normalized vectors (= cosine); 0 when lengths differ. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** A normalized copy (L2 = 1), or null for empty, zero or non-finite vectors. */
export function normalized(v: ArrayLike<number>): Float32Array | null {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  if (!(sum > 0) || !Number.isFinite(sum)) return null;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}
