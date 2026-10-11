/**
 * Connecting to a server and leaving it.
 */
import { bootstrapConnection, browserBootstrapDeps, clearCredentials, saveCredentials, type ConnectionSource } from '../connection.js';
import { httpStatus } from '../lib/errors.js';
import { useConversations } from '../state/conversations.js';
import { useData } from '../state/data.js';
import { loadProviders, setSettings, showConnect, startSession, useSession } from '../state/session.js';

/** Start a session with known-good credentials and load the essentials. */
export async function connectWith(serverUrl: string, token: string, source: ConnectionSource): Promise<void> {
  const client = startSession(serverUrl, token, source);
  try {
    const [settings, health] = await Promise.all([client.settings.get(), client.health().catch(() => null)]);
    setSettings(settings);
    useSession.setState({ health, phase: 'ready' });
    if (source !== 'desktop') saveCredentials({ serverUrl, token });
    void loadProviders().catch(() => undefined);
  } catch (err) {
    const status = httpStatus(err);
    if (status === 401 || status === 403) showConnect({ reason: 'unauthorized', serverUrl });
    else useSession.setState({ phase: 'offline', serverUrl, connectHint: { reason: 'manual', serverUrl, token } });
  }
}

let booting: Promise<void> | null = null;

/** Run the bootstrap once per page load (desktop bridge → pairing hash → saved → same origin → Connect). */
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
  useConversations.setState({ conversations: {}, entries: {}, listLoaded: false, archivedLoaded: false });
  useData.setState({ reminders: {}, remindersLoaded: false, tasks: {}, taskLists: [], tasksLoaded: false, notes: {}, notesLoaded: false, pendingMemories: 0, notifications: [], unreadNotifications: 0 });
  showConnect({ reason: 'none', serverUrl });
}
