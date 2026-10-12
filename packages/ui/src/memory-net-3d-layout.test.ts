import { describe, expect, it } from 'vitest';
import type { MemoryEdge, MemoryGraph, MemoryKind, ToolUseEvent } from '@neo/protocol';
import {
  buildMemoryNet3DLayout,
  createMemoryTimeScale,
  generateMemoryTimeTicks,
  memoryTimeOrder,
  stepMemoryInTime,
  toolUseFocusId,
} from './memory-net-3d-layout.js';

const DAY = 86_400_000;
const at = (date: string): number => Date.parse(date);
const start = at('2026-01-01T00:00:00Z');

function node(id: string, createdAt = start, kind: MemoryKind = 'fact', overrides: Partial<MemoryGraph['nodes'][number]> = {}): MemoryGraph['nodes'][number] {
  return {
    id, kind, label: id, content: id, importance: .5, confidence: 1, stability: 30,
    aliases: [], tags: [], accessCount: 0, lastAccessedAt: null, createdAt, updatedAt: createdAt,
    status: 'active', pinned: false, sensitivity: 'normal', source: { by: 'user' }, retention: 1,
    ...overrides,
  };
}

function edge(id: string, from: string, to: string, type: MemoryEdge['type'] = 'related', weight = 1): MemoryEdge {
  return { id, from, to, type, weight, createdAt: start, updatedAt: start, lastReinforcedAt: start, coactivations: 0 };
}

describe('memory net time scale', () => {
  it('puts newest memories on top and preserves the order within each UTC day', () => {
    const times = [start, start + DAY / 2, start + DAY, start + 4 * DAY];
    const scale = createMemoryTimeScale(times);
    const heights = times.map(scale.yAt);
    expect(heights[0]).toBe(scale.minY);
    expect(heights[heights.length - 1]).toBe(scale.maxY);
    for (let index = 1; index < heights.length; index++) expect(heights[index]).toBeGreaterThan(heights[index - 1]!);
  });

  it('keeps minimum spacing between occupied days, including memories near midnight', () => {
    const times = [start + DAY - 1, start + DAY, start + 2 * DAY + 1];
    const scale = createMemoryTimeScale(times, { minDaySpacing: 36 });
    expect(scale.yAt(times[1]!) - scale.yAt(times[0]!)).toBeGreaterThanOrEqual(36);
    expect(scale.yAt(times[2]!) - scale.yAt(times[1]!)).toBeGreaterThanOrEqual(36);
    expect(scale.gaps).toEqual([]);
  });

  it('compresses empty periods logarithmically and caps every gap', () => {
    const times = [start, start + DAY, start + 32 * DAY, start + 4000 * DAY + DAY - 1];
    const scale = createMemoryTimeScale(times, { minDaySpacing: 30, maxGapSpacing: 100 });
    expect(scale.gaps).toHaveLength(2);
    for (let index = 1; index < times.length; index++) {
      const distance = scale.yAt(times[index]!) - scale.yAt(times[index - 1]!);
      expect(distance).toBeGreaterThanOrEqual(30);
      expect(distance).toBeLessThanOrEqual(100);
    }
    expect(scale.maxY).toBeLessThan(300);
    expect(scale.gaps[1]!.spacing).toBeLessThanOrEqual(100);
    expect(scale.gaps[1]!.y).toBeGreaterThan(scale.yAt(times[2]!));
    expect(scale.gaps[1]!.y).toBeLessThan(scale.yAt(times[3]!));
  });

  it('stays monotonic through compressed intervals, and clamps outside the data', () => {
    const scale = createMemoryTimeScale([start + DAY / 2, start + 200 * DAY], { now: start + 500 * DAY });
    let previous = scale.minY;
    for (let hour = 12; hour <= 500 * 24; hour++) {
      const y = scale.yAt(start + hour * DAY / 24);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
    expect(scale.yAt(start - 10 * DAY)).toBe(scale.minY);
    expect(scale.yAt(start + 900 * DAY)).toBe(scale.maxY);
    expect(scale.newestAt).toBe(start + 500 * DAY);
    expect(scale.yAt(NaN)).toBe(scale.minY);
  });

  it('uses UTC boundaries independently of daylight saving offsets', () => {
    const first = at('2026-03-08T01:30:00-08:00');
    const second = at('2026-03-09T01:30:00-07:00');
    const scale = createMemoryTimeScale([first, second]);
    expect(scale.days.map((day) => new Date(day.at).toISOString())).toEqual(['2026-03-08T00:00:00.000Z', '2026-03-09T00:00:00.000Z']);
    expect(scale.yAt(second) - scale.yAt(first)).toBeGreaterThanOrEqual(scale.minDaySpacing);
  });

  it('handles empty and single-day nets without non-finite positions', () => {
    const empty = createMemoryTimeScale([]);
    expect(empty.minY).toBe(0);
    expect(empty.maxY).toBe(0);
    expect(empty.yAt(start)).toBe(0);
    const one = createMemoryTimeScale([start]);
    expect(one.yAt(start)).toBe(0);
    expect(one.gaps).toEqual([]);
  });

  it.each([
    [7, 'day'],
    [60, 'week'],
    [365, 'month'],
  ] as const)('chooses %s-day-span %s calendar ticks', (days, unit) => {
    const times = Array.from({ length: days + 1 }, (_, index) => start + index * DAY);
    const ticks = generateMemoryTimeTicks(createMemoryTimeScale(times));
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((tick) => tick.unit === unit)).toBe(true);
    if (unit === 'week') expect(ticks.every((tick) => new Date(tick.at).getUTCDay() === 1)).toBe(true);
    if (unit === 'month') expect(ticks.every((tick) => new Date(tick.at).getUTCDate() === 1)).toBe(true);
  });

  it('does not stack unreadable calendar ticks inside a long compressed gap', () => {
    const scale = createMemoryTimeScale([start, start + 3650 * DAY]);
    const ticks = generateMemoryTimeTicks(scale);
    expect(ticks.length).toBeLessThan(8);
    for (let index = 1; index < ticks.length; index++) expect(ticks[index]!.y - ticks[index - 1]!.y).toBeGreaterThanOrEqual(scale.minDaySpacing * .65);
  });
});

