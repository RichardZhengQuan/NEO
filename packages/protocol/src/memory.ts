/**
 * The memory net. NEO remembers the way people do: as a network of typed
 * memories joined by weighted associations. Recall spreads activation through
 * the net; unused memories fade; recalled ones get stronger; idle-time
 * consolidation turns experiences into knowledge. See docs/MEMORY.md.
 */
import { z } from 'zod';
import type { Message, ModelRef } from './content.js';

export const MemoryKindSchema = z.enum([
  'episode', // something that happened ("we planned the Kyoto trip on Oct 3")
  'fact', // semantic knowledge about the user or world ("Richard's sister is Mia")
  'entity', // a person, place, organization, pet, project, thing
  'preference', // likes/dislikes/how they want things done
  'skill', // procedures/how-tos the user taught NEO
  'goal', // ongoing intentions and plans
  'summary', // abstractions produced by consolidation
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export const MEMORY_KINDS = MemoryKindSchema.options;

export const MemoryStatusSchema = z.enum(['active', 'archived', 'superseded']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/** Sensitive memories are only shared with models on the user's own infrastructure (unless allowed). */
export const SensitivitySchema = z.enum(['normal', 'sensitive']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const EdgeTypeSchema = z.enum([
  'related', // generic association (also created by Hebbian co-activation)
  'about', // fact/preference/goal → entity it is about
  'mentions', // episode → entity/fact it mentions
  'part_of', // entity → larger entity, episode → summary
  'derived_from', // summary/fact → source episodes (consolidation provenance)
  'supersedes', // newer belief → older belief it replaced
  'contradicts', // unresolved conflict
  'precedes', // temporal order between episodes
  'causes', // causal link
  'similar', // high embedding similarity
]);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

/** Structural edges never decay or get pruned. */
export const STRUCTURAL_EDGE_TYPES: readonly EdgeType[] = ['about', 'part_of', 'derived_from', 'supersedes', 'precedes'];

export const MemorySourceSchema = z.object({
  by: z.enum(['user', 'assistant', 'extraction', 'consolidation', 'import', 'tool']),
  conversationId: z.string().nullable().optional(),
  /** Timeline message identity; conversationId remains the internal episode id. */
  messageId: z.string().nullable().optional(),
  note: z.string().max(500).optional(),
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryNodeSchema = z.object({
  id: z.string(),
  kind: MemoryKindSchema,
  /** Short title (≤ 120 chars), e.g. "Allergic to peanuts". */
  label: z.string().min(1).max(300),
  /** Full statement in third person, self-contained. */
  content: z.string().max(10_000),
  /** For entities: person | place | organization | pet | project | thing | concept … */
  entityType: z.string().max(40).nullable().optional(),
  aliases: z.array(z.string().max(120)).default([]),
  tags: z.array(z.string().max(60)).default([]),
  /** Salience at encoding time, 0..1. */
  importance: z.number().min(0).max(1),
  /** Belief strength, 0..1 (lowered when contradicted). */
  confidence: z.number().min(0).max(1),
  /** Memory stability S in days (retention R = exp(-Δt/S)); grows with spaced recall. */
  stability: z.number().positive(),
  accessCount: z.number().int().nonnegative(),
  lastAccessedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: MemoryStatusSchema,
  pinned: z.boolean(),
  sensitivity: SensitivitySchema,
  source: MemorySourceSchema,
  embeddingModel: z.string().nullable().optional(),
  /** Facts that expire (e.g. "is in Paris this week"). Epoch ms. */
  validUntil: z.number().nullable().optional(),
  /** Episodes: when consolidation absorbed it. */
  consolidatedAt: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type MemoryNode = z.infer<typeof MemoryNodeSchema>;

export const MemoryEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: EdgeTypeSchema,
  /** Association strength 0..1. */
  weight: z.number().min(0).max(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastReinforcedAt: z.number(),
  /** How many times both ends were recalled and used together. */
  coactivations: z.number().int().nonnegative(),
});
export type MemoryEdge = z.infer<typeof MemoryEdgeSchema>;

/**
 * The user's own node: the centre of the net. Every episode, and every other
 * memory written about the user ("The user …"), links to it with an `about`
 * edge, the way a person's memories hang together around their sense of self.
 * It only shapes the net: recall never seeds, spreads through or returns it.
 */
export const SELF_MEMORY_ID = 'mem_self';

/** Compact form used in events and UI. */
export interface MemoryNodeSummary {
  id: string;
  kind: MemoryKind;
  label: string;
  status: MemoryStatus;
}

export function summarizeNode(n: MemoryNode): MemoryNodeSummary {
  return { id: n.id, kind: n.kind, label: n.label, status: n.status };
}

export interface MemoryNodeDetail {
  node: MemoryNode;
  /** Current retention R ∈ [0,1]. */
  retention: number;
  edges: MemoryEdge[];
  neighbors: MemoryNodeSummary[];
  /** Older versions this node superseded (newest first). */
  history: MemoryNode[];
}

// ───────────────────────────── policy ─────────────────────────────

export const MemoryPolicySchema = z.object({
  /** Recall memories into context each turn. */
  recall: z.boolean().default(true),
  recallLimit: z.number().int().min(0).max(50).default(12),
  recallTokenBudget: z.number().int().min(0).max(8000).default(1500),
  minScore: z.number().min(0).max(1).default(0.15),
  allowedKinds: z.array(MemoryKindSchema).default([...MEMORY_KINDS]),
  storeEpisodes: z.boolean().default(true),
  /** Allow sensitive memories to be sent to cloud models. */
  sendSensitiveToCloud: z.boolean().default(false),
  consolidation: z
    .object({
      enabled: z.boolean().default(true),
      intervalHours: z.number().min(0.25).max(24 * 7).default(6),
    })
    .prefault({}),
});
export type MemoryPolicy = z.infer<typeof MemoryPolicySchema>;
export const DEFAULT_MEMORY_POLICY: MemoryPolicy = MemoryPolicySchema.parse({});

// ───────────────────────────── service I/O ─────────────────────────────

export interface RecallQuery {
  /** What the user just said. Drives every seed source (semantic, keyword, entity, profile). */
  text: string;
  /**
   * Optional surrounding context (e.g. the tail of the previous assistant reply). It only nudges
   * the semantic query vector and never creates keyword or entity seeds, so an assistant's own
   * wording can't flood recall.
   */
  context?: string;
  /**
   * The conversation being answered. Its own episodes are already in the transcript (working
   * memory), so recall leaves them out.
   */
  conversationId?: string;
  limit?: number;
  tokenBudget?: number;
  kinds?: MemoryKind[];
  /** Include sensitive memories (local model, or user allowed cloud). Default false. */
  allowSensitive?: boolean;
  includeArchived?: boolean;
  /** Strengthen recalled memories (spaced repetition + Hebbian links). Default true. */
  reinforce?: boolean;
  now?: number;
}

export interface RecalledMemory {
  node: MemoryNode;
  /** Final ranking score. */
  score: number;
  /** Spreading activation reached by this node. */
  activation: number;
  /** Cosine similarity to the query (0 when reached only through links). */
  similarity: number;
  retention: number;
  /** Association path from a seed, for "why do you remember this?". Empty for seeds. */
  via: { nodeId: string; label: string; edgeType: EdgeType }[];
  /** Human explanation, e.g. "matches your message" or "linked via Mia (about)". */
  reason: string;
}

export interface RecallResult {
  items: RecalledMemory[];
  tookMs: number;
  seeds: number;
  considered: number;
}

export interface ObservedTurn {
  conversationId: string;
  userMessage: Message;
  assistantMessage: Message;
  /** Model that answered (memory may use a different model for extraction). */
  model?: ModelRef | null;
  now?: number;
}

export interface MemoryWriteResult {
  created: MemoryNode[];
  updated: MemoryNode[];
  superseded: MemoryNode[];
  linked: number;
  /** Why nothing was written (incognito, nothing worth remembering…). */
  skipped?: string;
}

export const RememberInputSchema = z.object({
  content: z.string().min(1).max(10_000),
  label: z.string().min(1).max(300).optional(),
  kind: MemoryKindSchema.optional(),
  entityType: z.string().max(40).optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  pinned: z.boolean().optional(),
  sensitivity: SensitivitySchema.optional(),
  /** Entity names this memory is about; entities are created/linked automatically. */
  entities: z.array(z.string().max(120)).max(20).optional(),
  validUntil: z.number().nullable().optional(),
  source: MemorySourceSchema.optional(),
});
export type RememberInput = z.infer<typeof RememberInputSchema>;

export const MemoryNodePatchSchema = z.object({
  label: z.string().min(1).max(300).optional(),
  content: z.string().max(10_000).optional(),
  kind: MemoryKindSchema.optional(),
  entityType: z.string().max(40).nullable().optional(),
  aliases: z.array(z.string().max(120)).max(20).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
  sensitivity: SensitivitySchema.optional(),
  status: z.enum(['active', 'archived']).optional(),
  validUntil: z.number().nullable().optional(),
});
export type MemoryNodePatch = z.infer<typeof MemoryNodePatchSchema>;

export const MemorySearchQuerySchema = z.object({
  query: z.string().max(1000).optional(),
  kinds: z.array(MemoryKindSchema).optional(),
  status: z.array(MemoryStatusSchema).optional(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  sort: z.enum(['relevance', 'recent', 'importance', 'strength']).optional(),
});
export type MemorySearchQuery = z.infer<typeof MemorySearchQuerySchema>;

export const GraphQuerySchema = z.object({
  centerId: z.string().optional(),
  depth: z.number().int().min(1).max(4).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  kinds: z.array(MemoryKindSchema).optional(),
  includeArchived: z.boolean().optional(),
});
export type GraphQuery = z.infer<typeof GraphQuerySchema>;

export interface MemoryGraph {
  nodes: (MemoryNode & { retention: number })[];
  edges: MemoryEdge[];
}

export interface ConsolidationReport {
  id: string;
  startedAt: number;
  finishedAt: number;
  archived: number;
  edgesDecayed: number;
  edgesPruned: number;
  episodesConsolidated: number;
  factsCreated: number;
  linksCreated: number;
  entitiesMerged: number;
  /** Human-readable "dream journal" lines. */
  notes: string[];
}

export interface MemoryStats {
  total: number;
  byKind: Record<MemoryKind, number>;
  byStatus: Record<MemoryStatus, number>;
  edges: number;
  lastConsolidationAt: number | null;
  embeddingModel: string;
}

export const MemoryExportSchema = z.object({
  format: z.literal('neo-memory'),
  version: z.literal(1),
  exportedAt: z.number(),
  embeddingModel: z.string().nullable().optional(),
  nodes: z.array(MemoryNodeSchema),
  edges: z.array(MemoryEdgeSchema),
  /** nodeId → base64 of little-endian Float32 vector (only when exported with embeddings). */
  embeddings: z.record(z.string(), z.string()).optional(),
});
export type MemoryExport = z.infer<typeof MemoryExportSchema>;

export interface ImportReport {
  nodes: number;
  edges: number;
  skipped: number;
}

export type MemoryChangeEvent = {
  type: 'created' | 'updated' | 'deleted' | 'consolidated';
  nodeIds: string[];
};

export interface MemoryService {
  /** Read path: semantic seeds + spreading activation + retention/importance ranking. */
  recall(query: RecallQuery): Promise<RecallResult>;
  /** Write path after a turn: extract, dedupe/merge, supersede, link. Respects policy & incognito. */
  observe(turn: ObservedTurn): Promise<MemoryWriteResult>;
  /** Explicit "remember this". Memories are active immediately. */
  /** Cancellation is rechecked before the write, after embedding. */
  remember(input: RememberInput, signal?: AbortSignal): Promise<MemoryNode>;
  search(query: MemorySearchQuery): Promise<{ items: MemoryNode[]; total: number }>;
  get(id: string): Promise<MemoryNodeDetail | null>;
  update(id: string, patch: MemoryNodePatch): Promise<MemoryNode>;
  /** Hard delete (nodes + their edges + vectors). Returns number deleted. */
  forget(ids: string[]): Promise<number>;
  /** Memories whose provenance names one of these timeline messages. */
  findBySource(messageIds: string[]): Promise<MemoryNode[]>;
  forgetBySource(messageIds: string[]): Promise<number>;
  /** Find memories matching a natural-language description (for "forget everything about X"). */
  findForForget(query: string, limit?: number): Promise<MemoryNode[]>;
  link(from: string, to: string, type: EdgeType, weight?: number): Promise<MemoryEdge>;
  unlink(edgeId: string): Promise<boolean>;
  graph(query: GraphQuery): Promise<MemoryGraph>;
  /** "Sleep": decay, archive faded memories, abstract episodes, discover links, merge entities. */
  consolidate(options?: { now?: number; force?: boolean; signal?: AbortSignal }): Promise<ConsolidationReport>;
  journal(limit?: number): Promise<ConsolidationReport[]>;
  stats(): Promise<MemoryStats>;
  export(options?: { includeEmbeddings?: boolean }): Promise<MemoryExport>;
  import(data: MemoryExport, options?: { mode?: 'merge' | 'replace' }): Promise<ImportReport>;
  getPolicy(): MemoryPolicy;
  setPolicy(policy: MemoryPolicy): void;
  onChange(listener: (event: MemoryChangeEvent) => void): () => void;
}
