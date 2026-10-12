import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MEMORY_KINDS, type MemoryGraph, type MemoryKind, type ToolUseEvent } from '@neo/protocol';
import { I18nProvider, type MemoryNet3D } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { emptyEntry, useTimeline } from '../../state/timeline.js';
import { NetTab } from './NetTab.js';

type NetProps = Parameters<typeof MemoryNet3D>[0];
const mocks = vi.hoisted(() => ({ graph: vi.fn(), search: vi.fn(), toolUses: vi.fn(), view: vi.fn(), navigate: vi.fn(), openExternal: vi.fn() }));

vi.mock('../../state/session.js', () => ({ requireClient: () => ({ memory: { graph: mocks.graph, search: mocks.search, toolUses: mocks.toolUses } }) }));
vi.mock('../../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => true }));
vi.mock('../../router.js', () => ({ navigate: mocks.navigate }));
vi.mock('../../platform/index.js', () => ({ getPlatform: () => ({ openExternal: mocks.openExternal }) }));
vi.mock('@neo/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@neo/ui')>(),
  MemoryNet3D: (props: NetProps) => {
    mocks.view(props);
    return <div data-testid="memory-net-3d">{props.graph.nodes.map((n) => <span key={n.id}>{n.label}</span>)}</div>;
  },
}));

function node(id: string, kind: MemoryKind, status: 'active' | 'archived' = 'active'): MemoryGraph['nodes'][number] {
  return { id, kind, label: `${kind} memory`, content: '', aliases: [], tags: [], importance: 0.5, confidence: 1, stability: 30, accessCount: 0, createdAt: 1000, updatedAt: 1000, lastAccessedAt: null, status, pinned: false, sensitivity: 'normal', source: { by: 'user' }, retention: 0.8 };
}

const nodes = [node('mem_fact', 'fact'), node('mem_episode', 'episode'), node('mem_archived', 'goal', 'archived')];
const event: ToolUseEvent = { id: 'msg_1:call_1', at: 1500, tool: 'create_note', category: 'note', title: 'Wrote note “Kyoto itinerary”', messageId: 'msg_1', target: { kind: 'note', id: 'note_1' } };

async function show(props: Partial<Parameters<typeof NetTab>[0]> = {}, locale: 'en' | 'zh-CN' = 'en') {
  const onSelect = vi.fn();
  const onFocus = vi.fn();
  const view = render(<I18nProvider locale={locale} messages={appDictionaries}><NetTab selectedId={null} onSelect={onSelect} focusId={null} onFocus={onFocus} {...props} /></I18nProvider>);
  await act(async () => undefined);
  return { ...view, onSelect, onFocus };
}

