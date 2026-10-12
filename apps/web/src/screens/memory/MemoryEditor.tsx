/**
 * Edit a memory NEO formed: label, content, kind, importance, pinned,
 * sensitivity (+ tags, entity type and aliases where they apply). Memories
 * are never added by hand; you tell NEO and it remembers.
 */
import { useState, type ReactElement } from 'react';
import { MEMORY_KINDS, type MemoryKind, type MemoryNode, type MemoryNodePatch } from '@neo/protocol';
import { Button, Modal, Select, Switch, TextArea, TextField, useT } from '@neo/ui';
import { ChipInput } from '../../components/ChipInput.js';
import { errorMessage } from '../../lib/errors.js';
import { bumpMemoryVersion } from '../../state/data.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient } from '../../state/session.js';

interface Draft {
  label: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  pinned: boolean;
  sensitive: boolean;
  tags: string[];
  entityType: string;
  aliases: string[];
}

function toDraft(node: MemoryNode): Draft {
  return {
    label: node.label,
    content: node.content,
    kind: node.kind,
    importance: node.importance,
    pinned: node.pinned,
    sensitive: node.sensitivity === 'sensitive',
    tags: node.tags,
    entityType: node.entityType ?? '',
    aliases: node.aliases,
  };
}

export function MemoryEditor({ node, open, onClose, onSaved }: { node: MemoryNode; open: boolean; onClose: () => void; onSaved?: (node: MemoryNode) => void }): ReactElement {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => toDraft(node));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const valid = draft.content.trim().length > 0 && draft.label.trim().length > 0;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const patch: MemoryNodePatch = {
        label: draft.label.trim(),
        content: draft.content.trim(),
        kind: draft.kind,
        importance: draft.importance,
        pinned: draft.pinned,
        sensitivity: draft.sensitive ? 'sensitive' : 'normal',
        tags: draft.tags,
      };
      if (draft.kind === 'entity') {
        patch.entityType = draft.entityType.trim() || null;
        patch.aliases = draft.aliases;
      }
      const saved = await requireClient().memory.update(node.id, patch);
      bumpMemoryVersion();
      pushToast({ tone: 'success', title: t('memoryEdit.saved') });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('memoryEdit.edit_title')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="check" onClick={() => void save()} loading={saving} disabled={!valid}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextArea label={t('memoryEdit.content')} value={draft.content} onChange={(v) => set('content', v)} rows={3} required maxLength={10000} help={t('memoryEdit.content_help')} />
        <TextField label={t('memoryEdit.label')} value={draft.label} onChange={(v) => set('label', v)} maxLength={300} required />
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
          <Select label={t('memoryEdit.kind')} value={draft.kind} onChange={(v) => set('kind', v as MemoryKind)} options={MEMORY_KINDS.map((k) => ({ value: k, label: t(`memory.kind.${k}`) }))} />
          {draft.kind === 'entity' && <TextField label={t('memoryEdit.entity_type')} value={draft.entityType} onChange={(v) => set('entityType', v)} maxLength={40} placeholder={t('memoryEdit.entity_type_placeholder')} />}
        </div>
        <div className="neo-field">
          <label className="neo-label" htmlFor="mem-importance">
            {t('memoryEdit.importance')} · {Math.round(draft.importance * 100)}%
          </label>
          <input id="mem-importance" type="range" className="neo-range" min={0} max={1} step={0.05} value={draft.importance} onChange={(e) => set('importance', Number(e.target.value))} />
          <p className="neo-help" style={{ margin: 0 }}>
            {t('memoryEdit.importance_help')}
          </p>
        </div>
        {draft.kind === 'entity' && <ChipInput label={t('memoryEdit.aliases')} values={draft.aliases} onChange={(v) => set('aliases', v)} max={20} maxLength={120} />}
        <ChipInput label={t('memoryEdit.tags')} values={draft.tags} onChange={(v) => set('tags', v)} max={20} />
        <Switch checked={draft.pinned} onChange={(v) => set('pinned', v)} label={t('memoryEdit.pinned')} description={t('memoryEdit.pinned_help')} />
        <Switch checked={draft.sensitive} onChange={(v) => set('sensitive', v)} label={t('memory.sensitive')} description={t('memory.sensitive_hint')} />
        {error && (
          <p className="neo-error-text" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