describe('horizontal memory net layout', () => {
  const graph: MemoryGraph = {
    nodes: [node('alpha', start), node('beta', start + DAY), node('gamma', start + 2 * DAY), node('delta', start + 4 * DAY)],
    edges: [edge('alpha-beta', 'alpha', 'beta')],
  };

  it('is deterministic for the same input and independent of API ordering', () => {
    const first = buildMemoryNet3DLayout(graph);
    const second = buildMemoryNet3DLayout(graph);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
    expect(second.timeScale.days).toEqual(first.timeScale.days);
    expect(second.ticks).toEqual(first.ticks);
    const reversed = buildMemoryNet3DLayout({ nodes: graph.nodes.slice().reverse(), edges: graph.edges.slice().reverse() });
    expect(reversed.nodes).toEqual(first.nodes);
    expect(reversed.timeOrder).toEqual(first.timeOrder);
    expect(reversed.timeScale.days).toEqual(first.timeScale.days);
  });

  it('keeps linked nodes closer than unlinked nodes', () => {
    const layout = buildMemoryNet3DLayout(graph);
    const nodes = new Map(layout.nodes.map((memory) => [memory.id, memory]));
    const distance = (a: string, b: string) => Math.hypot(nodes.get(a)!.x - nodes.get(b)!.x, nodes.get(a)!.z - nodes.get(b)!.z);
    const linked = distance('alpha', 'beta');
    const unlinked = (distance('alpha', 'gamma') + distance('alpha', 'delta') + distance('beta', 'gamma') + distance('beta', 'delta')) / 4;
    expect(linked).toBeLessThan(unlinked);
    const unconnected = buildMemoryNet3DLayout({ ...graph, edges: [] });
    const [alpha, beta] = ['alpha', 'beta'].map((id) => unconnected.nodes.find((memory) => memory.id === id)!);
    expect(linked).toBeLessThan(Math.hypot(alpha!.x - beta!.x, alpha!.z - beta!.z));
  });

  it('uses edge weight to strengthen horizontal attraction', () => {
    const weak = buildMemoryNet3DLayout({ ...graph, edges: [edge('alpha-beta', 'alpha', 'beta', 'related', .1)] });
    const strong = buildMemoryNet3DLayout(graph);
    const distance = (layout: typeof weak) => {
      const alpha = layout.nodes.find((memory) => memory.id === 'alpha')!;
      const beta = layout.nodes.find((memory) => memory.id === 'beta')!;
      return Math.hypot(alpha.x - beta.x, alpha.z - beta.z);
    };
    expect(distance(strong)).toBeLessThan(distance(weak));
  });

  it('never changes y while the horizontal forces settle', () => {
    const initial = buildMemoryNet3DLayout(graph, { iterations: 0 });
    const settled = buildMemoryNet3DLayout(graph);
    expect(settled.nodes.map((memory) => memory.y)).toEqual(initial.nodes.map((memory) => memory.y));
    for (const memory of settled.nodes) expect(memory.y).toBe(settled.timeScale.yAt(memory.node.createdAt));
  });

  it('keeps all 200 nodes finite and caps work at 300 iterations', () => {
    const kinds: MemoryKind[] = ['fact', 'episode', 'entity', 'preference', 'goal', 'skill', 'summary'];
    const crowded: MemoryGraph = {
      nodes: Array.from({ length: 200 }, (_, index) => node(`memory-${index}`, start + index % 13 * DAY, kinds[index % kinds.length]!)),
      edges: Array.from({ length: 199 }, (_, index) => edge(`link-${index}`, `memory-${index}`, `memory-${index + 1}`, 'related', .6)),
    };
    const layout = buildMemoryNet3DLayout(crowded, { iterations: 900 });
    expect(layout.nodes).toHaveLength(200);
    expect(layout.nodes.every((memory) => [memory.x, memory.y, memory.z, memory.radius].every(Number.isFinite))).toBe(true);
    expect(layout.nodes).toEqual(buildMemoryNet3DLayout(crowded, { iterations: 300 }).nodes);
  });

  it('turns mem_self into the spine and converts its about links into horizontal spokes', () => {
    const self = node('mem_self', start - 5000 * DAY, 'entity', { label: 'Richard' });
    const other = node('visit', start + DAY, 'episode');
    const layout = buildMemoryNet3DLayout({ nodes: [self, other], edges: [edge('self-visit', 'visit', 'mem_self', 'about')] }, { now: start + 2 * DAY });
    expect(layout.spine).toEqual(self);
    expect(layout.nodes.map((memory) => memory.id)).toEqual(['visit']);
    expect(layout.timeScale.oldestAt).toBe(other.createdAt);
    expect(layout.timeScale.newestAt).toBe(start + 2 * DAY);
    expect(layout.edges).toHaveLength(1);
    const spoke = layout.edges[0]!;
    expect(spoke.spoke).toBe(true);
    expect(spoke.from.y).toBe(spoke.to.y);
    expect(spoke.to).toEqual({ x: 0, y: layout.nodes[0]!.y, z: 0 });
  });

  it('supports reverse about spokes and ordinary links without a self node', () => {
    const withSelf = buildMemoryNet3DLayout({ nodes: [node('mem_self'), node('fact')], edges: [edge('reverse', 'mem_self', 'fact', 'about')] });
    expect(withSelf.edges[0]!.from).toEqual({ x: 0, y: withSelf.nodes[0]!.y, z: 0 });
    expect(withSelf.edges[0]!.spoke).toBe(true);
    expect(buildMemoryNet3DLayout(graph).spine).toBeNull();
    expect(buildMemoryNet3DLayout(graph).edges[0]!.spoke).toBe(false);
    expect(buildMemoryNet3DLayout({ nodes: graph.nodes, edges: [edge('missing', 'alpha', 'missing')] }).edges).toEqual([]);
  });

  it('pulls memories linked to self closer to the spine', () => {
    const memories = Array.from({ length: 12 }, (_, index) => node(`memory-${index}`, start));
    const edges = memories.map((memory, index) => edge(`self-${index}`, memory.id, 'mem_self', 'about'));
    const linked = buildMemoryNet3DLayout({ nodes: [...memories, node('mem_self', start, 'entity')], edges });
    const unlinked = buildMemoryNet3DLayout({ nodes: memories, edges: [] });
    const averageRadius = (layout: typeof linked) => layout.nodes.reduce((total, memory) => total + Math.hypot(memory.x, memory.z), 0) / layout.nodes.length;
    expect(averageRadius(linked)).toBeLessThan(averageRadius(unlinked));
  });

  it('draws entity lifelines to last access while retaining first-mention height', () => {
    const person = node('person', start, 'entity', { lastAccessedAt: start + 90 * DAY });
    const fact = node('fact', start, 'fact', { lastAccessedAt: start + 900 * DAY });
    const layout = buildMemoryNet3DLayout({ nodes: [person, fact], edges: [] });
    const positioned = layout.nodes.find((memory) => memory.id === person.id)!;
    expect(positioned.y).toBe(layout.timeScale.yAt(person.createdAt));
    expect(positioned.threadEndY).toBe(layout.timeScale.yAt(person.lastAccessedAt!));
    expect(positioned.threadEndY).toBeGreaterThan(positioned.y);
    expect(layout.timeScale.newestAt).toBe(person.lastAccessedAt);
    expect(layout.nodes.find((memory) => memory.id === fact.id)!.threadEndY).toBeUndefined();
    expect(buildMemoryNet3DLayout({ nodes: [node('earlier', start, 'entity', { lastAccessedAt: start - DAY })], edges: [] }).nodes[0]!.threadEndY).toBeUndefined();
  });
});

