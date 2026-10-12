/** A contextual workspace for one day, built from existing NEO tasks and reminders. */
import { useEffect, useId, useRef, type ReactElement } from 'react';
import type { Reminder, Task } from '@neo/protocol';
import { Badge, Button, EmptyState, Icon, Skeleton, TextField, formatDateTime, formatTime, useLocale, useT } from '@neo/ui';
import { usePlanTomorrow } from '../actions/plan-tomorrow.js';
import { PageHeader } from '../components/PageHeader.js';
import { fromDateInputValue, toDateInputValue } from '../lib/time.js';
import { navigate } from '../router.js';
import './plan-tomorrow.css';

type Scene = ReturnType<typeof usePlanTomorrow>;
type Plan = NonNullable<Scene['plan']>;
type Choice = Plan['choices'][string];
type Receipt = Plan['operations'][number];

function returnToNeo(): void { navigate({ name: 'timeline' }); }

function TaskChoice({ task, choice, invalid, timezone, busy, onChange }: {
  task: Task;
  choice: Choice;
  invalid?: string;
  timezone: string;
  busy: boolean;
  onChange: (patch: Partial<Choice>) => void;
}): ReactElement {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const timeInvalid = invalid === 'time' || invalid === 'past';
  const sourceInvalid = Boolean(invalid) && !timeInvalid;
  return (
    <li className="plan-task" data-selected={choice.include || undefined} data-invalid={invalid ? true : undefined}>
      <div className="plan-task__heading">
        <label className="plan-check plan-task__include" htmlFor={`${id}-include`}>
          <input id={`${id}-include`} type="checkbox" className="neo-checkbox" checked={choice.include} disabled={busy}
            aria-label={t('plan.include_task', { title: task.title })} onChange={(event) => onChange({ include: event.target.checked })} />
          <span>{t('plan.include')}</span>
        </label>
        <h3 className="plan-task__title">{task.title}</h3>
        {task.priority > 0 && <span className="neo-priority plan-task__priority" data-level={task.priority}><Icon name="flag" size={12} />{t(`tasks.priority_${task.priority}`)}</span>}
      </div>
      <p className="plan-task__current"><Icon name="calendar" size={13} />{t('plan.current_due')}: {task.dueAt === null ? t('plan.no_due') : formatDateTime(task.dueAt, locale, timezone)}</p>
      {invalid && !timeInvalid && <p className="plan-task__invalid" role="status"><Icon name="alert-triangle" size={15} />{t(`plan.invalid.${invalid}`)}</p>}
      <div className="plan-task__controls">
        <TextField id={`${id}-time`} type="time" size="sm" label={<><span aria-hidden="true">{t('plan.target_time')}</span><span className="neo-sr">{t('plan.target_time_task', { title: task.title })}</span></>} value={choice.time}
          disabled={busy || !choice.include || sourceInvalid} error={timeInvalid ? t(`plan.invalid.${invalid}`) : undefined} onChange={(time) => onChange({ time })} />
        <label className="plan-check plan-task__reminder" htmlFor={`${id}-reminder`}>
          <input id={`${id}-reminder`} type="checkbox" className="neo-checkbox" checked={choice.addReminder}
            disabled={busy || !choice.include || Boolean(invalid)} aria-label={t('plan.reminder_task', { title: task.title })}
            onChange={(event) => onChange({ addReminder: event.target.checked })} />
          <Icon name="bell" size={15} /><span>{t('plan.add_reminder')}</span>
        </label>
      </div>
    </li>
  );
}

