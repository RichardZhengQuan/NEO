/**
 * Shared type definitions for @neo/tools (no circular deps).
 */
import type { Clock, MemoryService, ProductivityStores } from '@neo/protocol';

export interface WebSearchConfig {
  provider: 'none' | 'searxng' | 'brave' | 'tavily';
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

export interface BuiltinToolDeps {
  stores: ProductivityStores;
  memory: MemoryService;
  webSearch?: WebSearchConfig;
  /**
   * HTTP client for web_search, and for web_fetch when given (tests, custom runtimes). Without it,
   * web_fetch uses its own node:http(s) transport that connects only to the DNS answers it vetted
   * (DNS-rebinding safe); an injected fetch gets the same per-hop checks but resolves names itself.
   */
  fetch?: typeof fetch;
  /** Allow web_fetch to reach private/loopback addresses (local mode only). Default false. */
  allowPrivateNetwork?: boolean;
  /** Unused by the tools themselves (they read time from ToolContext.now); kept for API compatibility. */
  clock?: Clock;
}
