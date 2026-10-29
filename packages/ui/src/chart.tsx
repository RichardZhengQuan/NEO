/**
 * Hand-written SVG charts for the `chart` block: bar, line, area, pie, donut.
 *
 * - Renders at the container's real pixel width (labels stay legible on phones).
 * - Hover, touch and keyboard (←/→ on the focused chart) show a tooltip.
 * - Stacked bars/areas, negative values, many categories (label thinning).
 * - A visually hidden data table carries the numbers for screen readers.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import type { ChartBlock } from '@neo/protocol';
import { useLocale, useT } from './i18n.js';

const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--neo-chart-${i})`);
const color = (i: number): string => PALETTE[i % PALETTE.length]!;

type X = string | number;

interface Prepared {
  categories: X[];
  /** values[seriesIndex][categoryIndex] (null = missing). */
  values: (number | null)[][];
}

/** Align every series on the union of x values (first-seen order). */
export function prepareSeries(block: ChartBlock): Prepared {
  const categories: X[] = [];
  const seen = new Map<string, number>();
  for (const s of block.series) {
    for (const d of s.data) {
      const key = String(d.x);
      if (!seen.has(key)) {
        seen.set(key, categories.length);
        categories.push(d.x);
      }
    }
  }
  const values = block.series.map((s) => {
    const row: (number | null)[] = categories.map(() => null);
    for (const d of s.data) {
      const i = seen.get(String(d.x));
      if (i !== undefined && Number.isFinite(d.y)) row[i] = d.y;
    }
    return row;
  });
  return { categories, values };
}

