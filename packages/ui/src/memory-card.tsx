/**
 * MemoryNodeCard — one memory: kind, status, label, content, retention, and
 * the controls the user has over it (pin, edit, open, forget,
 * restore).
 */
import type { ReactElement } from 'react';
import { SELF_MEMORY_ID, type MemoryNode } from '@neo/protocol';
import { Icon } from './icons.js';
import { useT, type TranslateFn } from './i18n.js';

/** A memory's display label: the self node, the centre of the net, is "You". */
export function memoryLabel(node: Pick<MemoryNode, 'id' | 'label'>, t: TranslateFn): string {
  return node.id === SELF_MEMORY_ID ? t('memory.self') : node.label;
}
import { Button, IconButton } from './primitives.js';
import { useConfirm } from './confirm.js';

export interface MemoryNodeCardProps {
  node: MemoryNode;
  /** Current retention R ∈ [0, 1]; shows the strength meter. */
  retention?: number;
  /** Asks for confirmation first. */
  onForget?: () => void;
  onTogglePin?: () => void;
  onEdit?: () => void;
  /** Makes the label a button (e.g. open the detail panel). */
  onOpen?: () => void;
  /** Shown for archived memories. */
  onRestore?: () => void;
  compact?: boolean;
  selected?: boolean;
}

export function MemoryNodeCard({
  node,
  retention,
  onForget,
  onTogglePin,
  onEdit,
  onOpen,
  onRestore,
  compact = false,
  selected = false,
}: MemoryNodeCardProps): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const status = node.status;
  const pct = retention === undefined ? null : Math.round(Math.max(0, Math.min(1, retention)) * 100);

  return (
    <article className={`neo-mem-card${compact ? ' neo-mem-card--compact' : ''}`} data-status={status} data-kind={node.kind} data-selected={selected || undefined}>
      <div className="neo-mem-card__head">
        <span className="neo-kind" data-kind={node.kind}>
          {t(`memory.kind.${node.kind}`)}
        </span>
        {status !== 'active' && <span className="neo-mem-card__status">{t(`memory.status.${status}`)}</span>}
        {node.sensitivity === 'sensitive' && (
          <span className="neo-mem-card__status" title={t('memory.sensitive_hint')} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <Icon name="lock" size={12} />
            {!compact && t('memory.sensitive')}
          </span>
        )}
        {node.pinned && !onTogglePin && (
          <span className="neo-mem-card__status neo-pin--on" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <Icon name="pin" size={12} />
            {t('memory.pinned')}
          </span>
        )}
        <span className="neo-mem-card__tools">
          {onTogglePin && (
            <span className={node.pinned ? 'neo-pin neo-pin--on' : 'neo-pin'}>
              <IconButton icon="pin" label={node.pinned ? t('memory.unpin') : t('memory.pin')} size="sm" pressed={node.pinned} onClick={onTogglePin} />
            </span>
          )}
          {onEdit && <IconButton icon="edit" label={t('common.edit')} size="sm" onClick={onEdit} />}
          {onOpen && compact && <IconButton icon="chevron-right" label={t('common.open')} size="sm" onClick={onOpen} />}
        </span>
      </div>

      <h3 className="neo-mem-card__label">
        {onOpen ? (
          <button type="button" className="neo-mem-card__label-btn" onClick={onOpen}>
            {memoryLabel(node, t)}
          </button>
        ) : (
          memoryLabel(node, t)
        )}
      </h3>

      {node.content && node.content !== node.label && <p className="neo-mem-card__content">{node.content}</p>}

      {pct !== null && (
        <div className="neo-mem-card__retention" title={t('memory.retention_hint')}>
          <span>{t('memory.retention', { pct })}</span>
          <div className="neo-meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('memory.retention', { pct })}>
            <div className="neo-meter__fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {(onForget || (status === 'archived' && onRestore)) && (
        <div className="neo-mem-card__actions">
          {status === 'archived' && onRestore && (
            <Button size="sm" variant="secondary" icon="archive-restore" onClick={onRestore}>
              {t('memory.restore')}
            </Button>
          )}
          {onForget && (
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={() => {
                void confirm({ title: t('memory.forget_title'), message: t('memory.forget_confirm'), confirmLabel: t('memory.forget'), danger: true }).then((ok) => {
                  if (ok) onForget();
                });
              }}
            >
              {t('memory.forget')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
