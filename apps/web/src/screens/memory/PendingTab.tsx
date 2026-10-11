/**
 * Memories waiting for approval, one by one or in bulk.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { MemoryNode } from '@neo/protocol';
import { Button, EmptyState, MemoryNodeCard, Skeleton, useT } from '@neo/ui';
import { openLink } from '../../actions/links.js';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage } from '../../lib/errors.js';
import { bumpMemoryVersion, refreshPendingMemories, useData } from '../../state/data.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient, useSession } from '../../state/session.js';

export function PendingTab({ onSelect }: { onSelect: (id: string) => void }): ReactElement {
  const t = useT();
  const version = useData((s) => s.memoryVersion);
  const mode = useSession((s) => s.settings?.memory.mode);
  const loader = useLoader(async () => (await requireClient().memory.search({ status: ['pending'], limit: 200, sort: 'recent' })).items, [version]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const items: MemoryNode[] = loader.data ?? [];

  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => items.some((n) => n.id === id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader.data]);

  const decide = async (ids: string[], approve: boolean, key: string) => {
    if (!ids.length) return;
    setBusy(key);
    try {
      const client = requireClient();
      const res = approve ? await client.memory.approve(ids) : await client.memory.reject(ids);
      pushToast({ tone: 'success', title: approve ? t('memoryPending.approved', { n: res.count }) : t('memoryPending.rejected', { n: res.count }) });
      loader.setData((prev) => prev?.filter((n) => !ids.includes(n.id)));
      bumpMemoryVersion();
      void refreshPendingMemories(client);
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(null);
    }
  };

  if (loader.data === undefined) {
    return (
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <Skeleton height={96} style={{ borderRadius: 16 }} />
        <Skeleton height={96} style={{ borderRadius: 16 }} />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon="check-circle"
        title={t('memoryPending.empty')}
        description={mode === 'approve' ? t('memoryPending.empty_approve') : t('memoryPending.empty_auto')}
        action={
          mode !== 'approve' ? (
            <Button variant="secondary" onClick={() => openLink('neo://settings/memory')}>
              {t('memoryPending.change_mode')}
            </Button>
          ) : undefined
        }
      />
    );
  }

  const ids = selected.size ? [...selected] : items.map((n) => n.id);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className="neo-card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 0.75rem' }}>
        <label className="neo-check-row" style={{ flex: 1, minWidth: '10rem' }}>
          <input
            type="checkbox"
            className="neo-checkbox"
            checked={selected.size === items.length}
            ref={(el) => {
              if (el) el.indeterminate = selected.size > 0 && selected.size < items.length;
            }}
            onChange={(e) => setSelected(e.target.checked ? new Set(items.map((n) => n.id)) : new Set())}
          />
          {selected.size ? t('memoryPending.selected', { n: selected.size }) : t('memoryPending.count', { n: items.length })}
        </label>
        <Button size="sm" variant="primary" icon="check" loading={busy === 'approve'} disabled={busy !== null} onClick={() => void decide(ids, true, 'approve')}>
          {selected.size ? t('memoryPending.approve_selected') : t('memoryPending.approve_all')}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'reject'} disabled={busy !== null} onClick={() => void decide(ids, false, 'reject')}>
          {selected.size ? t('memoryPending.reject_selected') : t('memoryPending.reject_all')}
        </Button>
      </div>
      {items.map((node) => (
        <div key={node.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem' }}>
          <input
            type="checkbox"
            className="neo-checkbox"
            style={{ marginTop: '1rem' }}
            aria-label={t('memoryPending.select', { label: node.label })}
            checked={selected.has(node.id)}
            onChange={(e) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (e.target.checked) next.add(node.id);
                else next.delete(node.id);
                return next;
              })
            }
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <MemoryNodeCard node={node} onOpen={() => onSelect(node.id)} onApprove={() => void decide([node.id], true, `a:${node.id}`)} onReject={() => void decide([node.id], false, `r:${node.id}`)} />
          </div>
        </div>
      ))}
    </div>
  );
}
