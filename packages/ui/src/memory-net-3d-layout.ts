import { SELF_MEMORY_ID, type MemoryEdge, type MemoryGraph, type MemoryKind, type MemoryNode, type ToolUseEvent } from '@neo/protocol';

/** Memories shown in the net, leaving out the self node (the spine) so counts match Stats. */
export function countMemories(nodes: readonly { id: string }[]): number {
  return nodes.reduce((n, node) => (node.id === SELF_MEMORY_ID ? n : n + 1), 0);
}

const DAY = 86_400_000;
const KINDS: readonly MemoryKind[] = ['entity', 'fact', 'preference', 'goal', 'skill', 'episode', 'summary'];

export interface MemoryTimeScaleOptions {
  now?: number;
  minDaySpacing?: number;
  maxGapSpacing?: number;
}

export interface MemoryTimeGap {
  from: number;
  to: number;
  y: number;
  spacing: number;
}

export interface MemoryTimeScale {
  yAt: (timestamp: number) => number;
  minY: number;
  maxY: number;
  oldestAt: number;
  newestAt: number;
  days: { at: number; y: number }[];
  gaps: MemoryTimeGap[];
  minDaySpacing: number;
  maxGapSpacing: number;
}

export interface MemoryTimeTick {
  at: number;
  y: number;
  unit: 'day' | 'week' | 'month';
}

const dayAt = (timestamp: number): number => Math.floor(timestamp / DAY) * DAY;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;

/** UTC days occupy small bands; empty intervals take logarithmic, capped space. */
export function createMemoryTimeScale(timestamps: readonly number[], options: MemoryTimeScaleOptions = {}): MemoryTimeScale {
  const values = timestamps.filter(Number.isFinite);
  if (options.now !== undefined && Number.isFinite(options.now)) values.push(options.now);
  if (!values.length) values.push(0);
  const oldestAt = Math.min(...values);
  const newestAt = Math.max(...values);
  const minDaySpacing = Math.max(1, finite(options.minDaySpacing ?? 36, 36));
  const band = minDaySpacing / 6;
  const maxGapSpacing = Math.max(minDaySpacing + band * 2, finite(options.maxGapSpacing ?? 120, 120));
  const days = [...new Set(values.map(dayAt))].sort((a, b) => a - b).map((at) => ({ at, y: 0 }));
  const gaps: MemoryTimeGap[] = [];
  for (let index = 1; index < days.length; index++) {
    const previous = days[index - 1]!;
    const current = days[index]!;
    const elapsedDays = (current.at - previous.at) / DAY;
    // Reserve one band at each end so the cap and minimum also hold between nodes.
    const spacing = Math.min(maxGapSpacing - band, minDaySpacing + band + Math.log2(elapsedDays) * minDaySpacing / 2);
    current.y = previous.y + spacing;
    if (elapsedDays > 1) gaps.push({ from: previous.at + DAY, to: current.at, y: previous.y + spacing / 2, spacing });
  }
  const rawYAt = (timestamp: number): number => {
    const at = clamp(finite(timestamp, oldestAt), oldestAt, newestAt);
    const day = dayAt(at);
    let low = 0;
    let high = days.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (days[middle]!.at <= day) low = middle;
      else high = middle - 1;
    }
    const previous = days[low]!;
    if (previous.at === day || low === days.length - 1) return previous.y + (at - previous.at) / DAY * band;
    const next = days[low + 1]!;
    const start = previous.at + DAY;
    const fraction = (at - start) / (next.at - start);
    return previous.y + band + fraction * (next.y - previous.y - band);
  };
  const offset = rawYAt(oldestAt);
  const yAt = (timestamp: number): number => rawYAt(timestamp) - offset;
  return {
    yAt,
    minY: 0,
    maxY: yAt(newestAt),
    oldestAt,
    newestAt,
    days: days.map(({ at }) => ({ at, y: yAt(at) })),
    gaps: gaps.map((gap) => ({ ...gap, y: gap.y - offset })),
    minDaySpacing,
    maxGapSpacing,
  };
}

