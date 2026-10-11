/**
 * Replayable async event log of one turn (TurnHandle.events).
 *
 * The producer (the turn loop) pushes synchronously and is never blocked by a
 * slow or absent consumer. Every iterator — whenever it starts — receives every
 * event from the first one, in order, and ends after close(). Events are kept
 * for the lifetime of the queue, which is bounded by one turn.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly events: T[] = [];
  private closed = false;
  private waiters: (() => void)[] = [];

  /** Append an event. Ignored after close(). */
  push(event: T): void {
    if (this.closed) return;
    this.events.push(event);
    this.wake();
  }

  /** No more events; iterators end once they have read everything. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    let index = 0;
    let stopped = false;
    return {
      next: async (): Promise<IteratorResult<T, undefined>> => {
        for (;;) {
          if (stopped) return { value: undefined, done: true };
          if (index < this.events.length) return { value: this.events[index++] as T, done: false };
          if (this.closed) return { value: undefined, done: true };
          await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
      },
      return: async (): Promise<IteratorResult<T, undefined>> => {
        stopped = true;
        return { value: undefined, done: true };
      },
    };
  }
}
