/**
 * Productivity data (reminders, tasks, notes) kept fresh by server events,
 * plus memory changes and notification counters. Screens load what they show; events keep
 * everything that is loaded up to date, and live timeline widgets read from here.
 */
import { create } from 'zustand';
import type { Note, Notification, Reminder, Task, TaskList } from '@neo/protocol';
import type { NeoClient } from '@neo/client';
import { currentSessionEpoch, isCurrentSession } from './session.js';

export interface DataState {
  reminders: Record<string, Reminder>;
  reminderDeletions: Record<string, true>;
  remindersLoaded: boolean;
  tasks: Record<string, Task>;
  taskLists: TaskList[];
  tasksLoaded: boolean;
  notes: Record<string, Note>;
  notesLoaded: boolean;
  /** Bumped on every memory change; memory views refetch when it moves. */
  memoryVersion: number;
  notifications: Notification[];
  unreadNotifications: number;
}

export const useData = create<DataState>(() => ({
  reminders: {},
  reminderDeletions: {},
  remindersLoaded: false,
  tasks: {},
  taskLists: [],
  tasksLoaded: false,
  notes: {},
  notesLoaded: false,
  memoryVersion: 0,
  notifications: [],
  unreadNotifications: 0,
}));

/** The server caps list requests at 500 items. */
const MAX_PAGE = 500;

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]));

// ── reminders ──

export async function loadReminders(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const { items } = await client.reminders.list({ limit: MAX_PAGE });
  if (!isCurrentSession(epoch, client)) return;
  useData.setState((s) => ({ reminders: byId(items.filter((r) => !s.reminderDeletions[r.id])), remindersLoaded: items.length < MAX_PAGE }));
}

export function upsertReminder(r: Reminder): void {
  useData.setState((s) => {
    const reminderDeletions = { ...s.reminderDeletions };
    delete reminderDeletions[r.id];
    return { reminders: { ...s.reminders, [r.id]: r }, reminderDeletions };
  });
}

export function removeReminder(id: string): void {
  useData.setState((s) => {
    const reminders = { ...s.reminders };
    delete reminders[id];
    return { reminders, reminderDeletions: { ...s.reminderDeletions, [id]: true } };
  });
}

// ── tasks ──

export async function loadTasks(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const [lists, tasks] = await Promise.allSettled([client.tasks.lists(), client.tasks.list({ limit: MAX_PAGE })]);
  if (!isCurrentSession(epoch, client)) return;
  if (lists.status === 'fulfilled') useData.setState({ taskLists: [...lists.value.items].sort((a, b) => a.order - b.order) });
  if (tasks.status === 'fulfilled') useData.setState({ tasks: byId(tasks.value.items), tasksLoaded: true });
  if (lists.status === 'rejected') throw lists.reason;
  if (tasks.status === 'rejected') throw tasks.reason;
}

export async function loadTaskLists(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const lists = await client.tasks.lists();
  if (!isCurrentSession(epoch, client)) return;
  useData.setState({ taskLists: [...lists.items].sort((a, b) => a.order - b.order) });
}

export function upsertTask(t: Task): void {
  useData.setState((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
}

export function removeTask(id: string): void {
  useData.setState((s) => {
    const tasks = { ...s.tasks };
    delete tasks[id];
    return { tasks };
  });
}

export function upsertTaskList(list: TaskList): void {
  useData.setState((s) => {
    const others = s.taskLists.filter((l) => l.id !== list.id);
    return { taskLists: [...others, list].sort((a, b) => a.order - b.order) };
  });
}

export function removeTaskList(id: string): void {
  useData.setState((s) => ({ taskLists: s.taskLists.filter((l) => l.id !== id), tasks: Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.listId !== id)) }));
}

// ── notes ──

export async function loadNotes(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const { items } = await client.notes.list({ limit: MAX_PAGE });
  if (!isCurrentSession(epoch, client)) return;
  useData.setState({ notes: byId(items), notesLoaded: true });
}

export function upsertNote(n: Note): void {
  useData.setState((s) => ({ notes: { ...s.notes, [n.id]: n } }));
}

export function removeNote(id: string): void {
  useData.setState((s) => {
    const notes = { ...s.notes };
    delete notes[id];
    return { notes };
  });
}

// ── memory changes ──

export function bumpMemoryVersion(): void {
  useData.setState((s) => ({ memoryVersion: s.memoryVersion + 1 }));
}

// ── notifications ──

export async function loadNotifications(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const { items } = await client.notifications.list({ limit: 50 });
  if (!isCurrentSession(epoch, client)) return;
  useData.setState({ notifications: items, unreadNotifications: items.filter((n) => !n.readAt).length });
}

export function addNotification(n: Notification): void {
  useData.setState((s) => ({ notifications: [n, ...s.notifications.filter((x) => x.id !== n.id)].slice(0, 100), unreadNotifications: s.unreadNotifications + (n.readAt ? 0 : 1) }));
}

/** Everything loaded is refetched (reconnect / seq gap). */
export async function refreshLoadedData(client: NeoClient): Promise<void> {
  const epoch = currentSessionEpoch();
  const s = useData.getState();
  await Promise.allSettled([
    s.remindersLoaded ? loadReminders(client) : Promise.resolve(),
    s.tasksLoaded ? loadTasks(client) : Promise.resolve(),
    s.notesLoaded ? loadNotes(client) : Promise.resolve(),
  ]);
  if (isCurrentSession(epoch, client)) bumpMemoryVersion();
}
