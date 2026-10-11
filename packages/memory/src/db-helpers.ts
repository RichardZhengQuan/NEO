/**
 * Row ↔ domain conversions and the small set of SQL helpers every module
 * shares. All writes here are synchronous so callers can group them into one
 * `db.transaction()`.
 */
import type { EdgeType, MemoryEdge, MemoryKind, MemoryNode, MemorySource, MemoryStatus, Sensitivity } from '@neo/protocol';
import { newId } from '@neo/protocol';
import { fromJson, toBool, toNum, toNumOrNull, type NeoDatabase } from '@neo/storage';
import { normalizeText } from './text.js';
import { isSymmetric } from './utils.js';

// ─────────────────────────────── Row types ────────────────────────────────

export interface NodeRow {
  id: string;
  kind: string;
  label: string;
  norm_label: string;
  content: string;
  entity_type: string | null;
  aliases: string;
  tags: string;
  importance: number;
  confidence: number;
  stability: number;
  access_count: number | bigint;
  last_accessed_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  status: string;
  pinned: number | bigint;
  sensitivity: string;
  source: string;
  embedding_model: string | null;
  valid_until: number | bigint | null;
  consolidated_at: number | bigint | null;
  metadata: string | null;
}

export interface EdgeRow {
  id: string;
  src: string;
  dst: string;
  type: string;
  weight: number;
  created_at: number | bigint;
  updated_at: number | bigint;
  last_reinforced_at: number | bigint;
  coactivations: number | bigint;
}

// ─────────────────────────────── Row → domain ────────────────────────────────

export function rowToNode(row: NodeRow): MemoryNode {
  const node: MemoryNode = {
    id: row.id,
    kind: row.kind as MemoryKind,
    label: row.label,
    content: row.content,
    entityType: row.entity_type ?? undefined,
    aliases: fromJson<string[]>(row.aliases, []),
    tags: fromJson<string[]>(row.tags, []),
    importance: row.importance,
    confidence: row.confidence,
    stability: row.stability,
    accessCount: toNum(row.access_count),
    lastAccessedAt: toNumOrNull(row.last_accessed_at),
    createdAt: toNum(row.created_at),
    updatedAt: toNum(row.updated_at),
    status: row.status as MemoryStatus,
    pinned: toBool(row.pinned),
    sensitivity: row.sensitivity as Sensitivity,
    source: fromJson<MemorySource>(row.source, { by: 'extraction' }),
    embeddingModel: row.embedding_model ?? undefined,
    validUntil: toNumOrNull(row.valid_until) ?? undefined,
    consolidatedAt: toNumOrNull(row.consolidated_at) ?? undefined,
  };
  if (row.metadata) {
    const metadata = fromJson<Record<string, unknown> | null>(row.metadata, null);
    if (metadata && typeof metadata === 'object') node.metadata = metadata;
  }
  return node;
}

export function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    from: row.src,
    to: row.dst,
    type: row.type as EdgeType,
    weight: row.weight,
    createdAt: toNum(row.created_at),
    updatedAt: toNum(row.updated_at),
    lastReinforcedAt: toNum(row.last_reinforced_at),
    coactivations: toNum(row.coactivations),
  };
}

/** Run `query` over `ids` in chunks that stay far below SQLite's bound-parameter limit. */
export function chunked<T>(ids: readonly string[], query: (placeholders: string, chunk: string[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...query(chunk.map(() => '?').join(','), chunk));
  }
  return out;
}

// ─────────────────────────────── FTS ────────────────────────────────

function ftsInsert(db: NeoDatabase, node: MemoryNode): void {
  db.prepare('INSERT INTO memory_fts (node_id, label, content, aliases, tags) VALUES (?, ?, ?, ?, ?)').run(
    node.id,
    node.label,
    node.content,
    node.aliases.join(' '),
    node.tags.join(' '),
  );
}

export function ftsDelete(db: NeoDatabase, nodeId: string): void {
  db.prepare('DELETE FROM memory_fts WHERE node_id = ?').run(nodeId);
}

// ─────────────────────────────── Nodes ────────────────────────────────

