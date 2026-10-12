/** The WebGL scene is created only after the view's dynamic Three import. */
import type * as Three from 'three';
import type { MemoryKind } from '@neo/protocol';
import type { TranslateFn } from './i18n.js';
import { memoryKindColor } from './memory-graph.js';
import { stepMemoryInTime, type MemoryNet3DLayout } from './memory-net-3d-layout.js';

interface Appearance {
  selectedId: string | null;
  highlightIds: Set<string>;
  focusedId: string | null;
  searchActive: boolean;
}

export interface MemoryNetScene {
  update(appearance: Appearance): void;
  focus(id: string): void;
  zoom(factor: number): void;
  fit(): void;
  now(): void;
  key(key: string): boolean;
  dispose(): void;
}

interface SceneOptions {
  host: HTMLElement;
  labels: HTMLElement;
  canvas: HTMLCanvasElement;
  context: WebGL2RenderingContext;
  layout: MemoryNet3DLayout;
  locale: string;
  t: TranslateFn;
  onSelect(id: string | null): void;
  onFocus(id: string | null): void;
  onHover(hover: { id: string; x: number; y: number } | null): void;
  onFailure(): void;
}

type SceneThree = Pick<typeof Three,
  | 'WebGLRenderer' | 'Scene' | 'OrthographicCamera' | 'Color' | 'Vector2' | 'Vector3'
  | 'BufferGeometry' | 'SphereGeometry' | 'TorusGeometry' | 'Mesh' | 'MeshBasicMaterial'
  | 'MeshLambertMaterial' | 'Line' | 'LineBasicMaterial' | 'LineDashedMaterial'
  | 'HemisphereLight' | 'DirectionalLight' | 'Raycaster'
>;

