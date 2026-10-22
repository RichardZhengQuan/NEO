import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@neo/protocol';
import { routeFixture } from './route-fixture.test-utils.js';

let fixture: ReturnType<typeof routeFixture>;
beforeEach(() => { fixture = routeFixture(); });
afterEach(async () => { await fixture.services.close(); });
async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

describe('HTTP task lookup by ID', () => {
  it('returns the current full task even when it is absent from a filtered list, without writes or events', async () => {
    const tasks = fixture.services.stores.tasks;
    tasks.create({ title: 'Open task' });
    const task = tasks.create({ title: 'Prepare proposal', notes: 'Current source', dueAt: fixture.time.now + 86_400_000, tags: ['work'] });
    fixture.time.now += 1_000;
    const current = tasks.update(task.id, { title: 'Completed proposal', done: true, priority: 3 });
    const changed = vi.fn();
    tasks.onChange(changed);
    const seq = fixture.services.events.seq;
    const filtered = await json<{ items: Task[] }>(await fixture.request('/api/tasks?done=false&limit=1'), 200);
    expect(filtered.items.some((item) => item.id === task.id)).toBe(false);
    const result = await json<Task>(await fixture.request(`/api/tasks/${task.id}`), 200);
    expect(result).toEqual(current);
    expect(tasks.get(task.id)).toEqual(current);
    expect(tasks.list()).toHaveLength(2);
    expect(changed).not.toHaveBeenCalled();
    expect(fixture.services.events.seq).toBe(seq);
  });

  it('returns not_found for missing and deleted IDs without creating or updating a task', async () => {
    const tasks = fixture.services.stores.tasks;
    const deleted = tasks.create({ title: 'Deleted proposal' });
    tasks.delete(deleted.id);
    const changed = vi.fn();
    tasks.onChange(changed);
    const seq = fixture.services.events.seq;
    for (const id of ['missing-task', deleted.id]) {
      expect(await json(await fixture.request(`/api/tasks/${id}`), 404)).toMatchObject({ code: 'not_found', message: 'Task not found' });
    }
    expect(tasks.list()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(fixture.services.events.seq).toBe(seq);
  });
});