/** Calendar ticks use the real date span, even when its empty gaps are compressed. */
export function generateMemoryTimeTicks(scale: MemoryTimeScale): MemoryTimeTick[] {
  const spanDays = (scale.newestAt - scale.oldestAt) / DAY;
  const unit = spanDays <= 21 ? 'day' : spanDays <= 120 ? 'week' : 'month';
  const date = new Date(dayAt(scale.oldestAt));
  if (unit === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (unit === 'month') date.setUTCDate(1);
  const ticks: MemoryTimeTick[] = [];
  for (let count = 0; count < 2400 && date.getTime() <= scale.newestAt; count++) {
    const at = date.getTime();
    const y = scale.yAt(at);
    // Empty months can project close together; a break already marks that interval.
    if (!ticks.length || y - ticks[ticks.length - 1]!.y >= scale.minDaySpacing * .65) ticks.push({ at, y, unit });
    if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
    else date.setUTCDate(date.getUTCDate() + (unit === 'week' ? 7 : 1));
  }
  return ticks;
}

export interface Net3DPoint {
  x: number;
  y: number;
  z: number;
}

export interface Net3DNode extends Net3DPoint {
  id: string;
  node: MemoryGraph['nodes'][number];
  radius: number;
  threadEndY?: number;
}

export interface Net3DEdge {
  edge: MemoryEdge;
  from: Net3DPoint;
  to: Net3DPoint;
  spoke: boolean;
}

/** A flat glyph projects beside this spine anchor, independent of camera yaw. */
export interface Net3DToolMarker extends Net3DPoint {
  id: string;
  at: number;
  events: ToolUseEvent[];
}

export interface MemoryNet3DLayout {
  nodes: Net3DNode[];
  edges: Net3DEdge[];
  spine: MemoryGraph['nodes'][number] | null;
  timeScale: MemoryTimeScale;
  ticks: MemoryTimeTick[];
  timeOrder: string[];
  toolMarkers: Net3DToolMarker[];
  horizontalRadius: number;
}

export interface MemoryNet3DLayoutOptions extends MemoryTimeScaleOptions {
  iterations?: number;
  toolUses?: readonly ToolUseEvent[];
}

export const toolUseFocusId = (id: string): string => `tool-use:${id}`;

/** Keep nearby events in one glyph without moving its first event's time anchor. */
export function groupToolUseMarkers(events: readonly ToolUseEvent[], scale: MemoryTimeScale, minSpacing = 10): Net3DToolMarker[] {
  const sorted = events.filter((event) => Number.isFinite(event.at)).slice()
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const markers: Net3DToolMarker[] = [];
  for (const event of sorted) {
    const y = scale.yAt(event.at);
    const last = markers[markers.length - 1];
    if (last && y - last.y < minSpacing) last.events.push(event);
    else markers.push({ id: toolUseFocusId(event.id), at: event.at, x: 0, y, z: 0, events: [event] });
  }
  return markers;
}

function hashId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) / 4294967296;
}

/** Oldest first, with stable ties. The self spine is not a memory to step through. */
export function memoryTimeOrder(nodes: readonly Pick<MemoryNode, 'id' | 'createdAt'>[]): string[] {
  return nodes.filter((node) => node.id !== SELF_MEMORY_ID).slice()
    .sort((a, b) => finite(a.createdAt, 0) - finite(b.createdAt, 0) || a.id.localeCompare(b.id))
    .map((node) => node.id);
}

export function stepMemoryInTime(order: readonly string[], currentId: string | null | undefined, direction: 'newer' | 'older'): string | null {
  if (!order.length) return null;
  const index = currentId ? order.indexOf(currentId) : -1;
  if (index < 0) return direction === 'newer' ? order[0]! : order[order.length - 1]!;
  return order[clamp(index + (direction === 'newer' ? 1 : -1), 0, order.length - 1)]!;
}

