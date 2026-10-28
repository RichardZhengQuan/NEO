import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, MemoryEdgeSchema, MemoryNodeSchema, SELF_MEMORY_ID, type MemoryNode, type MemoryNodeDetail } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { useData } from '../../state/data.js';
import { useSession } from '../../state/session.js';
import { MemoryDetail } from './MemoryDetail.js';

let client: NeoClient;

function show(nodeId: string) {
  return render(
    <I18nProvider locale="en" messages={appDictionaries}>
      <ConfirmProvider>
        <MemoryDetail nodeId={nodeId} onClose={vi.fn()} onSelect={vi.fn()} />
      </ConfirmProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    memory: { get: vi.fn(), unlink: vi.fn().mockResolvedValue({ ok: true }) },
  } as unknown as NeoClient;
  useSession.setState((s) => ({
    client,
    serverUrl: 'http://neo.local',
    sessionEpoch: s.sessionEpoch + 1,
    wsStatus: 'open',
    settings: { ...DEFAULT_SETTINGS, timezone: 'UTC' },
    providers: {
      items: [{ id: 'local', kind: 'ollama', label: 'Local AI', enabled: true, defaultModel: 'model', hasApiKey: false, isLocal: true }],
      defaultModel: { provider: 'local', model: 'model' },
    },
  }));
  useData.setState({ memoryVersion: 0, reminders: {}, tasks: {} });
});

afterEach(cleanup);

describe('MemoryDetail — self-edge Unlink button', () => {
  it('shows no Unlink button on an edge whose other end is the self node', async () => {
    const node = MemoryNodeSchema.parse({
      id: 'mem_fact1',
      kind: 'fact',
      label: 'The user likes tea',
      content: 'The user likes tea.',
      importance: 0.5,
      confidence: 0.9,
      stability: 30,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
      status: 'active',
      pinned: false,
      sensitivity: 'normal',
      source: { by: 'extraction' },
    });

    const selfNode = MemoryNodeSchema.parse({
      id: SELF_MEMORY_ID,
      kind: 'entity',
      label: 'You',
      content: 'The user.',
      importance: 1,
      confidence: 1,
      stability: 365,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
      status: 'active',
      pinned: true,
      sensitivity: 'normal',
      source: { by: 'extraction' },
    });

    const selfEdge = MemoryEdgeSchema.parse({
      id: 'edge_self1',
      from: node.id,
      to: SELF_MEMORY_ID,
      type: 'about',
      weight: 0.3,
      createdAt: 1000,
      updatedAt: 1000,
      lastReinforcedAt: 1000,
      coactivations: 0,
    });

    vi.mocked(client.memory.get).mockResolvedValueOnce({
      node,
      retention: 1,
      edges: [selfEdge],
      neighbors: [selfNode],
      history: [],
    });

    show(node.id);

    // Wait for the detail to render
    await screen.findByText('The user likes tea');

    // The self edge must show no Unlink button (its aria-label would be "Remove link to You")
    const unlinkButtons = screen.queryAllByRole('button', { name: /remove link/i });
    expect(unlinkButtons).toHaveLength(0);
  });

  it('shows Unlink button on a non-self edge', async () => {
    const node = MemoryNodeSchema.parse({
      id: 'mem_fact2',
      kind: 'fact',
      label: 'Rainy day',
      content: 'It was raining.',
      importance: 0.4,
      confidence: 0.8,
      stability: 14,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
      status: 'active',
      pinned: false,
      sensitivity: 'normal',
      source: { by: 'extraction' },
    });

    const other = MemoryNodeSchema.parse({
      id: 'mem_other1',
      kind: 'entity',
      label: 'London',
      content: 'A city.',
      importance: 0.5,
      confidence: 0.9,
      stability: 90,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
      status: 'active',
      pinned: false,
      sensitivity: 'normal',
      source: { by: 'extraction' },
    });

    const normalEdge = MemoryEdgeSchema.parse({
      id: 'edge_normal1',
      from: node.id,
      to: other.id,
      type: 'related',
      weight: 0.6,
      createdAt: 1000,
      updatedAt: 1000,
      lastReinforcedAt: 1000,
      coactivations: 0,
    });

    vi.mocked(client.memory.get).mockResolvedValueOnce({
      node,
      retention: 0.9,
      edges: [normalEdge],
      neighbors: [other],
      history: [],
    });

    show(node.id);

    await screen.findByText('Rainy day');

    // Non-self edge should have a Remove link button
    const unlinkButtons = screen.queryAllByRole('button', { name: /remove link/i });
    expect(unlinkButtons).toHaveLength(1);
  });
});

