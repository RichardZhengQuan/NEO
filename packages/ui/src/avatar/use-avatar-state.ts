/**
 * Derive the avatar's state from what the chat is doing.
 */
import { useEffect, useRef, useState } from 'react';
import type { AvatarState } from './config.js';

export interface AvatarActivity {
  /** A turn is running. */
  busy?: boolean;
  /** The assistant text streamed so far in this turn. */
  text?: string;
  /** The user has a draft in the composer. */
  typing?: boolean;
}

/** How long after the last streamed text the avatar keeps talking. */
const SPEAKING_HOLD_MS = 700;

/**
 * 'speaking' while streamed text keeps arriving, 'thinking' while a turn runs
 * without new text (waiting for the model, running tools), 'listening' while
 * the user types, otherwise 'idle'.
 */
export function useAvatarState({ busy = false, text = '', typing = false }: AvatarActivity): AvatarState {
  const [speaking, setSpeaking] = useState(false);
  const last = useRef(text);

  useEffect(() => {
    if (!busy) {
      last.current = text;
      setSpeaking(false);
      return;
    }
    if (text === last.current) return;
    last.current = text;
    if (!text) return;
    setSpeaking(true);
    const timer = setTimeout(() => setSpeaking(false), SPEAKING_HOLD_MS);
    return () => clearTimeout(timer);
  }, [text, busy]);

  if (busy) return speaking ? 'speaking' : 'thinking';
  return typing ? 'listening' : 'idle';
}
