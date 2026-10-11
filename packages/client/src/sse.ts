/**
 * SSE (Server-Sent Events) parsing for the NEO event stream.
 *
 * readEventStream parses a text/event-stream response body into AgentEvents,
 * handling chunk boundaries, CRLF, multi-line data fields, and comment lines.
 */
import type { AgentEvent } from '@neo/protocol';

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a fetch Response body of text/event-stream into AgentEvents.
 *
 * Robust against:
 * - Chunks that split in the middle of a line
 * - CRLF (\r\n) and LF (\n) line endings
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

  // If the caller provides an AbortSignal, cancel the reader when it fires.
  if (signal) {
    if (signal.aborted) {
      cleanup();
      return;
    }
    signal.addEventListener('abort', cleanup, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;

      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        break;
      }

      if (done) break;
      if (!value) continue;

      // Decode the chunk and append to the buffer.
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines in the buffer.
      // Lines are delimited by \n or \r\n.
      let pos = 0;
      while (pos < buffer.length) {
        // Find the next line terminator.
        const lf = buffer.indexOf('\n', pos);
        if (lf === -1) {
          // No complete line yet — keep the remainder in the buffer.
          buffer = buffer.slice(pos);
          pos = 0;
          break;
        }

        // Extract the line (strip trailing \r if CRLF).
        let line = buffer.slice(pos, lf);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        pos = lf + 1;

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

      // If the inner while loop completed without break, clear the buffer.
      if (pos > 0) {
        buffer = buffer.slice(pos);
      }
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', cleanup);
    }
    // Flush decoder.
    decoder.decode(new Uint8Array(0));
  }
}
