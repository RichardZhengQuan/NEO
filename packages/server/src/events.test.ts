import { describe, expect, it } from 'vitest';
import { EventHub } from './events.js';

describe('EventHub', () => {
  it('uses the injected clock, keeps the latest 500 events, and replays events after a sequence', () => {
    let now = 1000;
    const events = new EventHub(() => now);
    for (let i = 1; i <= 502; i++) {
      now = 1000 + i;
      expect(events.publish({ type: 'task.deleted', taskId: `task-${i}` }).seq).toBe(i);
    }
    expect(events.seq).toBe(502);
    expect(events.since(0)).toHaveLength(500);
    expect(events.since(0)[0]).toMatchObject({ seq: 3, at: 1003 });
    expect(events.since(500).map((event) => event.seq)).toEqual([501, 502]);
  });

  it('isolates throwing listeners and makes unsubscription idempotent', () => {
    const events = new EventHub(() => 500);
    events.subscribe(() => { throw new Error('subscriber error'); });
    const received: number[] = [];
    const unsubscribe = events.subscribe((event) => received.push(event.seq));
    expect(() => events.publish({ type: 'note.deleted', noteId: 'note-1' })).not.toThrow();
    unsubscribe();
    unsubscribe();
    events.publish({ type: 'note.deleted', noteId: 'note-2' });
    expect(received).toEqual([1]);
  });
});
