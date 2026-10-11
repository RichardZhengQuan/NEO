/**
 * Connecting to a server and leaving it.
 */
import { bootstrapConnection, browserBootstrapDeps, clearCredentials, saveCredentials, type ConnectionSource } from '../connection.js';
import { NeoClient } from '@neo/client';
import { httpStatus } from '../lib/errors.js';
import { currentSessionEpoch, isCurrentSession, loadProviders, setSettings, showConnect, startSession, useSession } from '../state/session.js';

/** Start a session with known-good credentials and load the essentials. */
export async function connectWith(serverUrl: string, token: string, source: ConnectionSource, options: { preserveSessionOnFailure?: boolean } = {}): Promise<void> {
  if (options.preserveSessionOnFailure) {
    const epoch = currentSessionEpoch();
    const candidate = new NeoClient({ baseUrl: serverUrl, token, timeoutMs: 8000 });
    const [settings, health] = await Promise.all([candidate.settings.get(), candidate.health().catch(() => null)]);
    if (!isCurrentSession(epoch)) throw new Error('The session changed while pairing.');
    startSession(serverUrl, token, source);
    setSettings(settings);
    useSession.setState({ health, phase: 'ready' });
    if (source !== 'desktop') saveCredentials({ serverUrl, token });
    void loadProviders().catch(() => undefined);
    return;
  }
  const client = startSession(serverUrl, token, source);
  const epoch = currentSessionEpoch();
  try {
    const [settings, health] = await Promise.all([client.settings.get(), client.health().catch(() => null)]);
    if (!isCurrentSession(epoch, client)) return;
    setSettings(settings);
    useSession.setState({ health, phase: 'ready' });
    if (source !== 'desktop') saveCredentials({ serverUrl, token });
    void loadProviders().catch(() => undefined);
  } catch (err) {
    if (!isCurrentSession(epoch, client)) return;
    const status = httpStatus(err);
    if (status === 401 || status === 403) showConnect({ reason: 'unauthorized', serverUrl });
    else useSession.setState({ phase: 'offline', serverUrl, connectHint: { reason: 'manual', serverUrl, token } });
  }
}

let booting: Promise<void> | null = null;

/** Run bootstrap once per page load (desktop → pairing hash → launch link → saved → same origin → Connect). */
export function bootstrap(): Promise<void> {
  booting ??= runBootstrap();
  return booting;
}

async function runBootstrap(): Promise<void> {
  const result = await bootstrapConnection(browserBootstrapDeps());
  if (result.kind === 'ready') await connectWith(result.serverUrl, result.token, result.source);
  else if (result.kind === 'offline') useSession.setState({ phase: 'offline', serverUrl: result.serverUrl, connectHint: { reason: 'manual', serverUrl: result.serverUrl, token: result.token } });
  else showConnect({ reason: result.reason, serverUrl: result.serverUrl, token: result.token });
}

/** Forget this server on this device and go back to the Connect screen. */
export function disconnect(): void {
  const serverUrl = useSession.getState().serverUrl ?? undefined;
  clearCredentials();
  showConnect({ reason: 'none', serverUrl });
}
