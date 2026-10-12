import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import type { ConsolidationReport } from '@neo/protocol';
import type { NeoServer } from './index.js';
import { startServer } from './server.js';
import { scriptedProviderOptions } from './testing/mock-options.js';

let server: NeoServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  vi.useRealTimers();
});

const config = NeoConfigSchema.parse({
  server: { port: 0, authToken: 'server-lifecycle-owner' },
  settings: { memory: { consolidation: { enabled: true, intervalHours: 1 } } },
});

const report: ConsolidationReport = {
  id: 'journal-test', startedAt: 0, finishedAt: 0, archived: 0, edgesDecayed: 0,
  edgesPruned: 0, episodesConsolidated: 0, factsCreated: 0, linksCreated: 0, entitiesMerged: 0, notes: [],
};

describe('server background lifecycle', () => {
  it('checks consolidation every 15 minutes, respects enabled/elapsed time, and clears timer through services.close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 10_000_000;
    server = await startServer(config, { inMemory: true, logger: silentLogger, clock: () => now });
    const originalStats = await server.services.memory.stats();
    let lastConsolidationAt = now;
    vi.spyOn(server.services.memory, 'stats').mockImplementation(async () => ({ ...originalStats, lastConsolidationAt }));
    const consolidate = vi.spyOn(server.services.memory, 'consolidate').mockImplementation(async () => {
      lastConsolidationAt = now;
      return report;
    });
    for (let i = 0; i < 3; i++) {
      now += 15 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    }
    expect(consolidate).not.toHaveBeenCalled();
    now += 15 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    server.services.settings.update({ memory: { consolidation: { enabled: false } } });
    now += 2 * 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    await server.services.close();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs only one consolidation at a time and waits for it before closing storage', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startServer(config, { inMemory: true, logger: silentLogger, clock: () => 10_000_000 });
    const stats = await server.services.memory.stats();
    vi.spyOn(server.services.memory, 'stats').mockResolvedValue({ ...stats, lastConsolidationAt: 0 });
    let finish!: (value: ConsolidationReport) => void;
    const consolidate = vi.spyOn(server.services.memory, 'consolidate').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(3 * 15 * 60 * 1000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    const close = vi.fn();
    const closing = server.services.close().then(close);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    finish(report);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancels an active JSON turn and waits for a delayed provider before closing the database', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    server = await startServer(config, {
      ...scriptedProviderOptions(), inMemory: true, logger: silentLogger,
      mockScript: async () => { entered(); await pending; return { text: 'delayed' }; },
    });
    const response = await fetch(`${server.url}/api/timeline/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer server-lifecycle-owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Wait for provider' }),
    });
    expect(response.status).toBe(202);
    await response.json();
    await started;
    const close = vi.fn();
    const stopping = server.stop().then(close);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(close).toHaveBeenCalledTimes(1);
    expect(server.services.runtime.activeTurns()).toHaveLength(0);
  });
});
