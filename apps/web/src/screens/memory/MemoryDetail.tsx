/**
 * Everything about one memory: the card, full content, how strong it is,
 * where it came from (with a link to the message), its associations,
 * older versions it replaced, and the controls (edit, pin, forget, restore).
 */
import { useState, type ReactElement } from 'react';
import type { MemoryEdge, MemoryNodeDetail } from '@neo/protocol';
import { Badge, Button, EmptyState, Icon, IconButton, MemoryNodeCard, Skeleton, formatDateTime, formatRelative, useConfirm, useLocale, useT } from '@neo/ui';
import { openLink } from '../../actions/links.js';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage, httpStatus } from '../../lib/errors.js';
import { bumpMemoryVersion, useData } from '../../state/data.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient } from '../../state/session.js';
import { MemoryEditor } from './MemoryEditor.js';

function EdgeRow({ edge, nodeId, detail, onSelect, onUnlink }: { edge: MemoryEdge; nodeId: string; detail: MemoryNodeDetail; onSelect: (id: string) => void; onUnlink: (edge: MemoryEdge) => void }): ReactElement {
  const t = useT();
  const outgoing = edge.from === nodeId;
  const otherId = outgoing ? edge.to : edge.from;
  const other = detail.neighbors.find((n) => n.id === otherId);
  return (
    <li className="row" style={{ padding: '0.5rem 0.75rem' }}>
      <span className="neo-kind-dot" data-kind={other?.kind ?? 'summary'} />
      <div className="row__main">
        <button type="button" className="neo-link-btn" style={{ fontWeight: 550, fontSize: '0.875rem' }} onClick={() => onSelect(otherId)}>
          {other?.label ?? otherId}
        </button>
        <div className="row__meta">
          <span>
            {outgoing ? '→' : '←'} {t(`edge.${edge.type}`)}
          </span>
          <span title={t('memoryDetail.weight_hint')}>{Math.round(edge.weight * 100)}%</span>
          {edge.coactivations > 0 && <span>{t('memoryDetail.coactivations', { n: edge.coactivations })}</span>}
        </div>
      </div>
      <IconButton icon="unlink" label={t('memoryDetail.unlink', { label: other?.label ?? otherId })} size="sm" onClick={() => onUnlink(edge)} />
    </li>
  );
}

