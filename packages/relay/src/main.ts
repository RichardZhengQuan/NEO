#!/usr/bin/env node
import { createConsoleLogger } from '@neo/protocol';
import type { LogLevel } from '@neo/protocol';
import { startRelay } from './relay.js';
import type { RelayLimits } from './relay.js';

function integer(name: string, value: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`${name} is out of range`);
  return parsed;
}

const overrides: Record<keyof RelayLimits, string> = {
  perIpPhoneConnections: 'RELAY_PER_IP_PHONE_CONNECTIONS',
  perIpPhoneConnectionsPerMinute: 'RELAY_PER_IP_PHONE_CONNECTIONS_PER_MINUTE',
  perIpServerRegistrationsPerMinute: 'RELAY_PER_IP_SERVER_REGISTRATIONS_PER_MINUTE',
  perServerPhoneConnections: 'RELAY_PER_SERVER_PHONE_CONNECTIONS',
  maxServers: 'RELAY_MAX_SERVERS',
  maxPhones: 'RELAY_MAX_PHONES',
  bytesPerSecond: 'RELAY_BYTES_PER_SECOND',
  burstBytes: 'RELAY_BURST_BYTES',
  maxBufferedBytes: 'RELAY_MAX_BUFFERED_BYTES',
  registrationTimeoutMs: 'RELAY_REGISTRATION_TIMEOUT_MS',
  phoneIdleTimeoutMs: 'RELAY_PHONE_IDLE_TIMEOUT_MS',
  heartbeatIntervalMs: 'RELAY_HEARTBEAT_INTERVAL_MS',
};

async function main(): Promise<void> {
  const level = process.env.RELAY_LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) throw new Error('Invalid RELAY_LOG_LEVEL');
  const trustProxy = process.env.RELAY_TRUST_PROXY ?? 'false';
  if (!['true', 'false', '1', '0'].includes(trustProxy)) throw new Error('RELAY_TRUST_PROXY must be true or false');
  const port = integer('RELAY_PORT', process.env.RELAY_PORT ?? '8787', true);
  if (port > 65535) throw new Error('RELAY_PORT is out of range');
  const limits: Partial<RelayLimits> = {};
  for (const [key, name] of Object.entries(overrides)) {
    const value = process.env[name];
    if (value !== undefined) limits[key as keyof RelayLimits] = integer(name, value);
  }
  const logger = createConsoleLogger(level as LogLevel);
  const relay = await startRelay({ host: process.env.RELAY_HOST ?? '0.0.0.0', port, trustProxy: trustProxy === 'true' || trustProxy === '1', logger, limits });
  logger.info('NEO relay listening', { url: relay.url });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void relay.close().then(() => logger.info('NEO relay stopped')).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Unable to start NEO relay');
  process.exitCode = 1;
});
