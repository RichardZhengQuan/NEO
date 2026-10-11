/**
 * A small illustration of the memory net: kinds as colored nodes, associations
 * as lines, and a pulse of "spreading activation" travelling along them.
 */
import type { ReactElement } from 'react';

const NODES: { x: number; y: number; r: number; kind: string }[] = [
  { x: 150, y: 70, r: 15, kind: 'entity' },
  { x: 70, y: 40, r: 9, kind: 'fact' },
  { x: 60, y: 112, r: 10, kind: 'preference' },
  { x: 236, y: 46, r: 10, kind: 'goal' },
  { x: 236, y: 112, r: 9, kind: 'episode' },
  { x: 150, y: 140, r: 8, kind: 'skill' },
  { x: 290, y: 80, r: 7, kind: 'summary' },
  { x: 16, y: 74, r: 6, kind: 'fact' },
];
const EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  [3, 6],
  [4, 6],
  [1, 7],
  [2, 7],
  [4, 5],
];

export function MemoryNetArt({ className, label }: { className?: string; label?: string }): ReactElement {
  return (
    <svg className={['net-art', className].filter(Boolean).join(' ')} viewBox="0 0 306 160" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ width: '100%', height: 'auto', maxWidth: 360 }}>
      {EDGES.map(([a, b], i) => {
        const p = NODES[a]!;
        const q = NODES[b]!;
        return <line key={i} className="net-edge" x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
      })}
      {[0, 3].map((i) => {
        const p = NODES[0]!;
        const q = NODES[EDGES[i]![1]]!;
        return <line key={`p${i}`} className="net-pulse" x1={p.x} y1={p.y} x2={q.x} y2={q.y} style={{ animationDelay: `${i * 0.6}s` }} />;
      })}
      {NODES.map((n, i) => (
        <g key={i} className="net-node" data-kind={n.kind} style={{ animationDelay: `${i * 0.35}s` }}>
          <circle cx={n.x} cy={n.y} r={n.r + 4} style={{ fill: 'var(--k)', opacity: 0.16 }} />
          <circle cx={n.x} cy={n.y} r={n.r} style={{ fill: 'var(--k)' }} />
        </g>
      ))}
    </svg>
  );
}
