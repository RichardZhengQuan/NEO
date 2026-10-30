/**
 * SSE (Server-Sent Events) parsing for the NEO event stream.
 *
 * readEventStream parses a text/event-stream response body into AgentEvents,
 * handling chunk boundaries, CR/LF/CRLF, multi-line data fields, and comment lines.
 */
import { NeoError, type AgentEvent } from '@neo/protocol';

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a fetch Response body of text/event-stream into AgentEvents.
 *
 * Robust against:
 * - Chunks that split in the middle of a line
 * - CR (\r), LF (\n), and CRLF (\r\n) line endings
 * - Multi-line `data:` fields (joined with newline)
 * - Comment lines (starting with `:`)
 * - Missing `event:` field (uses default event type from data)
 */
export async function* readEventStream(
  response: Response,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  // Buffer for incomplete lines across chunks.
  let buffer = '';
  // A CR ends its line immediately; consume a following LF only once, even
  // when it arrives in the next chunk.
  let skipLF = false;

  // Current SSE message fields.
  let dataLines: string[] = [];
  // We only use data lines; `event:` and `id:` are ignored per spec for our use case.

  const cleanup = () => {
    try {
      reader.cancel().catch(() => {
        // Ignore cancel errors.
      });
    } catch {
      // Ignore.
    }
  };

  try {
    // If the caller provides an AbortSignal, cancel the reader when it fires.
    if (signal) {
      if (signal.aborted) return;
      signal.addEventListener('abort', cleanup, { once: true });
    }

    while (true) {
      if (signal?.aborted) break;

      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        if (signal?.aborted) break;
        throw new NeoError('stream_read_failed', 'The response body failed mid-stream.', { retryable: true, cause: err });
      }

      if (done) break;
      if (!value) continue;

      const chunk = decoder.decode(value, { stream: true });
      let start = 0;
      for (let pos = 0; pos < chunk.length; pos++) {
        const char = chunk[pos];
        if (skipLF) {
          skipLF = false;
          if (char === '\n') {
            start = pos + 1;
            continue;
          }
        }
        if (char !== '\r' && char !== '\n') continue;

        const line = buffer + chunk.slice(start, pos);
        buffer = '';
        start = pos + 1;
        skipLF = char === '\r';

        // An empty line dispatches the buffered message.
        if (line === '') {
          if (dataLines.length > 0) {
            const dataStr = dataLines.join('\n');
            dataLines = [];
            // Remove trailing \n if present (SSE spec).
            const trimmed = dataStr.endsWith('\n') ? dataStr.slice(0, -1) : dataStr;
            if (trimmed) {
              try {
                const event = JSON.parse(trimmed) as AgentEvent;
                if (signal?.aborted) break;
                yield event;
              } catch {
                // Ignore malformed JSON events.
              }
            }
          }
          continue;
        }

        // Comment line — ignore.
        if (line.startsWith(':')) continue;

        // Field line — parse field name and value.
        const colon = line.indexOf(':');
        if (colon === -1) {
          // No colon — field name with empty value.
          // We only care about `data:` so skip others.
          continue;
        }

        const field = line.slice(0, colon);
        // Value: strip one leading space if present.
        const rawValue = line.slice(colon + 1);
        const value2 = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

        if (field === 'data') {
          dataLines.push(value2);
        }
        // Ignore `event:`, `id:`, `retry:` fields.
      }

      buffer += chunk.slice(start);
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', cleanup);
    }
    cleanup();
    reader.releaseLock();
    // Flush decoder.
    if (!signal?.aborted) decoder.decode(new Uint8Array(0));
  }
}
