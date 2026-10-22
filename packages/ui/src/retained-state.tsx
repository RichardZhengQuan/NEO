/** Session-owned, in-memory state for editable chat controls. Nothing is persisted to disk. */
import {
  createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore,
  type Dispatch, type ReactNode, type SetStateAction,
} from 'react';

export interface RetainedStateSnapshot<T> {
  readonly value: T;
  /** A cleared entry gets a new token, invalidating async setters from its previous life. */
  readonly token: object;
}

export interface RetainedStateStore {
  getSnapshot<T>(path: readonly string[], initial: T | (() => T)): RetainedStateSnapshot<T>;
  subscribe(path: readonly string[], listener: () => void): () => void;
  set<T>(path: readonly string[], token: object, update: SetStateAction<T>): void;
  clear(): void;
  clearScope(prefix: readonly string[]): void;
}

type Entry = { path: readonly string[]; snapshot: RetainedStateSnapshot<unknown> };

export function createRetainedStateStore(): RetainedStateStore {
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const idOf = (path: readonly string[]) => JSON.stringify(path);
  const notify = (id: string) => { for (const listener of listeners.get(id) ?? []) listener(); };
  const clearScope = (prefix: readonly string[]) => {
    const removed: string[] = [];
    for (const [id, entry] of entries) {
      if (prefix.every((segment, index) => entry.path[index] === segment)) {
        entries.delete(id);
        removed.push(id);
      }
    }
    // Remove every old token before subscribers can reinitialize any entry.
    for (const id of removed) notify(id);
  };
  return {
    getSnapshot<T>(path: readonly string[], initial: T | (() => T)): RetainedStateSnapshot<T> {
      const id = idOf(path);
      let entry = entries.get(id);
      if (!entry) {
        const value = typeof initial === 'function' ? (initial as () => T)() : initial;
        entry = { path: [...path], snapshot: { value, token: {} } };
        entries.set(id, entry);
      }
      return entry.snapshot as RetainedStateSnapshot<T>;
    },
    subscribe(path, listener) {
      const id = idOf(path);
      let subscribers = listeners.get(id);
      if (!subscribers) { subscribers = new Set(); listeners.set(id, subscribers); }
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(id);
      };
    },
    set<T>(path: readonly string[], token: object, update: SetStateAction<T>) {
      const id = idOf(path);
      const entry = entries.get(id);
      if (!entry || entry.snapshot.token !== token) return;
      const previous = entry.snapshot.value as T;
      const value = typeof update === 'function' ? (update as (previous: T) => T)(previous) : update;
      if (Object.is(previous, value)) return;
      entry.snapshot = { value, token };
      notify(id);
    },
    clear: () => clearScope([]),
    clearScope,
  };
}

type RetainedStateContextValue = { store: RetainedStateStore; scope: readonly string[] };
const RetainedStateContext = createContext<RetainedStateContextValue | null>(null);

export function RetainedStateProvider({ store, children }: { store: RetainedStateStore; children: ReactNode }) {
  const value = useMemo(() => ({ store, scope: [] }), [store]);
  return <RetainedStateContext.Provider value={value}>{children}</RetainedStateContext.Provider>;
}

export function RetainedStateScope({ scope, children }: { scope: string; children: ReactNode }) {
  const parent = useContext(RetainedStateContext);
  const value = useMemo(() => parent ? { store: parent.store, scope: [...parent.scope, scope] } : null, [parent, scope]);
  // A new namespace is a different control instance; its defaults must come from
  // the new props rather than a previous namespace's local initializer.
  return <RetainedStateContext.Provider key={scope} value={value}>{children}</RetainedStateContext.Provider>;
}

const noSubscription = () => () => {};

/** Behaves as ordinary React state outside a provider. Keys are local to the current scope. */
export function useRetainedState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(RetainedStateContext);
  const [local, setLocal] = useState(initial);
  const defaults = useRef(local);
  const path = useMemo(() => [...(context?.scope ?? []), key], [context?.scope, key]);
  const subscribe = useCallback((listener: () => void) => context ? context.store.subscribe(path, listener) : noSubscription(), [context, path]);
  const getSnapshot = useCallback(() => context ? context.store.getSnapshot(path, defaults.current) : null, [context, path]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const token = snapshot?.token;
  const set: Dispatch<SetStateAction<T>> = useCallback((update) => {
    if (context && token) context.store.set(path, token, update);
    else setLocal(update);
  }, [context, path, token]);
  return [snapshot ? snapshot.value : local, set];
}
