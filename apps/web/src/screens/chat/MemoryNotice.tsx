/**
 * Shown under an assistant message after memory write-back: pending memories
 * to approve or reject ("NEO wants to remember 2 things"), or a quiet note of
 * what was remembered automatically.
 */
import { useState, type ReactElement } from 'react';
import { Button, Icon, IconButton, useT } from '@neo/ui';
import { decidePendingMemories } from '../../actions/chat.js';
import { openLink } from '../../actions/links.js';
import type { MemoryNotice as Notice } from '../../state/conversations.js';
import { requireClient, useSession } from '../../state/session.js';

export function MemoryNoticeCard({ conversationId, notice }: { conversationId: string; notice: Notice }): ReactElement | null {
  const t = useT();
  const name = useSession((s) => s.settings?.persona.name ?? 'NEO');
  const [busy, setBusy] = useState<string | null>(null);
  const open = notice.pending.filter((p) => !notice.resolved[p.id]);
  const approved = notice.pending.filter((p) => notice.resolved[p.id] === 'approved').length;
  const rejected = notice.pending.filter((p) => notice.resolved[p.id] === 'rejected').length;

  const decide = async (ids: string[], decision: 'approved' | 'rejected', key: string) => {
    setBusy(key);
    await decidePendingMemories(requireClient(), conversationId, notice.turnId, ids, decision, t);
    setBusy(null);
  };

  if (open.length > 0) {
    return (
      <section className="neo-card neo-animate-in" data-tone="accent" aria-label={t('memoryNotice.pending_title', { n: open.length, name })} style={{ padding: '0.875rem 1rem', maxWidth: '34rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <span className="neo-card__icon" style={{ width: '1.75rem', height: '1.75rem', background: 'var(--neo-accent-muted)', color: 'var(--neo-accent-text)' }}>
            <Icon name="brain" size={15} />
          </span>
          <p style={{ margin: 0, fontWeight: 650, fontSize: '0.9063rem' }}>{t('memoryNotice.pending_title', { n: open.length, name })}</p>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {open.map((item) => (
            <li key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
              <span className="neo-kind-dot" data-kind={item.kind} title={t(`memory.kind.${item.kind}`)} />
              <span style={{ flex: 1, minWidth: 0, fontSize: '0.875rem' }}>{item.label}</span>
              <IconButton icon="check" label={t('memoryNotice.remember_one', { label: item.label })} size="sm" loading={busy === `a:${item.id}`} disabled={busy !== null} onClick={() => void decide([item.id], 'approved', `a:${item.id}`)} />
              <IconButton icon="x" label={t('memoryNotice.reject_one', { label: item.label })} size="sm" loading={busy === `r:${item.id}`} disabled={busy !== null} onClick={() => void decide([item.id], 'rejected', `r:${item.id}`)} />
            </li>
          ))}
        </ul>
        {open.length > 1 && (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <Button size="sm" variant="primary" icon="check" loading={busy === 'all'} disabled={busy !== null} onClick={() => void decide(open.map((p) => p.id), 'approved', 'all')}>
              {t('memoryNotice.remember_all')}
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'none'} disabled={busy !== null} onClick={() => void decide(open.map((p) => p.id), 'rejected', 'none')}>
              {t('memoryNotice.reject_all')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  const created = notice.created.filter((c) => c.kind !== 'episode');
  const lines: string[] = [];
  if (approved && rejected) lines.push(t('memoryNotice.decided', { saved: approved, skipped: rejected }));
  else if (approved) lines.push(t('memoryNotice.saved_all', { n: approved }));
  else if (rejected) lines.push(t('memoryNotice.skipped_all', { n: rejected }));
  if (created.length) lines.push(t('memoryNotice.remembered', { items: created.slice(0, 3).map((c) => c.label).join(' · ') }));
  else if (notice.updated.length) lines.push(t('memoryNotice.updated', { items: notice.updated.slice(0, 3).map((c) => c.label).join(' · ') }));
  if (!lines.length) return null;
  const first = created[0] ?? notice.updated[0];
  return (
    <div className="neo-msg__status" style={{ fontSize: '0.8125rem' }}>
      <Icon name="brain" size={14} style={{ color: 'var(--neo-accent-text)' }} />
      <span style={{ minWidth: 0 }}>{lines.join(' · ')}</span>
      {first && (
        <button type="button" className="neo-link-btn" style={{ color: 'var(--neo-accent-text)' }} onClick={() => openLink(`neo://memory/${first.id}`)}>
          {t('memoryNotice.view')}
        </button>
      )}
    </div>
  );
}