describe('MemoryDetail — dates', () => {
  const midnight = Date.UTC(2026, 9, 28, 0, 25);

  beforeEach(() => {
    vi.stubEnv('TZ', 'Asia/Singapore');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(midnight);
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'America/New_York' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
    return MemoryNodeSchema.parse({
      id: 'mem_dates', kind: 'fact', label: 'Date fixture', content: 'A dated memory.',
      importance: 0.5, confidence: 0.9, stability: 30, accessCount: 0,
      lastAccessedAt: null, createdAt: midnight, updatedAt: midnight + 3_600_000,
      validUntil: midnight + 7_200_000, status: 'active', pinned: false,
      sensitivity: 'normal', source: { by: 'extraction' }, ...overrides,
    });
  }

  async function loadNode(node: MemoryNode, history: MemoryNode[] = []) {
    const response = Promise.resolve<MemoryNodeDetail>({ node, history, retention: 1, edges: [], neighbors: [] });
    vi.mocked(client.memory.get).mockReturnValueOnce(response);
    await act(async () => {
      show(node.id);
      await response;
    });
    expect(client.memory.get).toHaveBeenCalledWith(node.id);
    expect(screen.getByText('Date fixture')).toBeTruthy();
  }

  function fact(label: string) {
    return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
  }

  it.each([
    ['Formed', 'Oct 27, 2026, 8:25 PM'],
    ['Last changed', 'Oct 27, 2026, 9:25 PM'],
    ['Valid until', 'Oct 27, 2026, 10:25 PM'],
  ])('formats %s in the session timezone across the device date boundary', async (label, expected) => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Singapore');
    await loadNode(makeNode());
    expect(fact(label)).toBe(expected);
  });

  it('formats used-to-be history in the session timezone across the device date boundary', async () => {
    const older = makeNode({ id: 'mem_older', content: 'The previous version.', updatedAt: midnight + 10_800_000 });
    await loadNode(makeNode(), [older]);
    expect(screen.getByText('The previous version.')).toBeTruthy();
    expect(screen.getByText('Until Oct 27, 2026, 11:25 PM')).toBeTruthy();
  });

  it('updates the displayed dates when the session timezone changes', async () => {
    await loadNode(makeNode());
    expect(fact('Formed')).toBe('Oct 27, 2026, 8:25 PM');
    await act(async () => {
      useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'UTC' } });
    });
    expect(fact('Formed')).toBe('Oct 28, 2026, 12:25 AM');
    expect(fact('Last changed')).toBe('Oct 28, 2026, 1:25 AM');
    expect(fact('Valid until')).toBe('Oct 28, 2026, 2:25 AM');
  });

  it('shows an epoch last-accessed timestamp as recalled rather than Never', async () => {
    vi.setSystemTime(Date.UTC(1970, 0, 2));
    await loadNode(makeNode({ lastAccessedAt: 0, accessCount: 1 }));
    expect(fact('Last recalled')).toBe('yesterday');
  });

  it('shows an epoch valid-until timestamp in the session timezone', async () => {
    await loadNode(makeNode({ validUntil: 0 }));
    expect(fact('Valid until')).toBe('Dec 31, 1969, 7:00 PM');
  });

  it.each([null, undefined])('omits an unset valid-until timestamp (%s) and shows Never for no recall', async (validUntil) => {
    await loadNode(makeNode({ validUntil, lastAccessedAt: null }));
    expect(screen.queryByText('Valid until', { selector: 'dt' })).toBeNull();
    expect(fact('Last recalled')).toBe('Never');
  });
});
