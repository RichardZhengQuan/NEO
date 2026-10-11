import { useCallback, useSyncExternalStore } from 'react';

/** Live `matchMedia` result (false where matchMedia is unavailable). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    [query],
  );
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, get, () => false);
}

/** ≥ 768 px: persistent sidebar instead of drawer + bottom tabs. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)');
}

/** Touch keyboards: Enter inserts a newline instead of sending. */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}
