/**
 * MemoryGraphView — the memory net drawn on <canvas> with a small force
 * simulation.
 *
 * - DPR-aware drawing, theme-aware colors (read from CSS variables).
 * - Click/tap selects a node; drag moves it; drag the background to pan;
 *   wheel / pinch / buttons zoom; "fit" frames everything.
 * - Hover tooltip; keyboard: Tab to the canvas, ←/→ to move between nodes,
 *   Enter to select, Esc to clear. A list fallback renders when canvas is
 *   unavailable.
 * - The simulation sleeps when settled; reduced motion lays out synchronously.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import type { MemoryEdge, MemoryGraph, MemoryKind, MemoryNode } from '@neo/protocol';
import { useT } from './i18n.js';
import { Icon } from './icons.js';
import { IconButton } from './primitives.js';

/** Memory kind colors (light theme values; the canvas reads live CSS variables). */
export const memoryKindColor: Record<MemoryKind, string> = {
  episode: '#F59E0B',
  fact: '#0EA5E9',
  entity: '#10B981',
  preference: '#EC4899',
  skill: '#6366F1',
  goal: '#F97316',
  summary: '#64748B',
};

export const MEMORY_KIND_ORDER: readonly MemoryKind[] = ['entity', 'fact', 'preference', 'goal', 'skill', 'episode', 'summary'];

type GraphNode = MemoryNode & { retention: number };

interface SimNode {
  id: string;
  node: GraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  degree: number;
  fixed: boolean;
}

interface SimEdge {
  edge: MemoryEdge;
  a: SimNode;
  b: SimNode;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.25;

/** requestAnimationFrame with a timer fallback (non-visual environments). */
const nextFrame = (cb: (now: number) => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(() => cb(Date.now()), 16) as unknown as number);
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
};
const MAX_ZOOM = 4;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function buildSim(graph: MemoryGraph, previous: Map<string, SimNode>, width: number, height: number): { nodes: SimNode[]; edges: SimEdge[] } {
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const n = graph.nodes.length;
  const nodes = graph.nodes.map((node, i) => {
    const prev = previous.get(node.id);
    const angle = i * 2.399963; // golden angle spiral: even initial spread
    const dist = 18 * Math.sqrt(i + 1);
    const d = degree.get(node.id) ?? 0;
    return {
      id: node.id,
      node,
      x: prev?.x ?? width / 2 + Math.cos(angle) * dist,
      y: prev?.y ?? height / 2 + Math.sin(angle) * dist,
      vx: 0,
      vy: 0,
      r: 6 + node.importance * 9 + Math.min(d, 10) * 0.6 + (n < 30 ? 2 : 0),
      degree: d,
      fixed: false,
    } satisfies SimNode;
  });
  const byId = new Map(nodes.map((s) => [s.id, s]));
  const edges: SimEdge[] = [];
  for (const edge of graph.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (a && b && a !== b) edges.push({ edge, a, b });
  }
  return { nodes, edges };
}

function tick(nodes: SimNode[], edges: SimEdge[], cx: number, cy: number, alpha: number): void {
  const n = nodes.length;
  // Repulsion (and collision) between every pair.
  for (let i = 0; i < n; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (Math.random() - 0.5) * 0.5;
        dy = (Math.random() - 0.5) * 0.5;
        d2 = dx * dx + dy * dy + 0.01;
      }
      const d = Math.sqrt(d2);
      let f = (1800 * alpha) / d2;
      // Leave room for the labels drawn under each node.
      const minD = a.r + b.r + 30;
      if (d < minD) f += ((minD - d) / d) * 0.5;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }
  // Springs along edges: stronger associations pull closer.
  for (const { a, b, edge } of edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const target = 46 + (1 - edge.weight) * 60 + (a.r + b.r) * 0.6;
    const f = ((d - target) / d) * 0.06 * alpha;
    const fx = dx * f;
    const fy = dy * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
  // Gentle gravity towards the center keeps islands in view.
  for (const s of nodes) {
    s.vx += (cx - s.x) * 0.012 * alpha;
    s.vy += (cy - s.y) * 0.012 * alpha;
  }
  for (const s of nodes) {
    if (s.fixed) {
      s.vx = 0;
      s.vy = 0;
      continue;
    }
    s.vx *= 0.82;
    s.vy *= 0.82;
    s.x += s.vx;
    s.y += s.vy;
  }
}

