import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, INBOX_LIST_ID, type Reminder, type Task, type TaskList } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { loadReminders, loadTasks, useData } from '../state/data.js';
import { useSession } from '../state/session.js';
import { RemindersScreen } from './RemindersScreen.js';
import { TasksScreen } from './TasksScreen.js';

vi.mock('../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => true }));
vi.mock('../state/data.js', async (original) => ({
  ...await original<typeof import('../state/data.js')>(),
  loadTasks: vi.fn().mockResolvedValue(undefined),
  loadReminders: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../platform/index.js', () => ({ getPlatform: () => ({ notificationStatus: async () => ({ enabled: true }) }) }));

const NOW = Date.parse('2026-10-13T00:00:00Z');
const task: Task = { id: 'task_header', listId: INBOX_LIST_ID, title: 'Prepare notes', notes: null, done: false, doneAt: null, dueAt: null, priority: 0, tags: [], order: 1, parentId: null, createdAt: NOW, updatedAt: NOW };
const inbox: TaskList = { id: INBOX_LIST_ID, name: 'Inbox', color: null, icon: null, order: 0, createdAt: NOW };
const reminder: Reminder = { id: 'rem_header', title: 'Call home', notes: null, dueAt: NOW + 86_400_000, timezone: 'UTC', recurrence: null, status: 'scheduled', firedCount: 0, lastFiredAt: null, messageId: null, createdAt: NOW, updatedAt: NOW };

beforeEach(() => {
  vi.mocked(loadTasks).mockResolvedValue(undefined);
  vi.mocked(loadReminders).mockResolvedValue(undefined);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  useSession.setState({ settings: DEFAULT_SETTINGS, client: {} as NeoClient });
  useData.setState({ tasks: { [task.id]: task }, taskLists: [inbox], tasksLoaded: true, reminders: { [reminder.id]: reminder }, remindersLoaded: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['en', 'zh-CN'])('shows only the tasks heading for the inbox in %s', (locale) => {
  const view = render(<I18nProvider locale={locale} messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
  const header = within(view.container.querySelector('header')!);
  expect(header.getByRole('heading', { name: locale === 'en' ? 'Tasks' : '任务' })).toBeTruthy();
  expect(header.queryAllByRole('button')).toEqual([]);
});

it.each(['en', 'zh-CN'])('shows only the reminders heading with upcoming reminders in %s', (locale) => {
  const view = render(<I18nProvider locale={locale} messages={appDictionaries}><ConfirmProvider><RemindersScreen /></ConfirmProvider></I18nProvider>);
  const header = within(view.container.querySelector('header')!);
  expect(header.getByRole('heading', { name: locale === 'en' ? 'Reminders' : '提醒' })).toBeTruthy();
  expect(header.queryAllByRole('button')).toEqual([]);
});

it('preserves the custom task list actions', () => {
  const list: TaskList = { ...inbox, id: 'list_work', name: 'Work' };
  useData.setState({ taskLists: [inbox, list] });
  const view = render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen listId={list.id} /></ConfirmProvider></I18nProvider>);
  const header = within(view.container.querySelector('header')!);
  expect(header.getAllByRole('button')).toHaveLength(1);
  expect(header.getByRole('button', { name: 'List options' })).toBeTruthy();
});
