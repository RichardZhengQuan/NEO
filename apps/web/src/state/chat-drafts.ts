/** Unfinished chat input survives route changes within the current connected session. */
import { create } from 'zustand';
import { createRetainedStateStore, type RetainedStateStore } from '@neo/ui';
import { useTimeline } from './timeline.js';

export const useChatDrafts = create<{ store: RetainedStateStore }>(() => ({ store: createRetainedStateStore() }));

// Remember ownership even when paging moves an edited message out of the visible window.
const messageEpisodes = new Map<string, string>();
const privateEpisodes = new Set<string>();

export function resetChatDrafts(): void {
  useChatDrafts.getState().store.clear();
  useChatDrafts.setState({ store: createRetainedStateStore() });
  messageEpisodes.clear();
  privateEpisodes.clear();
}

useTimeline.subscribe((entry, previous) => {
  const store = useChatDrafts.getState().store;
  for (const episode of Object.values(entry.episodes)) {
    if (episode.ephemeral || episode.offRecord) privateEpisodes.add(episode.episodeId);
  }
  for (const message of entry.messages) messageEpisodes.set(message.id, message.episodeId ?? message.conversationId);

  const privateEnded = entry.offRecordLoaded && !entry.offRecord &&
    (previous.offRecord || previous.startingOffRecord || previous.endingOffRecord);
  if (privateEnded) store.clearScope(['composer:off-record']);
  for (const [messageId, episodeId] of messageEpisodes) {
    if (entry.deletedMessageIds[messageId] || entry.deletedEpisodes[episodeId] || (privateEnded && privateEpisodes.has(episodeId))) {
      store.clearScope(['messages', messageId]);
      messageEpisodes.delete(messageId);
    }
  }
  // Deleted IDs also cover retained UI whose message is no longer in a fetched page.
  for (const id of Object.keys(entry.deletedMessageIds)) {
    if (!previous.deletedMessageIds[id]) store.clearScope(['messages', id]);
  }
  if (privateEnded) privateEpisodes.clear();
});
