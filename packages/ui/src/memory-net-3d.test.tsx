import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MemoryGraph, MemoryNode, ToolUseEvent } from '@neo/protocol';
import { I18nProvider } from './i18n.js';
import { MemoryNet3D } from './memory-net-3d.js';
import type { createMemoryNetScene, MemoryNetScene } from './memory-net-3d-scene.js';

const importThree = vi.hoisted(() => vi.fn());
const createScene = vi.hoisted(() => vi.fn());

vi.mock('./memory-net-3d-scene.js', () => ({
  createMemoryNetScene: createScene,
  defaultToolUseLabels: { note: 'Note', reminder: 'Reminder', task: 'Task', search: 'Search', memory: 'Memory', other: 'Tool use' },
}));

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

const toolUses: ToolUseEvent[] = [
  { id: 'tool_1', at: Date.UTC(2026, 9, 10), tool: 'create_note', category: 'note', title: 'Wrote note “Kyoto itinerary”', messageId: 'message_1', target: { kind: 'note', id: 'note_1' } },
  { id: 'tool_2', at: Date.UTC(2026, 9, 11), tool: 'create_reminder', category: 'reminder', title: 'Set reminder “Call Mom”', messageId: 'message_2', target: { kind: 'reminder', id: 'reminder_1' } },
];

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
  it('ignores tool markers in the 2D fallback', async () => {
    const onToolUseSelect = vi.fn();
    const { container } = render(<I18nProvider locale="en"><MemoryNet3D graph={graph} toolUses={toolUses} onToolUseSelect={onToolUseSelect} /></I18nProvider>);
    await screen.findByRole('button', { name: /Mia/ });
    expect(screen.queryByText('Wrote note “Kyoto itinerary”')).toBeNull();
    expect(container.querySelector('.neo-net3d__tool-marker')).toBeNull();
    expect(onToolUseSelect).not.toHaveBeenCalled();
  });

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
  it('announces tool focus with translated category, shows tool titles/dates, and forwards the latest target callback', async () => {
    const { scene, options } = readyScene();
    const onToolUseSelect = vi.fn();
    const nextSelect = vi.fn();
    const labels = { note: '笔记', reminder: '提醒', task: '任务', search: '搜索', memory: '记忆', other: '工具' };
    const { container, rerender } = render(<I18nProvider locale="en"><MemoryNet3D graph={graph} toolUses={toolUses} toolUseLabels={labels} onToolUseSelect={onToolUseSelect} /></I18nProvider>);
    await waitFor(() => expect(createScene).toHaveBeenCalledOnce());
    scene.key.mockImplementation((key: string) => { if (key === 'ArrowDown') options().onFocus('tool-use:tool_1'); return true; });
    fireEvent.keyDown(screen.getByRole('group'), { key: 'ArrowDown' });
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('笔记: Wrote note “Kyoto itinerary”, Oct 10, 2026');
    act(() => options().onHover({ id: 'tool-use:tool_1', x: 30, y: 40, toolUses: [toolUses[0]!] }));
    expect(screen.getByRole('tooltip').textContent).toContain('Wrote note “Kyoto itinerary”');
    expect(screen.getByRole('tooltip').textContent).toContain('Oct 10, 2026');
    expect(screen.getByRole('tooltip').textContent).toContain('笔记');
    rerender(<I18nProvider locale="en"><MemoryNet3D graph={graph} toolUses={toolUses} toolUseLabels={labels} onToolUseSelect={nextSelect} /></I18nProvider>);
    act(() => options().onToolUseSelect?.(toolUses[0]!));
    expect(nextSelect).toHaveBeenCalledWith(toolUses[0]);
    expect(onToolUseSelect).not.toHaveBeenCalled();
  });

  it('opens all projected group members in a keyboard-accessible chooser and returns the clicked target', async () => {
    const { options } = readyScene();
    const onToolUseSelect = vi.fn();
    const rangedGraph = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0]!, id: 'day-two', createdAt: toolUses[1]!.at }] };
    render(<I18nProvider locale="en"><MemoryNet3D graph={rangedGraph} toolUses={toolUses} onToolUseSelect={onToolUseSelect} /></I18nProvider>);
    await waitFor(() => expect(createScene).toHaveBeenCalledOnce());
    expect(options().layout.toolMarkers).toHaveLength(2);
    act(() => options().onToolUseGroupSelect?.({ ...options().layout.toolMarkers[0]!, events: toolUses }, 40, 80));
    const chooser = screen.getByRole('dialog');
    expect(chooser.querySelectorAll('button')).toHaveLength(3);
    expect(document.activeElement?.textContent).toContain('Kyoto itinerary');
    fireEvent.click(screen.getByRole('button', { name: 'Reminder: Set reminder “Call Mom”, Oct 11, 2026' }));
    expect(onToolUseSelect).toHaveBeenLastCalledWith(toolUses[1]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('group'));
    act(() => options().onToolUseGroupSelect?.({ ...options().layout.toolMarkers[0]!, events: toolUses }, 40, 80));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses current event privacy titles and immediately removes deleted cached tooltips/choosers', async () => {
    const { options } = readyScene();
    const onToolUseSelect = vi.fn();
    const { rerender } = render(<I18nProvider locale="en"><MemoryNet3D graph={graph} toolUses={toolUses} onToolUseSelect={onToolUseSelect} /></I18nProvider>);
    await waitFor(() => expect(createScene).toHaveBeenCalledOnce());
    const original = options();
    const privateEvent = { ...toolUses[0]!, title: 'Remembered something private' };
    rerender(<I18nProvider locale="en"><MemoryNet3D graph={graph} toolUses={[privateEvent, toolUses[1]!]} onToolUseSelect={onToolUseSelect} /></I18nProvider>);
    // A queued callback from the old scene must resolve through current props.
    act(() => original.onHover({ id: 'tool-use:tool_1', x: 30, y: 40, toolUses: [toolUses[0]!] }));
    expect(screen.getByRole('tooltip').textContent).toContain('Remembered something private');
    expect(screen.getByRole('tooltip').textContent).not.toContain('Kyoto itinerary');
    act(() => original.onToolUseSelect?.(toolUses[0]!));
    expect(onToolUseSelect).toHaveBeenLastCalledWith(privateEvent);
    act(() => original.onToolUseGroupSelect?.({ ...original.layout.toolMarkers[0]!, events: toolUses }, 40, 80));
    expect(screen.getByRole('dialog').textContent).toContain('Remembered something private');
    rerender(<I18nProvider locale="en"><MemoryNet3D graph={graph} toolUses={[]} onToolUseSelect={onToolUseSelect} /></I18nProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    onToolUseSelect.mockClear();
    act(() => original.onToolUseSelect?.(toolUses[0]!));
    expect(onToolUseSelect).not.toHaveBeenCalled();
  });

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
