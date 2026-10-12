import { useEffect, useRef, useState, type RefObject } from 'react';
import { avatarOrbitGeometry, type OrbitEllipse } from './orbit-geometry.js';

type Ellipse = OrbitEllipse;
type Turn = { from: number; to: number; started: number };

const TAU = Math.PI * 2;
const FRONT = Math.PI / 2;
const SELECT_MS = 600;
const TOUCH_MS = 4000;

function angle(value: number): number {
  return ((value % TAU) + TAU) % TAU;
}

function frontArc(ellipse: Ellipse, count: number): number[] {
  const samples = Array.from({ length: 181 }, (_, i) => i * Math.PI / 180);
  const distances = [0];
  samples.slice(1).forEach((theta, index) => {
    const before = samples[index]!;
    distances.push(distances[index]! + Math.hypot(ellipse.rx * (Math.cos(theta) - Math.cos(before)), ellipse.ry * (Math.sin(theta) - Math.sin(before))));
  });
  return Array.from({ length: count }, (_, index) => {
    const target = distances[180]! * index / Math.max(1, count - 1);
    const upper = Math.max(1, distances.findIndex((distance) => distance >= target));
    const lower = upper - 1;
    const span = distances[upper]! - distances[lower]!;
    return samples[lower]! + (samples[upper]! - samples[lower]!) * (span ? (target - distances[lower]!) / span : 0);
  });
}