/** Round tick values for a [min, max] domain. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.5;
    return niceTicks(Math.min(0, min - pad), Math.max(0, max + pad), count);
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  // Overflow can make both v and the end threshold Infinity; bound by index too.
  for (let i = 0, v = start; i < count + 2 && v <= end + step / 2; i++, v += step) {
    if (!Number.isFinite(v)) break;
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

function useWidth(initial = 560): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

interface TooltipData {
  x: number;
  y: number;
  title: string;
  rows: { name: string; value: string; color: string }[];
}

function Tooltip({ tip }: { tip: TooltipData }): ReactElement {
  return (
    <div className="neo-chart__tooltip" style={{ left: tip.x, top: tip.y }} aria-hidden="true">
      <div className="neo-chart__tooltip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="neo-chart__tooltip-row">
          <span className="neo-legend__swatch" style={{ background: r.color }} />
          <span>{r.name}</span>
          <strong>{r.value}</strong>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { name: string; color: string; value?: string }[] }): ReactElement {
  return (
    <div className="neo-legend">
      {items.map((it, i) => (
        <span key={i} className="neo-legend__item">
          <span className="neo-legend__swatch" style={{ background: it.color }} />
          {it.name}
          {it.value !== undefined && <span className="neo-chart-pie__value">{it.value}</span>}
        </span>
      ))}
    </div>
  );
}

function DataTable({ block, prepared, fmt }: { block: ChartBlock; prepared: Prepared; fmt: (n: number) => string }): ReactElement {
  const t = useT();
  return (
    <table className="neo-sr">
      <caption>{block.title ?? t('chart.caption', { kind: block.kind })}</caption>
      <thead>
        <tr>
          <th scope="col">{block.xLabel ?? t('chart.category')}</th>
          {block.series.map((s, i) => (
            <th key={i} scope="col">
              {s.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {prepared.categories.map((x, ci) => (
          <tr key={ci}>
            <th scope="row">{String(x)}</th>
            {prepared.values.map((row, si) => (
              <td key={si}>{row[ci] === null ? '' : fmt(row[ci]!)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Cartesian (bar / line / area) ─────────────────────────────────────────

function Cartesian({ block, prepared, fmt, axisFmt }: { block: ChartBlock; prepared: Prepared; fmt: (n: number) => string; axisFmt: (n: number, scale?: number) => string }): ReactElement {
  const t = useT();
  const uid = useId().replace(/:/g, '');
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { categories, values: rawValues } = prepared;
  let values = rawValues;
  let valueScale = 1;
  const n = categories.length;
  const kind = block.kind;
  const stacked = Boolean(block.stacked) && (kind === 'bar' || kind === 'area') && values.length > 1;
  if (stacked) {
    let overflow = false;
    for (let c = 0; c < n; c++) {
      let pos = 0;
      let neg = 0;
      for (const row of rawValues) {
        const v = row[c] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      overflow ||= !Number.isFinite(pos) || !Number.isFinite(neg);
    }
    if (overflow) {
      valueScale = Math.max(...rawValues.flatMap((row) => row.map((v) => Math.abs(v ?? 0))));
      values = rawValues.map((row) => row.map((v) => v === null ? null : v / valueScale));
    }
  }

  // Domain
  let lo = Infinity;
  let hi = -Infinity;
  if (stacked) {
    for (let c = 0; c < n; c++) {
      let pos = 0;
      let neg = 0;
      for (const row of values) {
        const v = row[c] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  } else {
    for (const row of values) for (const v of row) if (v !== null) {
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (kind !== 'line' || lo > 0) lo = Math.min(lo, 0);
  if (kind !== 'line' || hi < 0) hi = Math.max(hi, 0);
  const ticks = niceTicks(lo, hi);
  // Extreme finite domains may have no usable ticks, or a bounded tick loop
  // may stop before the last data point. Keep the plotting domain complete.
  const yMin = Math.min(lo, ticks[0] ?? lo);
  const yMax = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const span = yMax - yMin;
  const scale = Math.max(Math.abs(yMin), Math.abs(yMax));

  const height = width < 420 ? 200 : 240;
  const labelChars = Math.max(0, ...ticks.map((v) => axisFmt(v, valueScale).length));
  const pad = { top: 12, right: 12, bottom: block.xLabel ? 44 : 28, left: Math.min(72, 14 + labelChars * 6.6) + (block.yLabel ? 14 : 0) };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const y = (v: number) => {
    // Divide before subtracting when opposite finite extrema overflow their
    // difference. Ordinary domains retain their existing arithmetic/geometry.
    const fraction = Number.isFinite(span)
      ? (v - yMin) / (span || 1)
      : (v / scale - yMin / scale) / (yMax / scale - yMin / scale);
    return pad.top + plotH - fraction * plotH;
  };
  const band = plotW / Math.max(n, 1);
  const xCenter = (i: number) => (kind === 'bar' ? pad.left + band * i + band / 2 : pad.left + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1)));
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 58))));

  const tipFor = (ci: number): TooltipData => {
    const rows = block.series.map((s, si) => ({ name: s.name, value: rawValues[si]![ci] === null ? '—' : fmt(rawValues[si]![ci]!), color: color(si) }));
    const top = Math.min(...values.map((row) => y(Math.max(0, row[ci] ?? 0))));
    return { x: Math.min(Math.max(xCenter(ci), 60), width - 60), y: Math.max(top, 40), title: String(categories[ci]), rows };
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      setActive((a) => (a === null ? (d > 0 ? 0 : n - 1) : (a + d + n) % n));
    } else if (e.key === 'Escape') setActive(null);
  };

  // Bars
  const bars: ReactElement[] = [];
  if (kind === 'bar') {
    const inner = band * (n > 24 ? 0.85 : 0.7);
    const sw = stacked ? inner : inner / values.length;
    for (let ci = 0; ci < n; ci++) {
      let pos = 0;
      let neg = 0;
      values.forEach((row, si) => {
        const v = row[ci];
        if (v === null || v === undefined) return;
        let y0: number;
        let y1: number;
        if (stacked) {
          if (v >= 0) {
            y0 = pos;
            y1 = pos + v;
            pos = y1;
          } else {
            y0 = neg;
            y1 = neg + v;
            neg = y1;
          }
        } else {
          y0 = 0;
          y1 = v;
        }
        const x = pad.left + band * ci + (band - inner) / 2 + (stacked ? 0 : sw * si);
        const top = Math.min(y(y0), y(y1));
        const h = Math.max(1, Math.abs(y(y1) - y(y0)));
        bars.push(
          <rect
            key={`${si}-${ci}`}
            x={x + (stacked ? 0 : 1)}
            y={top}
            width={Math.max(1, sw - (stacked ? 0 : 2))}
            height={h}
            rx={Math.min(4, sw / 4)}
            fill={color(si)}
            opacity={active === null || active === ci ? 1 : 0.45}
          />,
        );
      });
    }
  }

  // Lines / areas
  const lines: ReactElement[] = [];
  if (kind === 'line' || kind === 'area') {
    const cumulativePos = categories.map(() => 0);
    const cumulativeNeg = categories.map(() => 0);
    values.forEach((row, si) => {
      const pts: { x: number; y: number; base: number }[] = [];
      row.forEach((v, ci) => {
        if (v === null) return;
        const base = stacked ? (v >= 0 ? cumulativePos[ci]! : cumulativeNeg[ci]!) : 0;
        const top = base + v;
        if (stacked) {
          if (v >= 0) cumulativePos[ci] = top;
          else cumulativeNeg[ci] = top;
        }
        pts.push({ x: xCenter(ci), y: y(top), base: y(Math.max(yMin, Math.min(yMax, base))) });
      });
      if (pts.length === 0) return;
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
      if (kind === 'area') {
        const back = [...pts].reverse().map((p) => `L${p.x.toFixed(1)} ${p.base.toFixed(1)}`).join('');
        lines.push(<path key={`a${si}`} d={`${line}${back}Z`} fill={`url(#${uid}-g${si})`} />);
      }
      lines.push(<path key={`l${si}`} d={line} fill="none" stroke={color(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
      if (pts.length <= 40 || active !== null) {
        row.forEach((v, ci) => {
          if (v === null) return;
          if (pts.length > 40 && active !== ci) return;
          const p = pts.find((q) => q.x === xCenter(ci));
          if (!p) return;
          lines.push(
            <circle key={`d${si}-${ci}`} cx={p.x} cy={p.y} r={active === ci ? 4.5 : 3} fill="var(--neo-surface)" stroke={color(si)} strokeWidth={2} />,
          );
        });
      }
    });
  }

  return (
    <div ref={ref} className="neo-chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={block.title ?? t('chart.caption', { kind })}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        onPointerMove={(e) => {
          if (!n) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < n; i++) {
            const d = Math.abs(xCenter(i) - px);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          setActive(best);
        }}
      >
        <defs>
          {values.map((_, si) => (
            <linearGradient key={si} id={`${uid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color(si)} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color(si)} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line className="neo-chart__grid" x1={pad.left} x2={pad.left + plotW} y1={y(v)} y2={y(v)} strokeDasharray={v === 0 ? undefined : '3 4'} />
            <text className="neo-chart__axis" x={pad.left - 8} y={y(v) + 4} textAnchor="end">
              {axisFmt(v, valueScale)}
            </text>
          </g>
        ))}
        {active !== null && kind !== 'bar' && (
          <line x1={xCenter(active)} x2={xCenter(active)} y1={pad.top} y2={pad.top + plotH} stroke="var(--neo-border-strong)" strokeDasharray="3 3" />
        )}
        {active !== null && kind === 'bar' && (
          <rect x={pad.left + band * active} y={pad.top} width={band} height={plotH} fill="var(--neo-surface-2)" opacity={0.6} />
        )}
        {bars}
        {lines}
        {categories.map((c, i) =>
          i % labelEvery === 0 ? (
            <text key={i} className="neo-chart__axis" x={xCenter(i)} y={pad.top + plotH + 17} textAnchor="middle">
              {String(c).length > 12 ? `${String(c).slice(0, 11)}…` : String(c)}
            </text>
          ) : null,
        )}
        {block.xLabel && (
          <text className="neo-chart__axis" x={pad.left + plotW / 2} y={height - 6} textAnchor="middle">
            {block.xLabel}
          </text>
        )}
        {block.yLabel && (
          <text className="neo-chart__axis" transform={`translate(11 ${pad.top + plotH / 2}) rotate(-90)`} textAnchor="middle">
            {block.yLabel}
          </text>
        )}
      </svg>
      {active !== null && <Tooltip tip={tipFor(active)} />}
      {values.length > 1 && <Legend items={block.series.map((s, i) => ({ name: s.name, color: color(i) }))} />}
    </div>
  );
}

// ── Pie / donut ───────────────────────────────────────────────────────────

/** Accumulate an overflowed signed group without losing cancellation remainders. */
function overflowedGroup(values: number[]): { value: number; scale: number } {
  const bits = new DataView(new ArrayBuffer(8));
  const fractionMask = (1n << 52n) - 1n;
  let units = 0n;
  for (const value of values) {
    if (!Number.isFinite(value) || value === 0) continue;
    bits.setFloat64(0, value);
    const word = bits.getBigUint64(0);
    const exponent = Number((word >> 52n) & 0x7ffn);
    const significand = (word & fractionMask) | (exponent === 0 ? 0n : 1n << 52n);
    // Every finite double is an integer multiple of 2^-1074. Exact integer
    // addition preserves tiny terms even when huge terms later cancel out.
    const term = significand << BigInt(Math.max(0, exponent - 1));
    units += value < 0 ? -term : term;
  }
  if (units <= 0n) return { value: 0, scale: 1 };
  const shift = Math.max(0, units.toString(2).length - 53);
  let top = units >> BigInt(shift);
  if (shift > 0) {
    const remainder = units - (top << BigInt(shift));
    const halfway = 1n << BigInt(shift - 1);
    if (remainder > halfway || (remainder === halfway && (top & 1n) === 1n)) top++;
  }
  const coefficient = Number(top);
  const finite = coefficient * 2 ** (shift - 1074);
  if (Number.isFinite(finite)) return { value: finite, scale: 1 };
  // Keep unrepresentable positive totals as two finite factors for geometry
  // and scientific labels; never turn the total back into Infinity.
  return { value: coefficient * 2 ** (shift - 2097), scale: 2 ** 1023 };
}

