/**
 * The memory net: the graph with kind filters, archived toggle, search that
 * highlights matches, and "focus" on one memory's neighborhood.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { MEMORY_KINDS, type MemoryKind } from '@neo/protocol';
import { Button, Chip, EmptyState, GraphLegend, IconButton, MemoryGraphView, Skeleton, Switch, TextField, useT } from '@neo/ui';
import { useDebounced, useLoader } from '../../hooks/useLoader.js';
import { useIsDesktop } from '../../hooks/useMediaQuery.js';
import { useData } from '../../state/data.js';
import { requireClient } from '../../state/session.js';

/** Where the net will grow: you at the centre, the first memories still faint around you. */
function NetSeed(): ReactElement {
  const t = useT();
  const ghosts: { kind: MemoryKind; angle: number; dist: number }[] = [
    { kind: 'preference', angle: -150, dist: 62 },
    { kind: 'entity', angle: -95, dist: 54 },
    { kind: 'fact', angle: -35, dist: 66 },
    { kind: 'goal', angle: 25, dist: 58 },
    { kind: 'episode', angle: 95, dist: 50 },
    { kind: 'skill', angle: 155, dist: 60 },
  ];
  const at = (g: { angle: number; dist: number }) => ({ x: 120 + Math.cos((g.angle * Math.PI) / 180) * g.dist * 1.35, y: 78 + Math.sin((g.angle * Math.PI) / 180) * g.dist });
  return (
    <svg className="net-seed" viewBox="0 0 240 156" width="240" height="156" aria-hidden="true">
      {ghosts.map((g, i) => {
        const p = at(g);
        const next = at(ghosts[(i + 1) % ghosts.length]!);
        return (
          <g key={g.kind}>
            <line x1="120" y1="78" x2={p.x} y2={p.y} className="net-seed__link" />
            {i % 2 === 0 && <line x1={p.x} y1={p.y} x2={next.x} y2={next.y} className="net-seed__link net-seed__link--faint" />}
            <circle cx={p.x} cy={p.y} r="7" className="net-seed__ghost" style={{ fill: `var(--neo-kind-${g.kind})` }} />
          </g>
        );
      })}
      <circle cx="120" cy="78" r="22" className="net-seed__halo" />
      <circle cx="120" cy="78" r="14" className="net-seed__self" />
      <text x="120" y="112" textAnchor="middle" className="net-seed__label">{t('memory.self')}</text>
    </svg>
  );
}

export function NetTab({ selectedId, onSelect, focusId, onFocus }: { selectedId: string | null; onSelect: (id: string | null) => void; focusId: string | null; onFocus: (id: string | null) => void }): ReactElement {
  const t = useT();
  const desktop = useIsDesktop();
  const version = useData((s) => s.memoryVersion);
  const [kinds, setKinds] = useState<MemoryKind[]>([...MEMORY_KINDS]);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);

  const allKinds = kinds.length === MEMORY_KINDS.length;
  const graph = useLoader(
    () =>
      requireClient().memory.graph({
        limit: 200,
        includeArchived: archived,
        ...(allKinds ? {} : { kinds }),
        ...(focusId ? { centerId: focusId, depth: 2 } : {}),
      }),
    [version, archived, kinds.join(','), focusId],
  );
  const matches = useLoader(async () => (q ? (await requireClient().memory.search({ query: q, limit: 30, status: ['active', ...(archived ? (['archived'] as const) : [])] })).items.map((n) => n.id) : []), [q, version, archived]);

  const highlight = useMemo(() => matches.data ?? [], [matches.data]);
  const toggleKind = (k: MemoryKind) => setKinds((prev) => (prev.includes(k) ? (prev.length === 1 ? prev : prev.filter((x) => x !== k)) : [...prev, k]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
        <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
          <TextField
            size="sm"
            type="search"
            icon="search"
            value={query}
            onChange={setQuery}
            ariaLabel={t('memoryNet.search')}
            placeholder={t('memoryNet.search')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && highlight[0]) onSelect(highlight[0]);
            }}
          />
        </div>
        <Switch checked={archived} onChange={setArchived} label={t('memoryNet.show_archived')} />
        <IconButton icon="refresh" label={t('common.refresh')} onClick={() => void graph.reload()} loading={graph.loading && graph.data !== undefined} />
      </div>
      <div className="neo-tags" role="group" aria-label={t('memoryNet.filter_kinds')}>
        {MEMORY_KINDS.map((k) => (
          <Chip key={k} size="sm" pressed={kinds.includes(k)} onClick={() => toggleKind(k)}>
            <span className="neo-kind-dot" data-kind={k} />
            {t(`memory.kind.${k}`)}
          </Chip>
        ))}
        {!allKinds && (
          <Chip size="sm" onClick={() => setKinds([...MEMORY_KINDS])}>
            {t('memoryNet.all_kinds')}
          </Chip>
        )}
      </div>
      {focusId && (
        <div className="neo-callout" data-tone="accent" style={{ alignItems: 'center' }}>
          <p style={{ margin: 0, flex: 1, fontSize: '0.875rem' }}>{t('memoryNet.focused')}</p>
          <Button size="sm" variant="secondary" onClick={() => onFocus(null)}>
            {t('memoryNet.whole_net')}
          </Button>
        </div>
      )}
      {graph.data === undefined ? (
        graph.error ? (
          <EmptyState icon="alert-circle" title={t('common.error')} action={<Button onClick={() => void graph.reload()}>{t('common.retry')}</Button>} />
        ) : (
          <Skeleton height={desktop ? 540 : 420} style={{ borderRadius: 20 }} />
        )
      ) : graph.data.nodes.length === 0 ? (
        <EmptyState art={<NetSeed />} title={t('memoryNet.empty_title')} description={t('memoryNet.empty_text')} />
      ) : (
        <>
          <MemoryGraphView graph={graph.data} selectedId={selectedId} highlightIds={highlight} onSelect={onSelect} height={desktop ? 540 : 420} showLegend={false} />
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <GraphLegend />
            <span className="neo-help">{t('memoryNet.counts', { nodes: graph.data.nodes.length, edges: graph.data.edges.length })}</span>
          </div>
          <p className="neo-help" style={{ margin: 0 }}>
            {t('memoryNet.hint')}
          </p>
        </>
      )}
    </div>
  );
}
