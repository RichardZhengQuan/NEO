/** A memory net around a fixed time spine, with a lazy WebGL / 2D fallback. */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ToolUseEvent } from '@neo/protocol';
import { GraphLegend, MemoryGraphView, type MemoryGraphViewProps } from './memory-graph.js';
import { buildMemoryNet3DLayout, toolUseFocusId } from './memory-net-3d-layout.js';
import { createMemoryNetScene, defaultToolUseLabels, type MemoryNetScene } from './memory-net-3d-scene.js';
import { useLocale, useT } from './i18n.js';
import { Icon } from './icons.js';
import { IconButton, Skeleton } from './primitives.js';

export interface MemoryNet3DProps extends MemoryGraphViewProps {
  toolUses?: ToolUseEvent[];
  onToolUseSelect?: (event: ToolUseEvent) => void;
  toolUseLabels?: Record<ToolUseEvent['category'], string>;
}

export function MemoryNet3D({ graph, selectedId = null, highlightIds, onSelect, height = 420, showLegend = true, className, toolUses, onToolUseSelect, toolUseLabels = defaultToolUseLabels }: MemoryNet3DProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MemoryNetScene | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number; toolUses?: ToolUseEvent[] } | null>(null);
  const [openToolGroup, setOpenToolGroup] = useState<{ id: string; x: number; y: number; toolUses: ToolUseEvent[] } | null>(null);
  const graphNow = useMemo(() => Date.now(), [graph]);
  const layout = useMemo(() => buildMemoryNet3DLayout(graph, { now: graphNow, toolUses }), [graph, graphNow, toolUses]);
  const latest = useRef({ selectedId, highlightIds, onSelect, onToolUseSelect, focusedId, toolUses });
  latest.current = { selectedId, highlightIds, onSelect, onToolUseSelect, focusedId, toolUses };

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
    setOpenToolGroup(null);
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
        toolUseLabels,
        onToolUseSelect: (event) => {
          const current = latest.current.toolUses?.find((item) => item.id === event.id);
          if (current) latest.current.onToolUseSelect?.(current);
        },
        onToolUseGroupSelect: (marker, x, y) => setOpenToolGroup({ id: marker.id, x, y, toolUses: marker.events }),
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
  }, [layout, locale, t, toolUseLabels]);

  useEffect(() => {
    if (focusedId && !graph.nodes.some((node) => node.id === focusedId) && !toolUses?.some((event) => toolUseFocusId(event.id) === focusedId)) setFocusedId(null);
    sceneRef.current?.update({ selectedId, highlightIds: new Set(highlightIds), searchActive: highlightIds !== undefined, focusedId });
  }, [selectedId, highlightIds, focusedId, graph, toolUses, phase]);

  useEffect(() => {
    if (selectedId) sceneRef.current?.focus(selectedId);
  }, [selectedId, phase]);

  const focused = graph.nodes.find((node) => node.id === focusedId);
  const hovered = graph.nodes.find((node) => node.id === hover?.id);
  const focusedToolUse = toolUses?.find((event) => toolUseFocusId(event.id) === focusedId);
  // Cached projected groups carry ids; current props remain the privacy authority.
  const currentToolUses = new Map(toolUses?.map((event) => [event.id, event]));
  const hoveredToolUses = (openToolGroup?.toolUses ?? hover?.toolUses ?? []).flatMap((event) => {
    const current = currentToolUses.get(event.id);
    return current ? [current] : [];
  });
  const toolPosition = openToolGroup ?? hover;
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
          if (event.key === 'Escape' && openToolGroup) {
            event.preventDefault();
            setOpenToolGroup(null);
            hostRef.current?.focus({ preventScroll: true });
            return;
          }
          if (event.target !== event.currentTarget) return;
          setOpenToolGroup(null);
          if (sceneRef.current?.key(event.key)) event.preventDefault();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) { setFocusedId(null); setOpenToolGroup(null); }
        }}
      >
        <div ref={labelsRef} className="neo-net3d__labels" />
        {phase === 'loading' && <Skeleton height="100%" className="neo-net3d__loading" />}
        {hovered && hover && (
          <div className="neo-graph__tooltip" role="tooltip" style={{ left: Math.max(0, Math.min(hover.x, (hostRef.current?.clientWidth || 640) - 240)), top: Math.max(0, Math.min(hover.y, (hostRef.current?.clientHeight || height) - 120)) }}>
            <span className="neo-kind" data-kind={hovered.kind}>{t(`memory.kind.${hovered.kind}`)}</span>
            <strong>{hovered.sensitivity === 'sensitive' && <Icon name="lock" size={12} />} {hovered.label}</strong>
            <span>{date(hovered.createdAt)} · {t('memory.retention', { pct: Math.round(hovered.retention * 100) })}</span>
          </div>
        )}
        {hoveredToolUses.length > 0 && toolPosition && (
          <div
            className="neo-graph__tooltip"
            role={openToolGroup ? 'dialog' : 'tooltip'}
            aria-label={openToolGroup ? hoveredToolUses.map((event) => toolUseLabels[event.category]).join(', ') : undefined}
            style={{
              left: Math.max(0, Math.min(toolPosition.x, (hostRef.current?.clientWidth || 640) - 240)),
              top: Math.max(0, Math.min(toolPosition.y, (hostRef.current?.clientHeight || height) - 120)),
              pointerEvents: openToolGroup ? 'auto' : 'none', maxHeight: 'min(240px, 70%)', overflowY: 'auto', zIndex: 4,
            }}
          >
            {openToolGroup && <IconButton icon="x" label={t('common.close')} size="sm" onClick={() => { setOpenToolGroup(null); hostRef.current?.focus({ preventScroll: true }); }} />}
            {hoveredToolUses.map((event, index) => openToolGroup ? (
              <button
                key={event.id}
                type="button"
                autoFocus={index === 0}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, width: '100%', marginTop: 4, padding: 6, border: '1px solid var(--neo-border)', borderRadius: 4, background: 'var(--neo-surface)', color: 'var(--neo-text)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
                aria-label={`${toolUseLabels[event.category]}: ${event.title}, ${date(event.at)}`}
                onClick={() => { setOpenToolGroup(null); onToolUseSelect?.(event); hostRef.current?.focus({ preventScroll: true }); }}
              >
                <strong>{event.title}</strong><span>{toolUseLabels[event.category]} · {date(event.at)}</span>
              </button>
            ) : (
              <span key={event.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <strong>{event.title}</strong><span>{toolUseLabels[event.category]} · {date(event.at)}</span>
              </span>
            ))}
          </div>
        )}
        <div className="neo-graph__controls">
          <IconButton icon="zoom-in" label={t('memory.graph_zoom_in')} size="sm" onClick={() => sceneRef.current?.zoom(1.25)} />
          <IconButton icon="zoom-out" label={t('memory.graph_zoom_out')} size="sm" onClick={() => sceneRef.current?.zoom(0.8)} />
          <IconButton icon="maximize" label={t('memory.graph_fit')} size="sm" onClick={() => sceneRef.current?.fit()} />
          <IconButton icon="arrow-up" label={t('memory.graph_jump_now')} size="sm" onClick={() => sceneRef.current?.now()} />
        </div>
        <span className="neo-sr" aria-live="polite">{focusedToolUse ? `${toolUseLabels[focusedToolUse.category]}: ${focusedToolUse.title}, ${date(focusedToolUse.at)}` : focused ? `${focused.label}, ${t(`memory.kind.${focused.kind}`)}, ${date(focused.createdAt)}` : ''}</span>
      </div>
      {showLegend && <GraphLegend />}
    </div>
  );
}
