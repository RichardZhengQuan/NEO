import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MemoryGraph, MemoryNode } from '@neo/protocol';
import { I18nProvider } from './i18n.js';
import { MemoryNet3D } from './memory-net-3d.js';
import type { createMemoryNetScene, MemoryNetScene } from './memory-net-3d-scene.js';

const importThree = vi.hoisted(() => vi.fn());
const createScene = vi.hoisted(() => vi.fn());

vi.mock('./memory-net-3d-scene.js', () => ({ createMemoryNetScene: createScene }));

type SceneOptions = Parameters<typeof createMemoryNetScene>[1];

const node: MemoryNode = {
  id: 'mem_1',
  kind: 'preference',
  label: 'Prefers window seats',
  content: 'The user prefers window seats on flights.',
  aliases: [],
  tags: [],
  importance: 0.7,
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

const graph: MemoryGraph = {
  nodes: [
    { ...node, retention: 0.8 },
    { ...node, id: 'mem_2', kind: 'entity', label: 'Mia', retention: 1 },
  ],
  edges: [{ id: 'edge_1', from: 'mem_1', to: 'mem_2', type: 'about', weight: 0.8, createdAt: 1, updatedAt: 1, lastReinforcedAt: 1, coactivations: 0 }],
};

beforeEach(() => {
  vi.resetModules();
  importThree.mockReset();
  createScene.mockReset();
  vi.doMock('three', async () => {
    await importThree();
    return {
      WebGLRenderer: undefined, Scene: undefined, OrthographicCamera: undefined,
      Color: undefined, Vector2: undefined, Vector3: undefined, BufferGeometry: undefined,
      SphereGeometry: undefined, TorusGeometry: undefined, Mesh: undefined,
      MeshBasicMaterial: undefined, MeshLambertMaterial: undefined, Line: undefined,
      LineBasicMaterial: undefined, LineDashedMaterial: undefined, HemisphereLight: undefined,
      DirectionalLight: undefined, Raycaster: undefined,
    };
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MemoryNet3D fallback', () => {
  it('uses the accessible 2D fallback without WebGL and preserves selection', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <I18nProvider locale="en">
        <MemoryNet3D graph={graph} selectedId="mem_2" highlightIds={['mem_1']} onSelect={onSelect} className="memory-net-test" />
      </I18nProvider>,
    );
    const mia = await screen.findByRole('button', { name: /Mia/ });
    expect(mia.getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('.memory-net-test')).not.toBeNull();
    expect(container.querySelector('.neo-legend')).not.toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
    expect(importThree).not.toHaveBeenCalled();
    fireEvent.click(mia);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: /Prefers window seats/ }));
    expect(onSelect).toHaveBeenLastCalledWith('mem_1');
  });

  it('keeps filtering and callbacks current after the fallback has loaded', async () => {
    const firstSelect = vi.fn();
    const nextSelect = vi.fn();
    const { container, rerender } = render(
      <I18nProvider locale="en"><MemoryNet3D graph={graph} onSelect={firstSelect} /></I18nProvider>,
    );
    await screen.findByRole('button', { name: /Mia/ });
    rerender(
      <I18nProvider locale="en">
        <MemoryNet3D graph={{ nodes: [graph.nodes[0]!], edges: [] }} onSelect={nextSelect} showLegend={false} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('button', { name: /Mia/ })).toBeNull();
    expect(container.querySelector('.neo-legend')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Prefers window seats/ }));
    expect(nextSelect).toHaveBeenCalledWith('mem_1');
    expect(firstSelect).not.toHaveBeenCalled();
  });

  it('falls back if the browser refuses to create a WebGL context', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(((kind: string) => {
      if (kind === 'webgl2' || kind === 'webgl') throw new Error('WebGL is disabled');
      return null;
    }) as unknown as HTMLCanvasElement['getContext']);
    render(<I18nProvider locale="en"><MemoryNet3D graph={graph} /></I18nProvider>);
    expect(await screen.findByRole('button', { name: /Mia/ })).toBeTruthy();
    expect(importThree).not.toHaveBeenCalled();
  });

  it('falls back when the lazy three import fails', async () => {
    importThree.mockImplementation(() => { throw new Error('The 3D renderer could not be loaded'); });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(((kind: string) =>
      kind === 'webgl2' || kind === 'webgl' ? {} : null) as unknown as HTMLCanvasElement['getContext']);
    const onSelect = vi.fn();
    const { container } = render(
      <I18nProvider locale="zh-CN"><MemoryNet3D graph={graph} onSelect={onSelect} showLegend={false} /></I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText('记忆网络中的内容')).toBeTruthy());
    expect(importThree).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Mia/ }));
    expect(onSelect).toHaveBeenCalledWith('mem_2');
    expect(container.querySelector('canvas')).toBeNull();
  });
});

