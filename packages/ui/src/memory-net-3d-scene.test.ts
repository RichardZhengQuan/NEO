import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Three from 'three';
import type { MemoryGraph, MemoryKind, ToolUseEvent } from '@neo/protocol';
import { buildMessages, createTranslator } from './i18n.js';
import { buildMemoryNet3DLayout, toolUseFocusId } from './memory-net-3d-layout.js';
import { createMemoryNetScene, type MemoryNetScene } from './memory-net-3d-scene.js';

const DAY = 86_400_000;
const start = Date.UTC(2026, 9, 1);
const frames = new Map<number, FrameRequestCallback>();
const controllers: MemoryNetScene[] = [];
const resizeObservers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
const intersectionObservers: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
let frameId = 0;
let time = 100;
let hidden = false;
let reducedMotion = true;

function node(id: string, createdAt = start, kind: MemoryKind = 'fact'): MemoryGraph['nodes'][number] {
  return {
    id, kind, label: id, content: id, importance: .5, confidence: 1, stability: 30,
    aliases: [], tags: [], accessCount: 0, lastAccessedAt: null, createdAt, updatedAt: createdAt,
    status: 'active', pinned: false, sensitivity: 'normal', source: { by: 'user' }, retention: 1,
  };
}

class FakeRenderer {
  setPixelRatio = vi.fn();
  setSize = vi.fn();
  render = vi.fn((scene: Three.Scene, camera: Three.Camera) => { scene.updateMatrixWorld(); camera.updateMatrixWorld(); });
  dispose = vi.fn();
  forceContextLoss = vi.fn();
}

function draw(at = time + 16): void {
  time = at;
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(at);
}

function setup(graph: MemoryGraph, width = 800, height = 420, toolUses: ToolUseEvent[] = []) {
  const host = document.createElement('div');
  const labels = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.tabIndex = 0;
  host.append(labels);
  document.body.append(host);
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
  const renderer = new FakeRenderer();
  const T = { ...Three, WebGLRenderer: class { constructor() { return renderer; } } } as unknown as Parameters<typeof createMemoryNetScene>[0];
  const layout = buildMemoryNet3DLayout(graph, { now: Math.max(start, ...graph.nodes.map((memory) => memory.createdAt)), toolUses });
  const onSelect = vi.fn();
  const onFocus = vi.fn();
  const onHover = vi.fn();
  const onFailure = vi.fn();
  const onToolUseSelect = vi.fn();
  const onToolUseGroupSelect = vi.fn();
  const controller = createMemoryNetScene(T, {
    host, labels, canvas, context: {} as WebGL2RenderingContext, layout, locale: 'en',
    t: createTranslator('en', buildMessages('en')), onSelect, onFocus, onHover, onFailure, onToolUseSelect, onToolUseGroupSelect,
  });
  controllers.push(controller);
  const camera = () => renderer.render.mock.calls.at(-1)![1] as Three.OrthographicCamera;
  return { controller, renderer, camera, canvas, labels, layout, onSelect, onFocus, onHover, onFailure, onToolUseSelect, onToolUseGroupSelect, width, height };
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number, pointerId = 1): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId, clientX: x, clientY: y });
  canvas.dispatchEvent(event);
}

const yaw = (camera: Three.Camera) => Math.atan2(camera.position.x, camera.position.z);
const centerY = (camera: Three.Camera) => camera.position.y - Math.hypot(camera.position.x, camera.position.z) * Math.tan(Math.PI / 12);
const elevation = (camera: Three.Camera) => Math.asin(-camera.getWorldDirection(new Three.Vector3()).y);

beforeEach(() => {
  frameId = 0;
  time = 100;
  hidden = false;
  reducedMotion = true;
  frames.clear();
  resizeObservers.length = 0;
  intersectionObservers.length = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn();
    observe() {}
    constructor() { resizeObservers.push(this); }
  });
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn();
    observe() {}
    constructor(public callback: IntersectionObserverCallback) { intersectionObservers.push(this); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, Math.min(190, (this.textContent?.length ?? 0) * 7 + 8), 20);
  });
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  frames.clear();
});

