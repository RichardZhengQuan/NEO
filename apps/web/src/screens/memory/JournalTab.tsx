/**
 * The dream journal: what consolidation ("sleep") changed in the net, as a
 * readable diary, plus "Consolidate now".
 */
import { useState, type ReactElement } from 'react';
import type { ConsolidationReport } from '@neo/protocol';
import { Badge, Button, EmptyState, Icon, Skeleton, formatDateTime, formatRelative, useLocale, useT } from '@neo/ui';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage } from '../../lib/errors.js';
import { bumpMemoryVersion, useData } from '../../state/data.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient } from '../../state/session.js';

const COUNTS: { key: keyof ConsolidationReport; icon: string }[] = [
  { key: 'factsCreated', icon: 'lightbulb' },
  { key: 'episodesConsolidated', icon: 'layers' },
  { key: 'linksCreated', icon: 'link' },
  { key: 'entitiesMerged', icon: 'users' },
  { key: 'archived', icon: 'archive' },
  { key: 'edgesPruned', icon: 'unlink' },
];

export function JournalEntry({ report }: { report: ConsolidationReport }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const seconds = Math.max(0, (report.finishedAt - report.startedAt) / 1000);
  const counts = COUNTS.filter((c) => Number(report[c.key]) > 0);
  return (
    <article className="journal-entry">
      <span className="journal-entry__dot" aria-hidden="true">
        <Icon name="moon-star" size={10} />
      </span>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0.25rem 0.625rem' }}>
        <h3 style={{ margin: 0, fontSize: '0.9688rem', fontWeight: 650 }}>{formatDateTime(report.finishedAt, locale)}</h3>
        <span className="neo-help">
          {formatRelative(report.finishedAt, locale)} · {t('journal.took', { s: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds) })}
        </span>
      </header>
      {report.notes.length ? (
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.125rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.9063rem', lineHeight: 1.55 }}>
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : (
        <p className="neo-help" style={{ margin: '0.375rem 0 0' }}>
          {t('journal.quiet_night')}
        </p>
      )}
      {counts.length > 0 && (
        <div className="neo-tags" style={{ marginTop: '0.625rem' }}>
          {counts.map((c) => (
            <Badge key={c.key} icon={c.icon} tone={c.key === 'factsCreated' ? 'accent' : 'neutral'}>
              {t(`journal.count_${c.key}`, { n: Number(report[c.key]) })}
            </Badge>
          ))}
        </div>
      )}
    </article>
  );
}

export function JournalTab(): ReactElement {
  const t = useT();
  const version = useData((s) => s.memoryVersion);
  const loader = useLoader(async () => (await requireClient().memory.journal(50)).items, [version]);
  const [running, setRunning] = useState(false);

  const consolidate = async () => {
    setRunning(true);
    try {
      const report = await requireClient().memory.consolidate();
      loader.setData((prev) => [report, ...(prev ?? []).filter((r) => r.id !== report.id)]);
      pushToast({ tone: 'success', icon: 'moon-star', title: t('journal.done'), body: report.notes[0] ?? t('journal.quiet_night') });
      bumpMemoryVersion();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setRunning(false);
    }
  };

  const reports = loader.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="neo-card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
        <span className="neo-card__icon" style={{ background: 'var(--neo-accent-muted)', color: 'var(--neo-accent-text)' }}>
          <Icon name="moon-star" size={17} />
        </span>
        <p style={{ margin: 0, flex: '1 1 16rem', fontSize: '0.875rem', color: 'var(--neo-text-muted)', lineHeight: 1.55 }}>{t('journal.intro')}</p>
        <Button variant="primary" icon="moon" onClick={() => void consolidate()} loading={running}>
          {t('journal.consolidate')}
        </Button>
      </div>
      {reports === undefined ? (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Skeleton height={80} />
          <Skeleton height={80} />
        </div>
      ) : reports.length === 0 ? (
        <EmptyState icon="moon-star" title={t('journal.empty_title')} description={t('journal.empty_text')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {reports.map((r) => (
            <JournalEntry key={r.id} report={r} />
          ))}
        </div>
      )}
    </div>
  );
}
