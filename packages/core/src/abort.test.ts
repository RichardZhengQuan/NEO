/**
 * Cancellation helper unit tests.
 */
import { describe, expect, it } from 'vitest';
import { abortable, cancelledError, raceAbort } from './abort.js';
import { NeoError } from '@neo/protocol';

describe('raceAbort', () => {
  it('resolves with the promise value when signal is not aborted', async () => {
    const controller = new AbortController();
    const result = await raceAbort(Promise.resolve(42), controller.signal);
    expect(result).toBe(42);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceAbort(Promise.resolve(42), controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('rejects with cancelled when signal fires mid-flight', async () => {
    const controller = new AbortController();
    let resolve!: (v: number) => void;
    const pending = new Promise<number>((r) => { resolve = r; });
    const race = raceAbort(pending, controller.signal);
    controller.abort();
    await expect(race).rejects.toMatchObject({ code: 'cancelled' });
    // Resolving the now-loser promise must not cause an unhandled rejection.
    resolve(1);
    await Promise.resolve();
  });
});

describe('cancelledError', () => {
  it('returns a NeoError with code cancelled', () => {
    const err = cancelledError();
    expect(err).toBeInstanceOf(NeoError);
    expect(err.code).toBe('cancelled');
  });
});

describe('abortable', () => {
  it('yields all values from a finite iterable when not aborted', async () => {
    const controller = new AbortController();
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }
    const values: number[] = [];
    for await (const v of abortable(source(), controller.signal)) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('throws cancelled without calling next() when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let pulls = 0;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            pulls++;
            // Simulate slow provider work after the pull is counted.
            await new Promise<void>((r) => setTimeout(r, 10));
            return { value: pulls, done: false as const };
          },
          async return() {
            return { value: undefined, done: true as const };
          },
        };
      },
    };

    await expect(async () => {
      for await (const _ of abortable(source, controller.signal)) {
        // should never enter
      }
    }).rejects.toMatchObject({ code: 'cancelled' });

    // The critical invariant: the loop must not have dispatched a pull.
    expect(pulls).toBe(0);
  });

  it('stops iterating and throws cancelled when signal fires mid-stream', async () => {
    const controller = new AbortController();
    const values: number[] = [];

    async function* source() {
      yield 1;
      // Abort during the second iteration.
      controller.abort();
      yield 2;
    }

    await expect(async () => {
      for await (const v of abortable(source(), controller.signal)) {
        values.push(v);
      }
    }).rejects.toMatchObject({ code: 'cancelled' });

    // First value arrived before abort; second was blocked.
    expect(values).toEqual([1]);
  });
});