export function insertNode(db: NeoDatabase, node: MemoryNode): void {
  db.prepare(`
    INSERT INTO memory_nodes (
      id, kind, label, norm_label, content, entity_type, aliases, tags,
      importance, confidence, stability, access_count, last_accessed_at,
      created_at, updated_at, status, pinned, sensitivity, source,
      embedding_model, valid_until, consolidated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    node.id,
    node.kind,
    node.label,
    normalizeText(node.label),
    node.content,
    node.entityType ?? null,
    JSON.stringify(node.aliases),
    JSON.stringify(node.tags),
    node.importance,
    node.confidence,
    node.stability,
    node.accessCount,
    node.lastAccessedAt ?? null,
    node.createdAt,
    node.updatedAt,
    node.status,
    node.pinned ? 1 : 0,
    node.sensitivity,
    JSON.stringify(node.source),
    node.embeddingModel ?? null,
    node.validUntil ?? null,
    node.consolidatedAt ?? null,
    node.metadata ? JSON.stringify(node.metadata) : null,
  );
  ftsInsert(db, node);
}

export function getNode(db: NeoDatabase, id: string): MemoryNode | null {
  const row = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function getNodes(db: NeoDatabase, ids: readonly string[]): MemoryNode[] {
  return chunked(ids, (ph, chunk) => (db.prepare(`SELECT * FROM memory_nodes WHERE id IN (${ph})`).all(...chunk) as unknown as NodeRow[]).map(rowToNode));
}

/**
 * Write changed fields of a node. `updatedAt` moves only for edits (`touch`,
 * default true): reinforcement and bookkeeping pass `touch: false`. The FTS row
 * is rewritten only when indexed text changed.
 */
export function updateNode(
  db: NeoDatabase,
  id: string,
  fields: Partial<Omit<MemoryNode, 'id' | 'createdAt'>>,
  now: number,
  options: { touch?: boolean } = {},
): MemoryNode | null {
  const node = getNode(db, id);
  if (!node) return null;
  const updated: MemoryNode = { ...node, ...fields, id: node.id, createdAt: node.createdAt, updatedAt: options.touch === false ? node.updatedAt : now };
  if (fields.metadata === undefined && 'metadata' in fields) delete updated.metadata;
  db.prepare(`
    UPDATE memory_nodes SET
      kind = ?, label = ?, norm_label = ?, content = ?, entity_type = ?,
      aliases = ?, tags = ?, importance = ?, confidence = ?, stability = ?,
      access_count = ?, last_accessed_at = ?, updated_at = ?, status = ?,
      pinned = ?, sensitivity = ?, source = ?, embedding_model = ?,
      valid_until = ?, consolidated_at = ?, metadata = ?
    WHERE id = ?
  `).run(
    updated.kind,
    updated.label,
    normalizeText(updated.label),
    updated.content,
    updated.entityType ?? null,
    JSON.stringify(updated.aliases),
    JSON.stringify(updated.tags),
    updated.importance,
    updated.confidence,
    updated.stability,
    updated.accessCount,
    updated.lastAccessedAt ?? null,
    updated.updatedAt,
    updated.status,
    updated.pinned ? 1 : 0,
    updated.sensitivity,
    JSON.stringify(updated.source),
    updated.embeddingModel ?? null,
    updated.validUntil ?? null,
    updated.consolidatedAt ?? null,
    updated.metadata ? JSON.stringify(updated.metadata) : null,
    id,
  );
  const textChanged =
    updated.label !== node.label ||
    updated.content !== node.content ||
    updated.aliases.join(' ') !== node.aliases.join(' ') ||
    updated.tags.join(' ') !== node.tags.join(' ');
  if (textChanged) {
    ftsDelete(db, id);
    ftsInsert(db, updated);
  }
  return updated;
}

/**
 * Hard delete: FTS rows, edges, vectors and node rows. Explicit deletes (not
 * only ON DELETE CASCADE) so nothing survives even on a connection opened
 * without `foreign_keys`. Returns the ids that existed.
 */
export function deleteNodes(db: NeoDatabase, ids: readonly string[]): string[] {
  const deleted: string[] = [];
  for (const id of new Set(ids)) {
    const exists = db.prepare('SELECT 1 AS x FROM memory_nodes WHERE id = ?').get(id);
    if (!exists) continue;
    ftsDelete(db, id);
    db.prepare('DELETE FROM memory_edges WHERE src = ? OR dst = ?').run(id, id);
    db.prepare('DELETE FROM memory_vectors WHERE node_id = ?').run(id);
    db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(id);
    deleted.push(id);
  }
  return deleted;
}

/**
 * The entity called `name` (normalized label or alias), preferring active over
 * pending/archived and older over newer. Superseded entities never match.
 */
export function findEntityByName(db: NeoDatabase, name: string): MemoryNode | null {
  const norm = normalizeText(name);
  if (!norm) return null;
  const byLabel = db
    .prepare(
      `SELECT * FROM memory_nodes WHERE kind = 'entity' AND norm_label = ? AND status != 'superseded'
       ORDER BY (status = 'active') DESC, created_at ASC LIMIT 1`,
    )
    .get(norm) as NodeRow | undefined;
  if (byLabel) return rowToNode(byLabel);
  const withAliases = db
    .prepare(
      `SELECT * FROM memory_nodes WHERE kind = 'entity' AND aliases != '[]' AND status != 'superseded'
       ORDER BY (status = 'active') DESC, created_at ASC`,
    )
    .all() as unknown as NodeRow[];
  for (const row of withAliases) {
    const aliases = fromJson<string[]>(row.aliases, []);
    if (aliases.some((a) => normalizeText(a) === norm)) return rowToNode(row);
  }
  return null;
}

// ─────────────────────────────── Edges ────────────────────────────────

export function getEdge(db: NeoDatabase, id: string): MemoryEdge | null {
  const row = db.prepare('SELECT * FROM memory_edges WHERE id = ?').get(id) as EdgeRow | undefined;
  return row ? rowToEdge(row) : null;
}

export function getEdgeBySrcDstType(db: NeoDatabase, src: string, dst: string, type: string): MemoryEdge | null {
  const row = db.prepare('SELECT * FROM memory_edges WHERE src = ? AND dst = ? AND type = ?').get(src, dst, type) as EdgeRow | undefined;
  return row ? rowToEdge(row) : null;
}

/** The edge between two nodes with this type; for symmetric types either direction counts. */
export function findEdge(db: NeoDatabase, src: string, dst: string, type: string): MemoryEdge | null {
  return getEdgeBySrcDstType(db, src, dst, type) ?? (isSymmetric(type) ? getEdgeBySrcDstType(db, dst, src, type) : null);
}

export function insertEdge(db: NeoDatabase, edge: MemoryEdge): void {
  db.prepare(`
    INSERT INTO memory_edges (id, src, dst, type, weight, created_at, updated_at, last_reinforced_at, coactivations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(edge.id, edge.from, edge.to, edge.type, edge.weight, edge.createdAt, edge.updatedAt, edge.lastReinforcedAt, edge.coactivations);
}

/** Add an edge unless it (or, for symmetric types, its reverse) exists or it would be a self-loop. */
export function addEdge(db: NeoDatabase, from: string, to: string, type: EdgeType, weight: number, now: number): MemoryEdge | null {
  if (from === to) return null;
  if (findEdge(db, from, to, type)) return null;
  const edge: MemoryEdge = {
    id: newId('edge', now),
    from,
    to,
    type,
    weight: Math.max(0, Math.min(1, weight)),
    createdAt: now,
    updatedAt: now,
    lastReinforcedAt: now,
    coactivations: 0,
  };
  insertEdge(db, edge);
  return edge;
}

export function getNodeEdges(db: NeoDatabase, nodeId: string): MemoryEdge[] {
  const rows = db.prepare('SELECT * FROM memory_edges WHERE src = ? OR dst = ?').all(nodeId, nodeId) as unknown as EdgeRow[];
  return rows.map(rowToEdge);
}

// ─────────────────────────────── Meta ────────────────────────────────

export function getMeta(db: NeoDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: NeoDatabase, key: string, value: string): void {
  db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

