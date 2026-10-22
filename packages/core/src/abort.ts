/**
 * Cancellation helpers. A turn must stop promptly when it is cancelled, even if
 * a provider stream or a tool ignores its AbortSignal (stalled network, buggy
 * plugin), so every await on outside code is raced against the turn's signal.
 */
import { NeoError } from '@neo/protocol';

export function cancelledError(): NeoError {
  return new NeoError('cancelled', 'The turn was cancelled.');
}

/** Resolve/reject with `promise`, or reject with NeoError('cancelled') as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {}); // the loser may still reject later; never let that go unhandled
    return Promise.reject(cancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Iterate `source` until it ends or `signal` aborts (then throw NeoError('cancelled')).
 * When iteration stops early the source is asked to close, without waiting for it.
 */
export async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T, void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      if (signal.aborted) throw cancelledError();
      const result = await raceAbort(iterator.next(), signal);
      if (result.done) {
        finished = true;
        return;
      }
      yield result.value;
    }
  } catch (err) {
    finished = !signal.aborted; // a source that threw is already closed
    throw err;
  } finally {
    if (!finished && iterator.return) {
      const close = iterator.return.bind(iterator);
      void Promise.resolve()
        .then(() => close())
        .catch(() => {});
    }
  }
}