describe('memory net 3D scene without WebGL', () => {
  const event = (id: string, at: number, category: ToolUseEvent['category'] = 'note'): ToolUseEvent => ({
    id, at, category, title: `Wrote note “${id}”`, tool: 'create_note', messageId: `message-${id}`, target: { kind: 'note', id },
  });

  it('projects a flat glyph outside the spine at its exact time, with a short tick and target activation', () => {
    const toolUse = event('Kyoto itinerary', start + 2 * DAY);
    const view = setup({ nodes: [node('oldest'), node('newest', start + 10 * DAY)], edges: [] }, 800, 420, [toolUse]);
    draw();
    const marker = view.labels.querySelector<HTMLButtonElement>('.neo-net3d__tool-marker')!;
    const tick = view.labels.querySelector<HTMLElement>('.neo-net3d__tool-tick')!;
    const position = (el: HTMLElement) => el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!.slice(1).map(Number);
    const anchor = new Three.Vector3(0, view.layout.timeScale.yAt(toolUse.at), 0).project(view.camera());
    const anchorY = (1 - anchor.y) * view.height / 2;
    expect(marker.style.display).toBe('flex');
    expect(marker.querySelector('svg')?.getAttribute('data-icon')).toBe('book');
    expect(position(marker)[1]! + 14).toBeCloseTo(anchorY, 8);
    expect(position(tick)[1]).toBeCloseTo(anchorY, 8);
    expect(position(marker)[0]! + 28).toBeLessThan(view.width / 2);
    expect(marker.getAttribute('aria-label')).toContain('Note: Wrote note “Kyoto itinerary”, Oct 3, 2026');
    marker.dispatchEvent(new Event('pointerenter'));
    expect(view.onHover.mock.calls.at(-1)![0].toolUses).toEqual([toolUse]);
    marker.click();
    expect(view.onToolUseSelect).toHaveBeenLastCalledWith(toolUse);
    expect(view.onSelect).not.toHaveBeenCalled();
    view.controller.key('ArrowRight');
    draw();
    expect(position(marker)[0]! + 28).toBeLessThan(view.width / 2);
    expect(position(marker)[1]! + 14).toBeCloseTo(anchorY, 8);
  });

  it('keeps every grouped event keyboard-reachable alongside memories in time order', () => {
    const a = event('a', start + 1000);
    const b = event('b', start + 2000, 'reminder');
    const view = setup({ nodes: [node('oldest'), node('newest', start + DAY)], edges: [] }, 800, 420, [a, b]);
    draw();
    const marker = view.labels.querySelector<HTMLButtonElement>('.neo-net3d__tool-marker')!;
    expect(marker.dataset.count).toBe('2');
    marker.click();
    expect(view.onToolUseGroupSelect.mock.calls.at(-1)![0].events).toEqual([a, b]);
    expect(view.onToolUseSelect).not.toHaveBeenCalled();
    view.controller.update({ selectedId: null, focusedId: null, highlightIds: new Set(), searchActive: false });
    for (const id of ['oldest', toolUseFocusId('a'), toolUseFocusId('b'), 'newest']) {
      view.controller.key('ArrowUp');
      draw();
      expect(view.onFocus).toHaveBeenLastCalledWith(id);
      if (id === toolUseFocusId('b')) {
        expect(marker.dataset.active).toBe('true');
        view.controller.key('Enter');
        expect(view.onToolUseSelect).toHaveBeenLastCalledWith(b);
      }
    }
    view.controller.key('ArrowDown');
    view.controller.key('Enter');
    expect(view.onToolUseSelect).toHaveBeenLastCalledWith(b);
  });

  it('groups projected glyphs at fit-all without overlap and retains all aggregated hover/chooser targets', () => {
    const memories = Array.from({ length: 200 }, (_, index) => node(`mem_${index}`, start + index * DAY));
    const toolUses = memories.map((memory, index) => event(`event-${index}`, memory.createdAt));
    const view = setup({ nodes: memories, edges: [] }, 1200, 420, toolUses);
    draw();
    const visible = [...view.labels.querySelectorAll<HTMLButtonElement>('.neo-net3d__tool-marker')].filter((marker) => marker.style.display !== 'none');
    expect(visible.length).toBeGreaterThan(1);
    expect(visible.length).toBeLessThan(20);
    const positions = visible.map((marker) => Number(marker.style.transform.match(/, ([-\d.]+)px/)! [1])).sort((a, b) => a - b);
    for (let index = 1; index < positions.length; index++) expect(positions[index]! - positions[index - 1]!).toBeGreaterThanOrEqual(32);
    expect(visible.reduce((sum, marker) => sum + Number(marker.dataset.count), 0)).toBe(200);
    const grouped = visible.find((marker) => Number(marker.dataset.count) > 1)!;
    grouped.dispatchEvent(new Event('pointerenter'));
    const hoveredEvents = view.onHover.mock.calls.at(-1)![0].toolUses;
    expect(hoveredEvents).toHaveLength(Number(grouped.dataset.count));
    grouped.click();
    expect(view.onToolUseGroupSelect.mock.calls.at(-1)![0].events).toEqual(hoveredEvents);
    view.controller.focus(toolUseFocusId('event-50'));
    draw();
    expect(centerY(view.camera())).toBeCloseTo(view.layout.timeScale.yAt(toolUses[50]!.at), 8);
  });

  it('fits all 200 same-day spheres, including their depth, in a wide viewport', () => {
    const kinds: MemoryKind[] = ['entity', 'fact', 'preference', 'goal', 'skill', 'episode', 'summary'];
    const view = setup({ nodes: Array.from({ length: 200 }, (_, index) => node(`mem_${index}`, start + index * 1000, kinds[index % kinds.length]!)), edges: [] }, 1200, 420);
    draw();
    const camera = view.camera();
    expect(elevation(camera)).toBeCloseTo(Math.PI / 12, 8);
    for (const memory of view.layout.nodes) {
      for (const dx of [-memory.radius, memory.radius]) for (const dy of [-memory.radius, memory.radius]) for (const dz of [-memory.radius, memory.radius]) {
        const point = new Three.Vector3(memory.x + dx, memory.y + dy, memory.z + dz).project(camera);
        expect(Math.abs(point.x)).toBeLessThan(1);
        expect(Math.abs(point.y)).toBeLessThan(1);
      }
    }
    view.controller.key('ArrowRight');
    draw();
    expect(elevation(view.camera())).toBeCloseTo(Math.PI / 12, 8);
    const bottom = new Three.Vector3(0, view.layout.timeScale.minY, 0).project(view.camera());
    const top = new Three.Vector3(0, view.layout.timeScale.maxY, 0).project(view.camera());
    expect(bottom.x).toBeCloseTo(top.x, 8);
    expect(top.y).toBeGreaterThan(bottom.y);
  });

  it('keeps self and Now labels visible on opposite sides, with no active date ticks', () => {
    const view = setup({ nodes: [{ ...node('mem_self', start, 'entity'), label: 'My memory' }], edges: [] });
    draw();
    const ticks = [...view.labels.querySelectorAll<HTMLElement>('.neo-net3d__tick')];
    const now = ticks.find((label) => label.textContent === 'Now')!;
    // The self node's stored label is a placeholder; the spine shows the translated "You".
    expect(ticks.some((label) => label.textContent === 'My memory')).toBe(false);
    const self = ticks.find((label) => label.textContent === 'You')!;
    expect(now.style.display).toBe('block');
    expect(self.style.display).toBe('block');
    const position = (label: HTMLElement) => label.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!.slice(1).map(Number);
    expect(position(now)[0]).toBeGreaterThan(view.width / 2);
    expect(position(self)[0]! + self.getBoundingClientRect().width).toBeLessThan(view.width / 2);
    expect(position(now)[1]).toBeCloseTo(position(self)[1]!, 8);
    expect(ticks.filter((label) => label.style.display === 'block').every((label) => label.dataset.active === 'false')).toBe(true);
    const scene = view.renderer.render.mock.calls.at(-1)![0];
    expect(scene.children.filter((object) => object instanceof Three.Mesh)).toHaveLength(0);
    pointer(view.canvas, 'pointerdown', view.width / 2, view.height / 2);
    pointer(view.canvas, 'pointerup', view.width / 2, view.height / 2);
    expect(view.onSelect).toHaveBeenLastCalledWith('mem_self');
  });

  it('keeps a long history inside the camera depth range when fitting and jumping in time', () => {
    const view = setup({ nodes: Array.from({ length: 200 }, (_, index) => node(`mem_${index}`, start + index * 90 * DAY)), edges: [] }, 1200, 420);
    expect(view.layout.timeScale.maxY).toBeGreaterThan(4000);
    const checkDepth = () => {
      for (const memory of view.layout.nodes) {
        const point = new Three.Vector3(memory.x, memory.y, memory.z).project(view.camera());
        expect([point.x, point.y, point.z].every(Number.isFinite)).toBe(true);
        expect(point.z).toBeGreaterThan(-1);
        expect(point.z).toBeLessThan(1);
      }
    };
    view.controller.fit();
    draw();
    checkDepth();
    for (const memory of view.layout.nodes) {
      const point = new Three.Vector3(memory.x, memory.y, memory.z).project(view.camera());
      expect(Math.abs(point.x)).toBeLessThan(1);
      expect(Math.abs(point.y)).toBeLessThan(1);
    }
    view.controller.now();
    draw();
    expect(centerY(view.camera())).toBeCloseTo(view.layout.timeScale.maxY, 8);
    checkDepth();
    view.controller.update({ selectedId: 'mem_0', focusedId: null, highlightIds: new Set(), searchActive: false });
    view.controller.key('ArrowDown');
    draw();
    expect(view.onFocus).toHaveBeenLastCalledWith('mem_0');
    expect(centerY(view.camera())).toBeCloseTo(view.layout.timeScale.minY, 8);
    checkDepth();
  });

  it('steps through actual memory times and selects or clears the keyboard focus', () => {
    const view = setup({ nodes: [node('newest', start + 40 * DAY), node('oldest'), node('middle', start + 10 * DAY), node('mem_self', start, 'entity')], edges: [] });
    draw();
    for (const id of ['oldest', 'middle', 'newest', 'newest']) {
      expect(view.controller.key('ArrowUp')).toBe(true);
      draw();
      expect(view.onFocus).toHaveBeenLastCalledWith(id);
      expect(centerY(view.camera())).toBeCloseTo(view.layout.nodes.find((memory) => memory.id === id)!.y, 8);
    }
    view.controller.key('Enter');
    expect(view.onSelect).toHaveBeenLastCalledWith('newest');
    view.controller.key('ArrowDown');
    draw();
    expect(view.onFocus).toHaveBeenLastCalledWith('middle');
    view.controller.key('Escape');
    expect(view.onFocus).toHaveBeenLastCalledWith(null);
    expect(view.onSelect).toHaveBeenLastCalledWith(null);
    expect(frames.size).toBe(1);
    draw(20_000);
    expect(frames.size).toBe(0);
  });

  it('rotates only in yaw, clamps time panning, and zooms with ctrl-wheel', () => {
    const view = setup({ nodes: [node('oldest'), node('newest', start + 30 * DAY)], edges: [] });
    draw();
    const initialY = centerY(view.camera());
    pointer(view.canvas, 'pointerdown', 100, 100);
    pointer(view.canvas, 'pointermove', 200, 100);
    pointer(view.canvas, 'pointerup', 200, 100);
    draw();
    expect(yaw(view.camera())).toBeCloseTo(-.6, 8);
    expect(centerY(view.camera())).toBeCloseTo(initialY, 8);
    expect(elevation(view.camera())).toBeCloseTo(Math.PI / 12, 8);
    view.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1_000_000, cancelable: true }));
    draw();
    expect(centerY(view.camera())).toBeCloseTo(view.layout.timeScale.maxY, 8);
    view.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1_000_000, cancelable: true }));
    draw();
    expect(centerY(view.camera())).toBeCloseTo(view.layout.timeScale.minY, 8);
    const initialHeight = view.camera().top - view.camera().bottom;
    view.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, cancelable: true }));
    draw();
    expect(view.camera().top - view.camera().bottom).toBeLessThan(initialHeight);
    expect(centerY(view.camera())).toBeCloseTo(view.layout.timeScale.minY, 8);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it('pauses rendering off-screen or in a hidden tab and resumes when visible', () => {
    reducedMotion = false;
    const view = setup({ nodes: [node('one')], edges: [] });
    draw();
    const observer = intersectionObservers[0]!;
    observer.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(frames.size).toBe(0);
    view.controller.zoom(1.25);
    draw();
    expect(view.renderer.render).toHaveBeenCalledOnce();
    observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    draw();
    expect(view.renderer.render).toHaveBeenCalledTimes(2);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    draw();
    expect(view.renderer.render).toHaveBeenCalledTimes(3);
  });

  it('disposes shared geometries, materials, observers and the renderer once', () => {
    const disposeGeometry = vi.spyOn(Three.BufferGeometry.prototype, 'dispose');
    const disposeMaterial = vi.spyOn(Three.Material.prototype, 'dispose');
    const view = setup({ nodes: [node('one'), { ...node('entity', start, 'entity'), pinned: true, lastAccessedAt: start + DAY }], edges: [] });
    draw();
    const scene = view.renderer.render.mock.calls.at(-1)![0];
    const geometries = new Set<Three.BufferGeometry>();
    const materials = new Set<Three.Material>();
    scene.traverse((object) => {
      if (object instanceof Three.Mesh || object instanceof Three.Line) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    view.controller.dispose();
    view.controller.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(geometries.size);
    expect(disposeMaterial).toHaveBeenCalledTimes(materials.size + 1);
    expect(view.renderer.dispose).toHaveBeenCalledOnce();
    expect(view.renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(resizeObservers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(intersectionObservers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(view.canvas.isConnected).toBe(false);
    expect(view.labels.childElementCount).toBe(0);
    view.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }));
    expect(frames.size).toBe(0);
  });
});
