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

  it('drains 10,000 reentrant publishes in linear time and sequence order', () => {
    const batchSize = 10_000
    const expected = Array.from({ length: batchSize + 1 }, (_, i) => i + 1)
    const measure = () => {
      const events = new EventHub(() => 500)
      const firstSeen: number[] = []
      const seen: number[] = []
      events.subscribe((event) => {
        firstSeen.push(event.seq)
        if (event.seq === 1) {
          for (let i = 0; i < batchSize; i++) {
            events.publish({ type: 'note.deleted', noteId: `note-${i + 2}` })
          }
        }
      })
      events.subscribe((event) => seen.push(event.seq))

      // Native engines can optimize shift enough to pass a timing check. Count
      // the slots each shift may move as well, including the bounded replay buffer.
      let shiftedSlots = 0
      const originalShift = Array.prototype.shift
      Array.prototype.shift = function (this: unknown[]) {
        shiftedSlots += Math.max(0, this.length - 1)
        return originalShift.call(this)
      }
      let elapsed: number
      try {
        const started = performance.now()
        events.publish({ type: 'note.deleted', noteId: 'note-1' })
        elapsed = performance.now() - started
      } finally {
        Array.prototype.shift = originalShift
      }

      expect(firstSeen).toEqual(expected)
      expect(seen).toEqual(expected)
      // Each publish may trim at most 500 replay slots; the outbox must add no
      // quadratic shifting work (about 50 million slots for this batch).
      expect(shiftedSlots).toBeLessThanOrEqual(500 * (batchSize + 1))
      return elapsed
    }

    measure() // warm up before taking the median, as in CONTRIBUTING.md
    const samples = Array.from({ length: 7 }, measure).sort((a, b) => a - b)
    expect(samples[3]).toBeLessThan(100)
  })

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
