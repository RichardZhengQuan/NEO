/**
 * Memory: the net, a list, the dream journal, statistics
 * and data (export / import / forget). Opening a memory shows its details in a
 * side panel on wide screens and a sheet on phones.
 */
import { useState, type ReactElement } from 'react';
import { Button, IconButton, Modal, Tabs, tabPanelProps, useT } from '@neo/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { navigate, type MemoryTab } from '../router.js';
import { DataTab } from './memory/DataTab.js';
import { JournalTab } from './memory/JournalTab.js';
import { ListTab } from './memory/ListTab.js';
import { MemoryDetail } from './memory/MemoryDetail.js';
import { MemoryEditor } from './memory/MemoryEditor.js';
import { NetTab } from './memory/NetTab.js';
import { StatsTab } from './memory/StatsTab.js';

const TAB_ICON: Record<MemoryTab, string> = { net: 'network', list: 'list', journal: 'moon-star', stats: 'bar-chart', data: 'database' };

export function MemoryScreen({ tab, nodeId }: { tab: MemoryTab; nodeId?: string }): ReactElement {
  const t = useT();
  const wide = useMediaQuery('(min-width: 1180px)');
  const [creating, setCreating] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const selected = nodeId ?? null;

  const select = (id: string | null) => navigate(id ? { name: 'memory', tab, nodeId: id } : { name: 'memory', tab }, { replace: true });
  const setTab = (next: string) => navigate({ name: 'memory', tab: next as MemoryTab });
  const focus = (id: string | null) => {
    setFocusId(id);
    if (id && tab !== 'net') navigate({ name: 'memory', tab: 'net', nodeId: id });
  };

  const detail = selected ? <MemoryDetail key={selected} nodeId={selected} onClose={() => select(null)} onSelect={(id) => select(id)} onFocus={focus} /> : null;

  return (
    <div className="page">
      <PageHeader
        title={t('nav.memory')}
        actions={
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
            {t('memoryScreen.add')}
          </Button>
        }
      />
      <div style={{ padding: '0 1rem', flexShrink: 0 }}>
        <Tabs
          idPrefix="memory"
          label={t('nav.memory')}
          value={tab}
          onChange={setTab}
          tabs={(['net', 'list', 'journal', 'stats', 'data'] as const).map((id) => ({ id, label: t(`memoryScreen.tab_${id}`), icon: TAB_ICON[id] }))}
        />
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="page-body" {...tabPanelProps('memory', tab)}>
          <div className="page-inner" style={{ maxWidth: tab === 'net' ? '72rem' : undefined }}>
            {tab === 'net' && <NetTab selectedId={selected} onSelect={select} focusId={focusId} onFocus={focus} />}
            {tab === 'list' && <ListTab selectedId={selected} onSelect={select} />}
            {tab === 'journal' && <JournalTab />}
            {tab === 'stats' && <StatsTab />}
            {tab === 'data' && <DataTab />}
          </div>
        </div>
        {wide && detail && (
          <aside className="detail-panel" aria-label={t('memoryScreen.details')}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 0.75rem 0 1.25rem' }}>
              <h2 className="h-section" style={{ margin: 0 }}>
                {t('memoryScreen.details')}
              </h2>
              <IconButton icon="x" label={t('common.close')} onClick={() => select(null)} />
            </div>
            <div className="detail-panel__body">{detail}</div>
          </aside>
        )}
      </div>
      {!wide && (
        <Modal open={Boolean(detail)} onClose={() => select(null)} title={t('memoryScreen.details')} size="lg">
          {detail}
        </Modal>
      )}
      {creating && <MemoryEditor node={null} open={creating} onClose={() => setCreating(false)} onSaved={(n) => select(n.id)} />}
    </div>
  );
}
