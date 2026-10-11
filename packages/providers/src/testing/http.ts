/**
 * Test helpers: a recording fake `fetch` and builders for SSE / JSON responses.
 * Excluded from the build (tsconfig.build.json); used only by *.test.ts files.
 */
import type { ChatStreamEvent } from '@neo/protocol';

const enc = new TextEncoder();

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  /** Parsed JSON body (undefined for GET). */
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

export type FakeResponder = (req: RecordedRequest, callIndex: number) => Response | Promise<Response>;

/** A fake fetch that records every request and answers with `responder` (or a queue of responders). */
export function fakeFetch(responders: FakeResponder | FakeResponder[]): typeof fetch & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const req: RecordedRequest = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body, signal: init?.signal ?? undefined };
    const index = calls.length;
    calls.push(req);
    if (req.signal?.aborted) throw abortError();
    const responder = Array.isArray(responders) ? responders[Math.min(index, responders.length - 1)] : responders;
    if (!responder) throw new Error('fakeFetch: no responder');
    return responder(req, index);
  };
  return Object.assign(fn as typeof fetch, { calls });
}

export function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

export interface StreamOptions {
  /** Keep the body open after the chunks (until the request is aborted). */
  hang?: boolean;
  signal?: AbortSignal | undefined;
}

/** A byte stream that emits `chunks` and then closes (or hangs until `signal` aborts). */
export function byteStream(chunks: string[], opts: StreamOptions = {}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!opts.hang) {
        controller.close();
        return;
      }
      opts.signal?.addEventListener('abort', () => controller.error(abortError()), { once: true });
    },
  });
}

/** `data: <json>\n\n` frames (OpenAI / Gemini style). */
export function dataFrames(events: unknown[]): string {
  return events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
}

/** `event: <type>\ndata: <json>\n\n` frames (Anthropic style; the event name is the payload's `type`). */
export function typedFrames(events: { type: string }[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** Split a string into pieces of `size` characters (to stress chunk boundaries). */
export function splitEvery(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export function sseResponse(body: string | string[], opts: StreamOptions & { status?: number; headers?: Record<string, string> } = {}): Response {
  const chunks = Array.isArray(body) ? body : splitEvery(body, 7);
  return new Response(byteStream(chunks, opts), {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...opts.headers },
  });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

export function textOfEvents(events: ChatStreamEvent[]): string {
  return events.map((e) => (e.type === 'text' ? e.text : '')).join('');
}

export function ofType<T extends ChatStreamEvent['type']>(events: ChatStreamEvent[], type: T): Extract<ChatStreamEvent, { type: T }>[] {
  return events.filter((e): e is Extract<ChatStreamEvent, { type: T }> => e.type === type);
}

/** A sleep that never waits but records requested delays. */
export function recordingSleep(): ((ms: number) => Promise<void>) & { delays: number[] } {
  const delays: number[] = [];
  const fn = async (ms: number) => {
    delays.push(ms);
  };
  return Object.assign(fn, { delays });
}