function netProps(): NetProps {
  return mocks.view.mock.calls.at(-1)![0] as NetProps;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5000);
  useTimeline.setState(emptyEntry(), true);
  mocks.view.mockReset();
  mocks.navigate.mockReset();
  mocks.openExternal.mockReset();
  mocks.toolUses.mockReset().mockResolvedValue({ items: [event] });
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

  it('loads tool uses for the graph time range, with an enabled toggle and legend', async () => {
    await show();
    expect(mocks.toolUses).toHaveBeenLastCalledWith({ from: 1000, to: 5000, limit: 500 });
    expect(netProps().toolUses).toEqual([event]);
    expect(netProps().toolUseLabels?.note).toBe('Note');
    expect(screen.getByText("NEO's notes, reminders, tasks and searches")).toBeTruthy();
    const chip = screen.getByRole('button', { name: 'Tool uses' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(netProps().toolUses).toBeUndefined();
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(netProps().toolUses).toEqual([event]);
  });

  it('matches the spine range including entity access and excluding ancient self creation', async () => {
    mocks.graph.mockResolvedValue({ nodes: [{ ...node('mem_self', 'entity'), createdAt: 1 }, { ...node('mem_entity', 'entity'), createdAt: 2000, lastAccessedAt: 6000 }], edges: [] });
    await show();
    expect(mocks.toolUses).toHaveBeenLastCalledWith({ from: 2000, to: 6000, limit: 500 });
  });

  it('can show tool moments on an otherwise empty spine', async () => {
    mocks.graph.mockResolvedValue({ nodes: [], edges: [] });
    await show();
    expect(mocks.toolUses).toHaveBeenLastCalledWith({ to: 5000, limit: 500 });
    expect(screen.getByTestId('memory-net-3d')).toBeTruthy();
    expect(netProps().toolUses).toEqual([event]);
    fireEvent.click(screen.getByRole('button', { name: 'Tool uses' }));
    expect(netProps().toolUses).toBeUndefined();
  });

  it.each([
    [{ kind: 'note', id: 'note_1' }, { name: 'notes', noteId: 'note_1' }],
    [{ kind: 'reminder', id: 'rem_1' }, { name: 'reminders', reminderId: 'rem_1' }],
    [{ kind: 'task', id: 'task_1' }, { name: 'tasks', taskId: 'task_1' }],
    [undefined, { name: 'timeline', messageId: 'msg_1' }],
    [{ kind: 'note' }, { name: 'timeline', messageId: 'msg_1' }],
    [{ kind: 'url', url: 'javascript:alert(1)' }, { name: 'timeline', messageId: 'msg_1' }],
    [{ kind: 'url', url: 'https://user:secret@example.com/' }, { name: 'timeline', messageId: 'msg_1' }],
  ] as const)('routes a marker target %j through the navigation helper', async (target, route) => {
    await show();
    act(() => netProps().onToolUseSelect?.({ ...event, target }));
    expect(mocks.navigate).toHaveBeenCalledWith(route);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('selects a target memory and opens URL targets through the host platform', async () => {
    const { onSelect } = await show();
    act(() => netProps().onToolUseSelect?.({ ...event, target: { kind: 'memory', id: 'mem_1' } }));
    expect(onSelect).toHaveBeenCalledWith('mem_1');
    expect(mocks.navigate).not.toHaveBeenCalled();
    act(() => netProps().onToolUseSelect?.({ ...event, target: { kind: 'url', url: 'https://example.com/kyoto' } }));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/kyoto');
  });

  it('offers retry when tool uses fail while preserving the net', async () => {
    mocks.toolUses.mockRejectedValueOnce(new Error('offline'));
    await show();
    expect(screen.getByTestId('memory-net-3d')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Tool uses could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => undefined);
    expect(netProps().toolUses).toEqual([event]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('immediately hides markers whose source messages were deleted', async () => {
    await show();
    act(() => useTimeline.setState({ deletedMessageIds: { msg_1: true } }));
    expect(netProps().toolUses).toEqual([]);
  });

  it('invalidates older markers when an episode outside the loaded timeline is deleted', async () => {
    await show();
    expect(useTimeline.getState().messages).toEqual([]);
    const calls = mocks.toolUses.mock.calls.length;
    mocks.toolUses.mockResolvedValue({ items: [] });
    act(() => useTimeline.setState({ deletedEpisodes: { ep_old: true } }));
    expect(netProps().toolUses).toEqual([]);
    await act(async () => undefined);
    expect(mocks.toolUses.mock.calls.length).toBeGreaterThan(calls);
    expect(netProps().toolUses).toEqual([]);
  });

  it('localizes the marker toggle, legend and category announcements in Chinese', async () => {
    await show({}, 'zh-CN');
    expect(screen.getByRole('button', { name: '工具使用' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('NEO 的笔记、提醒、任务和搜索')).toBeTruthy();
    expect(netProps().toolUseLabels).toMatchObject({ note: '笔记', reminder: '提醒', task: '任务', search: '搜索', memory: '记忆' });
  });

  it('refreshes the graph range and markers when a tool result arrives, without refetching for text deltas', async () => {
    await show();
    const graphCalls = mocks.graph.mock.calls.length;
    act(() => useTimeline.setState({ messages: [{ id: 'msg_live', conversationId: 'episode_1', role: 'assistant', status: 'streaming', createdAt: 5000, parts: [{ type: 'text', text: 'Writing' }] }] }));
    await act(async () => undefined);
    const afterMessage = mocks.graph.mock.calls.length;
    expect(afterMessage).toBe(graphCalls);
    act(() => useTimeline.setState((s) => ({ messages: s.messages.map((m) => ({ ...m, parts: [{ type: 'text', text: 'Writing a note' }] })) })));
    await act(async () => undefined);
    expect(mocks.graph).toHaveBeenCalledTimes(afterMessage);
    vi.setSystemTime(6000);
    act(() => useTimeline.setState((s) => ({ messages: s.messages.map((m) => ({ ...m, parts: [...m.parts, { type: 'tool_result', toolCallId: 'call_live', name: 'create_note', output: { note: { id: 'note_live' } } }] })) })));
    await act(async () => undefined);
    expect(mocks.graph.mock.calls.length).toBeGreaterThan(afterMessage);
    expect(mocks.toolUses).toHaveBeenLastCalledWith({ from: 1000, to: 6000, limit: 500 });
  });
});
