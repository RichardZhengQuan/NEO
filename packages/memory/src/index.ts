/**
 * @neo/memory — the memory net.
 *
 * FROZEN PUBLIC API (docs/IMPLEMENTATION_PLAN.md, WP-memory). Implementations
 * may add exports but must not change these signatures.
 */
import type {
  Embedder,
  MemoryNode,
  MemoryService,
  ProviderAdapter,
  RememberInput,
} from '@neo/protocol';
import type { Migration } from '@neo/storage';
import { HashingEmbedder as HashingEmbedderImpl, createProviderEmbedder as createProviderEmbedderImpl } from './embedder.js';
import { retention as retentionImpl, cosineSimilarity as cosineSimilarityImpl } from './utils.js';
import { heuristicExtract as heuristicExtractImpl } from './heuristic.js';
import { memoryMigrations as _memoryMigrations } from './schema.js';
import { createMemoryServiceImpl } from './service.js';
import type { MemoryServiceOptions } from './constants.js';

// Export constants and shared types (also used by sub-modules via ./constants.js)
export { MEMORY_CONSTANTS, BASE_STABILITY_DAYS } from './constants.js';
export type { MemoryLLM, MemoryServiceOptions } from './constants.js';

/** Create the service and run memory migrations on `db`. */
export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  return createMemoryServiceImpl(options);
}

export const memoryMigrations: Migration[] = _memoryMigrations;

/**
 * Offline embedder: feature hashing of word uni/bigrams + char trigrams, L2-normalized.
 * id = `hash2-<dims>` (the prefix is versioned: a change of features changes the id, so stored
 * vectors are re-embedded).
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  /** Runs in-process: text never leaves the device. */
  readonly isLocal = true;

  private readonly _impl: HashingEmbedderImpl;

  constructor(dimensions = 512) {
    this._impl = new HashingEmbedderImpl(dimensions);
    this.dimensions = dimensions;
    this.id = this._impl.id;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return this._impl.embed(texts);
  }
}

/** Embedder backed by a provider's embeddings endpoint. id = `<provider>:<model>`. */
export function createProviderEmbedder(adapter: ProviderAdapter, model: string): Embedder {
  return createProviderEmbedderImpl(adapter, model);
}

/** Retention R = exp(-Δt/S) with Δt in days since last access (or creation). Pinned → 1. */
export function retention(node: Pick<MemoryNode, 'stability' | 'lastAccessedAt' | 'createdAt' | 'pinned'>, now: number): number {
  return retentionImpl(node, now);
}

/** Cosine similarity of two (not necessarily normalized) vectors; 0 when either is zero. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  return cosineSimilarityImpl(a, b);
}

/** Offline rule-based extraction ("my name is…", "I like…", "remember that…"). */
export function heuristicExtract(userText: string): RememberInput[] {
  return heuristicExtractImpl(userText);
}
