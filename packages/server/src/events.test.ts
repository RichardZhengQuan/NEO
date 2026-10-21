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

  it('delivers reentrant publishes in sequence order to later subscribers', () => {
    const events = new EventHub(() => 500);
    const firstSeen: number[] = [];
    const seen: number[] = [];
    events.subscribe((event) => {
      firstSeen.push(event.seq);
      if (event.seq === 1) {
        events.publish({ type: 'note.deleted', noteId: 'note-2' });
      }
    });
    events.subscribe((event) => seen.push(event.seq));

    events.publish({ type: 'note.deleted', noteId: 'note-1' });

    expect(seen).toEqual([1, 2]);
    expect(firstSeen).toEqual([1, 2]);
  });

  it('drains publishes queued during delivery despite listener errors and accepts later publishes', () => {
    const events = new EventHub(() => 500);
    const seen: number[] = [];
    events.subscribe((event) => {
      if (event.seq === 1) {
        events.publish({ type: 'note.deleted', noteId: 'note-2' });
        events.publish({ type: 'note.deleted', noteId: 'note-3' });
      } else if (event.seq === 2) {
        events.publish({ type: 'note.deleted', noteId: 'note-4' });
      }
      throw new Error('subscriber error');
    });
    events.subscribe((event) => seen.push(event.seq));

    events.publish({ type: 'note.deleted', noteId: 'note-1' });
    expect(seen).toEqual([1, 2, 3, 4]);

    expect(events.publish({ type: 'note.deleted', noteId: 'note-5' }).seq).toBe(5);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(events.since(0).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});
