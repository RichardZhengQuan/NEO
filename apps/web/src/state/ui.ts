/**
 * Small cross-screen UI state: the mobile drawer, timeline search and a
 * handle to focus the composer from shortcuts.
 */
import { create } from 'zustand';
import type { ComposerHandle } from '@neo/ui';

export interface UiState {
  drawerOpen: boolean;
  timelineSearchRequested: number;
}

export const useUi = create<UiState>(() => ({
  drawerOpen: false,
  timelineSearchRequested: 0,
}));

export function setDrawer(open: boolean): void {
  useUi.setState({ drawerOpen: open });
}

export function requestTimelineSearch(): void {
  useUi.setState((s) => ({ timelineSearchRequested: s.timelineSearchRequested + 1 }));
}

export function consumeTimelineSearch(): void {
  useUi.setState({ timelineSearchRequested: 0 });
}

let composer: ComposerHandle | null = null;
let pendingFocus = false;

/** TimelineScreen registers its composer; shortcuts call focusComposer(). */
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
