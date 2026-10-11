import type { PhoneAccessStatus, TunnelRoute } from '@neo/protocol';
import { toBase64Url } from '@neo/tunnel';
import type { TunnelHandler } from '@neo/tunnel';
import type { NeoServices } from '../index.js';
import { lanAddresses } from './addresses.js';
import { loadOrCreateTunnelIdentity } from './identity.js';
import { startLanListener } from './lan.js';
import type { LanListener } from './lan.js';

export interface PhoneAccessManager {
  status(): PhoneAccessStatus;
  /** The route phones should use, or null while nothing is reachable. */
  route(): TunnelRoute | null;
  /** Follow settings.phoneAccess from now on. Idempotent. */
  start(): Promise<void>;
  /** Wait until the latest settings have been applied. */
  ready(): Promise<void>;
  stop(): Promise<void>;
}

export function createPhoneAccess({ services, handler }: { services: NeoServices; handler: TunnelHandler }): PhoneAccessManager {
  const { config, settings, logger } = services;
  const identity = loadOrCreateTunnelIdentity(config.dataDir, { inMemory: !services.db || services.db.path === ':memory:', logger });
  const publicKey = toBase64Url(identity.dh.publicKey);
  let listener: LanListener | null = null;
  let error: string | null = null;
  let started = false;
  let unsubscribe: (() => void) | null = null;
  let revision = 0;
  let applied = -1;
  let pending = Promise.resolve();

  function schedule(): void {
    revision++;
    pending = pending.then(async () => {
      while (applied !== revision) {
        const current = revision;
        const enabled = started && settings.get().phoneAccess.enabled && config.tunnel.lan;
        if (!enabled) {
          const closing = listener;
          listener = null;
          error = null;
          await closing?.close();
        } else if (!listener) {
          error = null;
          try {
            listener = await startLanListener({
              host: config.tunnel.host, port: config.tunnel.port, identity, handler, logger,
              clock: services.clock, maxRequestBodyBytes: config.server.maxBodyBytes,
            });
          } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
            logger.warn('Phone access could not listen on this network.', { error });
          }
        }
        applied = current;
      }
    }).catch((failure: unknown) => {
      // Keep the queue alive: one failed apply must not block later settings changes.
      error = failure instanceof Error ? failure.message : String(failure);
      logger.warn('Applying phone access settings failed.', { error });
    });
  }

  function status(): PhoneAccessStatus {
    const phoneAccess = settings.get().phoneAccess;
    const relayUrl = phoneAccess.relayUrl ?? config.tunnel.relayUrl;
    return {
      enabled: phoneAccess.enabled, serverId: identity.serverId, publicKey,
      lan: { listening: listener !== null, port: listener?.port ?? null, addresses: listener ? lanAddresses(listener.port, config) : [], error },
      relay: { url: relayUrl || null, status: 'off', error: null },
      defaultRelayUrl: config.tunnel.relayUrl,
    };
  }

  async function ready(): Promise<void> {
    let current: Promise<void>;
    do { current = pending; await current; } while (current !== pending);
  }

  return {
    status,
    route() {
      const state = status();
      if (!state.enabled || !state.lan.addresses.length) return null;
      return { serverId: state.serverId, publicKey: state.publicKey, lan: state.lan.addresses, relay: null };
    },
    async start() {
      if (!started) {
        started = true;
        unsubscribe = settings.onChange(() => schedule());
        schedule();
      }
      await ready();
    },
    ready,
    async stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      schedule();
      await ready();
    },
  };
}
