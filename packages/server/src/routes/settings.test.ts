import { afterEach, describe, expect, it } from 'vitest';
import { routeFixture } from '../route-fixture.test-utils.js';

const fixtures: ReturnType<typeof routeFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.services.close();
});

function fixture() {
  const f = routeFixture();
  fixtures.push(f);
  return f;
}

describe('PATCH /api/settings timezone', () => {
  it('rejects an unknown timezone without changing the stored timezone', async () => {
    const f = fixture();
    const timezone = f.services.settings.get().timezone;

    const response = await f.request('/api/settings', 'PATCH', { timezone: 'Not/AZone' });

    expect.soft(response.status).toBe(400);
    expect(f.services.settings.get().timezone).toBe(timezone);
  });

  it('accepts and persists a valid IANA timezone', async () => {
    const f = fixture();

    const response = await f.request('/api/settings', 'PATCH', { timezone: 'America/New_York' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ timezone: 'America/New_York' });
    expect(f.services.settings.get().timezone).toBe('America/New_York');
  });

  it('keeps reminder creation working after rejected and accepted timezone updates', async () => {
    const f = fixture();
    const timezone = f.services.settings.get().timezone;
    const dueAt = f.time.now + 3_600_000;

    await f.request('/api/settings', 'PATCH', { timezone: 'Not/AZone' });
    // Check the downstream failure before a valid update could repair a poisoned setting.
    const unchanged = await f.request('/api/reminders', 'POST', { title: 'Call home', dueAt });
    expect(unchanged.status).toBe(201);
    expect(await unchanged.json()).toMatchObject({ title: 'Call home', dueAt, timezone });

    const updated = await f.request('/api/settings', 'PATCH', { timezone: 'America/New_York' });
    expect(updated.status).toBe(200);

    const response = await f.request('/api/reminders', 'POST', { title: 'Call New York', dueAt });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ title: 'Call New York', dueAt, timezone: 'America/New_York' });
  });
});
