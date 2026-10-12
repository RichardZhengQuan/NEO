/**
 * Live connection: the event WebSocket plus refetching after a reconnect or
 * a gap in the event sequence.
 */
import type { NeoClient } from '@neo/client';
import { httpStatus } from '../lib/errors.js';
import { applyOffRecordState, emptyEntry, isTimelineStreamEvent, mergeFetched, setAllConfirmations, setTimeline, useTimeline } from './timeline.js';
import { refreshLoadedData } from './data.js';
import { EventSequencer, handleServerEvent, type EventContext } from './events.js';
import { currentSessionEpoch, isCurrentSession, onSessionEnd, setSettings, useSession } from './session.js';

const timelineLoads = new WeakMap<NeoClient, number>();
const pendingTimelineLoads = new WeakMap<NeoClient, Promise<void>>();
const privacyLoads = new WeakMap<NeoClient, Promise<void>>();

export function loadOffRecord(client: NeoClient): Promise<void> {
  const existing = privacyLoads.get(client);
  if (existing) return existing;
  const epoch = currentSessionEpoch();
  const revision = useTimeline.getState().privacyRevision;
  const loading = client.timeline.offRecord().then((state) => {
    if (isCurrentSession(epoch, client) && useTimeline.getState().privacyRevision === revision) applyOffRecordState(state);
  }).finally(() => {
    if (privacyLoads.get(client) === loading) privacyLoads.delete(client);
  });
  privacyLoads.set(client, loading);
  return loading;
}


/** Reload the newest page or jump to a message/date; newest request wins. */
export function loadTimeline(client: NeoClient, around?: string): Promise<void> {
  const loading = fetchTimeline(client, around);
  pendingTimelineLoads.set(client, loading);
  const clear = () => { if (pendingTimelineLoads.get(client) === loading) pendingTimelineLoads.delete(client); };
  void loading.then(clear, clear);
  return loading;
}

async function fetchTimeline(client: NeoClient, around?: string): Promise<void> {
  const epoch = currentSessionEpoch();
  const generation = (timelineLoads.get(client) ?? 0) + 1;
  timelineLoads.set(client, generation);
  const snapshotIds = new Set(useTimeline.getState().messages.map((message) => message.id));
  const current = () => isCurrentSession(epoch, client) && timelineLoads.get(client) === generation;
  let page;
  try {
    page = await client.timeline.list({ limit: 100, ...(around ? { around } : {}) });
  } catch (error) {
    if (!current()) return;
    if (httpStatus(error) === 404) {
      setTimeline((entry) => ({ ...entry, ...emptyEntry(), offRecord: entry.offRecord,
        privacyScope: entry.privacyScope, offRecordLoaded: entry.offRecordLoaded, startingOffRecord: entry.startingOffRecord,
        endingOffRecord: entry.endingOffRecord, privacyRevision: entry.privacyRevision,
        deletedEpisodes: entry.deletedEpisodes, deletedMessageIds: entry.deletedMessageIds,
        loaded: true, viewAround: around }));
    }
    throw error;
  }
  if (!current()) return;
  setTimeline((entry) => {
    const target = { ...entry, viewAround: around, ...(around && entry.viewAround !== around ? { messages: [] } : {}) };
    return { ...mergeFetched(target, page, snapshotIds), viewAround: around };
  });
}

export async function loadPendingConfirmations(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const { items } = await client.confirmations.list();
  if (isCurrentSession(epoch, client)) setAllConfirmations(items);
}

/** Resync the current timeline window, approvals, settings and loaded data. */
export async function refreshAll(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  if (!isCurrentSession(epoch, client)) return;
  await Promise.allSettled([
    (async () => {
      // A reconnect must not replace a jump whose page is still loading.
      while (pendingTimelineLoads.has(client)) await pendingTimelineLoads.get(client)?.catch(() => undefined);
      if (isCurrentSession(epoch, client)) await loadTimeline(client, useTimeline.getState().viewAround);
    })(),
    loadPendingConfirmations(client),
    loadOffRecord(client),
    client.settings.get().then((settings) => { if (isCurrentSession(epoch, client)) setSettings(settings); }),
    refreshLoadedData(client),
  ]);
}

export interface EventStreamOptions {
  client: NeoClient;
  context: () => EventContext;
  timelineActive: () => boolean;
  /** Called after a reconnect / gap refetch (e.g. to re-plan local notifications). */
  onResync?: () => void;
}

/** Open the WebSocket and route events. Returns a function that closes it. */
export function startEventStream({ client, context, onResync }: EventStreamOptions): () => void {
  const epoch = currentSessionEpoch();
  const sequencer = new EventSequencer();
  let closed = false;
  let openedBefore = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const resync = () => {
    if (closed || !isCurrentSession(epoch, client)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (closed || !isCurrentSession(epoch, client)) return;
      void refreshAll(client).finally(() => { if (!closed && isCurrentSession(epoch, client)) onResync?.(); });
    }, 300);
  };

  const conn = client.connect({
    conversations: 'all',
    onEvent(envelope) {
      if (closed || !isCurrentSession(epoch, client)) return;
      if (sequencer.observe(envelope.seq)) resync();
      if (!isTimelineStreamEvent(client, envelope.event)) handleServerEvent(envelope.event, context());
      if (envelope.event.type === 'timeline.off_record' && !envelope.event.active) resync();
    },
    onStatus(status) {
      if (closed || !isCurrentSession(epoch, client)) return;
      useSession.setState({ wsStatus: status });
      if (status === 'open') {
        sequencer.reset(conn.lastSeq);
        // Anything that happened while we were away was missed.
        if (openedBefore) resync();
        else void loadOffRecord(client).catch(() => undefined);
        openedBefore = true;
      }
    },
  });

  const stop = () => {
    if (closed) return;
    closed = true;
    unregister();
    if (timer) clearTimeout(timer);
    conn.close();
    if (isCurrentSession(epoch, client)) useSession.setState({ wsStatus: 'idle' });
  };
  const unregister = onSessionEnd(stop);
  return stop;
}