export function MemoryDetail({ nodeId, onClose, onSelect, onFocus }: { nodeId: string; onClose: () => void; onSelect: (id: string) => void; onFocus?: (id: string) => void }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const version = useData((s) => s.memoryVersion);
  const [editing, setEditing] = useState(false);
  const loader = useLoader(() => requireClient().memory.get(nodeId), [nodeId, version]);
  const detail = loader.data?.node.id === nodeId ? loader.data : undefined;

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      bumpMemoryVersion();
      if (success) pushToast({ tone: 'success', title: success });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  if (loader.error && httpStatus(loader.error) === 404) {
    return <EmptyState icon="brain" title={t('memoryDetail.gone')} description={t('memoryDetail.gone_hint')} action={<Button onClick={onClose}>{t('common.close')}</Button>} />;
  }
  if (!detail) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <Skeleton height={20} width="60%" />
        <Skeleton height={14} />
        <Skeleton height={14} width="80%" />
        <Skeleton height={90} />
      </div>
    );
  }

  const { node } = detail;
  const client = requireClient();
  const facts: [string, string][] = [
    [t('memoryDetail.created'), formatDateTime(node.createdAt, locale)],
    [t('memoryDetail.updated'), formatDateTime(node.updatedAt, locale)],
    [t('memoryDetail.last_recalled'), node.lastAccessedAt ? formatRelative(node.lastAccessedAt, locale) : t('memoryDetail.never')],
    [t('memoryDetail.recalls'), String(node.accessCount)],
    [t('memoryDetail.importance'), `${Math.round(node.importance * 100)}%`],
    [t('memoryDetail.confidence'), `${Math.round(node.confidence * 100)}%`],
    [t('memoryDetail.stability'), t('memoryDetail.days', { n: Math.round(node.stability) })],
  ];
  if (node.entityType) facts.push([t('memoryEdit.entity_type'), node.entityType]);
  if (node.aliases.length) facts.push([t('memoryEdit.aliases'), node.aliases.join(', ')]);
  if (node.tags.length) facts.push([t('memoryEdit.tags'), node.tags.join(', ')]);
  if (node.validUntil) facts.push([t('memoryDetail.valid_until'), formatDateTime(node.validUntil, locale)]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <MemoryNodeCard
        node={node}
        retention={detail.retention}
        onTogglePin={() => void act(() => client.memory.update(node.id, { pinned: !node.pinned }))}
        onEdit={() => setEditing(true)}
        onRestore={() => void act(() => client.memory.update(node.id, { status: 'active' }), t('memoryDetail.restored'))}
        onForget={() =>
          void act(async () => {
            await client.memory.forget([node.id]);
            onClose();
          }, t('memoryDetail.forgotten'))
        }
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {onFocus && (
          <Button size="sm" variant="secondary" icon="crosshair" onClick={() => onFocus(node.id)}>
            {t('memoryDetail.focus')}
          </Button>
        )}
        {node.source.messageId && (
          <Button size="sm" variant="secondary" icon="message" onClick={() => openLink(`neo://timeline/${encodeURIComponent(node.source.messageId!)}`)}>
            {t('memoryDetail.open_message')}
          </Button>
        )}
      </div>

      <section>
        <h3 className="group-title">{t('memoryDetail.source')}</h3>
        <p style={{ margin: 0, fontSize: '0.875rem' }}>
          <Badge tone="neutral" icon={node.source.by === 'user' ? 'user' : node.source.by === 'consolidation' ? 'moon-star' : 'sparkles'}>
            {t(`source.${node.source.by}`)}
          </Badge>
          {node.source.note && <span className="neo-help" style={{ marginLeft: '0.5rem' }}>{node.source.note}</span>}
        </p>
      </section>

      <section>
        <h3 className="group-title">{t('memoryDetail.details')}</h3>
        <dl className="neo-kv" style={{ containerType: 'inline-size' }}>
          {facts.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h3 className="group-title">{t('memoryDetail.links', { n: detail.edges.length })}</h3>
        {detail.edges.length === 0 ? (
          <p className="neo-help" style={{ margin: 0 }}>
            {t('memoryDetail.no_links')}
          </p>
        ) : (
          <ul className="row-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {[...detail.edges]
              .sort((a, b) => b.weight - a.weight)
              .map((edge) => (
                <EdgeRow
                  key={edge.id}
                  edge={edge}
                  nodeId={node.id}
                  detail={detail}
                  onSelect={onSelect}
                  onUnlink={(e) =>
                    void confirm({ message: t('memoryDetail.unlink_confirm'), danger: true, confirmLabel: t('memoryDetail.unlink_short') }).then((ok) => {
                      if (ok) void act(() => client.memory.unlink(e.id));
                    })
                  }
                />
              ))}
          </ul>
        )}
      </section>

      {detail.history.length > 0 && (
        <section>
          <h3 className="group-title">{t('memoryDetail.history')}</h3>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {detail.history.map((h) => (
              <li key={h.id} className="neo-card" style={{ padding: '0.625rem 0.75rem', background: 'var(--neo-surface-2)' }}>
                <div className="neo-help" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <Icon name="rotate-ccw" size={12} />
                  {t('memoryDetail.used_to_be', { date: formatDateTime(h.updatedAt, locale) })}
                </div>
                <div style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>{h.content || h.label}</div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {editing && <MemoryEditor node={node} open={editing} onClose={() => setEditing(false)} onSaved={() => void loader.reload()} />}
    </div>
  );
}
