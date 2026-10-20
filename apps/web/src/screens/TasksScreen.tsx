/**
 * Tasks NEO keeps track of: lists (Inbox + the ones NEO made), check off,
 * inline details (notes, due date, priority, move to list), completed toggle.
 * There is no manual add: you tell NEO, the way you would tell a person.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { INBOX_LIST_ID, type Task, type TaskList } from '@neo/protocol';
import {
  Button,
  Chip,
  EmptyState,
  Icon,
  IconButton,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  TextArea,
  TextField,
  formatDate,
  useConfirm,
  useLocale,
  useT,
} from '@neo/ui';
import { Menu } from '../components/Menu.js';
import { PageHeader } from '../components/PageHeader.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { errorMessage } from '../lib/errors.js';
import { fromDateInputValue, toDateInputValue } from '../lib/time.js';
import { navigate } from '../router.js';
import { loadTasks, removeTask, removeTaskList, upsertTask, upsertTaskList, useData } from '../state/data.js';
import { pushToast } from '../state/notifications.js';
import { currentSessionEpoch, isCurrentSession, requireClient, useSession } from '../state/session.js';

function listName(list: TaskList | undefined, t: (k: string) => string): string {
  if (!list) return t('tasks.inbox');
  return list.id === INBOX_LIST_ID ? t('tasks.inbox') : list.name;
}

async function patchTask(task: Task, patch: Parameters<ReturnType<typeof requireClient>['tasks']['update']>[1], t: (k: string) => string): Promise<void> {
  const epoch = currentSessionEpoch();
  const optimistic: Task = { ...task, ...(patch as Partial<Task>), updatedAt: Date.now() };
  if (patch.done !== undefined) optimistic.doneAt = patch.done ? Date.now() : null;
  upsertTask(optimistic);
  try {
    const saved = await requireClient().tasks.update(task.id, patch);
    if (isCurrentSession(epoch)) upsertTask(saved);
  } catch (err) {
    if (!isCurrentSession(epoch)) return;
    upsertTask(task);
    pushToast({ tone: 'error', title: errorMessage(err, t) });
  }
}

function TaskDetails({ task, lists, onClose }: { task: Task; lists: TaskList[]; onClose: () => void }): ReactElement {
  const t = useT();
  const epoch = currentSessionEpoch();
  const confirm = useConfirm();
  const tz = useSession((s) => s.settings?.timezone);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? '');
  useEffect(() => {
    setTitle(task.title);
  }, [task.title]);
  useEffect(() => {
    setNotes(task.notes ?? '');
  }, [task.notes]);
  const save = (patch: Parameters<typeof patchTask>[1]) => void patchTask(task, patch, t);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.25rem 0 0.5rem 2rem' }}>
      <TextField size="sm" label={t('tasks.title')} value={title} onChange={setTitle} onBlur={() => title.trim() && title.trim() !== task.title && save({ title: title.trim() })} maxLength={1000} />
      <TextArea label={t('tasks.notes')} value={notes} onChange={setNotes} rows={2} onBlur={() => notes !== (task.notes ?? '') && save({ notes: notes.trim() || null })} />
      <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', alignItems: 'end' }}>
        <TextField
          size="sm"
          type="date"
          label={t('tasks.due')}
          value={task.dueAt ? toDateInputValue(task.dueAt, tz) : ''}
          onChange={(v) => save({ dueAt: v ? fromDateInputValue(v, tz, 9) : null })}
        />
        <Select size="sm" label={t('tasks.list')} value={task.listId} onChange={(v) => save({ listId: v })} options={lists.map((l) => ({ value: l.id, label: listName(l, t) }))} />
      </div>
      <div className="neo-field">
        <span className="neo-label">{t('tasks.priority')}</span>
        <SegmentedControl
          label={t('tasks.priority')}
          value={String(task.priority) as '0' | '1' | '2' | '3'}
          onChange={(v) => save({ priority: Number(v) })}
          options={(['0', '1', '2', '3'] as const).map((p) => ({ value: p, label: t(`tasks.priority_${p}`) }))}
        />
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.done')}
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          onClick={() =>
            void confirm({ message: t('tasks.delete_confirm', { title: task.title }), danger: true, confirmLabel: t('common.delete') }).then(async (ok) => {
              if (!ok || !isCurrentSession(epoch)) return;
              try {
                await requireClient().tasks.delete(task.id);
                if (isCurrentSession(epoch)) removeTask(task.id);
              } catch (err) {
                pushToast({ tone: 'error', title: errorMessage(err, t) });
              }
            })
          }
        >
          {t('common.delete')}
        </Button>
      </div>
    </div>
  );
}

function TaskRow({ task, subtasks, lists, expanded, onToggleExpand, highlight }: { task: Task; subtasks: Task[]; lists: TaskList[]; expanded: boolean; onToggleExpand: () => void; highlight: boolean }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const ref = useRef<HTMLLIElement>(null);
  const overdue = !task.done && task.dueAt !== null && task.dueAt < Date.now();
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);
  return (
    <li ref={ref} style={{ borderTop: '1px solid var(--neo-border)' }} data-highlight={highlight || undefined}>
      <div className="row" style={{ borderTop: 0 }}>
        <input type="checkbox" className="neo-checkbox" checked={task.done} aria-label={t('tasks.toggle', { title: task.title })} onChange={(e) => void patchTask(task, { done: e.target.checked }, t)} />
        <button type="button" className="neo-link-btn row__main" aria-expanded={expanded} onClick={onToggleExpand} style={{ color: 'inherit', textDecoration: 'none' }}>
          <span className="row__title" style={task.done ? { color: 'var(--neo-text-muted)', textDecoration: 'line-through' } : undefined}>
            {task.title}
          </span>
          {(task.dueAt || task.notes || task.priority > 0 || subtasks.length > 0) && (
            <span className="row__meta">
              {task.priority > 0 && (
                <span className="neo-priority" data-level={task.priority} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <Icon name="flag" size={12} />
                  {t(`tasks.priority_${task.priority}`)}
                </span>
              )}
              {task.dueAt && (
                <span style={overdue ? { color: 'var(--neo-tone-danger-text)', fontWeight: 600 } : undefined}>
                  <Icon name="calendar" size={12} /> {formatDate(task.dueAt, locale, undefined, 'medium')}
                </span>
              )}
              {task.notes && <Icon name="file-text" size={12} label={t('tasks.has_notes')} />}
              {subtasks.length > 0 && <span>{t('tasks.subtasks', { done: subtasks.filter((c) => c.done).length, total: subtasks.length })}</span>}
            </span>
          )}
        </button>
        <IconButton icon={expanded ? 'chevron-up' : 'chevron-down'} label={expanded ? t('tasks.collapse') : t('tasks.details')} size="sm" onClick={onToggleExpand} />
      </div>
      {expanded && <TaskDetails task={task} lists={lists} onClose={onToggleExpand} />}
      {subtasks.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 0.25rem 2rem' }}>
          {subtasks.map((c) => (
            <li key={c.id} className="row" style={{ borderTop: 0, padding: '0.375rem 0.875rem' }}>
              <input type="checkbox" className="neo-checkbox" checked={c.done} aria-label={t('tasks.toggle', { title: c.title })} onChange={(e) => void patchTask(c, { done: e.target.checked }, t)} />
              <span className="row__main" style={c.done ? { color: 'var(--neo-text-muted)', textDecoration: 'line-through', fontSize: '0.875rem' } : { fontSize: '0.875rem' }}>
                {c.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ListEditor({ list, open, onClose }: { list: TaskList; open: boolean; onClose: () => void }): ReactElement {
  const t = useT();
  const [name, setName] = useState(list.name);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const epoch = currentSessionEpoch();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const saved = await requireClient().tasks.updateList(list.id, { name: name.trim() });
      if (!isCurrentSession(epoch)) return;
      upsertTaskList(saved);
      onClose();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('tasks.rename_list')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label={t('tasks.list_name')} value={name} onChange={setName} maxLength={100} autoFocus required />
      </form>
    </Modal>
  );
}

export function TasksScreen({ listId, taskId }: { listId?: string; taskId?: string }): ReactElement {
  const t = useT();
  const confirm = useConfirm();
  const desktop = useIsDesktop();
  const tasks = useData((s) => s.tasks);
  const lists = useData((s) => s.taskLists);
  const loaded = useData((s) => s.tasksLoaded);
  const [showDone, setShowDone] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(taskId ?? null);
  const [listModal, setListModal] = useState<TaskList | null>(null);

  useEffect(() => {
    void loadTasks(requireClient()).catch((err) => pushToast({ tone: 'error', title: errorMessage(err, t) }));
  }, [t]);
  useEffect(() => {
    if (taskId) setExpanded(taskId);
  }, [taskId]);

  const highlighted = taskId ? tasks[taskId] : undefined;
  const currentId = highlighted?.listId ?? listId ?? INBOX_LIST_ID;
  const current = lists.find((l) => l.id === currentId);
  const all = Object.values(tasks);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const task of all) if (!task.done && !task.parentId) m.set(task.listId, (m.get(task.listId) ?? 0) + 1);
    return m;
  }, [all]);
  const inList = all.filter((x) => x.listId === currentId);
  const top = inList.filter((x) => !x.parentId || !tasks[x.parentId]);
  const childrenOf = (id: string) => inList.filter((x) => x.parentId === id).sort((a, b) => a.order - b.order);
  const open = top.filter((x) => !x.done).sort((a, b) => b.priority - a.priority || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.order - b.order);
  const done = top.filter((x) => x.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));

  const deleteList = async (list: TaskList) => {
    const epoch = currentSessionEpoch();
    const ok = await confirm({ title: t('tasks.delete_list_title'), message: t('tasks.delete_list_text', { name: list.name }), confirmLabel: t('common.delete'), danger: true });
    if (!ok || !isCurrentSession(epoch)) return;
    try {
      await requireClient().tasks.deleteList(list.id);
      if (!isCurrentSession(epoch)) return;
      removeTaskList(list.id);
      navigate({ name: 'tasks' });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  const sortedLists = [...lists].sort((a, b) => (a.id === INBOX_LIST_ID ? -1 : b.id === INBOX_LIST_ID ? 1 : a.order - b.order));
  const listPicker = desktop ? (
    <nav style={{ width: '14rem', flexShrink: 0, padding: '1rem 0.5rem', borderRight: '1px solid var(--neo-border)', overflowY: 'auto' }} aria-label={t('tasks.lists')}>
      {sortedLists.map((l) => (
        <button key={l.id} type="button" className="nav-item" style={{ width: '100%' }} aria-current={l.id === currentId ? 'page' : undefined} onClick={() => navigate({ name: 'tasks', listId: l.id })}>
          <Icon name={l.id === INBOX_LIST_ID ? 'inbox' : l.icon ?? 'list'} size={16} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{listName(l, t)}</span>
          {counts.get(l.id) ? <span className="neo-help">{counts.get(l.id)}</span> : null}
        </button>
      ))}
    </nav>
  ) : (
    <div className="neo-tags" style={{ flexWrap: 'nowrap', overflowX: 'auto', padding: '0.75rem 1rem 0', scrollbarWidth: 'none' }} role="group" aria-label={t('tasks.lists')}>
      {sortedLists.map((l) => (
        <Chip key={l.id} pressed={l.id === currentId} onClick={() => navigate({ name: 'tasks', listId: l.id })}>
          {listName(l, t)}
          {counts.get(l.id) ? ` · ${counts.get(l.id)}` : ''}
        </Chip>
      ))}
    </div>
  );

  return (
    <div className="page">
      <PageHeader
        title={desktop ? t('nav.tasks') : listName(current, t)}
        actions={
          current && current.id !== INBOX_LIST_ID && (
            <Menu
              label={t('tasks.list_actions')}
              items={[
                { label: t('tasks.rename_list'), icon: 'edit', onSelect: () => setListModal(current) },
                { label: t('tasks.delete_list'), icon: 'trash', danger: true, onSelect: () => void deleteList(current) },
              ]}
            />
          )
        }
      />
      <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: desktop ? 'row' : 'column' }}>
        {listPicker}
        <div className="page-body">
          <div className="page-inner">
            {desktop && <h2 className="h-section" style={{ marginBottom: '1rem' }}>{listName(current, t)}</h2>}
            {!loaded ? (
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                <Skeleton height={52} />
                <Skeleton height={52} />
                <Skeleton height={52} />
              </div>
            ) : open.length === 0 && done.length === 0 ? (
              <EmptyState icon="check-square" title={t('tasks.empty_title')} description={t('tasks.empty_text')} />
            ) : (
              <>
                {open.length === 0 ? (
                  <p className="neo-help" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <Icon name="check-circle" size={15} /> {t('tasks.all_done')}
                  </p>
                ) : (
                  <ul className="row-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {open.map((task) => (
                      <TaskRow key={task.id} task={task} subtasks={childrenOf(task.id)} lists={sortedLists} expanded={expanded === task.id} highlight={task.id === taskId} onToggleExpand={() => setExpanded((e) => (e === task.id ? null : task.id))} />
                    ))}
                  </ul>
                )}
                {done.length > 0 && (
                  <>
                    <button type="button" className="nav-item" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)} style={{ marginTop: '1rem' }}>
                      <Icon name={showDone ? 'chevron-down' : 'chevron-right'} size={15} />
                      {t('tasks.completed', { n: done.length })}
                    </button>
                    {showDone && (
                      <ul className="row-list" style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }}>
                        {done.map((task) => (
                          <TaskRow key={task.id} task={task} subtasks={childrenOf(task.id)} lists={sortedLists} expanded={expanded === task.id} highlight={task.id === taskId} onToggleExpand={() => setExpanded((e) => (e === task.id ? null : task.id))} />
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {listModal && <ListEditor key={listModal.id} list={listModal} open onClose={() => setListModal(null)} />}
    </div>
  );
}