/** Only the measured geometry changes layout; every moving frame paints transforms. */
export function useAvatarOrbit(props: {
  enabled: boolean;
  frameRef?: RefObject<HTMLElement | null>;
  areaRef?: RefObject<HTMLElement | null>;
  clearanceRef?: RefObject<HTMLElement | null>;
  reducedMotion?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<(index: number) => void>(() => undefined);
  const [systemReduced, setSystemReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const reduced = props.reducedMotion ?? systemReduced;

  useEffect(() => {
    if (props.reducedMotion !== undefined || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setSystemReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [props.reducedMotion]);

  useEffect(() => {
    const root = rootRef.current;
    if (!props.enabled || !root) return;
    const area = props.areaRef?.current ?? root;
    const frame = props.frameRef?.current;
    const clearance = props.clearanceRef?.current;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-orbit="portrait"].neo-avp-orbit-node'));
    let phase = FRONT;
    let turn: Turn | null = null;
    let ellipse: Ellipse = { x: 0, y: 0, rx: 0, ry: 0 };
    let staticAngles: number[] = [];
    let frameId: number | null = null;
    let lastTime: number | null = null;
    let speed = 1;
    let rootHover = false;
    let areaHover = false;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let keyboardFocus = true;
    let touchUntil = 0;
    let touchTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let hiddenAt = document.hidden ? performance.now() : null;
    let focusedPortraitMinY: number | null = null;
    let hasGeometry = false;
    let originX = 0;
    let originY = 0;
    let geometryFrame: number | null = null;

    const paused = () => reduced || rootHover || areaHover || hovered !== null || (focused !== null && keyboardFocus) || performance.now() < touchUntil || document.hidden;
    const paint = () => {
      if (!hasGeometry) return;
      root.dataset.orbitPaused = String(paused());
      root.dataset.orbitMotion = reduced ? 'reduced' : 'running';
      nodes.forEach((node, index) => {
        const theta = reduced
          ? staticAngles[index] ?? FRONT
          : angle(phase + index * TAU / nodes.length);
        const showFocused = keyboardFocus && (focused === node || node.contains(focused));
        const front = Math.sin(theta) >= 0 || showFocused;
        const showHovered = hovered === node;
        const lifted = showFocused || (!front && showHovered);
        const depth = front ? 'front' : 'back';
        const x = originX + ellipse.x + ellipse.rx * Math.cos(theta);
        let y = ellipse.y + ellipse.ry * Math.sin(theta);
        if (showFocused && focusedPortraitMinY !== null) {
          // A raised rear portrait must pass below even the animal muzzle,
          // rather than appearing over the face when focus lifts it to z=4.
          y = Math.max(focusedPortraitMinY, ellipse.y + ellipse.ry * Math.abs(Math.sin(theta)));
        }
        node.style.transform = `translate3d(${x.toFixed(2)}px, ${(originY + y).toFixed(2)}px, 0) translate(-50%, -50%) scale(${front ? 1 : showHovered ? .9 : .8})`;
        node.style.opacity = front || showHovered ? '1' : '.6';
        node.style.zIndex = showFocused ? '4' : front ? '3' : '1';
        node.dataset.orbitAngle = String(theta);
        node.dataset.orbitDepth = depth;
        node.dataset.orbitLifted = String(lifted);
      });
    };

    const measure = () => {
      const geometry = avatarOrbitGeometry({
        area: area.getBoundingClientRect(),
        frame: frame?.getBoundingClientRect(),
        clearance: clearance?.getBoundingClientRect(),
        viewport: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
      });
      if (!geometry) {
        if (!hasGeometry) root.style.visibility = 'hidden';
        return;
      }
      hasGeometry = true;
      root.style.visibility = '';
      const origin = root.getBoundingClientRect();
      originX = geometry.bounds.left - origin.left;
      originY = geometry.bounds.top - origin.top;
      focusedPortraitMinY = geometry.focusedPortraitMinY;
      ellipse = geometry.portrait;
      const { x, rx } = geometry.portrait;
      const radius = geometry.portraitRadius;
      staticAngles = frontArc(ellipse, nodes.length);
      for (const half of ['back', 'front'] as const) {
        const path = root.querySelector<SVGPathElement>(`[data-orbit-path="portrait-${half}"] path`);
        const start = half === 'back' ? -1 : 1;
        path?.setAttribute('d', `M ${originX + ellipse.x + start * ellipse.rx} ${originY + ellipse.y} A ${ellipse.rx} ${ellipse.ry} 0 0 1 ${originX + ellipse.x - start * ellipse.rx} ${originY + ellipse.y}`);
      }
      const hit = root.querySelector<HTMLElement>('[data-orbit-area]');
      if (hit) {
        const left = originX + x - rx - radius - 8;
        const upper = originY + ellipse.y - ellipse.ry - radius - 8;
        const lower = originY + ellipse.y + ellipse.ry + radius + 8;
        hit.style.transform = `translate3d(${left}px, ${upper}px, 0)`;
        hit.style.width = `${rx * 2 + (radius + 8) * 2}px`;
        hit.style.height = `${Math.max(0, lower - upper)}px`;
      }
      paint();
    };

    const scheduleMeasure = () => {
      if (geometryFrame !== null) return;
      geometryFrame = requestAnimationFrame(() => {
        geometryFrame = null;
        if (!disposed) measure();
      });
    };

    const tick = (now: number) => {
      if (disposed || document.hidden) { frameId = null; return; }
      const elapsed = lastTime === null ? 0 : Math.max(0, now - lastTime);
      lastTime = now;
      if (paused()) speed = 0;
      const nextSpeed = paused() ? 0 : 1 - (1 - speed) * Math.exp(-elapsed / 300);
      if (turn) {
        const progress = Math.min(1, Math.max(0, (now - turn.started) / SELECT_MS));
        const ease = progress * progress * (3 - 2 * progress);
        phase = turn.from + (turn.to - turn.from) * ease;
        if (progress === 1) turn = null;
      } else {
        phase += elapsed * (speed + nextSpeed) / 2 * TAU / 30000;
      }
      speed = nextSpeed;
      paint();
      frameId = requestAnimationFrame(tick);
    };

    selectRef.current = (index) => {
      if (reduced) return;
      const target = FRONT - index * TAU / nodes.length;
      const delta = angle(target - phase + Math.PI) - Math.PI;
      turn = { from: phase, to: phase + delta, started: performance.now() };
    };
    const hoverRoot = (event: PointerEvent) => { if (event.pointerType !== 'touch') { rootHover = true; speed = 0; paint(); } };
    const leaveRoot = () => { rootHover = false; hovered = null; paint(); };
    const hoverArea = (event: PointerEvent) => { if (event.pointerType !== 'touch') { areaHover = true; speed = 0; paint(); } };
    const leaveArea = () => { areaHover = false; hovered = null; paint(); };
    const hoverNode = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      hovered = event.currentTarget as HTMLElement;
      speed = 0;
      paint();
    };
    const leaveNode = (event: PointerEvent) => {
      if (hovered === event.currentTarget) hovered = null;
      paint();
    };
    const focus = (event: FocusEvent) => {
      focused = (event.target as HTMLElement).closest<HTMLElement>('.neo-avp-orbit-node');
      if (focused && keyboardFocus) speed = 0;
      paint();
    };
    const blur = (event: FocusEvent) => {
      const next = event.relatedTarget as HTMLElement | null;
      focused = next && root.contains(next) ? next.closest<HTMLElement>('.neo-avp-orbit-node') : null;
      paint();
    };
    const touch = () => {
      keyboardFocus = false;
      hovered = null;
      touchUntil = performance.now() + TOUCH_MS;
      speed = 0;
      clearTimeout(touchTimer);
      touchTimer = setTimeout(paint, TOUCH_MS);
      paint();
    };
    const pointer = (event: PointerEvent) => {
      keyboardFocus = false;
      if (event.pointerType === 'touch') touch();
      else paint();
    };
    const key = () => { keyboardFocus = true; if (focused) speed = 0; paint(); };
    const visibility = () => {
      const now = performance.now();
      if (document.hidden && hiddenAt === null) hiddenAt = now;
      else if (!document.hidden && hiddenAt !== null) {
        if (turn) turn.started += now - Math.max(hiddenAt, turn.started);
        hiddenAt = null;
      }
      lastTime = null;
      speed = 0;
      if (document.hidden && frameId !== null) { cancelAnimationFrame(frameId); frameId = null; }
      else if (!reduced && frameId === null) frameId = requestAnimationFrame(tick);
      paint();
    };
    root.addEventListener('pointerenter', hoverRoot);
    root.addEventListener('pointerleave', leaveRoot);
    root.addEventListener('focusin', focus);
    root.addEventListener('focusout', blur);
    root.addEventListener('pointerdown', pointer);
    nodes.forEach((node) => {
      node.addEventListener('pointerenter', hoverNode);
      node.addEventListener('pointerleave', leaveNode);
    });
    document.addEventListener('keydown', key);
    root.addEventListener('touchstart', touch, { passive: true });
    if (area !== root) {
      area.addEventListener('pointerenter', hoverArea);
      area.addEventListener('pointerleave', leaveArea);
      area.addEventListener('pointerdown', pointer);
      area.addEventListener('touchstart', touch, { passive: true });
    }
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(area);
    if (frame && frame !== area) observer?.observe(frame);
    if (clearance && clearance !== area && clearance !== frame) observer?.observe(clearance);
    // FLIP changes measured transforms without changing the observed box size.
    // Re-read the settled pose even when cleanup cancels the animation early.
    const settleTargets = new Set<HTMLElement>();
    if (frame) settleTargets.add(frame);
    if (clearance) settleTargets.add(clearance);
    const settleGeometry = (event: Event) => { if (event.target === event.currentTarget) measure(); };
    settleTargets.forEach((element) => {
      element.addEventListener('animationend', settleGeometry);
      element.addEventListener('animationcancel', settleGeometry);
      element.addEventListener('transitionend', settleGeometry);
      element.addEventListener('transitioncancel', settleGeometry);
    });
    // Step/card-side and native view-transition completion may change position
    // without resizing the frame. Measure the new layout without restarting it.
    let layoutRoot: HTMLElement = area;
    while (layoutRoot.parentElement && !layoutRoot.contains(root)) layoutRoot = layoutRoot.parentElement;
    const layoutObserver = typeof MutationObserver === 'function' ? new MutationObserver(scheduleMeasure) : undefined;
    layoutObserver?.observe(layoutRoot, { attributes: true, attributeFilter: ['class', 'data-step', 'data-card-side', 'data-transition', 'data-layout'] });
    frame?.addEventListener('load', scheduleMeasure, true);
    window.addEventListener('resize', measure);
    measure();
    if (!reduced && !document.hidden) frameId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
      clearTimeout(touchTimer);
      observer?.disconnect();
      layoutObserver?.disconnect();
      frame?.removeEventListener('load', scheduleMeasure, true);
      settleTargets.forEach((element) => {
        element.removeEventListener('animationend', settleGeometry);
        element.removeEventListener('animationcancel', settleGeometry);
        element.removeEventListener('transitionend', settleGeometry);
        element.removeEventListener('transitioncancel', settleGeometry);
      });
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', visibility);
      root.removeEventListener('pointerenter', hoverRoot);
      root.removeEventListener('pointerleave', leaveRoot);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', blur);
      root.removeEventListener('pointerdown', pointer);
      nodes.forEach((node) => {
        node.removeEventListener('pointerenter', hoverNode);
        node.removeEventListener('pointerleave', leaveNode);
      });
      document.removeEventListener('keydown', key);
      root.removeEventListener('touchstart', touch);
      if (area !== root) {
        area.removeEventListener('pointerenter', hoverArea);
        area.removeEventListener('pointerleave', leaveArea);
        area.removeEventListener('pointerdown', pointer);
        area.removeEventListener('touchstart', touch);
      }
      selectRef.current = () => undefined;
    };
  }, [props.enabled, props.frameRef, props.areaRef, props.clearanceRef, reduced]);

  return { rootRef, selectOrbit: (index: number) => selectRef.current(index) };
}
