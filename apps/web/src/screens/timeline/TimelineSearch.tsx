import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { TimelineSearchHit, TimelineSearchSnippet } from '@neo/protocol';
import { Button, Modal, Spinner, TextField, useLocale, useT } from '@neo/ui';
import { useSession, currentSessionEpoch, isCurrentSession } from '../../state/session.js';

function SearchSnippet({ snippet }: { snippet: TimelineSearchSnippet }): ReactElement {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const [start, end] of snippet.highlights) {
    parts.push(snippet.text.slice(offset, start), <mark key={start}>{snippet.text.slice(start, end)}</mark>);
    offset = end;
  }
  return <span>{parts}{snippet.text.slice(offset)}</span>;
}

export function TimelineSearch({ onClose, onJump }: { onClose: () => void; onJump: (messageId: string) => Promise<void> }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const client = useSession((s) => s.client);
  const timezone = useSession((s) => s.settings?.timezone);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TimelineSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [jumping, setJumping] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    const epoch = currentSessionEpoch();
    setHits([]);
    setError(false);
    setLoading(Boolean(query.trim()));
    const timer = setTimeout(() => {
      if (!query.trim() || !client) { setLoading(false); return; }
      void client.timeline.search(query.trim(), 50).then((data) => {
        if (!disposed && isCurrentSession(epoch, client)) setHits(data.items);
      }).catch(() => {
        if (!disposed && isCurrentSession(epoch, client)) setError(true);
      }).finally(() => {
        if (!disposed) setLoading(false);
      });
    }, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [query, client]);

  const jump = async (id: string) => {
    setJumping(true);
    setError(false);
    try { await onJump(id); onClose(); }
    catch { setError(true); }
    finally { setJumping(false); }
  };
  return (
    <Modal open title={t('timeline.search')} onClose={onClose}>
      <TextField label={t('timeline.search_query')} value={query} onChange={setQuery} type="search" />
      {loading && <div className="timeline-search-status" role="status"><Spinner size={18} />{t('common.loading')}</div>}
      {error && <p role="alert">{t('timeline.search_error')}</p>}
      {!loading && !error && query.trim() && hits.length === 0 && <p className="neo-help">{t('timeline.search_empty')}</p>}
      <ul className="timeline-search-results" aria-label={t('timeline.search_results')}>
        {hits.map((hit) => (
          <li key={hit.messageId}>
            <Button variant="ghost" className="timeline-search-hit" disabled={jumping} onClick={() => void jump(hit.messageId)}>
              <SearchSnippet snippet={hit.snippet} />
              <time dateTime={new Date(hit.createdAt).toISOString()}>{new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(hit.createdAt)}</time>
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
