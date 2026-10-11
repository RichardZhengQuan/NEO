/**
 * Notes: a searchable list and a Markdown editor with live preview, tags,
 * pinning and autosave. Two panes on wide screens, list → editor on phones.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Note } from '@neo/protocol';
import { Button, Chip, EmptyState, Icon, IconButton, Markdown, SegmentedControl, Skeleton, TextField, formatRelative, useConfirm, useLocale, useT } from '@neo/ui';
import { ChipInput } from '../components/ChipInput.js';
import { PageHeader } from '../components/PageHeader.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { errorMessage } from '../lib/errors.js';
import { navigate } from '../router.js';
import { loadNotes, removeNote, upsertNote, useData } from '../state/data.js';
import { pushToast } from '../state/notifications.js';
import { requireClient } from '../state/session.js';

function titleOf(note: Pick<Note, 'title' | 'content'>, fallback: string): string {
  if (note.title.trim()) return note.title.trim();
  const line = note.content.split('\n').find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, '').slice(0, 80) : fallback;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

function NoteEditor({ note, onBack }: { note: Note; onBack?: () => void }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [tags, setTags] = useState(note.tags);
  const [mode, setMode] = useState<'write' | 'preview'>(note.content ? 'preview' : 'write');
  const [state, setState] = useState<SaveState>('saved');
  const latest = useRef({ title, content, tags });
  latest.current = { title, content, tags };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Remote edits (another device) flow in while we have nothing unsaved.
  useEffect(() => {
    if (state !== 'saved') return;
    setTitle(note.title);
    setContent(note.content);
    setTags(note.tags);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.updatedAt]);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { title: tt, content: cc, tags: tg } = latest.current;
    setState('saving');
    try {
      upsertNote(await requireClient().notes.update(note.id, { title: tt, content: cc, tags: tg }));
      setState('saved');
    } catch {
      setState('error');
    }
  };

  const change = () => {
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  };

  // Save on leave; drop notes that were never written. The check runs a tick
  // later so a StrictMode remount (dev) doesn't count as leaving.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setTimeout(() => {
        if (alive.current) return;
        const { title: tt, content: cc } = latest.current;
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
          void requireClient()
            .notes.update(note.id, latest.current)
            .then(upsertNote)
            .catch(() => undefined);
        } else if (!tt.trim() && !cc.trim() && useData.getState().notes[note.id]) {
          void requireClient()
            .notes.delete(note.id)
            .then(() => removeNote(note.id))
            .catch(() => undefined);
        }
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const togglePin = async () => {
    try {
      upsertNote(await requireClient().notes.update(note.id, { pinned: !note.pinned }));
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  const remove = async () => {
    const ok = await confirm({ title: t('notes.delete_title'), message: t('notes.delete_text', { title: titleOf(note, t('notes.untitled')) }), confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      await requireClient().notes.delete(note.id);
      removeNote(note.id);
      navigate({ name: 'notes' }, { replace: true });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  const status = state === 'saving' ? t('notes.saving') : state === 'dirty' ? t('notes.unsaved') : state === 'error' ? t('notes.save_failed') : t('notes.saved', { when: formatRelative(note.updatedAt, locale) });

  return (
    <div className="page" style={{ minWidth: 0 }}>
      <PageHeader
        back={onBack}
        actions={
          <>
            <span className="neo-help" role="status" style={{ marginRight: '0.25rem', color: state === 'error' ? 'var(--neo-tone-danger-text)' : undefined }}>
              {status}
            </span>
            {state === 'error' && <IconButton icon="refresh" label={t('common.retry')} onClick={() => void flush()} />}
            <span className={note.pinned ? 'neo-pin neo-pin--on' : 'neo-pin'}>
              <IconButton icon="pin" label={note.pinned ? t('common.unpin') : t('common.pin')} pressed={note.pinned} onClick={() => void togglePin()} />
            </span>
            <IconButton icon="trash" label={t('common.delete')} onClick={() => void remove()} />
          </>
        }
      >
        <span style={{ flex: 1 }} />
      </PageHeader>
      <div className="page-body">
        <div className="page-inner" style={{ maxWidth: '46rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <input
            className="title-btn"
            style={{ fontSize: '1.5rem', fontWeight: 700, cursor: 'text', marginLeft: 0, padding: '0.25rem 0' }}
            value={title}
            placeholder={t('notes.title_placeholder')}
            aria-label={t('notes.title')}
            maxLength={300}
            onChange={(e) => {
              setTitle(e.target.value);
              change();
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <SegmentedControl
              label={t('notes.mode')}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'write', label: t('notes.write'), icon: 'edit' },
                { value: 'preview', label: t('notes.preview'), icon: 'eye' },
              ]}
            />
            <span className="neo-help">{t('notes.markdown_hint')}</span>
          </div>
          {mode === 'write' ? (
            <textarea
              className="neo-textarea"
              style={{ minHeight: '50vh', fontSize: '0.9688rem', lineHeight: 1.65 }}
              value={content}
              placeholder={t('notes.content_placeholder')}
              aria-label={t('notes.content')}
              autoFocus={!note.content}
              onChange={(e) => {
                setContent(e.target.value);
                change();
              }}
            />
          ) : content.trim() ? (
            <div className="neo-card" style={{ minHeight: '30vh', cursor: 'text' }} onDoubleClick={() => setMode('write')}>
              <Markdown text={content} />
            </div>
          ) : (
            <EmptyState icon="file-text" title={t('notes.empty_note')} action={<Button onClick={() => setMode('write')}>{t('notes.start_writing')}</Button>} />
          )}
          <ChipInput
            label={t('notes.tags')}
            values={tags}
            onChange={(v) => {
              setTags(v);
              latest.current = { ...latest.current, tags: v };
              void flush();
            }}
            max={30}
          />
        </div>
      </div>
    </div>
  );
}

export function NotesScreen({ noteId }: { noteId?: string }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const desktop = useIsDesktop();
  const notes = useData((s) => s.notes);
  const loaded = useData((s) => s.notesLoaded);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void loadNotes(requireClient()).catch((err) => pushToast({ tone: 'error', title: errorMessage(err, t) }));
  }, [t]);

  const all = useMemo(() => Object.values(notes).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), [notes]);
  const tags = useMemo(() => [...new Set(all.flatMap((n) => n.tags))].sort(), [all]);
  const q = query.trim().toLowerCase();
  const visible = all.filter((n) => (!tag || n.tags.includes(tag)) && (!q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q) || n.tags.some((x) => x.toLowerCase().includes(q))));
  const current = noteId ? notes[noteId] : undefined;

  const create = async () => {
    setCreating(true);
    try {
      const note = await requireClient().notes.create({ title: '', content: '', ...(tag ? { tags: [tag] } : {}) });
      upsertNote(note);
      navigate({ name: 'notes', noteId: note.id });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setCreating(false);
    }
  };

  const list = (
    <div className="page" style={desktop ? { flex: '0 0 21rem', borderRight: '1px solid var(--neo-border)' } : undefined}>
      <PageHeader
        title={t('nav.notes')}
        actions={
          <Button size="sm" variant="primary" icon="plus" onClick={() => void create()} loading={creating}>
            {t('notes.new')}
          </Button>
        }
      />
      <div style={{ padding: '0.75rem 1rem 0.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <TextField size="sm" type="search" icon="search" value={query} onChange={setQuery} ariaLabel={t('notes.search')} placeholder={t('notes.search')} />
        {tags.length > 0 && (
          <div className="neo-tags" role="group" aria-label={t('notes.tags')}>
            {tags.map((x) => (
              <Chip key={x} size="sm" icon="hash" pressed={tag === x} onClick={() => setTag(tag === x ? null : x)}>
                {x}
              </Chip>
            ))}
          </div>
        )}
      </div>
      <div className="page-body" style={{ padding: '0.5rem 0.5rem 1rem' }}>
        {!loaded ? (
          <div style={{ display: 'grid', gap: '0.5rem', padding: '0 0.5rem' }}>
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon="note" title={q || tag ? t('notes.no_results') : t('notes.empty_title')} description={q || tag ? undefined : t('notes.empty_text')} />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visible.map((n) => (
              <li key={n.id} className="conv-item" aria-current={n.id === noteId ? 'page' : undefined}>
                <button type="button" className="conv-item__link" onClick={() => navigate({ name: 'notes', noteId: n.id })}>
                  <span className="conv-item__title">
                    {n.pinned && <Icon name="pin" size={12} style={{ color: 'var(--neo-tone-warning-text)' }} />}
                    <span>{titleOf(n, t('notes.untitled'))}</span>
                  </span>
                  <span className="conv-item__preview">
                    {formatRelative(n.updatedAt, locale)}
                    {n.content ? ` · ${n.content.replace(/[#*_`>\-[\]]/g, '').replace(/\s+/g, ' ').slice(0, 90)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  const editor = current ? (
    <NoteEditor key={current.id} note={current} onBack={desktop ? undefined : () => navigate({ name: 'notes' })} />
  ) : noteId && loaded ? (
    <div className="page">
      <EmptyState icon="file-text" title={t('notes.not_found')} action={<Button onClick={() => navigate({ name: 'notes' })}>{t('common.back')}</Button>} />
    </div>
  ) : (
    <div className="page" style={{ justifyContent: 'center' }}>
      <EmptyState icon="note" title={t('notes.pick_title')} description={t('notes.pick_text')} action={<Button variant="primary" icon="plus" onClick={() => void create()}>{t('notes.new')}</Button>} />
    </div>
  );

  if (!desktop) return noteId ? editor : list;
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {list}
      {editor}
    </div>
  );
}
