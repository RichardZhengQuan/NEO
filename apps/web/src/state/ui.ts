/**
 * Small cross-screen UI state: the mobile drawer, the chat draft (for a chat
 * that doesn't exist yet) and a handle to focus the composer from shortcuts.
 */
import { create } from 'zustand';
import type { ModelRef } from '@neo/protocol';
import type { ComposerHandle } from '@neo/ui';

export interface DraftChat {
  incognito: boolean;
  model: ModelRef | null;
}

export interface UiState {
  drawerOpen: boolean;
  draft: DraftChat;
}

export const useUi = create<UiState>(() => ({
  drawerOpen: false,
  draft: { incognito: false, model: null },
}));

export function setDrawer(open: boolean): void {
  useUi.setState({ drawerOpen: open });
}

export function resetDraft(incognito = false): void {
  useUi.setState({ draft: { incognito, model: null } });
}

let composer: ComposerHandle | null = null;
let pendingFocus = false;

/** ChatScreen registers its composer; shortcuts call focusComposer(). */
export function registerComposer(handle: ComposerHandle | null): void {
  composer = handle;
  if (handle && pendingFocus) {
    pendingFocus = false;
    handle.focus();
  }
}

export function focusComposer(): void {
  if (composer) composer.focus();
  else pendingFocus = true;
}

export function fillComposer(text: string): void {
  composer?.setText(text);
}
