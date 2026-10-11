/** Start the HTTP/WebSocket server and own its background-work lifecycle. */
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { NeoError } from '@neo/protocol';
import type { NeoConfig } from '@neo/protocol';
import { createApp } from './app.js';
import { createServices } from './services.js';
import { closeWebSockets } from './ws.js';
import type { CreateServicesOptions, NeoServer } from './index.js';

const CONSOLIDATION_INTERVAL_MS = 15 * 60 * 1000;

export async function startServer(config: NeoConfig, options: CreateServicesOptions = {}): Promise<NeoServer> {
  const services = await createServices(config, options);
  let httpServer: Server | undefined;
  let consolidationTimer: ReturnType<typeof setInterval> | null = null;
  let consolidation: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  const closeServices = services.close.bind(services);
  services.close = () => {
    if (!closePromise) {
      if (consolidationTimer) clearInterval(consolidationTimer);
      consolidationTimer = null;
      closePromise = (async () => {
        await consolidation;
        await closeServices();
      })();
    }
    return closePromise;
  };

  try {
    const { app, injectWebSocket } = createApp(services);
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      httpServer = serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, resolve) as Server;
      httpServer.once('error', reject);
      injectWebSocket(httpServer);
    });
    const server = httpServer!;
    const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host === '::' ? '::1' : config.server.host;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;

    services.scheduler.start();
    consolidationTimer = setInterval(() => {
      if (consolidation || closePromise) return;
      consolidation = (async () => {
        const policy = services.settings.get().memory.consolidation;
        if (!policy.enabled) return;
        const { lastConsolidationAt } = await services.memory.stats();
        if (services.clock() - (lastConsolidationAt ?? 0) >= policy.intervalHours * 60 * 60 * 1000) {
          await services.memory.consolidate();
        }
      })().catch((error: unknown) => {
        services.logger.warn('Memory consolidation failed', { error: String(error) });
      }).finally(() => { consolidation = null; });
    }, CONSOLIDATION_INTERVAL_MS);
    consolidationTimer.unref();
    services.logger.info(`NEO is ready at ${url}`, { mode: config.mode });

    let stopPromise: Promise<void> | null = null;
    return {
      url,
      port: address.port,
      ownerToken: services.ownerToken,
      services,
      stop() {
        if (!stopPromise) stopPromise = (async () => {
          if (consolidationTimer) clearInterval(consolidationTimer);
          consolidationTimer = null;
          services.scheduler.stop();
          for (const turn of services.runtime.activeTurns()) services.runtime.cancel(turn.turnId);
          await closeWebSockets(services.events);
          await new Promise<void>((resolve, reject) => {
            // Allow active streams to complete, then release unresponsive clients.
            const timeout = setTimeout(() => server.closeAllConnections(), 1000);
            timeout.unref();
            server.close((error) => {
              clearTimeout(timeout);
              if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(NeoError.from(error));
              else resolve();
            });
            server.closeIdleConnections();
          });
          await services.close();
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    if (consolidationTimer) clearInterval(consolidationTimer);
    await closeWebSockets(services.events);
    httpServer?.close();
    await services.close();
    throw NeoError.from(error, 'config_error');
  }
}
