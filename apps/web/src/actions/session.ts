/**
 * Connecting to a server and leaving it.
 */
import { bootstrapConnection, browserBootstrapDeps, clearCredentials, createServerClient, refreshTunnelRoute, saveCredentials, type ConnectionSource, type Credentials } from '../connection.js';
import type { NeoClient } from '@neo/client';
import { httpStatus } from '../lib/errors.js';
import { currentSessionEpoch, isCurrentSession, loadProviders, setSettings, showConnect, startSession, useSession } from '../state/session.js';

/** Start a session with known-good credentials and load the essentials. */
export async function connectWith(credentials: Credentials, source: ConnectionSource, options: { preserveSessionOnFailure?: boolean } = {}): Promise<void> {
  const { serverUrl } = credentials;
  if (options.preserveSessionOnFailure) {
    const epoch = currentSessionEpoch();
    const candidate = createServerClient(credentials, { timeoutMs: 8000 });
    const [settings, health] = await Promise.all([candidate.settings.get(), candidate.health().catch(() => null)]);
    if (!isCurrentSession(epoch)) throw new Error('The session changed while pairing.');
    const client = startSession(credentials, source);
    const nextEpoch = currentSessionEpoch();
    setSettings(settings);
    useSession.setState({ health, phase: 'ready' });
    if (source !== 'desktop') saveCredentials(credentials);
    refreshRoute(credentials, client, nextEpoch);
    void loadProviders().catch(() => undefined);
    return;
  }
  const client = startSession(credentials, source);
  const epoch = currentSessionEpoch();
  try {
    const [settings, health] = await Promise.all([client.settings.get(), client.health().catch(() => null)]);
    if (!isCurrentSession(epoch, client)) return;
    setSettings(settings);
    useSession.setState({ health, phase: 'ready' });
    if (source !== 'desktop') saveCredentials(credentials);
    refreshRoute(credentials, client, epoch);
    void loadProviders().catch(() => undefined);
  } catch (err) {
    if (!isCurrentSession(epoch, client)) return;
    const status = httpStatus(err);
    if (status === 401 || status === 403) showConnect({ reason: 'unauthorized', serverUrl, tunnel: credentials.tunnel });
    else useSession.setState({ phase: 'offline', serverUrl, connectHint: { reason: 'manual', ...credentials } });
  }
}

function refreshRoute(credentials: Credentials, client: NeoClient, epoch: number): void {
  if (!credentials.tunnel) return;
  void refreshTunnelRoute(credentials, client, () => isCurrentSession(epoch, client)).then(next => {
    if (isCurrentSession(epoch, client)) useSession.setState({ credentials: next });
  });
}

let booting: Promise<void> | null = null;

/** Run bootstrap once per page load (desktop → pairing hash → launch link → saved → same origin → Connect). */
export function bootstrap(): Promise<void> {
  booting ??= runBootstrap();
  return booting;
}

async function runBootstrap(): Promise<void> {
  const result = await bootstrapConnection(browserBootstrapDeps());
  if (result.kind === 'ready') await connectWith({ serverUrl: result.serverUrl, token: result.token, ...(result.tunnel ? { tunnel: result.tunnel } : {}) }, result.source);
  else if (result.kind === 'offline') useSession.setState({ phase: 'offline', serverUrl: result.serverUrl, credentials: { serverUrl: result.serverUrl, token: result.token, tunnel: result.tunnel }, connectHint: { reason: 'manual', serverUrl: result.serverUrl, token: result.token, tunnel: result.tunnel } });
  else showConnect({ reason: result.reason, serverUrl: result.serverUrl, token: result.token, tunnel: result.tunnel });
}

/** Forget this server on this device and go back to the Connect screen. */
export function disconnect(): void {
  const serverUrl = useSession.getState().serverUrl ?? undefined;
  clearCredentials();
  showConnect({ reason: 'none', serverUrl });
}
