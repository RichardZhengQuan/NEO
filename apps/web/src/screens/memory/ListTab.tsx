/**
 * Memories as a searchable, filterable list (paged).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { MEMORY_KINDS, SELF_MEMORY_ID, type MemoryKind, type MemoryNode, type MemorySearchQuery, type MemoryStatus } from '@neo/protocol';
import { Button, Chip, EmptyState, MemoryNodeCard, Select, Skeleton, TextField, useT } from '@neo/ui';
import { useDebounced } from '../../hooks/useLoader.js';
import { errorMessage } from '../../lib/errors.js';
import { bumpMemoryVersion, useData } from '../../state/data.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient } from '../../state/session.js';

type StatusFilter = MemoryStatus | 'all';
type Sort = NonNullable<MemorySearchQuery['sort']>;
const PAGE = 40;

const STATUS_QUERY: Record<StatusFilter, MemoryStatus[] | undefined> = {
  active: ['active'],
  archived: ['archived'],
  superseded: ['superseded'],
  all: ['active', 'archived', 'superseded'],
};

export function ListTab({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }): ReactElement {
  const t = useT();
  const version = useData((s) => s.memoryVersion);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | MemoryKind>('all');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [sort, setSort] = useState<Sort>('recent');
  const [pinned, setPinned] = useState(false);
  const [items, setItems] = useState<MemoryNode[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const q = useDebounced(query.trim(), 300);

  const buildQuery = (offset: number): MemorySearchQuery => ({
    limit: PAGE,
    offset,
    sort: q && sort === 'recent' ? 'relevance' : sort,
    ...(q ? { query: q } : {}),
    ...(kind !== 'all' ? { kinds: [kind] } : {}),
    ...(STATUS_QUERY[status] ? { status: STATUS_QUERY[status] } : {}),
    ...(pinned ? { pinned: true } : {}),
  });

  useEffect(() => {
    let cancelled = false;
    requireClient()
      .memory.search(buildQuery(0))
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total ?? res.items.length);
      })
      .catch((err) => {
        if (!cancelled) pushToast({ tone: 'error', title: errorMessage(err, t) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind, status, sort, pinned, version]);

  const loadMore = async () => {
    if (!items) return;
    setLoadingMore(true);
    try {
      const res = await requireClient().memory.search(buildQuery(items.length));
      setItems([...items, ...res.items.filter((n) => !items.some((m) => m.id === n.id))]);
      setTotal(res.total ?? total);
    } finally {
      setLoadingMore(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      bumpMemoryVersion();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };
  const client = requireClient();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'grid', gap: '0.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', alignItems: 'end' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField size="sm" type="search" icon="search" value={query} onChange={setQuery} ariaLabel={t('memoryList.search')} placeholder={t('memoryList.search')} />
        </div>
        <Select size="sm" ariaLabel={t('memoryList.kind')} value={kind} onChange={(v) => setKind(v as 'all' | MemoryKind)} options={[{ value: 'all', label: t('memoryList.all_kinds') }, ...MEMORY_KINDS.map((k) => ({ value: k, label: t(`memory.kind.${k}`) }))]} />
        <Select
          size="sm"
          ariaLabel={t('memoryList.status')}
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
          options={(['active', 'archived', 'superseded', 'all'] as const).map((s) => ({ value: s, label: t(`memoryList.status_${s}`) }))}
        />
        <Select size="sm" ariaLabel={t('memoryList.sort')} value={sort} onChange={(v) => setSort(v as Sort)} options={(['recent', 'importance', 'strength', 'relevance'] as const).map((s) => ({ value: s, label: t(`memoryList.sort_${s}`) }))} />
        <Chip pressed={pinned} onClick={() => setPinned((v) => !v)} icon="pin">
          {t('memoryList.pinned_only')}
        </Chip>
      </div>
      {items === null ? (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={84} style={{ borderRadius: 16 }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon="search" title={q ? t('memoryList.no_results') : t('memoryList.empty')} description={q ? undefined : t('memoryList.empty_hint')} />
      ) : (
        <>
          <p className="neo-help" style={{ margin: 0 }}>
            {t('memoryList.count', { n: total })}
          </p>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {items.map((node) => (
              <MemoryNodeCard
                key={node.id}
                node={node}
                compact
                selected={node.id === selectedId}
                onOpen={() => onSelect(node.id)}
                onTogglePin={node.id === SELF_MEMORY_ID ? undefined : () => void act(() => client.memory.update(node.id, { pinned: !node.pinned }))}
                onRestore={() => void act(() => client.memory.update(node.id, { status: 'active' }))}
                onForget={node.id === SELF_MEMORY_ID ? undefined : () => void act(() => client.memory.forget([node.id]))}
              />
            ))}
          </div>
          {items.length < total && (
            <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore} block>
              {t('memoryList.load_more')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
