/**
 * Vector cache: `Map<nodeId, Float32Array>` per embedding model, loaded lazily
 * from `memory_vectors` and kept consistent with the database.
 *
 * Writers use two steps so a rolled-back transaction can never leave a vector
 * in the cache: `write()` (database, inside the caller's transaction) and then
 * `remember()` (cache, after commit). `put()` does both for single writes.
 */
import { SELF_MEMORY_ID, type Embedder, type Logger } from '@neo/protocol';
import { blobToVector, fromJson, vectorToBlob, type NeoDatabase } from '@neo/storage';
import { nodeEmbedText } from './embedder.js';
import { normalized } from './utils.js';

const REEMBED_BATCH = 64;

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface StaleRow {
  id: string;
  kind: string;
  label: string;
  content: string;
  aliases: string;
  sensitivity: string;
}

/** The embedding model each vector in memory came from (vectors of different models are never compared). */
const MODEL_OF = new WeakMap<Float32Array, string>();

export function tagVector(vector: Float32Array, model: string): Float32Array {
  MODEL_OF.set(vector, model);
  return vector;
}

/** The model a vector was computed with, when known. */
export function vectorModel(vector: Float32Array): string | undefined {
  return MODEL_OF.get(vector);
}

/** True when both vectors come from the same embedding space (untagged vectors count as the same). */
export function sameSpace(a: Float32Array, b: Float32Array): boolean {
  const ma = MODEL_OF.get(a);
  const mb = MODEL_OF.get(b);
  return a.length === b.length && (!ma || !mb || ma === mb);
}

/**
 * Where a memory's text may be embedded (docs/MEMORY.md, privacy): text that must
 * stay on the device (sensitive memories unless sendSensitiveToCloud) only ever
 * goes to the local embedder, and its vector is stored under that model id.
 */
export interface EmbeddingRouting {
  main: Embedder;
  /** === main when the main embedder runs locally. */
  local: Embedder;
  keepLocal(node: { sensitivity: string }): boolean;
}

export class VectorCache {
  private readonly caches = new Map<string, Map<string, Float32Array>>();
  private readonly loaded = new Set<string>();
  private reembedding: Promise<number> | null = null;
  private rerun = false;
  private routing: EmbeddingRouting | null = null;

  constructor(
    private readonly db: NeoDatabase,
    private readonly logger: Logger,
  ) {}

  /** How re-embedding chooses between the main and the local embedder. */
  setRouting(routing: EmbeddingRouting): void {
    this.routing = routing;
  }

  /** The embedder a node's text may go to: the local one when it must stay on the device. */
  embedderFor(main: Embedder, node: { sensitivity: string }): Embedder {
    const r = this.routing;
    return r && r.main === main && r.local !== main && r.keepLocal(node) ? r.local : main;
  }

  private cache(model: string): Map<string, Float32Array> {
    let cache = this.caches.get(model);
    if (!cache) {
      cache = new Map();
      this.caches.set(model, cache);
    }
    return cache;
  }

  /** All vectors of `model`, loading persisted ones on first use (entries already cached are newer and win). */
  all(model: string): Map<string, Float32Array> {
    const cache = this.cache(model);
    if (!this.loaded.has(model)) {
      const rows = this.db.prepare('SELECT node_id, vector FROM memory_vectors WHERE model = ?').all(model) as { node_id: string; vector: Uint8Array }[];
      for (const row of rows) {
        if (cache.has(row.node_id)) continue;
        try {
          const raw = blobToVector(row.vector);
          const vec = normalized(raw);
          if (vec) cache.set(row.node_id, tagVector(vec, model));
          else if (raw.length && raw.every((x) => x === 0)) cache.set(row.node_id, tagVector(raw, model));
        } catch {
          // A corrupt blob is treated as a missing vector (re-embedded later).
        }
      }
      this.loaded.add(model);
    }
    return cache;
  }

  get(model: string, nodeId: string): Float32Array | undefined {
    return this.all(model).get(nodeId);
  }

  /**
   * Persist a vector (normalized) and mark the node as embedded with `model`.
   * Database only: call {@link remember} after the surrounding transaction commits.
   * Returns the stored vector, or null when the vector is unusable.
   */
  write(model: string, nodeId: string, vector: Float32Array): Float32Array | null {
    if (!vector.length || vector.some((x) => !Number.isFinite(x))) return null;
    // A zero vector (some endpoints return one for empty/unsupported input) is kept as-is:
    // it matches nothing, but the node counts as embedded and is not re-embedded forever.
    const vec = tagVector(normalized(vector) ?? Float32Array.from(vector), model);
    this.db
      .prepare(
        `INSERT INTO memory_vectors (node_id, model, dims, vector) VALUES (?, ?, ?, ?)
         ON CONFLICT (node_id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vector = excluded.vector`,
      )
      .run(nodeId, model, vec.length, vectorToBlob(vec));
    this.db.prepare('UPDATE memory_nodes SET embedding_model = ? WHERE id = ?').run(model, nodeId);
    return vec;
  }

