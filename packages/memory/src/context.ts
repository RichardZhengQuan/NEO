/**
 * What every memory module needs: the database, the embedder and its vector
 * cache, time, logging, the live policy, the model, and the change emitter.
 */
import type { Clock, Embedder, Logger, MemoryChangeEvent, MemoryPolicy } from '@neo/protocol';
import type { NeoDatabase } from '@neo/storage';
import type { MemoryLLM } from './constants.js';
import type { VectorCache } from './vectors.js';

export interface MemoryContext {
  db: NeoDatabase;
  /** The main embedder (may be a cloud provider). */
  embedder: Embedder;
  /** On-device embedder for text that must not leave the device; === embedder when that one is local. */
  localEmbedder: Embedder;
  /**
   * True when a memory's text must stay on the device: sensitive (unless policy.sendSensitiveToCloud),
   * while the main embedder is remote.
   */
  keepLocal(node: { sensitivity: string }): boolean;
  vectors: VectorCache;
  clock: Clock;
  logger: Logger;
  policy(): MemoryPolicy;
  llm(): MemoryLLM | null;
  emit(event: MemoryChangeEvent): void;
}