function ChangeReceipt({ receipt, timezone, showStatus, currentInvalid }: { receipt: Receipt; timezone: string; showStatus: boolean; currentInvalid?: string }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const reason = receipt.reason ?? currentInvalid;
  const tone = receipt.status === 'saved' ? 'success' : receipt.status === 'error' || receipt.status === 'invalid' ? 'warning' : receipt.status === 'saving' ? 'accent' : 'neutral';
  return (
    <li className="plan-change" data-status={receipt.status}>
      <div className="plan-change__heading">
        <Icon name={receipt.kind === 'reminder' ? 'bell' : 'calendar'} size={17} />
        <div><h3>{receipt.title}</h3><p>{t(receipt.kind === 'reminder' ? 'plan.new_reminder' : 'plan.due_change')}</p></div>
        {showStatus && <Badge tone={tone} icon={receipt.status === 'saved' ? 'check' : undefined}>{t(`plan.status_${receipt.status}`)}</Badge>}
      </div>
      <dl className="plan-change__values">
        <div><dt>{t('plan.before')}</dt><dd>{receipt.before === null ? t(receipt.kind === 'reminder' ? 'plan.not_created' : 'plan.no_due') : formatDateTime(receipt.before, locale, timezone)}</dd></div>
        <Icon name="arrow-right" size={17} />
        <div><dt>{t('plan.after')}</dt><dd>{formatDateTime(receipt.after, locale, timezone)}</dd></div>
      </dl>
      {reason ? <p className="plan-task__invalid" role="status">{t(`plan.invalid.${reason}`)}</p> : receipt.error ? <p className="plan-task__invalid" role="status">{receipt.error}</p> : null}
      {receipt.kind === 'reminder' && (receipt.reason === 'reminder-unknown' || receipt.uncertain) && <Button size="sm" variant="secondary" icon="bell" className="plan-change__recovery" onClick={() => navigate({ name: 'reminders' })}>{t('plan.check_reminders')}</Button>}
    </li>
  );
}

function ReminderAnchors({ reminders, timezone }: { reminders: Reminder[]; timezone: string }): ReactElement {
  const locale = useLocale();
  return (
    <ul className="plan-anchors">
      {reminders.map((reminder) => (
        <li key={reminder.id}>
          <time dateTime={new Date(reminder.dueAt).toISOString()}>{formatTime(reminder.dueAt, locale, timezone)}</time>
          <span>{reminder.title}</span>
        </li>
      ))}
    </ul>
  );
}