  /** Cache a vector already written with {@link write}. */
  remember(model: string, nodeId: string, vector: Float32Array): void {
    // Other models' entries for this node are stale now (one vector row per node).
    for (const [m, cache] of this.caches) if (m !== model) cache.delete(nodeId);
    this.cache(model).set(nodeId, tagVector(vector, model));
  }

  /** A node's vector in the main model, else in the local model (with the model it belongs to). */
  find(main: string, local: string, nodeId: string): Float32Array | undefined {
    return this.get(main, nodeId) ?? (local !== main ? this.get(local, nodeId) : undefined);
  }

  /** write + remember, for writes outside a larger transaction. */
  put(model: string, nodeId: string, vector: Float32Array): void {
    const vec = this.write(model, nodeId, vector);
    if (vec) this.remember(model, nodeId, vec);
  }

  /** Forget a node's vectors in every model's cache (database rows are deleted with the node). */
  drop(nodeId: string): void {
    for (const cache of this.caches.values()) cache.delete(nodeId);
  }

  /** Forget a model's cached vectors; the next read reloads from the database. */
  evictAll(model: string): void {
    this.caches.delete(model);
    this.loaded.delete(model);
  }

  /** Forget everything (after `import(replace)`); the next read reloads from the database. */
  clear(): void {
    this.caches.clear();
    this.loaded.clear();
  }

  /** True while a background re-embedding pass is running. */
  get busy(): boolean {
    return this.reembedding !== null;
  }

  /**
   * Re-embed every node whose vector is missing or from another model than the
   * one it should have (see {@link EmbeddingRouting}: text that must stay on the
   * device goes to the local embedder only), in batches of 64, yielding between
   * batches. Concurrent calls share one pass. Recall keeps working meanwhile:
   * nodes without a current vector are just not vector seeds. Never touches
   * `updated_at`. The self node is never embedded: nothing compares against it.
   * Resolves to the number of nodes embedded.
   */
  reembedStale(embedder: Embedder): Promise<number> {
    if (this.reembedding) {
      // Nodes added during the running pass may sort before its cursor: go again afterwards.
      this.rerun = true;
      return this.reembedding;
    }
    const run = async (): Promise<number> => {
      let embedded = 0;
      let cursor = '';
      const isCurrent = () => !this.routing || this.routing.main === embedder;
      try {
        this.all(embedder.id);
        for (;;) {
          if (!isCurrent()) break;
          const page = this.db
            .prepare(
              `SELECT id, kind, label, content, aliases, sensitivity, embedding_model FROM memory_nodes
               WHERE (embedding_model IS NULL OR embedding_model != ?) AND id > ? AND id != ?
               ORDER BY id LIMIT ${REEMBED_BATCH}`,
            )
            .all(embedder.id, cursor, SELF_MEMORY_ID) as unknown as (StaleRow & { embedding_model: string | null })[];
          if (!page.length) break;
          cursor = page[page.length - 1]!.id;
          // Group by target embedder; a node already embedded where it belongs is left alone.
          const groups = new Map<Embedder, StaleRow[]>();
          for (const row of page) {
            const target = this.embedderFor(embedder, row);
            if (row.embedding_model === target.id) continue;
            const group = groups.get(target) ?? [];
            group.push(row);
            groups.set(target, group);
          }
          for (const [target, rows] of groups) {
            if (!isCurrent()) return embedded;
            const texts = rows.map((r) => nodeEmbedText(r.kind, r.label, r.content, fromJson<string[]>(r.aliases, [])));
            const vectors = await target.embed(texts);
            // A live swap retires this adapter, including any batch already in flight.
            if (!isCurrent()) return embedded;
            if (vectors.length !== rows.length) throw new Error(`embedder returned ${vectors.length} vectors for ${rows.length} texts`);
            const written: [string, Float32Array][] = [];
            this.db.transaction(() => {
              rows.forEach((row, i) => {
                // The node may have been edited, re-embedded, made sensitive or deleted while we waited.
                const current = this.db
                  .prepare('SELECT kind, label, content, aliases, sensitivity, embedding_model FROM memory_nodes WHERE id = ?')
                  .get(row.id) as (StaleRow & { embedding_model: string | null }) | undefined;
                if (!current || current.embedding_model === target.id || this.embedderFor(embedder, current) !== target) return;
                const text = nodeEmbedText(current.kind, current.label, current.content, fromJson<string[]>(current.aliases, []));
                if (text !== texts[i]) return;
                const vec = this.write(target.id, row.id, vectors[i]!);
                if (vec) written.push([row.id, vec]);
              });
            });
            for (const [id, vec] of written) this.remember(target.id, id, vec);
            embedded += written.length;
          }
          await yieldToEventLoop();
        }
      } catch (err) {
        this.logger.warn('memory: re-embedding failed; will retry later', { error: String(err), embedder: embedder.id });
      }
      if (embedded) this.logger.debug('memory: re-embedded nodes', { count: embedded, embedder: embedder.id });
      return embedded;
    };
    const pass: Promise<number> = run().finally(() => {
      if (this.reembedding === pass) this.reembedding = null;
      if (this.rerun) {
        this.rerun = false;
        void this.reembedStale(this.routing?.main ?? embedder);
      }
    });
    this.reembedding = pass;
    return pass;
  }
}