interface Palette {
  kind: Record<string, string>;
  text: string;
  muted: string;
  surface: string;
  edge: string;
  accent: string;
  pin: string;
}

function readPalette(el: Element): Palette {
  const css = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  const v = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback;
  const kind: Record<string, string> = {};
  for (const k of Object.keys(memoryKindColor)) kind[k] = v(`--neo-kind-${k}`, memoryKindColor[k as MemoryKind]);
  return {
    kind,
    text: v('--neo-text', '#16161d'),
    muted: v('--neo-text-muted', '#5f5f76'),
    surface: v('--neo-surface', '#ffffff'),
    edge: v('--neo-text-subtle', '#8a8aa0'),
    accent: v('--neo-accent', '#7c5cff'),
    pin: v('--neo-tone-warning-text', '#9a5b00'),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export interface MemoryGraphViewProps {
  graph: MemoryGraph;
  selectedId?: string | null;
  /** Nodes to emphasize (e.g. search matches). */
  highlightIds?: string[];
  onSelect?: (id: string | null) => void;
  height?: number;
  /** Show the kind legend under the canvas (default true). */
  showLegend?: boolean;
  className?: string;
}

export function MemoryGraphView({ graph, selectedId = null, highlightIds = [], onSelect, height = 420, showLegend = true, className }: MemoryGraphViewProps): ReactElement {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [supported, setSupported] = useState(true);
  const [size, setSize] = useState({ w: 640, h: height });
  /** Latest size for long-lived callbacks (the animation loop outlives renders). */
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const sim = useRef<{ nodes: SimNode[]; edges: SimEdge[] }>({ nodes: [], edges: [] });
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const alpha = useRef(1);
  const raf = useRef<number | null>(null);
  const palette = useRef<Palette | null>(null);
  const fitted = useRef(false);
  /** The user panned/zoomed: stop re-fitting on resize. */
  const interacted = useRef(false);

  // Props read inside the animation loop.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const highlightRef = useRef(new Set(highlightIds));
  highlightRef.current = new Set(highlightIds);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const focusRef = useRef(focusIndex);
  focusRef.current = focusIndex;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const ordered = useMemo(() => [...graph.nodes].sort((a, b) => b.importance - a.importance || a.label.localeCompare(b.label)), [graph.nodes]);

  // ── drawing ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const p = palette.current ?? readPalette(canvas);
    palette.current = p;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const { w, h } = { w: canvas.width / dpr, h: canvas.height / dpr };
    const { nodes, edges } = sim.current;
    const v = view.current;
    const sel = selectedRef.current;
    const hl = highlightRef.current;
    const hov = hoverRef.current?.id ?? null;
    const focusId = focusRef.current !== null ? ordered[focusRef.current]?.id ?? null : null;

    const neighbors = new Set<string>();
    if (sel) for (const e of edges) {
      if (e.a.id === sel) neighbors.add(e.b.id);
      if (e.b.id === sel) neighbors.add(e.a.id);
    }
    const dim = (id: string) => sel !== null && id !== sel && !neighbors.has(id) && !hl.has(id);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(v.x, v.y);
    ctx.scale(v.k, v.k);

    // Edges
    for (const { a, b, edge } of edges) {
      const touches = sel !== null && (a.id === sel || b.id === sel);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.globalAlpha = sel === null ? 0.25 + edge.weight * 0.4 : touches ? 0.95 : 0.06;
      ctx.strokeStyle = touches ? p.accent : p.edge;
      ctx.lineWidth = (0.6 + edge.weight * 1.8) / Math.sqrt(v.k);
      ctx.setLineDash(edge.type === 'supersedes' || edge.type === 'contradicts' ? [4, 4] : edge.type === 'similar' ? [1, 3] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Nodes
    for (const s of nodes) {
      const { node } = s;
      const color = p.kind[node.kind] ?? p.kind.summary ?? '#64748b';
      const faded = node.status === 'archived' || node.status === 'superseded';
      ctx.globalAlpha = dim(s.id) ? 0.14 : 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      if (faded) {
        ctx.fillStyle = p.surface;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = p.surface;
        ctx.fill();
        ctx.globalAlpha *= 0.3 + 0.7 * Math.max(0, Math.min(1, node.retention));
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = dim(s.id) ? 0.14 : 1;
      }
      if (node.pinned) {
        ctx.beginPath();
        ctx.arc(s.x + s.r * 0.72, s.y - s.r * 0.72, 3, 0, Math.PI * 2);
        ctx.fillStyle = p.pin;
        ctx.fill();
      }
      if (s.id === sel || s.id === focusId || hl.has(s.id) || s.id === hov) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r + (s.id === sel ? 5 : 3.5), 0, Math.PI * 2);
        ctx.strokeStyle = s.id === sel || s.id === focusId ? p.accent : color;
        ctx.lineWidth = s.id === sel ? 2.5 : 1.5;
        ctx.stroke();
      }
    }

    // Labels: important or interesting nodes, more as you zoom in.
    ctx.globalAlpha = 1;
    const fontSize = 11.5 / v.k;
    ctx.font = `500 ${fontSize}px ${getComputedStyle(canvas).fontFamily || 'system-ui, sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    for (const s of nodes) {
      const interesting = s.id === sel || s.id === hov || s.id === focusId || neighbors.has(s.id) || hl.has(s.id);
      const show = interesting || (sel === null && (nodes.length <= 28 || s.r * v.k > 13 || v.k > 1.6));
      if (!show) continue;
      const label = truncate(s.node.label, interesting ? 40 : 22);
      const y = s.y + s.r + 4 / v.k;
      ctx.globalAlpha = dim(s.id) ? 0.25 : 1;
      ctx.lineWidth = 3.5 / v.k;
      ctx.strokeStyle = p.surface;
      ctx.strokeText(label, s.x, y);
      ctx.fillStyle = interesting ? p.text : p.muted;
      ctx.fillText(label, s.x, y);
    }
    ctx.globalAlpha = 1;
  }, [ordered]);

  const fit = useCallback(
    (animate = false) => {
      const { nodes } = sim.current;
      if (!nodes.length) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const s of nodes) {
        minX = Math.min(minX, s.x - s.r);
        minY = Math.min(minY, s.y - s.r);
        maxX = Math.max(maxX, s.x + s.r);
        maxY = Math.max(maxY, s.y + s.r + 16);
      }
      const pad = 32;
      const { w, h } = sizeRef.current;
      const spanX = maxX - minX || 1;
      const spanY = maxY - minY || 1;
      // Labels are drawn at a fixed screen size, so on narrow screens the side
      // margins must also fit half of the outermost labels (estimated width).
      const halfLabel = (s: SimNode) => Math.min(truncate(s.node.label, 22).length * 3.3, 75);
      let padL = pad;
      let padR = pad;
      let k = 1;
      for (let pass = 0; pass < 3; pass++) {
        k = Math.max(MIN_ZOOM, Math.min(1.8, Math.min((w - padL - padR) / spanX, (h - pad * 2) / spanY)));
        let needL = 0;
        let needR = 0;
        for (const s of nodes) {
          needL = Math.max(needL, halfLabel(s) - (s.x - minX) * k);
          needR = Math.max(needR, halfLabel(s) - (maxX - s.x) * k);
        }
        padL = Math.max(pad, needL + 6);
        padR = Math.max(pad, needR + 6);
      }
      k = Math.max(MIN_ZOOM, Math.min(1.8, Math.min((w - padL - padR) / spanX, (h - pad * 2) / spanY)));
      const availW = w - padL - padR;
      const target = { k, x: padL + (availW - spanX * k) / 2 - minX * k, y: h / 2 - ((minY + maxY) / 2) * k };
      if (!animate || prefersReducedMotion()) {
        view.current = target;
        draw();
        return;
      }
      const start = { ...view.current };
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 260);
        const e = 1 - (1 - p) ** 3;
        view.current = { k: start.k + (target.k - start.k) * e, x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e };
        draw();
        if (p < 1) nextFrame(step);
      };
      nextFrame(step);
    },
    [draw],
  );

  // ── animation loop ──
  const kick = useCallback(
    (energy = 0.5) => {
      alpha.current = Math.max(alpha.current, energy);
      if (raf.current !== null) return;
      const loop = () => {
        const { nodes, edges } = sim.current;
        tick(nodes, edges, sizeRef.current.w / 2, sizeRef.current.h / 2, alpha.current);
        alpha.current *= 0.97;
        draw();
        if (alpha.current > 0.01 || nodes.some((s) => s.fixed)) raf.current = nextFrame(loop);
        else {
          raf.current = null;
          // Settled: frame the final layout unless the user has taken over the view.
          if (!interacted.current) fit(true);
        }
      };
      raf.current = nextFrame(loop);
    },
    [draw, fit],
  );

  useEffect(
    () => () => {
      if (raf.current !== null) cancelFrame(raf.current);
      raf.current = null;
    },
    [],
  );

  // ── size & DPR ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: Math.max(200, Math.round(el.clientWidth || 640)), h: height });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setSupported(false);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    draw();
  }, [size, draw]);

  // Keep the net framed when the container resizes, until the user takes over.
  useEffect(() => {
    if (fitted.current && !interacted.current) fit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);

  // Theme changes: re-read colors.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const mo = new MutationObserver(() => {
      palette.current = null;
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const onScheme = () => {
      palette.current = null;
      draw();
    };
    mq?.addEventListener?.('change', onScheme);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', onScheme);
    };
  }, [draw]);

  // ── (re)build the simulation when the graph changes ──
  useEffect(() => {
    if (!supported) return;
    const previous = new Map(sim.current.nodes.map((s) => [s.id, s]));
    const hadNodes = previous.size > 0;
    sim.current = buildSim(graph, previous, size.w, size.h);
    if (prefersReducedMotion()) {
      for (let i = 0; i < 300; i++) tick(sim.current.nodes, sim.current.edges, size.w / 2, size.h / 2, 0.6 * 0.985 ** i);
      fitted.current = true;
      fit(false);
      return;
    }
    if (!hadNodes) {
      // Settle most of the layout up front so the first frame already looks right
      // (and stays right where animation frames are throttled), then animate the rest.
      const n = sim.current.nodes.length;
      const warm = n <= 60 ? 160 : n <= 200 ? 90 : 40;
      let a = 1;
      for (let i = 0; i < warm; i++) {
        tick(sim.current.nodes, sim.current.edges, size.w / 2, size.h / 2, a);
        a *= 0.97;
      }
      alpha.current = a;
      fitted.current = true;
      fit(false);
      kick(a);
      return;
    }
    kick(0.35);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, supported]);

  // Redraw on selection/highlight/hover/focus changes; bring the selection into view.
  useEffect(() => {
    if (selectedId) {
      const s = sim.current.nodes.find((n) => n.id === selectedId);
      if (s) {
        const v = view.current;
        const sx = s.x * v.k + v.x;
        const sy = s.y * v.k + v.y;
        if (sx < 40 || sx > size.w - 40 || sy < 40 || sy > size.h - 40) {
          view.current = { ...v, x: size.w / 2 - s.x * v.k, y: size.h / 2 - s.y * v.k };
        }
      }
    }
    draw();
  }, [selectedId, highlightIds, hover, focusIndex, draw, size.h, size.w]);

  // ── pointer & wheel ──
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const v = view.current;
    return { sx: clientX - rect.left, sy: clientY - rect.top, x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k };
  };
  const hitTest = (x: number, y: number): SimNode | null => {
    const { nodes } = sim.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const s = nodes[i]!;
      const hit = s.r + 4 / view.current.k;
      if ((x - s.x) ** 2 + (y - s.y) ** 2 <= hit * hit) return s;
    }
    return null;
  };
  const zoomAt = (factor: number, sx: number, sy: number) => {
    interacted.current = true;
    const v = view.current;
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
    const f = k / v.k;
    view.current = { k, x: sx - (sx - v.x) * f, y: sy - (sy - v.y) * f };
    draw();
  };

  const gesture = useRef<{
    mode: 'none' | 'node' | 'pan' | 'pinch';
    node: SimNode | null;
    startX: number;
    startY: number;
    moved: boolean;
    lastX: number;
    lastY: number;
    pinchDist: number;
  }>({ mode: 'none', node: null, startX: 0, startY: 0, moved: false, lastX: 0, lastY: 0, pinchDist: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Native, non-passive listener so the page doesn't scroll while zooming.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      g.mode = 'pinch';
      g.pinchDist = Math.hypot(p1!.x - p2!.x, p1!.y - p2!.y);
      if (g.node) g.node.fixed = false;
      return;
    }
    const pt = toWorld(e.clientX, e.clientY);
    const hit = hitTest(pt.x, pt.y);
    g.mode = hit ? 'node' : 'pan';
    g.node = hit;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    g.moved = false;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.mode === 'pinch' && pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      const dist = Math.hypot(p1!.x - p2!.x, p1!.y - p2!.y);
      const rect = canvasRef.current!.getBoundingClientRect();
      if (g.pinchDist > 0) zoomAt(dist / g.pinchDist, (p1!.x + p2!.x) / 2 - rect.left, (p1!.y + p2!.y) / 2 - rect.top);
      g.pinchDist = dist;
      return;
    }
    if (g.mode === 'none') {
      const pt = toWorld(e.clientX, e.clientY);
      const hit = hitTest(pt.x, pt.y);
      const next = hit ? { id: hit.id, x: pt.sx, y: pt.sy } : null;
      if (next?.id !== hover?.id || (next && hover && (Math.abs(next.x - hover.x) > 2 || Math.abs(next.y - hover.y) > 2))) setHover(next);
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) return;
    g.moved = true;
    setHover(null);
    if (g.mode === 'node' && g.node) {
      const pt = toWorld(e.clientX, e.clientY);
      g.node.x = pt.x;
      g.node.y = pt.y;
      g.node.fixed = true;
      kick(0.3);
    } else if (g.mode === 'pan') {
      interacted.current = true;
      const v = view.current;
      view.current = { ...v, x: v.x + e.clientX - g.lastX, y: v.y + e.clientY - g.lastY };
      draw();
    }
    g.lastX = e.clientX;
    g.lastY = e.clientY;
  };

  const endGesture = (e: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.mode === 'pinch') {
      if (pointers.current.size === 0) g.mode = 'none';
      return;
    }
    if (g.node) g.node.fixed = false;
    if (!cancelled && !g.moved) {
      if (g.mode === 'node' && g.node) onSelectRef.current?.(g.node.id === selectedRef.current ? null : g.node.id);
      else if (g.mode === 'pan') onSelectRef.current?.(null);
    }
    g.mode = 'none';
    g.node = null;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (!ordered.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      setFocusIndex((i) => (i === null ? (d > 0 ? 0 : ordered.length - 1) : (i + d + ordered.length) % ordered.length));
    } else if ((e.key === 'Enter' || e.key === ' ') && focusIndex !== null) {
      e.preventDefault();
      const node = ordered[focusIndex];
      if (node) onSelect?.(node.id);
    } else if (e.key === 'Escape') {
      setFocusIndex(null);
      onSelect?.(null);
    } else if (e.key === '+' || e.key === '=') {
      zoomAt(1.25, size.w / 2, size.h / 2);
    } else if (e.key === '-') {
      zoomAt(0.8, size.w / 2, size.h / 2);
    } else if (e.key === '0') {
      fit(true);
    }
  };

  const hovered = hover ? graph.nodes.find((n) => n.id === hover.id) : undefined;
  const focused = focusIndex !== null ? ordered[focusIndex] : undefined;
  const kindLabel = (k: string) => t(`memory.kind.${k}`);

  if (!supported) {
    return (
      <div className={className}>
        <div className="neo-graph" style={{ height: 'auto' }}>
          <p className="neo-help" style={{ margin: '0.75rem 0.875rem 0' }}>
            {t('memory.graph_fallback')}
          </p>
          <ul className="neo-graph__list">
            {ordered.map((n) => (
              <li key={n.id}>
                <button type="button" aria-current={n.id === selectedId} onClick={() => onSelect?.(n.id === selectedId ? null : n.id)}>
                  <span className="neo-kind-dot" data-kind={n.kind} />
                  <span style={{ flex: 1, minWidth: 0 }}>{n.label}</span>
                  <span className="neo-help">{kindLabel(n.kind)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {showLegend && <GraphLegend />}
      </div>
    );
  }

  return (
    <div className={className}>
      <div ref={wrapRef} className="neo-graph" style={{ height }}>
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={0}
          aria-label={t('memory.graph_aria', { nodes: graph.nodes.length, edges: graph.edges.length })}
          aria-describedby={undefined}
          data-hover={hover ? 'true' : undefined}
          data-dragging={gesture.current.mode === 'node' && gesture.current.moved ? 'true' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endGesture(e, false)}
          onPointerCancel={(e) => endGesture(e, true)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setFocusIndex(null)}
        />
        {graph.nodes.length === 0 && <div className="neo-graph__empty">{t('memory.graph_empty')}</div>}
        {hovered && hover && (
          <div className="neo-graph__tooltip" style={{ left: Math.min(hover.x, size.w - 200), top: Math.min(hover.y, size.h - 90) }}>
            <span className="neo-kind" data-kind={hovered.kind}>
              {kindLabel(hovered.kind)}
            </span>
            <strong>{truncate(hovered.label, 80)}</strong>
            {t('memory.retention', { pct: Math.round(hovered.retention * 100) })}
            {hovered.status !== 'active' && ` · ${t(`memory.status.${hovered.status}`)}`}
          </div>
        )}
        <div className="neo-graph__controls">
          <IconButton icon="zoom-in" label={t('memory.graph_zoom_in')} size="sm" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)} />
          <IconButton icon="zoom-out" label={t('memory.graph_zoom_out')} size="sm" onClick={() => zoomAt(0.8, size.w / 2, size.h / 2)} />
          <IconButton icon="maximize" label={t('memory.graph_fit')} size="sm" onClick={() => fit(true)} />
        </div>
        <span className="neo-sr" aria-live="polite">
          {focused ? `${kindLabel(focused.kind)}: ${focused.label}` : ''}
        </span>
      </div>
      {showLegend && <GraphLegend />}
    </div>
  );
}

/** The kind color legend (also usable on its own). */
export function GraphLegend(): ReactElement {
  const t = useT();
  return (
    <div className="neo-legend" aria-label={t('memory.graph_legend')}>
      {MEMORY_KIND_ORDER.map((kind) => (
        <span key={kind} className="neo-legend__item">
          <span className="neo-kind-dot" data-kind={kind} />
          {t(`memory.kind.${kind}`)}
        </span>
      ))}
      <span className="neo-legend__item">
        <Icon name="circle" size={11} />
        {t('memory.graph_legend_faded')}
      </span>
    </div>
  );
}