function Pie({ block, prepared, fmt, aggregateFmt, donut }: { block: ChartBlock; prepared: Prepared; fmt: (n: number) => string; aggregateFmt: (n: number, scale: number) => string; donut: boolean }): ReactElement {
  const t = useT();
  const [active, setActive] = useState<number | null>(null);
  // One series: its points are the slices. Several series: one slice per series total.
  const { slices, valueScale, rawLabels } = useMemo(() => {
    let overflow = false;
    const makeSlices = (scale: number) => {
      if (block.series.length === 1) {
        return prepared.categories.map((c, i) => ({ name: String(c), value: Math.max(0, (prepared.values[0]![i] ?? 0) / scale) }));
      }
      return block.series.map((s) => {
        let value = 0;
        for (const d of s.data) {
          value += Number.isFinite(d.y) ? d.y / scale : 0;
          overflow ||= !Number.isFinite(value);
        }
        return { name: s.name, value: Math.max(0, value) };
      });
    };
    const raw = makeSlices(1);
    overflow ||= !Number.isFinite(raw.reduce((sum, s) => sum + s.value, 0));
    if (!overflow) return { slices: raw, valueScale: 1, rawLabels: null };
    // Scale before either per-series or overall sums overflow. A common scale
    // preserves proportions, including signed cancellation within a series.
    if (block.series.length === 1) {
      const scale = Math.max(...raw.map((s) => s.value));
      return { slices: makeSlices(scale), valueScale: scale, rawLabels: raw.map((s) => ({ value: s.value, scale: 1 })) };
    }
    const groups = block.series.map((s) => {
      let value = 0;
      let groupOverflow = false;
      for (const d of s.data) {
        value += Number.isFinite(d.y) ? d.y : 0;
        groupOverflow ||= !Number.isFinite(value);
      }
      // Keep finite aggregates intact: scaling their large cancelling terms
      // first could underflow an otherwise representable tiny remainder.
      if (!groupOverflow) return { value: Math.max(0, value), scale: 1 };
      return overflowedGroup(s.data.map((d) => d.y));
    });
    // A discarded negative group must not set the scale: doing so could erase
    // an unrelated tiny positive slice. Determine signs at each group's scale.
    const scale = Math.max(0, ...groups.map((group) => group.value > 0 ? (group.scale === 1 ? group.value : group.scale) : 0));
    if (scale === 0) return { slices: raw.map((s) => ({ ...s, value: 0 })), valueScale: 1, rawLabels: null };
    const slices = block.series.map((s, i) => ({
      name: s.name,
      value: groups[i]!.scale === 1 ? groups[i]!.value / scale : groups[i]!.value * (groups[i]!.scale / scale),
    }));
    return { slices, valueScale: scale, rawLabels: groups };
  }, [block.series, prepared]);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const displayValue = (v: number) => valueScale === 1 && Math.abs(v) < 1e21 ? fmt(v) : aggregateFmt(v, valueScale);
  const R = 90;
  const RI = donut ? 56 : 0;
  const C = 100;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const sweep = total > 0 ? (s.value / total) * Math.PI * 2 : 0;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    if (sweep >= Math.PI * 2 - 1e-6) {
      // Full circle: two halves (an arc cannot start and end at the same point).
      const d = donut
        ? `M${C - R} ${C}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0ZM${C - RI} ${C}a${RI} ${RI} 0 1 1 ${2 * RI} 0a${RI} ${RI} 0 1 1 ${-2 * RI} 0Z`
        : `M${C - R} ${C}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0Z`;
      return { d, i };
    }
    const large = sweep > Math.PI ? 1 : 0;
    const p = (r: number, a: number) => `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
    const d = donut
      ? `M${p(R, a0)}A${R} ${R} 0 ${large} 1 ${p(R, a1)}L${p(RI, a1)}A${RI} ${RI} 0 ${large} 0 ${p(RI, a0)}Z`
      : `M${C} ${C}L${p(R, a0)}A${R} ${R} 0 ${large} 1 ${p(R, a1)}Z`;
    return { d, i };
  });
  const pct = (v: number) => (total > 0 ? `${Math.round((v / total) * 100)}%` : '0%');
  const shown = active === null ? null : slices[active];

  return (
    <div className="neo-chart neo-chart-pie">
      <svg
        viewBox="0 0 200 200"
        role="img"
        aria-label={block.title ?? t('chart.caption', { kind: block.kind })}
        tabIndex={0}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (!slices.length) return;
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const d = e.key === 'ArrowRight' ? 1 : -1;
            setActive((a) => (a === null ? 0 : (a + d + slices.length) % slices.length));
          }
        }}
      >
        {arcs.map(({ d, i }) => (
          <path
            key={i}
            d={d}
            fill={color(i)}
            fillRule="evenodd"
            stroke="var(--neo-surface)"
            strokeWidth={1.5}
            opacity={active === null || active === i ? 1 : 0.4}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
            style={{ transition: 'opacity 150ms ease' }}
          />
        ))}
        {donut && (
          <>
            <text x={C} y={C - 2} textAnchor="middle" fontSize={shown ? 13 : 18} fontWeight={700} fill="var(--neo-text)">
              {shown ? pct(shown.value) : displayValue(total)}
            </text>
            <text x={C} y={C + 16} textAnchor="middle" fontSize={10} fill="var(--neo-text-muted)">
              {shown ? (shown.name.length > 16 ? `${shown.name.slice(0, 15)}…` : shown.name) : t('chart.total')}
            </text>
          </>
        )}
      </svg>
      <Legend items={slices.map((s, i) => ({ name: s.name, color: color(i), value: `${rawLabels ? aggregateFmt(rawLabels[i]!.value, rawLabels[i]!.scale) : displayValue(s.value)} · ${pct(s.value)}` }))} />
    </div>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────

export function ChartRenderer({ block }: { block: ChartBlock }): ReactElement {
  const locale = useLocale();
  const prepared = useMemo(() => prepareSeries(block), [block]);
  const unit = block.unit ? ` ${block.unit}` : '';
  const fmt = (v: number) => {
    try {
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v)}${unit}`;
    } catch {
      return `${v}${unit}`;
    }
  };
  const scaledFmt = (v: number, scale: number) => {
    if (v === 0) return '0';
    // Compose the exponent as text: multiplying back by scale could overflow.
    const [scaleMantissa, scaleExponent] = scale.toExponential(16).split('e');
    const [mantissa, exponent] = (v * Number(scaleMantissa)).toExponential(2).split('e');
    let coefficient = String(Number(mantissa));
    try { coefficient = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(mantissa)); } catch { /* numeric fallback */ }
    return `${coefficient}E${Number(exponent) + Number(scaleExponent)}`;
  };
  const axisFmt = (v: number, scale = 1) => {
    if (scale !== 1) return scaledFmt(v, scale);
    const extreme = Math.abs(v) >= 1e21;
    try {
      // Compact suffixes stop scaling at a locale's largest named magnitude;
      // scientific notation keeps extreme axes inside their bounded gutter.
      return new Intl.NumberFormat(locale, { notation: extreme ? 'scientific' : Math.abs(v) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(v);
    } catch {
      return extreme ? v.toExponential(2) : String(v);
    }
  };
  const isPie = block.kind === 'pie' || block.kind === 'donut';
  return (
    <figure className="neo-figure" style={{ minWidth: 0 }}>
      {block.title && (
        <figcaption className="neo-block-title" style={{ marginTop: 0 }}>
          {block.title}
          {block.unit && <span style={{ color: 'var(--neo-text-muted)', fontWeight: 400 }}> ({block.unit})</span>}
        </figcaption>
      )}
      {isPie ? (
        <Pie block={block} prepared={prepared} fmt={fmt} aggregateFmt={(v, scale) => `${scaledFmt(v, scale)}${unit}`} donut={block.kind === 'donut'} />
      ) : (
        <Cartesian block={block} prepared={prepared} fmt={(v) => Math.abs(v) >= 1e21 ? `${axisFmt(v)}${unit}` : fmt(v)} axisFmt={axisFmt} />
      )}
      <DataTable block={block} prepared={prepared} fmt={fmt} />
    </figure>
  );
}