export function createMemoryNetScene(T: SceneThree, options: SceneOptions): MemoryNetScene {
  const { host, labels, canvas, context, layout, locale, t } = options;
  const renderer = new T.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-100, 100, 100, -100, 0.1, 4000);
  const geometries = new Set<Three.BufferGeometry>();
  const materials = new Set<Three.Material>();
  const disposers: (() => void)[] = [];
  const paletteBindings: { material: Three.Material & { color: Three.Color }; variable: string; fallback: string }[] = [];
  const opacityBindings: { material: Three.Material & { opacity: number }; base: number; ids: string[] }[] = [];
  let disposed = false;
  let frame = 0;
  let visible = true;
  let width = 640;
  let height = 420;
  let appearance: Appearance = { selectedId: null, highlightIds: new Set(), focusedId: null, searchActive: false };
  let hoveredId: string | null = null;
  let yaw = 0;
  let centerY = (layout.timeScale.minY + layout.timeScale.maxY) / 2;
  let viewHeight = 160;
  let yawVelocity = 0;
  let lastInteraction = performance.now();
  let lastFrame = 0;
  let target: { yaw: number; y: number; height: number } | null = null;
  const spineColor = new T.Color();
  const accentColor = new T.Color();
  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reducedMotion = motion?.matches ?? false;
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { x: number; y: number; startX: number; startY: number; moved: boolean; pinch: number } | null = null;
  const trackGeometry = <G extends Three.BufferGeometry>(g: G): G => { geometries.add(g); return g; };
  const trackMaterial = <M extends Three.Material>(m: M): M => { materials.add(m); return m; };
  const bindColor = <M extends Three.Material & { color: Three.Color }>(material: M, variable: string, fallback: string): M => {
    paletteBindings.push({ material, variable, fallback });
    return trackMaterial(material);
  };
  const bindOpacity = <M extends Three.Material & { opacity: number }>(material: M, base: number, ids: string[]): M => {
    opacityBindings.push({ material, base, ids });
    return material;
  };
  const sphereGeometry = trackGeometry(new T.SphereGeometry(1, 16, 10));
  const ringGeometry = trackGeometry(new T.TorusGeometry(1, 0.035, 4, 40));
  const pickMaterial = trackMaterial(new T.MeshBasicMaterial());
  const pickObjects: Three.Mesh[] = [];
  const rings: { mesh: Three.Mesh; id: string }[] = [];
  const projected = new T.Vector3();
  const raycaster = new T.Raycaster();
  const pointer = new T.Vector2();
  const date = (at: number, month = false) => new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', year: 'numeric', month: 'short', ...(month ? {} : { day: 'numeric' }),
  }).format(at);
  const overlay: { el: HTMLSpanElement; position: Three.Vector3; id: string | null; priority: number; tick: boolean; width: number; left: boolean }[] = [];
  const addLabel = (text: string, x: number, y: number, z: number, id: string | null, priority: number, tick = false, left = false) => {
    const el = document.createElement('span');
    el.className = tick ? 'neo-net3d__tick' : 'neo-net3d__label';
    el.textContent = text;
    labels.append(el);
    overlay.push({ el, position: new T.Vector3(x, y, z), id, priority, tick, width: 0, left });
  };
  const line = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, base: number, ids: string[] = [], dashed = false, variable = '--neo-text-subtle') => {
    const geometry = trackGeometry(new T.BufferGeometry().setFromPoints([
      new T.Vector3(from.x, from.y, from.z), new T.Vector3(to.x, to.y, to.z),
    ]));
    const material = bindOpacity(bindColor(dashed
      ? new T.LineDashedMaterial({ transparent: true, dashSize: 2, gapSize: 1.5, depthWrite: false })
      : new T.LineBasicMaterial({ transparent: true, depthWrite: false }), variable, '#8a8aa0'), base, ids);
    const object = new T.Line(geometry, material);
    if (dashed) object.computeLineDistances();
    scene.add(object);
    return object;
  };
  const spine = line({ x: 0, y: layout.timeScale.minY - 8, z: 0 }, { x: 0, y: layout.timeScale.maxY + 8, z: 0 }, 0.8, layout.spine ? [layout.spine.id] : [], false, '--neo-text-muted');
  scene.add(new T.HemisphereLight(0xffffff, 0x555566, 2));
  const light = new T.DirectionalLight(0xffffff, 2);
  light.position.set(80, 160, 120);
  scene.add(light);
  const importantIds = new Set([...layout.nodes].sort((a, b) => b.node.importance - a.node.importance || a.id.localeCompare(b.id)).slice(0, 12).map((n) => n.id));

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    disposers.forEach((dispose) => dispose());
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    labels.replaceChildren();
  };

  try {
    for (const node of layout.nodes) {
      const material = bindOpacity(bindColor(new T.MeshLambertMaterial({ transparent: true, wireframe: node.node.status === 'archived', depthWrite: false }), `--neo-kind-${node.node.kind}`, memoryKindColor[node.node.kind as MemoryKind]), 0.12 + Math.max(0, Math.min(1, node.node.retention)) * 0.88, [node.id]);
      const sphere = new T.Mesh(sphereGeometry, material);
      sphere.position.set(node.x, node.y, node.z);
      sphere.scale.setScalar(node.radius);
      scene.add(sphere);
      const pick = new T.Mesh(sphereGeometry, pickMaterial);
      pick.position.copy(sphere.position);
      pick.userData.id = node.id;
      pickObjects.push(pick);
      const accentMaterial = bindColor(new T.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false }), '--neo-accent', '#7c5cff');
      const ring = new T.Mesh(ringGeometry, accentMaterial);
      ring.position.copy(sphere.position);
      ring.scale.setScalar(node.radius + 1.5);
      ring.visible = false;
      scene.add(ring);
      rings.push({ mesh: ring, id: node.id });
      if (node.node.pinned) {
        const pin = new T.Mesh(ringGeometry, bindOpacity(bindColor(new T.MeshBasicMaterial({ transparent: true, depthTest: false }), '--neo-tone-warning-text', '#9a5b00'), 0.8, [node.id]));
        pin.position.copy(sphere.position);
        pin.scale.setScalar(node.radius + 0.7);
        scene.add(pin);
        rings.push({ mesh: pin, id: '' });
      }
      if (node.threadEndY !== undefined && node.threadEndY > node.y) {
        line(node, { x: node.x, y: node.threadEndY, z: node.z }, 0.18, [node.id], false, `--neo-kind-${node.node.kind}`);
      }
      addLabel(`${node.node.sensitivity === 'sensitive' ? '🔒 ' : ''}${node.node.label}`, node.x, node.y, node.z, node.id, node.node.importance);
    }
    for (const edge of layout.edges) {
      const structural = ['about', 'part_of', 'derived_from', 'supersedes', 'precedes'].includes(edge.edge.type);
      line(edge.from, edge.to, (structural ? 0.25 : 0.08) + edge.edge.weight * 0.35, [edge.edge.from, edge.edge.to], edge.edge.type === 'contradicts');
    }
    for (const tick of layout.ticks) {
      line({ x: -2, y: tick.y, z: 0 }, { x: 2, y: tick.y, z: 0 }, 0.55);
      addLabel(date(tick.at, tick.unit === 'month'), 0, tick.y, 0, null, 0, true);
    }
    for (const gap of layout.timeScale.gaps) addLabel('≈', 0, gap.y, 0, null, 2, true);
    addLabel(t('memory.graph_now'), 0, layout.timeScale.maxY + 8, 0, null, 200, true);
    if (layout.spine) addLabel(`${layout.spine.sensitivity === 'sensitive' ? '🔒 ' : ''}${layout.spine.label}`, 0, layout.timeScale.maxY + 8, 0, layout.spine.id, 5, true, true);

    const updatePalette = () => {
      const css = getComputedStyle(host);
      for (const binding of paletteBindings) binding.material.color.set(css.getPropertyValue(binding.variable).trim() || binding.fallback);
      spineColor.set(css.getPropertyValue('--neo-text-muted').trim() || '#5f5f76');
      accentColor.set(css.getPropertyValue('--neo-accent').trim() || '#7c5cff');
      schedule();
    };
    const markInteraction = () => { lastInteraction = performance.now(); target = null; schedule(); };
    const clampY = (y: number) => Math.max(layout.timeScale.minY, Math.min(layout.timeScale.maxY, y));
    const fitHeight = () => Math.max(80, (layout.timeScale.maxY - layout.timeScale.minY) * Math.cos(Math.PI / 12) + 2 * layout.horizontalRadius * Math.sin(Math.PI / 12) + 58, (layout.horizontalRadius * 2 + 65) * height / width);
    const updateCamera = () => {
      const distance = Math.max(1000, (layout.timeScale.maxY - layout.timeScale.minY) * Math.sin(Math.PI / 12) + layout.horizontalRadius * 2 + 100);
      camera.left = -viewHeight * width / height / 2;
      camera.right = -camera.left;
      camera.top = viewHeight / 2;
      camera.bottom = -camera.top;
      camera.far = distance * 4 + 100;
      camera.position.set(Math.sin(yaw) * distance, centerY + distance * Math.tan(Math.PI / 12), Math.cos(yaw) * distance);
      camera.lookAt(0, centerY, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    };
    const drawLabels = () => {
      const boxes: { x: number; y: number; w: number; h: number }[] = [];
      const priority = (label: typeof overlay[number]) => label.id === null ? label.priority : label.id === appearance.selectedId ? 100 : label.id === hoveredId ? 90 : label.id === appearance.focusedId ? 85 : appearance.highlightIds.has(label.id) ? 80 : label.priority;
      for (const label of [...overlay].sort((a, b) => priority(b) - priority(a))) {
        const emphasized = label.id !== null && (label.id === appearance.selectedId || label.id === hoveredId || label.id === appearance.focusedId || appearance.highlightIds.has(label.id));
        const node = label.id ? layout.nodes.find((n) => n.id === label.id) : undefined;
        const show = label.tick || emphasized || (label.id && (node?.node.pinned || importantIds.has(label.id)));
        label.el.style.display = 'none';
        if (!show) continue;
        if (!label.width) {
          label.el.style.display = 'block';
          label.width = label.el.getBoundingClientRect().width || 190;
          label.el.style.display = 'none';
        }
        projected.copy(label.position).project(camera);
        const x = (projected.x + 1) * width / 2 + (label.left ? -label.width - 9 : label.tick ? 9 : (node?.radius ?? 0) * height / viewHeight + 5);
        const y = (1 - projected.y) * height / 2 - 9;
        if (projected.z < -1 || projected.z > 1 || x < 0 || x > width - 12 || y < 2 || y > height - 24) continue;
        const w = Math.min(190, width - x - 4, label.width);
        const box = { x, y, w, h: 20 };
        if (boxes.some((b) => x < b.x + b.w + 4 && x + w + 4 > b.x && y < b.y + b.h + 3 && y + 23 > b.y)) continue;
        boxes.push(box);
        label.el.style.display = 'block';
        label.el.style.transform = `translate(${x}px, ${y}px)`;
        label.el.style.maxWidth = `${w}px`;
        label.el.style.opacity = appearance.searchActive && label.id && !appearance.highlightIds.has(label.id) && !emphasized ? '0.35' : '1';
        label.el.dataset.active = emphasized ? 'true' : 'false';
      }
    };
    const draw = () => {
      updateCamera();
      const selfId = layout.spine?.id;
      const selfActive = selfId && (selfId === appearance.selectedId || selfId === appearance.focusedId || selfId === hoveredId || appearance.highlightIds.has(selfId));
      spine.material.color.copy(selfActive ? accentColor : spineColor);
      for (const { material, base, ids } of opacityBindings) {
        const matches = ids.some((id) => appearance.highlightIds.has(id) || id === appearance.selectedId || id === appearance.focusedId || id === hoveredId);
        material.opacity = base * (appearance.searchActive && ids.length && !matches ? 0.18 : 1);
      }
      for (const ring of rings) {
        ring.mesh.quaternion.copy(camera.quaternion);
        if (ring.id) ring.mesh.visible = ring.id === appearance.selectedId || ring.id === appearance.focusedId || ring.id === hoveredId || appearance.highlightIds.has(ring.id);
      }
      renderer.render(scene, camera);
      drawLabels();
    };
    const animate = (at: number) => {
      frame = 0;
      if (disposed || document.hidden || !visible) return;
      const dt = Math.min(0.05, lastFrame ? (at - lastFrame) / 1000 : 1 / 60);
      lastFrame = at;
      if (target) {
        const blend = reducedMotion ? 1 : 1 - Math.exp(-dt * 8);
        yaw += Math.atan2(Math.sin(target.yaw - yaw), Math.cos(target.yaw - yaw)) * blend;
        centerY += (target.y - centerY) * blend;
        viewHeight += (target.height - viewHeight) * blend;
        if (Math.abs(target.y - centerY) < 0.05 && Math.abs(target.height - viewHeight) < 0.05 && Math.abs(Math.atan2(Math.sin(target.yaw - yaw), Math.cos(target.yaw - yaw))) < 0.001) target = null;
      } else if (!pointers.size && !reducedMotion) {
        yaw += yawVelocity * dt;
        yawVelocity *= Math.exp(-dt * 5);
        if (at - lastInteraction > 8000) yaw += dt * 0.025;
      }
      draw();
      if (!reducedMotion || target) schedule();
    };
    function schedule() {
      if (!disposed && !frame && !document.hidden && visible) frame = requestAnimationFrame(animate);
    }
    const goTo = (next: { yaw: number; y: number; height: number }) => {
      markInteraction();
      yawVelocity = 0;
      if (reducedMotion) { yaw = next.yaw; centerY = next.y; viewHeight = next.height; }
      else target = next;
      schedule();
    };
    const focus = (id: string) => {
      const node = layout.nodes.find((n) => n.id === id);
      if (node) goTo({ yaw: Math.atan2(node.x, node.z), y: clampY(node.y), height: Math.min(viewHeight, Math.max(80, layout.horizontalRadius * 2.5 * height / width)) });
      else if (id === layout.spine?.id) goTo({ yaw, y: (layout.timeScale.minY + layout.timeScale.maxY) / 2, height: viewHeight });
    };
    const zoom = (factor: number) => {
      markInteraction();
      yawVelocity = 0;
      viewHeight = Math.max(30, Math.min(Math.max(800, fitHeight() * 1.5), viewHeight / factor));
    };
    const fit = () => goTo({ yaw, y: (layout.timeScale.minY + layout.timeScale.maxY) / 2, height: fitHeight() });
    const now = () => goTo({ yaw, y: layout.timeScale.maxY, height: Math.min(viewHeight, Math.max(100, layout.horizontalRadius * 2.5 * height / width)) });
    const hit = (clientX: number, clientY: number): string | null => {
      updateCamera();
      const rect = canvas.getBoundingClientRect();
      pointer.set((clientX - rect.left) / width * 2 - 1, -(clientY - rect.top) / height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const minRadius = (width < 600 ? 14 : 9) * viewHeight / height;
      for (let i = 0; i < pickObjects.length; i++) {
        const pick = pickObjects[i]!;
        pick.scale.setScalar(Math.max(layout.nodes[i]!.radius, minRadius));
        pick.updateMatrixWorld();
      }
      const hits = raycaster.intersectObjects(pickObjects, false);
      if (hits[0]) return hits[0].object.userData.id as string;
      raycaster.params.Line.threshold = minRadius;
      spine.updateMatrixWorld();
      return layout.spine && raycaster.intersectObject(spine).length ? layout.spine.id : null;
    };
    const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement, event: K, handler: (event: HTMLElementEventMap[K]) => void, settings?: AddEventListenerOptions) => {
      el.addEventListener(event, handler, settings);
      disposers.push(() => el.removeEventListener(event, handler, settings));
    };
    listen(canvas, 'pointerdown', (event) => {
      markInteraction();
      host.focus({ preventScroll: true });
      yawVelocity = 0;
      canvas.setPointerCapture?.(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      gesture = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: pointers.size > 1, pinch: 0 };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture.pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
      hoveredId = null;
      options.onHover(null);
    });
    listen(canvas, 'pointermove', (event) => {
      if (pointers.has(event.pointerId) && gesture) {
        markInteraction();
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size >= 2) {
          const [a, b] = [...pointers.values()];
          const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
          if (gesture.pinch > 0 && distance > 0) zoom(distance / gesture.pinch);
          gesture.pinch = distance;
          gesture.moved = true;
          return;
        }
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 4) gesture.moved = true;
        if (gesture.moved) {
          yaw -= dx * 0.006;
          yawVelocity = reducedMotion ? 0 : Math.max(-2, Math.min(2, -dx * 0.18));
          centerY = clampY(centerY + dy * viewHeight / height);
          canvas.dataset.dragging = 'true';
        }
        gesture.x = event.clientX;
        gesture.y = event.clientY;
      } else {
        markInteraction();
        hoveredId = hit(event.clientX, event.clientY);
        canvas.dataset.hover = hoveredId ? 'true' : 'false';
        const rect = canvas.getBoundingClientRect();
        options.onHover(hoveredId ? { id: hoveredId, x: event.clientX - rect.left, y: event.clientY - rect.top } : null);
      }
    });
    const finishPointer = (event: PointerEvent, cancelled: boolean) => {
      if (!pointers.has(event.pointerId)) return;
      markInteraction();
      pointers.delete(event.pointerId);
      if (!cancelled && gesture && !gesture.moved && !pointers.size) options.onSelect(hit(event.clientX, event.clientY));
      if (pointers.size) {
        const remaining = [...pointers.values()][0]!;
        gesture = { x: remaining.x, y: remaining.y, startX: remaining.x, startY: remaining.y, moved: true, pinch: 0 };
      } else gesture = null;
      if (cancelled) yawVelocity = 0;
      delete canvas.dataset.dragging;
    };
    listen(canvas, 'pointerup', (event) => finishPointer(event, false));
    listen(canvas, 'pointercancel', (event) => finishPointer(event, true));
    listen(canvas, 'pointerleave', () => { hoveredId = null; options.onHover(null); delete canvas.dataset.hover; schedule(); });
    listen(canvas, 'wheel', (event) => {
      event.preventDefault();
      markInteraction();
      yawVelocity = 0;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      if (event.ctrlKey) zoom(Math.exp(-delta * 0.01));
      else centerY = clampY(centerY - delta * viewHeight / height);
    }, { passive: false });
    const contextLost = (event: Event) => { event.preventDefault(); cleanup(); options.onFailure(); };
    canvas.addEventListener('webglcontextlost', contextLost);
    disposers.push(() => canvas.removeEventListener('webglcontextlost', contextLost));
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const oldFit = fitHeight();
      const wasFit = Math.abs(viewHeight - oldFit) < 1;
      width = Math.max(1, rect.width || 640);
      height = Math.max(1, rect.height || 420);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      if (wasFit) viewHeight = fitHeight();
      schedule();
    };
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      disposers.push(() => observer.disconnect());
    }
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver((entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        if (!visible) { cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
        else schedule();
      });
      observer.observe(host);
      disposers.push(() => observer.disconnect());
    }
    const visibility = () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
      else schedule();
    };
    document.addEventListener('visibilitychange', visibility);
    disposers.push(() => document.removeEventListener('visibilitychange', visibility));
    const themeObserver = new MutationObserver(updatePalette);
    // Variables may be overridden on a scoped ancestor as well as the document root.
    for (let el: HTMLElement | null = host; el; el = el.parentElement) themeObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    disposers.push(() => themeObserver.disconnect());
    const motionChange = () => { reducedMotion = motion?.matches ?? false; yawVelocity = 0; schedule(); };
    motion?.addEventListener('change', motionChange);
    disposers.push(() => motion?.removeEventListener('change', motionChange));
    host.prepend(canvas);
    resize();
    viewHeight = fitHeight();
    updatePalette();
    schedule();
    return {
      update(next) { appearance = next; schedule(); },
      focus, zoom, fit, now,
      key(key) {
        markInteraction();
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          const id = stepMemoryInTime(layout.timeOrder, appearance.focusedId ?? appearance.selectedId, key === 'ArrowUp' ? 'newer' : 'older');
          options.onFocus(id);
          if (id) { appearance.focusedId = id; focus(id); }
        } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
          yaw += key === 'ArrowLeft' ? -0.15 : 0.15;
          yawVelocity = 0;
        } else if (key === '+' || key === '=') zoom(1.25);
        else if (key === '-' || key === '−') zoom(0.8);
        else if (key === 'Enter') { if (appearance.focusedId) options.onSelect(appearance.focusedId); }
        else if (key === 'Escape') { appearance.focusedId = null; options.onFocus(null); options.onSelect(null); }
        else if (key === '0') fit();
        else return false;
        return true;
      },
      dispose: cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