describe('keyboard time stepping', () => {
  const order = memoryTimeOrder([node('latest', start + 2 * DAY), node('same-b', start), node('mem_self', start - DAY), node('same-a', start), node('middle', start + DAY)]);

  it('orders memories by creation time with deterministic ties and omits self', () => {
    expect(order).toEqual(['same-a', 'same-b', 'middle', 'latest']);
  });

  it('steps newer or older and clamps at each end', () => {
    expect(stepMemoryInTime(order, null, 'newer')).toBe('same-a');
    expect(stepMemoryInTime(order, null, 'older')).toBe('latest');
    expect(stepMemoryInTime(order, 'same-a', 'newer')).toBe('same-b');
    expect(stepMemoryInTime(order, 'middle', 'older')).toBe('same-b');
    expect(stepMemoryInTime(order, 'latest', 'newer')).toBe('latest');
    expect(stepMemoryInTime(order, 'same-a', 'older')).toBe('same-a');
    expect(stepMemoryInTime(order, 'missing', 'older')).toBe('latest');
    expect(stepMemoryInTime([], null, 'newer')).toBeNull();
  });
});

describe('tool-use spine markers', () => {
  const event = (id: string, at: number, category: ToolUseEvent['category'] = 'note'): ToolUseEvent => ({
    id, at, category, title: `Wrote note “${id}”`, tool: 'create_note', messageId: `message-${id}`,
  });

  it('anchors markers at their event time on the existing graph spine without moving memories', () => {
    const graph: MemoryGraph = { nodes: [node('first'), node('last', start + 30 * DAY)], edges: [] };
    const base = buildMemoryNet3DLayout(graph, { now: start + 40 * DAY });
    const events = [event('early', start + DAY), event('later', start + 20 * DAY)];
    const layout = buildMemoryNet3DLayout(graph, { now: start + 40 * DAY, toolUses: events });
    expect(layout.nodes).toEqual(base.nodes);
    expect(layout.timeScale.days).toEqual(base.timeScale.days);
    expect(layout.toolMarkers).toHaveLength(2);
    for (const marker of layout.toolMarkers) {
      expect(marker.x).toBe(0);
      expect(marker.z).toBe(0);
      expect(marker.y).toBe(base.timeScale.yAt(marker.events[0]!.at));
    }
  });

  it('groups close events deterministically across categories while retaining every target', () => {
    const events = [event('second', start + 1000, 'reminder'), event('first', start), event('third', start + DAY, 'search')];
    const graph: MemoryGraph = { nodes: [node('first-memory'), node('last-memory', start + DAY)], edges: [] };
    const layout = buildMemoryNet3DLayout(graph, { toolUses: events });
    expect(layout.toolMarkers.map((marker) => marker.events.map((item) => item.id))).toEqual([['first', 'second'], ['third']]);
    expect(layout.toolMarkers[0]!.at).toBe(start);
    expect(layout.toolMarkers[0]!.y).toBe(layout.timeScale.yAt(start));
    expect(buildMemoryNet3DLayout(graph, { toolUses: events.slice().reverse() }).toolMarkers).toEqual(layout.toolMarkers);
  });

  it('steps through each tool event and memory by time even when events share a marker', () => {
    const layout = buildMemoryNet3DLayout({ nodes: [node('oldest'), node('middle', start + DAY), node('newest', start + 2 * DAY)], edges: [] }, {
      toolUses: [event('a', start + 1000), event('b', start + 2000), event('c', start + DAY + 1000)],
    });
    expect(layout.timeOrder).toEqual(['oldest', toolUseFocusId('a'), toolUseFocusId('b'), 'middle', toolUseFocusId('c'), 'newest']);
    expect(stepMemoryInTime(layout.timeOrder, toolUseFocusId('a'), 'newer')).toBe(toolUseFocusId('b'));
    expect(stepMemoryInTime(layout.timeOrder, 'middle', 'older')).toBe(toolUseFocusId('b'));
  });

  it('supports a marker-only net and ignores invalid timestamps', () => {
    const layout = buildMemoryNet3DLayout({ nodes: [], edges: [] }, { toolUses: [event('oldest', start), event('latest', start + DAY), event('bad', NaN)] });
    expect(layout.timeScale.oldestAt).toBe(start);
    expect(layout.timeScale.newestAt).toBe(start + DAY);
    expect(layout.toolMarkers).toHaveLength(2);
    expect(layout.toolMarkers.every((marker) => Number.isFinite(marker.y))).toBe(true);
    expect(layout.timeOrder).not.toContain(toolUseFocusId('bad'));
  });
});
