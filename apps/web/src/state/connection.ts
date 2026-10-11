/**
 * Live connection: the event WebSocket plus refetching after a reconnect or
 * a gap in the event sequence.
 */
import type { NeoClient } from '@neo/client';
import { emptyEntry, mergeFetched, setAllConfirmations, upsertConversations, useConversations } from './conversations.js';
import { refreshLoadedData } from './data.js';
import { EventSequencer, handleServerEvent, type EventContext } from './events.js';
import { currentSessionEpoch, isCurrentSession, setSettings, useSession } from './session.js';

/** Reload a conversation's newest messages into the cache. */
export async function loadConversation(client: NeoClient, id: string): Promise<void> {
  const epoch = currentSessionEpoch();
  const data = await client.conversations.get(id, { limit: 100 });
  if (!isCurrentSession(epoch)) return;
  useConversations.setState((s) => ({
    conversations: { ...s.conversations, [id]: data.conversation },
    entries: { ...s.entries, [id]: mergeFetched(s.entries[id] ?? emptyEntry(), data) },
  }));
}

export async function loadConversationList(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const { items } = await client.conversations.list({ limit: 200 });
  if (!isCurrentSession(epoch)) return;
  upsertConversations(items, { listLoaded: true });
}

export async function loadPendingConfirmations(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const { items } = await client.confirmations.list();
  if (!isCurrentSession(epoch)) return;
  setAllConfirmations(items);
}

/**
 * Bring everything back in sync: the conversation list, the conversation on
 * screen and any with a running turn (others reload when opened), pending
 * confirmations, settings and loaded productivity data.
 */
export async function refreshAll(client: NeoClient, activeConversationId: string | null): Promise<void> {
  const { entries } = useConversations.getState();
  const reload = Object.entries(entries)
    .filter(([id, e]) => e.loaded && (id === activeConversationId || e.turn !== null))
    .map(([id]) => id);
  // Everything else is marked stale so it refetches on open.
  useConversations.setState((s) => ({
    entries: Object.fromEntries(Object.entries(s.entries).map(([id, e]) => [id, reload.includes(id) ? e : { ...e, loaded: false }])),
  }));
  await Promise.allSettled([
    loadConversationList(client),
    ...reload.map((id) => loadConversation(client, id)),
    loadPendingConfirmations(client),
    client.settings.get().then(setSettings),
    refreshLoadedData(client),
  ]);
}

export interface EventStreamOptions {
  client: NeoClient;
  context: () => EventContext;
  activeConversationId: () => string | null;
  /** Called after a reconnect / gap refetch (e.g. to re-plan local notifications). */
  onResync?: () => void;
}

/** Open the WebSocket and route events. Returns a function that closes it. */
export function startEventStream({ client, context, activeConversationId, onResync }: EventStreamOptions): () => void {
  const sequencer = new EventSequencer();
  let openedBefore = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const resync = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refreshAll(client, activeConversationId()).finally(() => onResync?.());
    }, 300);
  };

  const conn = client.connect({
    conversations: 'all',
    onEvent(envelope) {
      if (sequencer.observe(envelope.seq)) resync();
      handleServerEvent(envelope.event, context());
    },
    onStatus(status) {
      useSession.setState({ wsStatus: status });
      if (status === 'open') {
        sequencer.reset(conn.lastSeq);
        // Anything that happened while we were away was missed.
        if (openedBefore) resync();
        openedBefore = true;
      }
    },
  });

  return () => {
    if (timer) clearTimeout(timer);
    conn.close();
    useSession.setState({ wsStatus: 'idle' });
  };
}
