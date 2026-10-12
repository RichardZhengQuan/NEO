import { describe, expect, it } from 'vitest';
import type { Task } from '@neo/protocol';
import { initialPlanChoices, planInstant, rankPlanTasks, tomorrowDate } from './plan-tomorrow.js';

const task = (id: string, dueAt: number | null, priority = 0): Task => ({ id, dueAt, priority, title: id, listId: 'inbox', notes: null, done: false, doneAt: null, tags: [], order: 0, parentId: null, createdAt: 1, updatedAt: 1 });

describe('Plan tomorrow dates and recommendations', () => {
  it('uses the user timezone calendar date rather than 24 elapsed hours', () => {
    expect(tomorrowDate(Date.parse('2026-10-12T17:30:00Z'), 'Asia/Singapore')).toBe('2026-10-14');
    const spring = Date.parse('2026-03-07T17:00:00Z');
    expect(tomorrowDate(spring, 'America/New_York')).toBe('2026-03-08');
    expect(planInstant('2026-03-08', '09:00', 'America/New_York')).toBe(Date.parse('2026-03-08T13:00:00Z'));
    expect(planInstant('2026-11-01', '09:00', 'America/New_York')).toBe(Date.parse('2026-11-01T14:00:00Z'));
  });

  it('rejects nonexistent DST times and malformed calendar dates instead of moving approved values', () => {
    expect(planInstant('2026-03-08', '02:30', 'America/New_York')).toBeNull();
    expect(planInstant('2026-02-30', '09:00', 'UTC')).toBeNull();
    expect(planInstant('2026-10-13', '24:00', 'UTC')).toBeNull();
    expect(planInstant('2026-10-13', '09:00', 'Invalid/Timezone')).toBeNull();
  });

  it('recommends tomorrow, overdue and undated tasks by priority while preserving future deadlines', () => {
    const tasks = [task('future', Date.parse('2026-10-15T09:00Z'), 3), task('undated', null, 1), task('overdue', Date.parse('2026-10-11T09:00Z'), 3), task('tomorrow-low', Date.parse('2026-10-13T10:30Z'), 1), task('tomorrow-high', Date.parse('2026-10-13T11:00Z'), 3)];
    expect(rankPlanTasks(tasks, '2026-10-13', 'UTC').map((row) => row.id)).toEqual(['tomorrow-high', 'tomorrow-low', 'overdue', 'undated', 'future']);
    const initial = initialPlanChoices(tasks, '2026-10-13', 'UTC');
    expect(initial.suggestedIds).toEqual(['tomorrow-high', 'tomorrow-low', 'overdue']);
    expect(initial.choices['tomorrow-low']?.time).toBe('10:30');
    expect(initial.choices.future?.include).toBe(false);
    expect(Object.values(initial.choices).every((choice) => !choice.addReminder)).toBe(true);
  });

  it('does not recommend advancing deadlines when only future tasks exist', () => {
    const initial = initialPlanChoices([task('next-week', Date.parse('2026-10-20T09:00Z'))], '2026-10-13', 'UTC');
    expect(initial.suggestedIds).toEqual([]);
    expect(initial.choices['next-week']?.include).toBe(false);
  });
});
