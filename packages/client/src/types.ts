/**
 * Shared interface types for the NEO client.
 */
import type { EventEnvelope } from '@neo/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectOptions {
  onEvent: (envelope: EventEnvelope) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Limit conversation-scoped events to these conversations (default: all). */
  conversations?: string[] | 'all';
  /** Reconnect with exponential backoff (1s → 30s, jittered). Default true. */
  reconnect?: boolean;
}

export interface EventConnection {
  readonly status: ConnectionStatus;
  /** Last seq received; a jump means events were missed while disconnected (refetch state). */
  readonly lastSeq: number;
  subscribe(conversations: string[] | 'all'): void;
  close(): void;
}

export interface NeoClientOptions {
  /** Server origin, e.g. "http://127.0.0.1:7777" (no trailing /api). */
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  /** WebSocket constructor; defaults to globalThis.WebSocket (browsers, Node ≥ 22). */
  WebSocket?: typeof WebSocket;
  /** Per-request timeout for non-streaming calls. Default 30 s. */
  timeoutMs?: number;
}
