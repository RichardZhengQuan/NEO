/**
 * Tests that MemoryGraphView respects prefers-reduced-motion during node drag.
 *
 * When the OS reduces-motion preference is set, dragging a node must:
 *   - redraw synchronously (draw()) after each move and on release
 *   - NOT start the animation loop (no requestAnimationFrame call)
 *   - NOT move any non-dragged node
 *
 * This test fails on the unpatched code where the drag-move handler
 * unconditionally calls kick(0.3) regardless of reduced-motion preference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { MemoryGraph, MemoryNode } from '@neo/protocol';
import { I18nProvider } from './i18n.js';
import { MemoryGraphView } from './memory-graph.js';

// ---------------------------------------------------------------------------
// jsdom polyfill: PointerEvent is not defined as a global in some jsdom
// versions.  Extend MouseEvent so that clientX/clientY are properly set
// from the EventInit dict (MouseEvent's constructor handles this correctly).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (globalThis as any).PointerEvent === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = class PointerEvent extends MouseEvent {
    readonly pointerId: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(type: string, init: Record<string, any> = {}) {
      super(type, init as MouseEventInit);
      this.pointerId = (init.pointerId as number) ?? 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const baseNode: MemoryNode = {
  id: 'mem_a',
  kind: 'fact',
  label: 'Alpha',
  content: 'First fact.',
  aliases: [],
  tags: [],
  importance: 0.5,
  confidence: 0.9,
  stability: 40,
  accessCount: 2,
  lastAccessedAt: null,
  createdAt: Date.UTC(2026, 9, 10),
  updatedAt: Date.UTC(2026, 9, 10),
  status: 'active',
  pinned: false,
  sensitivity: 'normal',
  source: { by: 'extraction' },
};

/** Three non-self nodes; no edges so repulsion drives them apart. */
const graph: MemoryGraph = {
  nodes: [
    { ...baseNode, id: 'mem_a', label: 'Alpha', importance: 0.7, retention: 0.9 },
    { ...baseNode, id: 'mem_b', label: 'Beta',  importance: 0.5, retention: 0.8 },
    { ...baseNode, id: 'mem_c', label: 'Gamma', importance: 0.3, retention: 0.7 },
  ],
  edges: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Node-circle radius range (matches buildSim formula; importance 0.3–0.7, n≤30). */
const NODE_R_MIN = 5;
const NODE_R_MAX = 25;

/** Filter arc calls to the main node-body circles (excludes halos, rings etc.). */
function nodeCircles(arcs: Array<{ x: number; y: number; r: number }>) {
  return arcs.filter(({ r }) => r >= NODE_R_MIN && r <= NODE_R_MAX);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('MemoryGraphView drag with prefers-reduced-motion', () => {
  // Mutable state captured from the canvas context mock.
  let arcCalls: Array<{ x: number; y: number; r: number }>;
  let viewTransform: { vx: number; vy: number; vk: number };

  beforeEach(() => {
    arcCalls = [];
    viewTransform = { vx: 0, vy: 0, vk: 1 };

    // --- matchMedia: always return reduced-motion for the reduce query -------
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      const matches = query === '(prefers-reduced-motion: reduce)';
      return {
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      } as unknown as MediaQueryList;
    });

    // --- ResizeObserver stub -------------------------------------------------
    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }

    // --- Canvas 2D context mock that records arc calls + view transform ------
    const mockCtx = {
      // transform tracking
      setTransform: vi.fn(),
      clearRect: vi.fn(() => {
        // Each draw() starts with clearRect; reset arc accumulator.
        arcCalls = [];
      }),
      translate: vi.fn((x: number, y: number) => {
        viewTransform = { ...viewTransform, vx: x, vy: y };
      }),
      scale: vi.fn((k: number) => {
        viewTransform = { ...viewTransform, vk: k };
      }),
      // path primitives
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn((x: number, y: number, r: number) => {
        arcCalls.push({ x, y, r });
      }),
      fill: vi.fn(),
      stroke: vi.fn(),
      closePath: vi.fn(),
      // text
      fillText: vi.fn(),
      strokeText: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 } as TextMetrics)),
      // misc
      setLineDash: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      // writable props
      globalAlpha: 1,
      fillStyle: '' as string | CanvasGradient | CanvasPattern,
      strokeStyle: '' as string | CanvasGradient | CanvasPattern,
      lineWidth: 1,
      font: '',
      textAlign: 'center' as CanvasTextAlign,
      textBaseline: 'top' as CanvasTextBaseline,
      lineJoin: 'round' as CanvasLineJoin,
      shadowBlur: 0,
      shadowColor: '',
    };

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('redraws synchronously and does not start the animation loop when dragging a node', async () => {
    // Spy on rAF *before* render so we catch everything from the start.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

    const { container } = render(
      <I18nProvider locale="en">
        <MemoryGraphView graph={graph} showLegend={false} />
      </I18nProvider>,
    );

    // Flush all effects (300-tick settle + fit + draw).
    await act(async () => {});

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();

    // After initial layout there must be at least 3 node-body arcs.
    const initialNodes = nodeCircles(arcCalls);
    expect(initialNodes.length, 'expected at least 3 node arcs after initial layout').toBeGreaterThanOrEqual(3);

    // --- Compute the screen-space position of the first node ----------------
    //
    // draw() calls ctx.translate(v.x, v.y) then ctx.scale(v.k, v.k).
    // Our mock captures those as viewTransform.{vx, vy, vk}.
    //
    // Mapping from simulation → screen (with dpr=1 in jsdom):
    //   screenX = simX * vk + vx
    //   screenY = simY * vk + vy
    //
    // Firing a pointer at these coords means toWorld() returns exactly (simX, simY),
    // which hits the node in hitTest() with squared distance = 0.
    const { x: simX, y: simY } = initialNodes[0]!;
    const { vx, vy, vk } = viewTransform;
    const screenX = Math.round(simX * vk + vx);
    const screenY = Math.round(simY * vk + vy);

    // Baseline positions of the two OTHER nodes (indices 1 and 2 in draw order).
    const othersBefore = initialNodes.slice(1, 3).map(({ x, y }) => ({ x, y }));

    // Reset the rAF spy — ignore any rAF calls from the initial render
    // (with reduced motion the initial layout is synchronous, so there should
    // be none, but we reset for a cleaner assertion).
    rafSpy.mockClear();

    // --- Drag the first node 60px right and 30px down -----------------------
    //
    // NOTE: RTL's fireEvent.pointerDown(el, { clientX }) does NOT propagate
    // clientX/clientY into the native PointerEvent dispatched to the DOM — the
    // React component receives e.clientX === undefined.  Constructing the
    // native PointerEvent directly and dispatching it with fireEvent() is the
    // correct way to carry these properties through to the handler.
    fireEvent(canvas!, new PointerEvent('pointerdown', {
      pointerId: 1,
      clientX: screenX,
      clientY: screenY,
      buttons: 1,
      bubbles: true,
      cancelable: true,
    }));
    // The move must exceed the 4px threshold to be treated as a drag.
    fireEvent(canvas!, new PointerEvent('pointermove', {
      pointerId: 1,
      clientX: screenX + 60,
      clientY: screenY + 30,
      buttons: 1,
      bubbles: true,
      cancelable: true,
    }));
    fireEvent(canvas!, new PointerEvent('pointerup', {
      pointerId: 1,
      clientX: screenX + 60,
      clientY: screenY + 30,
      buttons: 0,
      bubbles: true,
      cancelable: true,
    }));

    // --- Assertions ----------------------------------------------------------

    // 1. The animation loop must NOT have been started.
    expect(rafSpy, 'kick() must not call requestAnimationFrame when prefers-reduced-motion is set')
      .not.toHaveBeenCalled();

    // 2. After the drag + release, the canvas must have been redrawn
    //    synchronously (arcCalls is populated by the last draw() call).
    const afterNodes = nodeCircles(arcCalls);
    expect(afterNodes.length, 'expected at least 3 node arcs after drag').toBeGreaterThanOrEqual(3);

    // 3. The dragged node (first in draw order) must have moved to the pointer.
    const draggedAfter = afterNodes[0]!;
    const expectedSimX = simX + 60 / vk;
    expect(
      draggedAfter.x,
      'dragged node x must have moved to the pointer position',
    ).toBeCloseTo(expectedSimX, 0);

    // 4. The OTHER nodes must NOT have moved (no simulation ticks fired).
    const othersAfter = afterNodes.slice(1, 3).map(({ x, y }) => ({ x, y }));
    for (let i = 0; i < othersBefore.length; i++) {
      expect(
        othersAfter[i]!.x,
        `non-dragged node ${i + 1} x must be unchanged`,
      ).toBeCloseTo(othersBefore[i]!.x, 1);
      expect(
        othersAfter[i]!.y,
        `non-dragged node ${i + 1} y must be unchanged`,
      ).toBeCloseTo(othersBefore[i]!.y, 1);
    }
  });
});