export function PlanTomorrowScreen({ date }: { date?: string }): ReactElement {
  const t = useT();
  const locale = useLocale();
  const scene = usePlanTomorrow(date);
  const { plan, loading, loadError, tasks, reminders, suggestedIds, invalid } = scene;
  const reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const reviewRequest = useRef<string | null>(null);
  const previousStep = useRef<{ key: string; stage: Plan['stage'] } | null>(null);
  useEffect(() => {
    const previous = previousStep.current;
    if (plan && previous?.key === plan.key && previous.stage === 'edit' && plan.stage === 'review' && reviewRequest.current === plan.key) {
      reviewHeading.current?.focus();
    }
    if (previous?.key !== plan?.key || previous?.stage !== plan?.stage) reviewRequest.current = null;
    previousStep.current = plan ? { key: plan.key, stage: plan.stage } : null;
  }, [plan?.key, plan?.stage]);
  const saving = plan?.stage === 'saving';
  const editing = plan?.stage === 'edit';
  const selected = plan ? Object.entries(plan.choices).filter(([, choice]) => choice.include).map(([id]) => id) : [];
  const needsReview = selected.some((id) => Boolean(invalid[id]));
  const needsSourceReview = selected.some((id) => Boolean(invalid[id]) && invalid[id] !== 'time' && invalid[id] !== 'past');
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const suggested = suggestedIds.map((id) => taskById.get(id)).filter((task): task is Task => task !== undefined);
  const alternatives = tasks.filter((task) => !suggestedIds.includes(task.id));
  const anchors = plan ? reminders.filter((reminder) => reminder.status === 'scheduled' && toDateInputValue(reminder.dueAt, plan.timezone) === plan.date).sort((a, b) => a.dueAt - b.dueAt) : [];
  const savedCount = plan?.operations.filter((operation) => operation.status === 'saved').length ?? 0;
  const uncertain = plan?.operations.some((operation) => operation.uncertain) ?? false;
  const retryable = !uncertain && (plan?.operations.some((operation) => (operation.status === 'pending' || operation.status === 'error') && operation.reason !== 'reminder-unknown' && operation.reason !== 'session') ?? false);
  const dateAt = plan ? fromDateInputValue(plan.date, plan.timezone, 12) : null;
  const dateLabel = dateAt === null ? plan?.date ?? '' : new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone: plan?.timezone }).format(dateAt);
  const firstLoadPending = loading && !loadError && (!plan || Object.keys(plan.baselines).length === 0);
  const sourceAvailable = plan && (plan.status !== 'error' || Object.keys(plan.baselines).length > 0);
  const taskRow = (task: Task) => plan?.choices[task.id] ? <TaskChoice key={task.id} task={task} choice={plan.choices[task.id]!}
    invalid={invalid[task.id]} timezone={plan.timezone} busy={Boolean(saving)} onChange={(patch) => scene.setChoice(task.id, patch)} /> : null;

  return (
    <div className="page plan-page">
      <PageHeader title={t('plan.title')} actions={<Button size="sm" variant="ghost" icon="message" onClick={returnToNeo}>{t('plan.back')}</Button>} />
      <div className="page-body">
        <div className="page-inner plan-inner">
          <div className="plan-heading">
            <div><h2>{dateLabel || t('plan.title')}</h2><p>{plan ? t('plan.timezone', { timezone: plan.timezone }) : t('plan.loading')}</p></div>
            {plan && <Badge tone={plan.stage === 'saved' ? 'success' : plan.stage === 'partial' || plan.stage === 'error' ? 'warning' : plan.stage === 'saving' ? 'accent' : 'neutral'}>{t(`plan.stage_${plan.stage}`)}</Badge>}
          </div>
          <p className="plan-source">{t('plan.source')}</p>
          {plan?.limited && <p className="plan-limited" role="status"><Icon name="alert-triangle" size={15} />{t('plan.limited_hint')}</p>}
          {loadError && <div className="plan-load-error" role="alert"><Icon name="alert-circle" size={18} /><span>{t('plan.load_error')}</span><Button size="sm" variant="secondary" icon="refresh-cw" loading={loading} onClick={() => void scene.reload()}>{t('plan.retry_load')}</Button></div>}
          {firstLoadPending ? <div className="plan-skeleton" role="status" aria-label={t('plan.loading')}><Skeleton height={110} /><Skeleton height={110} /><Skeleton height={110} /></div> : sourceAvailable && plan && (
            <div className="plan-layout">
              <aside className="plan-context" aria-labelledby="plan-context-title">
                <div className="plan-section-heading"><Icon name="bell" size={17} /><h2 id="plan-context-title">{t('plan.context_title')}</h2></div>
                <p className="plan-context__hint">{t('plan.context_hint')}</p>
                {anchors.length === 0 ? <p className="plan-context__empty">{t('plan.context_empty')}</p> : <>
                  <ReminderAnchors reminders={anchors.slice(0, 4)} timezone={plan.timezone} />
                  {anchors.length > 4 && (
                    <details className="plan-context__more" open={plan.disclosures.reminders} onToggle={(event) => {
                      if (event.currentTarget.open !== plan.disclosures.reminders) scene.setDisclosure('reminders', event.currentTarget.open);
                    }}>
                      <summary>{t('plan.context_more', { n: anchors.length - 4 })}</summary>
                      <ReminderAnchors reminders={anchors.slice(4)} timezone={plan.timezone} />
                    </details>
                  )}
                </>}
              </aside>
              <div className="plan-work">
                {editing ? tasks.length === 0 ? <EmptyState icon="check-circle" title={t('plan.empty_title')} description={t('plan.empty_text')} /> : <>
                  <div className="plan-section-heading"><h2>{t('plan.suggested')}</h2></div>
                  <p className="plan-section-hint">{t('plan.suggested_reason')}</p>
                  {suggested.length === 0 ? <p className="plan-no-changes">{t('plan.no_suggestions')}</p> : <ul className="plan-task-list">{suggested.map(taskRow)}</ul>}
                  {alternatives.length > 0 && (
                    <details className="plan-alternatives" open={plan.disclosures.alternatives} onToggle={(event) => {
                      if (event.currentTarget.open !== plan.disclosures.alternatives) scene.setDisclosure('alternatives', event.currentTarget.open);
                    }}>
                      <summary><Icon name="list" size={16} />{t('plan.alternatives', { n: alternatives.length })}</summary>
                      <ul className="plan-task-list">{alternatives.map(taskRow)}</ul>
                    </details>
                  )}
                  {needsSourceReview && <div className="plan-refresh" role="status"><span>{t('plan.refresh_hint')}</span><Button size="sm" variant="secondary" icon="refresh-cw" loading={loading} onClick={() => void scene.reload()}>{t('plan.refresh')}</Button></div>}
                </> : <section aria-labelledby="plan-review-title">
                  <div className="plan-section-heading"><h2 id="plan-review-title" ref={reviewHeading} tabIndex={plan.stage === 'review' ? -1 : undefined}>{t(plan.stage === 'review' ? 'plan.review_title' : 'plan.receipts')}</h2></div>
                  <p className="plan-section-hint" role="status">{plan.stage === 'review' ? t('plan.review_hint') : t('plan.summary_saved', { n: savedCount, total: plan.operations.length })}</p>
                  {needsSourceReview && !saving && !uncertain && plan.stage !== 'saved' && (
                    <div className="plan-refresh" role="status">
                      <span>{t('plan.refresh_hint')}</span>
                      <Button size="sm" variant="secondary" icon="refresh-cw" loading={loading} onClick={() => void scene.reload()}>{t('plan.refresh')}</Button>
                    </div>
                  )}
                  {plan.operations.length === 0 ? <p className="plan-no-changes">{t('plan.no_changes')}</p> : (
                    <ul className="plan-change-list">
                      {plan.operations.map((receipt) => <ChangeReceipt key={receipt.id} receipt={receipt} timezone={plan.timezone}
                        showStatus={plan.stage !== 'review'} currentInvalid={receipt.status === 'saved' ? undefined : invalid[receipt.taskId]} />)}
                    </ul>
                  )}
                </section>}
              </div>
            </div>
          )}
        </div>
        {plan && <div className="plan-footer"><div className="plan-footer__inner">
          <p aria-live="polite">{saving ? t('plan.stage_saving') : plan.stage === 'saved' ? t('plan.summary_saved', { n: savedCount, total: plan.operations.length }) : selected.length === 0 ? t('plan.no_selection') : t('plan.selection_summary', { n: selected.length })}</p>
          <div className="plan-footer__actions">
            {!editing && !saving && !uncertain && plan.stage !== 'saved' && <Button variant={retryable || plan.stage === 'review' ? 'secondary' : 'primary'} onClick={scene.edit}>{t('plan.edit')}</Button>}
            {editing && tasks.length > 0 && <Button variant="primary" icon="arrow-right" disabled={loading || Boolean(loadError) || selected.length === 0 || needsReview} onClick={() => { reviewRequest.current = plan.key; scene.review(); }}>{t('plan.review')}</Button>}
            {editing && tasks.length === 0 && <Button variant="primary" icon="message" onClick={returnToNeo}>{t('plan.back')}</Button>}
            {plan.stage === 'review' && <Button variant="primary" icon="check" disabled={loading || Boolean(loadError) || plan.operations.length === 0 || needsReview} onClick={() => void scene.apply()}>{t('plan.apply')}</Button>}
            {saving && <Button variant="primary" loading disabled>{t('plan.stage_saving')}</Button>}
            {(plan.stage === 'partial' || plan.stage === 'error') && uncertain && <Button variant="primary" icon="refresh-cw" loading={loading} onClick={() => void scene.reload()}>{t('plan.check_results')}</Button>}
            {(plan.stage === 'partial' || plan.stage === 'error') && retryable && <Button variant="primary" icon="refresh-cw" disabled={loading || Boolean(loadError)} onClick={() => void scene.retry()}>{t('plan.retry')}</Button>}
            {plan.stage === 'saved' && <Button variant="primary" icon="message" onClick={returnToNeo}>{t('plan.back')}</Button>}
          </div>
        </div></div>}
      </div>
    </div>
  );
}
