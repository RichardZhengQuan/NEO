import { useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

const MOVE_MS = 560;
const CROSSFADE_MS = 150;
const EXIT_MS = 620;
type Direction = 'forward' | 'back';
type Mode = 'fallback' | 'view' | 'crossfade' | 'finish' | null;
type Request = { key: string; direction: Direction; commit: () => void; exit?: boolean; settled?: () => void };
type SceneRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
type FlipAnchor = 'top-left' | 'bottom-left' | 'bottom-right';

/** Measure from the window's anchor so its shared corner stays fixed while it resizes. */
export function getSceneFlipGeometry(before: SceneRect, after: SceneRect, anchor: FlipAnchor = 'top-left') {
  const fromBottom = anchor !== 'top-left';
  const fromRight = anchor === 'bottom-right';
  return {
    x: before.left + (fromRight ? before.width : 0) - after.left - (fromRight ? after.width : 0),
    y: before.top + (fromBottom ? before.height : 0) - after.top - (fromBottom ? after.height : 0),
    scaleX: after.width ? before.width / after.width : 1,
    scaleY: after.height ? before.height / after.height : 1,
    origin: anchor.replace('-', ' '),
  };
}

/** Keep the live scene in place; only the departing content is a disposable snapshot. */
export function useSceneTransition(root: RefObject<HTMLDivElement | null>, reducedMotion: boolean) {
  const [motion, setMotion] = useState<{ mode: Mode; direction: Direction; burst: number; started: boolean; exit: boolean }>({ mode: null, direction: 'forward', burst: 0, started: false, exit: false });
  const locked = useRef(false);
  const current = useRef<Request | null>(null);
  const queued = useRef<Request | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dispose = useRef(() => {});
  const native = useRef<ViewTransition | null>(null);
  const reduce = useRef(reducedMotion);
  reduce.current = reducedMotion;

  const settle = () => {
    clearTimeout(timer.current);
    dispose.current();
    dispose.current = () => {};
    native.current = null;
    const completed = current.current;
    current.current = null;
    locked.current = false;
    setMotion((value) => ({ ...value, mode: null, started: false, exit: false }));
    completed?.settled?.();
    const pending = queued.current;
    queued.current = null;
    if (pending && !completed?.exit) run(pending);
  };

  const run = (request: Request) => {
    if (locked.current) {
      if (request.key !== current.current?.key && !current.current?.exit) queued.current = request;
      return;
    }
    const scene = root.current;
    if (!scene) return;
    locked.current = true;
    current.current = request;
    const card = scene.querySelector<HTMLElement>('.cyber-card')!;
    const content = scene.querySelector<HTMLElement>('.cyber-card-content')!;
    const figureHit = scene.querySelector<HTMLElement>('.cyber-figure-hit');
    const shared = [card, scene.querySelector<HTMLElement>('.cyber-figure-frame')!, scene.querySelector<HTMLElement>('.cyber-wordmark')!, ...(figureHit ? [figureHit] : [])];
    const before = shared.map((element) => element.getBoundingClientRect());
    const sceneRect = scene.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const snapshot = document.createElement('div');
    snapshot.className = `${card.className} cyber-card-snapshot`;
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.inert = true;
    Object.assign(snapshot.style, {
      position: 'absolute', left: `${before[0]!.left - sceneRect.left + scene.scrollLeft}px`,
      top: `${before[0]!.top - sceneRect.top + scene.scrollTop}px`, width: `${before[0]!.width}px`, height: `${before[0]!.height}px`,
      right: 'auto', bottom: 'auto', maxHeight: 'none', margin: '0', padding: '0', border: '0',
      translate: 'none', transform: 'none',
      background: 'transparent', backdropFilter: 'none', pointerEvents: 'none', zIndex: '5', gridArea: 'auto', viewTransitionName: 'none',
    });
    const outgoing = content.cloneNode(true) as HTMLElement;
    outgoing.className = 'cyber-card-content cyber-card-content--outgoing';
    outgoing.setAttribute('aria-hidden', 'true');
    outgoing.inert = true;
    outgoing.style.left = `${contentRect.left - before[0]!.left}px`;
    outgoing.style.top = `${contentRect.top - before[0]!.top}px`;
    outgoing.style.width = `${contentRect.width}px`;
    outgoing.style.height = `${contentRect.height}px`;
    outgoing.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    outgoing.querySelectorAll('button, input, select, textarea').forEach((element) => element.setAttribute('disabled', ''));
    const orbit = scene.querySelector<HTMLElement>('.cyber-orbit-host');
    const leavingOrbit = orbit?.childElementCount ? orbit.cloneNode(true) as HTMLElement : null;
    if (leavingOrbit) {
      leavingOrbit.className = 'cyber-orbit-exit';
      leavingOrbit.setAttribute('aria-hidden', 'true');
      leavingOrbit.inert = true;
      leavingOrbit.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
      leavingOrbit.querySelectorAll('button, input').forEach((element) => element.setAttribute('disabled', ''));
    }
    let applied = false;
    let fallbackStarted = false;
    const fallback = () => {
      if (fallbackStarted || current.current !== request) return;
      fallbackStarted = true;
      // The departing text stays at its original scale while the live frame morphs.
      snapshot.append(outgoing);
      scene.append(snapshot);
      if (leavingOrbit && !reduce.current && !request.exit) scene.append(leavingOrbit);
      if (!reduce.current && !request.exit) {
        shared.forEach((element, index) => {
          const old = before[index]!;
          const next = element.getBoundingClientRect();
          const anchor = element === card ? card.dataset.windowAnchor === 'bottom-left' ? 'bottom-left' : 'bottom-right' : 'top-left';
          const geometry = getSceneFlipGeometry(old, next, anchor);
          element.style.setProperty('--neo-flip-x', `${geometry.x}px`);
          element.style.setProperty('--neo-flip-y', `${geometry.y}px`);
          element.style.setProperty('--neo-flip-scale-x', String(geometry.scaleX));
          element.style.setProperty('--neo-flip-scale-y', String(geometry.scaleY));
          element.style.setProperty('--neo-flip-origin', geometry.origin);
          element.classList.add('cyber-flip');
        });
      }
      setMotion((value) => ({ ...value, mode: reduce.current ? 'crossfade' : request.exit ? 'finish' : 'fallback' }));
    };
    dispose.current = () => {
      outgoing.remove();
      snapshot.remove();
      leavingOrbit?.remove();
      shared.forEach((element) => {
        element.classList.remove('cyber-flip');
        ['x', 'y', 'scale-x', 'scale-y', 'origin'].forEach((part) => element.style.removeProperty(`--neo-flip-${part}`));
      });
    };
    const apply = (mode: Mode) => {
      if (applied || current.current !== request) return;
      applied = true;
      const activeMode = reduce.current ? 'crossfade' : mode;
      flushSync(() => {
        request.commit();
        setMotion((value) => ({ mode: activeMode, direction: request.direction, started: true, exit: Boolean(request.exit), burst: reduce.current ? value.burst : value.burst + 1 }));
      });
      if (activeMode !== 'view') fallback();
      else if (leavingOrbit) scene.append(leavingOrbit);
      timer.current = setTimeout(settle, reduce.current ? CROSSFADE_MS : request.exit ? EXIT_MS : MOVE_MS);
    };
    // Set the direction and lock controls before the browser captures the old scene.
    flushSync(() => setMotion((value) => ({ ...value, started: false, exit: Boolean(request.exit), direction: request.direction, mode: reduce.current ? 'crossfade' : request.exit ? 'finish' : 'view' })));
    if (reduce.current || request.exit || typeof document.startViewTransition !== 'function') {
      apply(reduce.current ? 'crossfade' : request.exit ? 'finish' : 'fallback');
      return;
    }
    try {
      const transition = document.startViewTransition(() => apply('view'));
      native.current = transition;
      void transition.ready.then(() => {
        if (current.current === request && !reduce.current && !fallbackStarted) {
          clearTimeout(timer.current);
          timer.current = setTimeout(settle, MOVE_MS);
        }
      }).catch(() => undefined);
      void transition.ready.catch(() => {
        if (current.current !== request) return;
        transition.skipTransition();
        apply('fallback');
        fallback();
      });
      void transition.finished.catch(() => undefined);
    } catch {
      apply('fallback');
      fallback();
    }
  };

  useEffect(() => {
    if (reducedMotion && locked.current) {
      native.current?.skipTransition();
      root.current?.querySelectorAll('.cyber-flip').forEach((element) => element.classList.remove('cyber-flip'));
      root.current?.querySelector('.cyber-orbit-exit')?.remove();
      setMotion((value) => ({ ...value, mode: 'crossfade' }));
      if (motion.started) {
        clearTimeout(timer.current);
        timer.current = setTimeout(settle, CROSSFADE_MS);
      }
    }
  }, [reducedMotion]);

  useEffect(() => () => {
    clearTimeout(timer.current);
    native.current?.skipTransition();
    dispose.current();
    current.current = queued.current = null;
    locked.current = false;
  }, []);

  return { ...motion, busy: motion.mode !== null, run, isLocked: () => locked.current };
}
