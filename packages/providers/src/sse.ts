/**
 * Server-sent events (text/event-stream) parser.
 *
 * Follows the WHATWG event-stream rules: LF, CRLF and lone CR line endings,
 * multi-line `data`, comments, `event`/`id` fields, one leading space stripped
 * from values, nothing dispatched for an empty data buffer. Leniency: a final
 * event that is not followed by a blank line is still dispatched at EOF.
 *
 * Aborting `signal` ends the iteration with NeoError('cancelled') even when
 * the body itself does not observe the signal; leaving the loop early cancels
 * the body so the connection is released.
 */
import { cancelledError } from './shared.js';
import type { SSEMessage } from './index.js';

export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<SSEMessage> {
  if (signal?.aborted) {
    void body.cancel().catch(() => {});
    throw cancelledError(signal.reason);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let aborted: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    aborted = () => reject(cancelledError(signal?.reason));
  });
  abortPromise.catch(() => {});
  const onAbort = () => aborted?.();
  signal?.addEventListener('abort', onAbort, { once: true });

  let buf = '';
  let eventType: string | undefined;
  let dataLines: string[] = [];
  let lastId: string | undefined;
  let done = false;

  const takeEvent = (): SSEMessage | null => {
    const data = dataLines.join('\n');
    const msg: SSEMessage | null = dataLines.length && data !== '' ? { data } : null;
    if (msg && eventType !== undefined) msg.event = eventType;
    if (msg && lastId !== undefined) msg.id = lastId;
    eventType = undefined;
    dataLines = [];
    return msg;
  };

  /** Process one line; returns an event when the line is a dispatch point. */
  const processLine = (line: string): SSEMessage | null => {
    if (line === '') return takeEvent();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventType = value;
    else if (field === 'id' && !value.includes('\0')) lastId = value;
    return null;
  };

  try {
    for (;;) {
      if (signal?.aborted) throw cancelledError(signal.reason);
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await (signal ? Promise.race([reader.read(), abortPromise]) : reader.read());
      } catch (err) {
        if (signal?.aborted) throw cancelledError(err);
        throw err;
      }
      if (result.done) {
        done = true;
        buf += decoder.decode();
        // A trailing line without a line break, then whatever event is pending.
        if (buf) {
          const msg = processLine(buf.endsWith('\r') ? buf.slice(0, -1) : buf);
          buf = '';
          if (msg) {
            if (signal?.aborted) throw cancelledError(signal.reason);
            yield msg;
          }
        }
        const last = takeEvent();
        if (last) {
          if (signal?.aborted) throw cancelledError(signal.reason);
          yield last;
        }
        return;
      }
      buf += decoder.decode(result.value, { stream: true });

      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (ch !== '\n' && ch !== '\r') continue;
        // A CR at the very end may be the first half of a CRLF split across chunks: wait for more.
        if (ch === '\r' && i === buf.length - 1) break;
        const line = buf.slice(start, i);
        if (ch === '\r' && buf[i + 1] === '\n') i++;
        start = i + 1;
        const msg = processLine(line);
        if (msg) {
          if (signal?.aborted) throw cancelledError(signal.reason);
          yield msg;
        }
      }
      buf = buf.slice(start);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
