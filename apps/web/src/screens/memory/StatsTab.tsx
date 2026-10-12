/**
 * Memory statistics: totals, kinds (chart), statuses, last consolidation and
 * the embedding model.
 */
import type { ReactElement } from 'react';
import { MEMORY_KINDS, type MemoryStatus } from '@neo/protocol';
import { ChartRenderer, EmptyState, Icon, Skeleton, formatDateTime, formatNumber, formatRelative, useLocale, useT } from '@neo/ui';
import { useLoader } from '../../hooks/useLoader.js';
import { useData } from '../../state/data.js';
import { requireClient } from '../../state/session.js';

const STATUSES: MemoryStatus[] = ['active', 'archived', 'superseded'];

function Tile({ icon, label, value, caption }: { icon: string; label: string; value: string; caption?: string }): ReactElement {
  return (
    <div className="neo-card neo-stat">
      <div className="neo-stat__label">
        <Icon name={icon} size={15} />
        {label}
      </div>
      <div className="neo-stat__value" style={{ fontSize: '1.5rem' }}>
        {value}
      </div>
      {caption && <div className="neo-stat__caption">{caption}</div>}
    </div>
  );
}

export function StatsTab(): ReactElement {
  const t = useT();
  const locale = useLocale();
  const version = useData((s) => s.memoryVersion);
  const loader = useLoader(() => requireClient().memory.stats(), [version]);
  const stats = loader.data;
  if (!stats) {
    return loader.error ? (
      <EmptyState icon="alert-circle" title={t('common.error')} />
    ) : (
      <div className="stat-grid">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={92} style={{ borderRadius: 16 }} />
        ))}
      </div>
    );
  }
  const n = (v: number) => formatNumber(v, locale);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="stat-grid">
        <Tile icon="brain" label={t('stats.total')} value={n(stats.total)} caption={t('stats.active', { n: n(stats.byStatus.active ?? 0) })} />
        <Tile icon="link" label={t('stats.links')} value={n(stats.edges)} />
        <Tile
          icon="moon-star"
          label={t('stats.last_consolidation')}
          value={stats.lastConsolidationAt ? formatRelative(stats.lastConsolidationAt, locale) : t('stats.never')}
          caption={stats.lastConsolidationAt ? formatDateTime(stats.lastConsolidationAt, locale) : undefined}
        />
      </div>
      <section className="neo-card">
        <ChartRenderer
          block={{
            type: 'chart',
            kind: 'bar',
            title: t('stats.by_kind'),
            series: [{ name: t('stats.memories'), data: MEMORY_KINDS.map((k) => ({ x: t(`memory.kind.${k}`), y: stats.byKind[k] ?? 0 })) }],
          }}
        />
      </section>
      <section className="neo-card">
        <h3 className="neo-block-title">{t('stats.by_status')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {STATUSES.map((s) => {
            const count = stats.byStatus[s] ?? 0;
            const pct = stats.total ? Math.round((count / stats.total) * 100) : 0;
            return (
              <div key={s}>
                <div className="neo-progress__head">
                  <span>{t(`memory.status.${s}`)}</span>
                  <span style={{ color: 'var(--neo-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {n(count)} · {pct}%
                  </span>
                </div>
                <div className="neo-meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t(`memory.status.${s}`)}>
                  <div className="neo-meter__fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <p className="neo-help" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', margin: 0 }}>
        <Icon name="cpu" size={14} />
        {t('stats.embedding', { model: stats.embeddingModel })}
      </p>
    </div>
  );
}
