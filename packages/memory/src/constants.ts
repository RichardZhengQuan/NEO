/**
 * Shared constants and core types (no imports from the rest of the package).
 * Imported by utils.ts, write.ts, recall.ts, etc. to avoid circular deps.
 */
import type { ChatModel, Clock, Embedder, Logger, MemoryNode, MemoryPolicy } from '@neo/protocol';
import type { NeoDatabase } from '@neo/storage';

/** The model memory uses for extraction & consolidation. */
export interface MemoryLLM {
  model: ChatModel;
  name: string;
  isLocal: boolean;
}

export interface MemoryServiceOptions {
  db: NeoDatabase;
  embedder?: Embedder;
  llm?: () => MemoryLLM | null;
  policy?: MemoryPolicy;
  clock?: Clock;
  logger?: Logger;
}

export const MEMORY_CONSTANTS = {
  seedTopK: 24,
  seedSimilarityFloor: 0.2,
  lexicalTopK: 24,
  spreadHops: 2,
  spreadDecay: 0.5,
  minEdgeWeight: 0.05,
  frontierLimit: 200,
  pinnedActivationFloor: 0.3,
  pinnedAlwaysLimit: 6,
  strengthBase: 0.5,
  weightRetention: 0.25,
  weightImportance: 0.15,
  weightConfidence: 0.1,
  pinnedBoost: 1.15,
  mmrLambda: 0.7,
  dedupeSimilarity: 0.92,
  extractionConfidence: 0.8,
  userConfidence: 0.95,
  hebbianRate: 0.1,
  hebbianPairs: 5,
  stabilityGain: 1.0,
  stabilityEpsilonDays: 0.1,
  maxStabilityDays: 3650,
  archiveRetention: 0.05,
  archiveMaxImportance: 0.7,
  edgeHalfLifeDays: 90,
  edgeFloor: 0.02,
  similarLinkThreshold: 0.8,
  similarLinksPerNode: 3,
  consolidationClusterThreshold: 0.75,
  maxClustersPerRun: 20,
  entityMergeSimilarity: 0.95,
  // ── additions (not in the original table of docs/MEMORY.md) ──
  /**
   * "Personal profile" seeds: a broad self-referential question ("what do you
   * remember about me?", "你记得我什么") shares no words with any memory, so it
   * seeds the strongest active facts/preferences/goals/entities (importance × R).
   */
  profileSeedLimit: 8,
  profileActivation: 0.35,
  /** Hard cap on one extraction/consolidation model call; a hung model must not stall memory. */
  llmTimeoutMs: 90_000,
  /** User/assistant text is truncated to this many characters before extraction. */
  maxTurnTextChars: 4000,
  /**
   * Offline episodes: without an extracted memory, an episode is only kept when the user's
   * statements (questions and chit-chat removed) are at least this many characters long…
   */
  episodeMinChars: 15,
  /** …or this many when they contain Han characters (Chinese says more per character). */
  episodeMinCharsCJK: 6,
  /** Episodes older than this are abstracted even when they form a cluster of one. */
  singleEpisodeAbstractDays: 7,
  /** findForForget: minimum cosine similarity for a vector match. */
  forgetSimilarity: 0.35,
  /**
   * RecallQuery.context (e.g. the tail of NEO's previous reply) only nudges the semantic
   * similarity up: sim = s_text + w·max(0, s_context − s_text), so sim ≤ w + (1 − w)·s_text and
   * the context alone never lifts a memory over seedSimilarityFloor. It never seeds keywords,
   * entities or profile memories.
   */
  recallContextWeight: 0.2,
  /**
   * Keyword seeds are IDF-weighted: a term's weight is idf(df) / idf(1) (1 for a term only one
   * memory has, lower the more memories share it). A memory's lexical relevance is the sum over
   * the query terms it contains; it seeds only at ≥ lexicalMinRelevance, with
   * a₀ = lexicalMaxActivation × min(1, relevance).
   */
  lexicalMinRelevance: 0.35,
  lexicalMaxActivation: 0.8,
  /**
   * idf is computed as if the net had this many more memories without the term (a prior),
   * so small nets don't treat their main topic as a common word.
   */
  lexicalIdfPrior: 20,
  /** In a net of ≥ lexicalIdfPrior candidates, a term found in more than this share of them is ignored as too common. */
  lexicalMaxDocShare: 0.5,
  /**
   * observe(): a create that matches a memory the `remember` tool wrote in the same turn
   * (same kind, or fact ↔ preference) at this similarity, or by label/content containment,
   * is that memory, not a new one.
   */
  turnDedupeSimilarity: 0.8,
} as const;

export const BASE_STABILITY_DAYS: Record<MemoryNode['kind'], number> = {
  episode: 3,
  fact: 30,
  entity: 90,
  preference: 60,
  skill: 45,
  goal: 14,
  summary: 30,
};
