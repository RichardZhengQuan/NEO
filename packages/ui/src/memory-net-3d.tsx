/** A memory net around a fixed time spine, with a lazy WebGL / 2D fallback. */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { GraphLegend, MemoryGraphView, type MemoryGraphViewProps } from './memory-graph.js';
import { buildMemoryNet3DLayout } from './memory-net-3d-layout.js';
import { createMemoryNetScene, type MemoryNetScene } from './memory-net-3d-scene.js';
import { useLocale, useT } from './i18n.js';
import { Icon } from './icons.js';
import { IconButton, Skeleton } from './primitives.js';

export function MemoryNet3D({ graph, selectedId = null, highlightIds, onSelect, height = 420, showLegend = true, className }: MemoryGraphViewProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MemoryNetScene | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const layout = useMemo(() => buildMemoryNet3DLayout(graph, { now: Date.now() }), [graph]);
  const latest = useRef({ selectedId, highlightIds, onSelect, focusedId });
  latest.current = { selectedId, highlightIds, onSelect, focusedId };

  useEffect(() => {
    const host = hostRef.current;
    const labels = labelsRef.current;
    if (!host || !labels) return;
    let cancelled = false;
    let scene: MemoryNetScene | null = null;
    let context: WebGL2RenderingContext | null = null;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const fallback = () => { if (!cancelled) setPhase('fallback'); };
    setPhase('loading');
    setHover(null);
    try { context = canvas.getContext('webgl2', { alpha: true, antialias: true }); }
    catch { fallback(); }
    if (!context) { fallback(); return; }
    const releaseContext = () => context?.getExtension?.('WEBGL_lose_context')?.loseContext();

    void import('three').then(({
      WebGLRenderer, Scene, OrthographicCamera, Color, Vector2, Vector3,
      BufferGeometry, SphereGeometry, TorusGeometry, Mesh, MeshBasicMaterial,
      MeshLambertMaterial, Line, LineBasicMaterial, LineDashedMaterial,
      HemisphereLight, DirectionalLight, Raycaster,
    }) => {
      if (cancelled) { releaseContext(); return; }
      scene = createMemoryNetScene({
        WebGLRenderer, Scene, OrthographicCamera, Color, Vector2, Vector3,
        BufferGeometry, SphereGeometry, TorusGeometry, Mesh, MeshBasicMaterial,
        MeshLambertMaterial, Line, LineBasicMaterial, LineDashedMaterial,
        HemisphereLight, DirectionalLight, Raycaster,
      }, {
        host, labels, canvas, context: context!, layout, locale, t,
        onSelect: (id) => latest.current.onSelect?.(id),
        onFocus: setFocusedId,
        onHover: setHover,
        onFailure: fallback,
      });
      sceneRef.current = scene;
      setPhase('ready');
    }).catch(() => { releaseContext(); fallback(); });
    return () => {
      cancelled = true;
      if (sceneRef.current === scene) sceneRef.current = null;
      scene?.dispose();
    };
  }, [layout, locale, t]);

  useEffect(() => {
    if (focusedId && !graph.nodes.some((node) => node.id === focusedId)) setFocusedId(null);
    sceneRef.current?.update({ selectedId, highlightIds: new Set(highlightIds), searchActive: highlightIds !== undefined, focusedId });
  }, [selectedId, highlightIds, focusedId, graph, phase]);

  useEffect(() => {
    if (selectedId) sceneRef.current?.focus(selectedId);
  }, [selectedId, phase]);

  const focused = graph.nodes.find((node) => node.id === focusedId);
  const hovered = graph.nodes.find((node) => node.id === hover?.id);
  const date = (at: number) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(at);

  if (phase === 'fallback') return <MemoryGraphView graph={graph} selectedId={selectedId} highlightIds={highlightIds} onSelect={onSelect} height={height} showLegend={showLegend} className={className} />;

  return (
    <div className={className}>
      <div
        ref={hostRef}
        className="neo-graph neo-net3d"
        style={{ height }}
        role="group"
        tabIndex={0}
        aria-label={t('memory.graph_3d_aria', { nodes: graph.nodes.length, edges: graph.edges.length })}
        aria-busy={phase === 'loading'}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (sceneRef.current?.key(event.key)) event.preventDefault();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
        }}
      >
        <div ref={labelsRef} className="neo-net3d__labels" aria-hidden="true" />
        {phase === 'loading' && <Skeleton height="100%" className="neo-net3d__loading" />}
        {hovered && hover && (
          <div className="neo-graph__tooltip" role="tooltip" style={{ left: Math.max(0, Math.min(hover.x, (hostRef.current?.clientWidth || 640) - 240)), top: Math.max(0, Math.min(hover.y, (hostRef.current?.clientHeight || height) - 120)) }}>
            <span className="neo-kind" data-kind={hovered.kind}>{t(`memory.kind.${hovered.kind}`)}</span>
            <strong>{hovered.sensitivity === 'sensitive' && <Icon name="lock" size={12} />} {hovered.label}</strong>
            <span>{date(hovered.createdAt)} · {t('memory.retention', { pct: Math.round(hovered.retention * 100) })}</span>
          </div>
        )}
        <div className="neo-graph__controls">
          <IconButton icon="zoom-in" label={t('memory.graph_zoom_in')} size="sm" onClick={() => sceneRef.current?.zoom(1.25)} />
          <IconButton icon="zoom-out" label={t('memory.graph_zoom_out')} size="sm" onClick={() => sceneRef.current?.zoom(0.8)} />
          <IconButton icon="maximize" label={t('memory.graph_fit')} size="sm" onClick={() => sceneRef.current?.fit()} />
          <IconButton icon="arrow-up" label={t('memory.graph_jump_now')} size="sm" onClick={() => sceneRef.current?.now()} />
        </div>
        <span className="neo-sr" aria-live="polite">{focused ? `${focused.label}, ${t(`memory.kind.${focused.kind}`)}, ${date(focused.createdAt)}` : ''}</span>
      </div>
      {showLegend && <GraphLegend />}
    </div>
  );
}
