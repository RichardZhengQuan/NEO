import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '@neo/protocol';
import { routeFixture } from './route-fixture.test-utils.js';

let fixture: ReturnType<typeof routeFixture>;
beforeEach(() => { fixture = routeFixture(); });
afterEach(async () => { await fixture.services.close(); });
async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

describe('HTTP reminder creation replay', () => {
  it('accepts concurrent identical keys as one reminder without another change event or visible retry notes', async () => {
    const changed = vi.fn();
    fixture.services.stores.reminders.onChange(changed);
    const body = { title: 'Prepare proposal', dueAt: fixture.time.now + 60_000, notes: null, recurrence: null,
      creationKey: 'fdd8d6cb-021a-4fa6-9c8f-8c56704086cc' };
    const [first, replay] = await Promise.all([fixture.request('/api/reminders', 'POST', body), fixture.request('/api/reminders', 'POST', body)]).then((responses) => Promise.all(responses.map((response) => json<Reminder>(response, 201))));
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ creationKey: body.creationKey, notes: null, timezone: 'Asia/Singapore' });
    expect(await json(await fixture.request('/api/reminders'), 200)).toMatchObject({ items: [first] });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed create payload under the same key and leaves the original record intact', async () => {
    const body = { title: 'Prepare proposal', dueAt: fixture.time.now + 60_000, creationKey: 'replay-key' };
    const first = await json<Reminder>(await fixture.request('/api/reminders', 'POST', body), 201);
    expect(await json(await fixture.request('/api/reminders', 'POST', { ...body, dueAt: body.dueAt + 60_000 }), 409)).toMatchObject({ code: 'conflict' });
    expect(await json(await fixture.request('/api/reminders'), 200)).toMatchObject({ items: [first] });
  });

  it('keeps unkeyed clients compatible and rejects an empty or oversized creation key', async () => {
    const body = { title: 'Legacy reminder', dueAt: fixture.time.now + 60_000 };
    const one = await json<Reminder>(await fixture.request('/api/reminders', 'POST', body), 201);
    const two = await json<Reminder>(await fixture.request('/api/reminders', 'POST', body), 201);
    expect(one.id).not.toBe(two.id);
    expect(one).not.toHaveProperty('creationKey');
    for (const creationKey of ['', 'x'.repeat(257)]) expect(await json(await fixture.request('/api/reminders', 'POST', { ...body, creationKey }), 400)).toMatchObject({ code: 'bad_request' });
  });
});