/** All forces act only on x/z. The simulation finishes before any frame is drawn. */
export function buildMemoryNet3DLayout(graph: MemoryGraph, options: MemoryNet3DLayoutOptions = {}): MemoryNet3DLayout {
  const spine = graph.nodes.find((node) => node.id === SELF_MEMORY_ID) ?? null;
  const memories = graph.nodes.filter((node) => node.id !== SELF_MEMORY_ID).slice().sort((a, b) => a.id.localeCompare(b.id));
  const timestamps = memories.flatMap((node) => node.kind === 'entity' && node.lastAccessedAt !== null && node.lastAccessedAt > node.createdAt
    ? [node.createdAt, node.lastAccessedAt] : [node.createdAt]);
  const toolUses = (options.toolUses ?? []).filter((event) => Number.isFinite(event.at));
  // Markers use the graph's existing compression; toggling them must not move memories.
  if (!timestamps.length) timestamps.push(...toolUses.map((event) => event.at));
  if (!timestamps.length && options.now === undefined && spine) timestamps.push(spine.createdAt);
  const timeScale = createMemoryTimeScale(timestamps, options);
  const linkedToSelf = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!spine) continue;
    const id = edge.from === SELF_MEMORY_ID ? edge.to : edge.to === SELF_MEMORY_ID ? edge.from : null;
    if (id) linkedToSelf.set(id, Math.max(linkedToSelf.get(id) ?? 0, clamp(finite(edge.weight, 0), 0, 1)));
  }
  const initialRadius = 40 + Math.sqrt(memories.length) * 3;
  const nodes = memories.map((node) => {
    const seed = hashId(node.id);
    const angle = KINDS.indexOf(node.kind) * Math.PI * 2 / KINDS.length + (seed - .5) * 1.1;
    const distance = initialRadius + hashId(`${node.id}:radius`) * 20;
    const y = timeScale.yAt(node.createdAt);
    return {
      id: node.id,
      node,
      x: Math.cos(angle) * distance,
      y,
      z: Math.sin(angle) * distance,
      radius: 4 + clamp(finite(node.importance, 0), 0, 1) * 5,
      threadEndY: node.kind === 'entity' && node.lastAccessedAt !== null && node.lastAccessedAt > node.createdAt
        ? timeScale.yAt(node.lastAccessedAt) : undefined,
      vx: 0,
      vz: 0,
      angle,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const springs = graph.edges.slice().sort((a, b) => a.id.localeCompare(b.id)).flatMap((edge) => {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    return a && b && a !== b ? [{ edge, a, b }] : [];
  });
  const iterations = clamp(Math.round(finite(options.iterations ?? 300, 300)), 0, 300);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const alpha = 1 - iteration / Math.max(1, iterations) * .9;
    for (let index = 0; index < nodes.length; index++) {
      const a = nodes[index]!;
      for (let other = index + 1; other < nodes.length; other++) {
        const b = nodes[other]!;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const distanceSquared = dx * dx + dz * dz;
        if (distanceSquared < .0001) {
          const angle = hashId(`${a.id}:${b.id}`) * Math.PI * 2;
          dx = Math.cos(angle) * .1;
          dz = Math.sin(angle) * .1;
        }
        const distance = Math.hypot(dx, dz);
        const separation = a.radius + b.radius + 8;
        const force = (300 / (distance * distance + 25) + Math.max(0, separation - distance) * .08) * alpha;
        const fx = dx / distance * force;
        const fz = dz / distance * force;
        a.vx -= fx;
        a.vz -= fz;
        b.vx += fx;
        b.vz += fz;
      }
    }
    for (const { a, b, edge } of springs) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distance = Math.hypot(dx, dz) || .1;
      const weight = clamp(finite(edge.weight, 0), 0, 1);
      const target = a.radius + b.radius + 12 + (1 - weight) * 32;
      const force = (distance - target) / distance * (.012 + weight * .075) * alpha;
      a.vx += dx * force;
      a.vz += dz * force;
      b.vx -= dx * force;
      b.vz -= dz * force;
    }
    for (const node of nodes) {
      const pull = .006 + (linkedToSelf.get(node.id) ?? 0) * .02;
      node.vx -= node.x * pull * alpha;
      node.vz -= node.z * pull * alpha;
      const distance = Math.hypot(node.x, node.z);
      node.vx += (Math.cos(node.angle) * distance - node.x) * .0015 * alpha;
      node.vz += (Math.sin(node.angle) * distance - node.z) * .0015 * alpha;
      node.vx = clamp(node.vx * .72, -8, 8);
      node.vz = clamp(node.vz * .72, -8, 8);
      node.x += node.vx;
      node.z += node.vz;
    }
  }
  const positioned: Net3DNode[] = nodes.map(({ vx: _vx, vz: _vz, angle: _angle, ...node }) => node);
  const edges: Net3DEdge[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from && to && from !== to) {
      edges.push({ edge, from: { x: from.x, y: from.y, z: from.z }, to: { x: to.x, y: to.y, z: to.z }, spoke: false });
      continue;
    }
    const memory = edge.from === SELF_MEMORY_ID ? to : edge.to === SELF_MEMORY_ID ? from : undefined;
    if (!spine || !memory) continue;
    const origin = { x: 0, y: edge.type === 'about' ? memory.y : timeScale.yAt(spine.createdAt), z: 0 };
    const point = { x: memory.x, y: memory.y, z: memory.z };
    edges.push({ edge, from: edge.from === SELF_MEMORY_ID ? origin : point, to: edge.from === SELF_MEMORY_ID ? point : origin, spoke: edge.type === 'about' });
  }
  return {
    nodes: positioned,
    edges,
    spine,
    timeScale,
    ticks: generateMemoryTimeTicks(timeScale),
    timeOrder: [...memories.map((node) => ({ id: node.id, at: node.createdAt })), ...toolUses.map((event) => ({ id: toolUseFocusId(event.id), at: event.at }))]
      .sort((a, b) => finite(a.at, 0) - finite(b.at, 0) || a.id.localeCompare(b.id)).map((item) => item.id),
    toolMarkers: groupToolUseMarkers(toolUses, timeScale),
    horizontalRadius: Math.max(24, ...positioned.map((node) => Math.hypot(node.x, node.z) + node.radius)),
  };
}
