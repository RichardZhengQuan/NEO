import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MEMORY_KINDS, type MemoryGraph, type MemoryKind } from '@neo/protocol';
import { I18nProvider, type MemoryGraphViewProps } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { NetTab } from './NetTab.js';

const mocks = vi.hoisted(() => ({ graph: vi.fn(), search: vi.fn(), view: vi.fn() }));

vi.mock('../../state/session.js', () => ({ requireClient: () => ({ memory: { graph: mocks.graph, search: mocks.search } }) }));
vi.mock('../../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => true }));
vi.mock('@neo/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@neo/ui')>(),
  MemoryNet3D: (props: MemoryGraphViewProps) => {
    mocks.view(props);
    return <div data-testid="memory-net-3d">{props.graph.nodes.map((n) => <span key={n.id}>{n.label}</span>)}</div>;
  },
}));

function node(id: string, kind: MemoryKind, status: 'active' | 'archived' = 'active'): MemoryGraph['nodes'][number] {
  return { id, kind, label: `${kind} memory`, content: '', aliases: [], tags: [], importance: 0.5, confidence: 1, stability: 30, accessCount: 0, createdAt: 1000, updatedAt: 1000, lastAccessedAt: null, status, pinned: false, sensitivity: 'normal', source: { by: 'user' }, retention: 0.8 };
}

const nodes = [node('mem_fact', 'fact'), node('mem_episode', 'episode'), node('mem_archived', 'goal', 'archived')];

async function show(props: Partial<Parameters<typeof NetTab>[0]> = {}) {
  const onSelect = vi.fn();
  const onFocus = vi.fn();
  const view = render(<I18nProvider locale="en" messages={appDictionaries}><NetTab selectedId={null} onSelect={onSelect} focusId={null} onFocus={onFocus} {...props} /></I18nProvider>);
  await act(async () => undefined);
  return { ...view, onSelect, onFocus };
}

function netProps(): MemoryGraphViewProps {
  return mocks.view.mock.calls.at(-1)![0] as MemoryGraphViewProps;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.view.mockReset();
  mocks.search.mockReset().mockResolvedValue({ items: [nodes[0]], total: 1 });
  mocks.graph.mockReset().mockImplementation(async ({ kinds, includeArchived }: { kinds?: MemoryKind[]; includeArchived?: boolean }) => ({
    nodes: nodes.filter((n) => (!kinds || kinds.includes(n.kind)) && (includeArchived || n.status === 'active')),
    edges: [],
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NetTab 3D net', () => {
  it('renders the 3D component with selection, viewport height and the time legend', async () => {
    const { onSelect } = await show({ selectedId: 'mem_fact' });
    expect(screen.getByTestId('memory-net-3d')).toBeTruthy();
    expect(mocks.graph).toHaveBeenCalledWith({ limit: 200, includeArchived: false });
    expect(netProps()).toMatchObject({ selectedId: 'mem_fact', onSelect, height: 640, showLegend: false, className: 'neo-memory-net-viewport' });
    expect(netProps().highlightIds).toBeUndefined();
    expect(screen.getByText('2 memories · 0 links')).toBeTruthy();
    expect(screen.getByText(appDictionaries.en['memoryNet.hint']!)).toBeTruthy();
  });

  it('keeps kind filters working and restores all kinds', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Fact' }));
    await act(async () => undefined);
    expect(mocks.graph).toHaveBeenLastCalledWith({ limit: 200, includeArchived: false, kinds: MEMORY_KINDS.filter((k) => k !== 'fact') });
    expect(netProps().graph.nodes.map((n) => n.id)).toEqual(['mem_episode']);
    expect(screen.getByRole('button', { name: 'Fact' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await act(async () => undefined);
    expect(mocks.graph).toHaveBeenLastCalledWith({ limit: 200, includeArchived: false });
    expect(netProps().graph.nodes).toHaveLength(2);
  });

  it('passes the archived toggle through to the graph', async () => {
    await show();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    await act(async () => undefined);
    expect(mocks.graph).toHaveBeenLastCalledWith({ limit: 200, includeArchived: true });
    expect(netProps().graph.nodes.some((n) => n.id === 'mem_archived')).toBe(true);
  });

  it('highlights search matches and keeps Enter selection', async () => {
    const { onSelect } = await show();
    const search = screen.getByRole('searchbox', { name: 'Find in the net' });
    fireEvent.change(search, { target: { value: ' fact ' } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(mocks.search).toHaveBeenCalledWith({ query: 'fact', limit: 30, status: ['active'] });
    expect(netProps().highlightIds).toEqual(['mem_fact']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('mem_fact');
    fireEvent.change(search, { target: { value: '' } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(netProps().highlightIds).toBeUndefined();
  });

  it('distinguishes an active search with no matches from an inactive search', async () => {
    mocks.search.mockResolvedValue({ items: [], total: 0 });
    await show();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in the net' }), { target: { value: 'nothing' } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(netProps().highlightIds).toEqual([]);
  });

  it('preserves neighborhood focus and the whole-net action', async () => {
    const { onFocus } = await show({ focusId: 'mem_fact' });
    expect(mocks.graph).toHaveBeenCalledWith({ limit: 200, includeArchived: false, centerId: 'mem_fact', depth: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Show whole net' }));
    expect(onFocus).toHaveBeenCalledWith(null);
  });
});
