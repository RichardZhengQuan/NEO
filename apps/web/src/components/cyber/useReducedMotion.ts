import { useMediaQuery } from '../../hooks/useMediaQuery.js';

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
