import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, MemoryEdgeSchema, MemoryNodeSchema, SELF_MEMORY_ID } from '@neo/protocol';
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
