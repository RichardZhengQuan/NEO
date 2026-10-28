/**
 * Your memory as data: export (JSON download), import (merge or replace),
 * and "forget everything about…".
 */
import { useRef, useState, type ReactElement } from 'react';
import { MemoryExportSchema, type MemoryExport, type MemoryNode } from '@neo/protocol';
import { Button, Icon, SegmentedControl, Switch, TextField, formatDateTime, useConfirm, useLocale, useT } from '@neo/ui';
import { downloadJson, readFileText } from '../../lib/download.js';
import { errorMessage } from '../../lib/errors.js';
import { bumpMemoryVersion } from '../../state/data.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient, useSession } from '../../state/session.js';

function ExportCard(): ReactElement {
  const t = useT();
  const [embeddings, setEmbeddings] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const data = await requireClient().memory.export(embeddings);
      downloadJson(data, `neo-memory-${new Date().toISOString().slice(0, 10)}.json`);
      pushToast({ tone: 'success', title: t('memoryData.exported', { n: data.nodes.length }) });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="neo-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <h3 className="h-section">{t('memoryData.export_title')}</h3>
        <p className="h-sub" style={{ margin: 0 }}>
          {t('memoryData.export_text')}
        </p>
      </div>
      <Switch checked={embeddings} onChange={setEmbeddings} label={t('memoryData.include_embeddings')} description={t('memoryData.include_embeddings_help')} />
      <div>
        <Button variant="primary" icon="download" onClick={() => void run()} loading={busy}>
          {t('memoryData.export')}
        </Button>
      </div>
    </section>
  );
}

function ImportCard(): ReactElement {
  const t = useT();
  const locale = useLocale();
  const timezone = useSession((s) => s.settings?.timezone);
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: MemoryExport } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    setError(null);
    setFile(null);
    if (!f) return;
    try {
      const parsed = MemoryExportSchema.safeParse(JSON.parse(await readFileText(f)));
      if (!parsed.success) throw new Error(t('memoryData.invalid_file'));
      setFile({ name: f.name, data: parsed.data });
    } catch (err) {
      setError(err instanceof SyntaxError ? t('memoryData.invalid_file') : errorMessage(err, t));
    }
  };

  const run = async () => {
    if (!file) return;
    if (mode === 'replace') {
      const ok = await confirm({ title: t('memoryData.replace_title'), message: t('memoryData.replace_text'), confirmLabel: t('memoryData.replace_confirm'), danger: true });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const report = await requireClient().memory.import(file.data, mode);
      pushToast({ tone: 'success', title: t('memoryData.imported', { nodes: report.nodes, edges: report.edges, skipped: report.skipped }) });
      setFile(null);
      if (input.current) input.current.value = '';
      bumpMemoryVersion();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="neo-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <h3 className="h-section">{t('memoryData.import_title')}</h3>
        <p className="h-sub" style={{ margin: 0 }}>
          {t('memoryData.import_text')}
        </p>
      </div>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <div>
        <Button variant="secondary" icon="upload" onClick={() => input.current?.click()}>
          {t('memoryData.choose_file')}
        </Button>
      </div>
      {error && (
        <p className="neo-error-text" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {file && (
        <>
          <div className="neo-callout" data-tone="info">
            <span className="neo-callout__icon">
              <Icon name="file-text" size={16} />
            </span>
            <div style={{ fontSize: '0.875rem' }}>
              <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{file.name}</div>
              <div className="neo-help">{t('memoryData.file_summary', { nodes: file.data.nodes.length, edges: file.data.edges.length, date: formatDateTime(file.data.exportedAt, locale, timezone) })}</div>
            </div>
          </div>
          <SegmentedControl
            label={t('memoryData.mode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'merge', label: t('memoryData.mode_merge') },
              { value: 'replace', label: t('memoryData.mode_replace') },
            ]}
          />
          <p className="neo-help" style={{ margin: 0 }}>
            {mode === 'merge' ? t('memoryData.mode_merge_help') : t('memoryData.mode_replace_help')}
          </p>
          <div>
            <Button variant={mode === 'replace' ? 'danger' : 'primary'} icon="upload" onClick={() => void run()} loading={busy}>
              {t('memoryData.import')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function ForgetCard(): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<MemoryNode[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'find' | 'forget' | null>(null);

  const find = async () => {
    if (!query.trim()) return;
    setBusy('find');
    try {
      const { items } = await requireClient().memory.findForForget(query.trim(), 100);
      setMatches(items);
      setSelected(new Set(items.map((n) => n.id)));
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirm({ title: t('memoryData.forget_title'), message: t('memoryData.forget_confirm', { n: ids.length }), confirmLabel: t('memory.forget'), danger: true });
    if (!ok) return;
    setBusy('forget');
    try {
      const res = await requireClient().memory.forget(ids);
      pushToast({ tone: 'success', title: t('memoryData.forgotten', { n: res.deleted }) });
      setMatches(null);
      setQuery('');
      bumpMemoryVersion();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="neo-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <h3 className="h-section">{t('memoryData.forget_section')}</h3>
        <p className="h-sub" style={{ margin: 0 }}>
          {t('memoryData.forget_text')}
        </p>
      </div>
      <form
        style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextField value={query} onChange={setQuery} ariaLabel={t('memoryData.forget_query')} placeholder={t('memoryData.forget_placeholder')} />
        </div>
        <Button type="submit" variant="secondary" icon="search" loading={busy === 'find'} disabled={!query.trim()}>
          {t('memoryData.find')}
        </Button>
      </form>
      {matches && matches.length === 0 && <p className="neo-help">{t('memoryData.no_matches')}</p>}
      {matches && matches.length > 0 && (
        <>
          <ul className="row-list" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '18rem', overflowY: 'auto' }}>
            {matches.map((n) => (
              <li key={n.id} className="row" style={{ padding: '0.5rem 0.75rem' }}>
                <label className="neo-check-row" style={{ flex: 1, minWidth: 0 }}>
                  <input
                    type="checkbox"
                    className="neo-checkbox"
                    checked={selected.has(n.id)}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(n.id);
                        else next.delete(n.id);
                        return next;
                      })
                    }
                  />
                  <span className="neo-kind-dot" data-kind={n.kind} />
                  <span style={{ minWidth: 0 }}>{n.label}</span>
                </label>
              </li>
            ))}
          </ul>
          <div>
            <Button variant="danger" icon="trash" onClick={() => void forget()} loading={busy === 'forget'} disabled={!selected.size}>
              {t('memoryData.forget_selected', { n: selected.size })}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export function DataTab(): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <ExportCard />
      <ImportCard />
      <ForgetCard />
    </div>
  );
}