describe('MemoryNet3D scene wrapper', () => {
  const readyScene = () => {
    let options: SceneOptions;
    const scene = {
      update: vi.fn(), focus: vi.fn(), zoom: vi.fn(), fit: vi.fn(), now: vi.fn(), key: vi.fn(), dispose: vi.fn(),
    } satisfies MemoryNetScene;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(((kind: string) =>
      kind === 'webgl2' ? {} : null) as unknown as HTMLCanvasElement['getContext']);
    createScene.mockImplementation((_three, next: SceneOptions) => {
      options = next;
      next.host.prepend(next.canvas);
      scene.dispose.mockImplementation(() => next.canvas.remove());
      return scene;
    });
    return { scene, options: () => options! };
  };

  it('dispatches keyboard input and announces the focused memory with its date', async () => {
    const { scene, options } = readyScene();
    const onSelect = vi.fn();
    const { container } = render(<I18nProvider locale="en"><MemoryNet3D graph={graph} onSelect={onSelect} /></I18nProvider>);
    const host = screen.getByRole('group', { name: /2 memories and 1 links/ });
    await waitFor(() => expect(host.getAttribute('aria-busy')).toBe('false'));
    expect(host.getAttribute('tabindex')).toBe('0');
    scene.key.mockImplementation((key: string) => {
      if (key === 'ArrowDown') options().onFocus('mem_1');
      else if (key === 'Enter') options().onSelect('mem_1');
      else if (key === 'Escape') { options().onFocus(null); options().onSelect(null); }
      else return false;
      return true;
    });
    fireEvent.keyDown(host, { key: 'ArrowDown' });
    expect(scene.key).toHaveBeenLastCalledWith('ArrowDown');
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('Prefers window seats, Preference, Oct 10, 2026');
    fireEvent.keyDown(host, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('mem_1');
    fireEvent.keyDown(host, { key: 'Escape' });
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(live.textContent).toBe('');
    scene.key.mockClear();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Zoom in' }), { key: 'Enter' });
    expect(scene.key).not.toHaveBeenCalled();
  });

  it('focuses the selection, forwards controls and new props, and disposes on unmount', async () => {
    const { scene, options } = readyScene();
    const firstSelect = vi.fn();
    const nextSelect = vi.fn();
    const { rerender, unmount } = render(
      <I18nProvider locale="en"><MemoryNet3D graph={graph} selectedId="mem_1" onSelect={firstSelect} /></I18nProvider>,
    );
    await waitFor(() => expect(scene.focus).toHaveBeenCalledWith('mem_1'));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to now' }));
    expect(scene.zoom.mock.calls).toEqual([[1.25], [0.8]]);
    expect(scene.fit).toHaveBeenCalledOnce();
    expect(scene.now).toHaveBeenCalledOnce();
    rerender(
      <I18nProvider locale="en"><MemoryNet3D graph={graph} selectedId="mem_2" highlightIds={[]} onSelect={nextSelect} /></I18nProvider>,
    );
    expect(scene.focus).toHaveBeenLastCalledWith('mem_2');
    expect(scene.update).toHaveBeenLastCalledWith({ selectedId: 'mem_2', highlightIds: new Set(), searchActive: true, focusedId: null });
    options().onSelect('mem_2');
    expect(nextSelect).toHaveBeenCalledWith('mem_2');
    expect(firstSelect).not.toHaveBeenCalled();
    expect(createScene).toHaveBeenCalledOnce();
    unmount();
    expect(scene.dispose).toHaveBeenCalledOnce();
  });

  it('releases a pending context instead of mounting a scene after unmount', async () => {
    let finishImport!: () => void;
    const loseContext = vi.fn();
    importThree.mockImplementation(() => new Promise<void>((resolve) => { finishImport = resolve; }));
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(((kind: string) =>
      kind === 'webgl2' ? { getExtension: () => ({ loseContext }) } : null) as unknown as HTMLCanvasElement['getContext']);
    const { unmount } = render(<I18nProvider locale="en"><MemoryNet3D graph={graph} /></I18nProvider>);
    expect(screen.getByRole('group', { name: /2 memories and 1 links/ }).getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(importThree).toHaveBeenCalledOnce());
    unmount();
    await act(async () => { finishImport(); });
    await waitFor(() => expect(loseContext).toHaveBeenCalledOnce());
    expect(createScene).not.toHaveBeenCalled();
  });
});
