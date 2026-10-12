/**
 * A quiet note under an assistant message of what was remembered automatically.
 */
import type { ReactElement } from 'react';
import { Icon, useT } from '@neo/ui';
import { openLink } from '../../actions/links.js';
import type { MemoryNotice as Notice } from '../../state/timeline.js';

export function MemoryNoticeCard({ notice }: { notice: Notice }): ReactElement | null {
  const t = useT();
  const created = notice.created.filter((c) => c.kind !== 'episode');
  const lines: string[] = [];
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
