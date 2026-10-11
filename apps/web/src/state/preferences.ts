/**
 * Device-local preferences: things that belong to this browser/device rather
 * than to the user's server settings (and are read before any connection).
 */
import { create } from 'zustand';
import { STORAGE_KEYS, readString, writeString } from '../lib/storage.js';

export interface PreferencesState {
  /** Load remote (other-site) images in replies without asking. Off by default for privacy. */
  remoteImages: boolean;
}

export const usePreferences = create<PreferencesState>(() => ({
  remoteImages: readString(STORAGE_KEYS.remoteImages) === 'on',
}));

export function setRemoteImages(on: boolean): void {
  writeString(STORAGE_KEYS.remoteImages, on ? 'on' : null);
  usePreferences.setState({ remoteImages: on });
}

/** Origin of an http(s) server URL, or null. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}
