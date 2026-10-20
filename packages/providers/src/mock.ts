/**
 * Internal test double. `MockProvider` streams whatever the explicit script returns.
 */
import { NeoError, estimateTokens } from '@neo/protocol';
import type { ChatRequest, ChatStreamEvent, ModelCapabilities, ModelInfo, ProviderAdapter, ProviderConfig, ProviderTestResult } from '@neo/protocol';
import type { MockReply, MockScript, ProviderOptions } from './index.js';
import { abortableSleep, newCallId, throwIfAborted } from './shared.js';

const DEFAULT_CHUNK_SIZE = 12;
const TEST_MODEL = 'neo-test';

function* chunks(text: string, size: number): Generator<string> {
  const step = Math.max(1, Math.floor(size));
  const chars = [...text]; // never split a surrogate pair (emoji, rare CJK)
  for (let i = 0; i < chars.length; i += step) yield chars.slice(i, i + step).join('');
}

export class MockProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind = 'mock' as const;
  readonly config: ProviderConfig;
  /** The mock never leaves the machine. */
  readonly isLocal: boolean;

  private readonly script: MockScript;
  private callIndex = 0;

  constructor(config: ProviderConfig, options: ProviderOptions = {}) {
    this.id = config.id;
    this.config = config;
    this.isLocal = config.local ?? true;
    if (!options.mockScript) throw new NeoError('config_error', 'Mock providers require an explicit test script.');
    this.script = options.mockScript;
  }

  capabilities(_model: string): ModelCapabilities {
    return { nativeWebSearch: false, tools: true, vision: false, reasoning: false, embeddings: false, contextWindow: 128_000, maxOutputTokens: 8192 };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    throwIfAborted(request.signal);
    let reply: MockReply;
    try {
      reply = await this.script(request, this.callIndex++);
    } catch (err) {
      throw NeoError.from(err, 'provider_error');
    }

    if (reply.delayMs && reply.delayMs > 0) await abortableSleep(reply.delayMs, request.signal);
    const size = reply.chunkSize ?? DEFAULT_CHUNK_SIZE;
    for (const piece of chunks(reply.reasoning ?? '', size)) {
      throwIfAborted(request.signal);
      yield { type: 'reasoning', text: piece };
    }
    for (const piece of chunks(reply.text ?? '', size)) {
      throwIfAborted(request.signal);
      yield { type: 'text', text: piece };
    }
    throwIfAborted(request.signal);
    const toolCalls = reply.toolCalls ?? [];
    for (const tc of toolCalls) {
      throwIfAborted(request.signal);
      yield { type: 'tool_call', id: tc.id ?? newCallId('call_mock'), name: tc.name, input: tc.input };
    }

    const inputText = [request.system ?? '', ...request.messages.flatMap((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')))].join('\n');
    throwIfAborted(request.signal);
    yield {
      type: 'usage',
      usage: reply.usage ?? { inputTokens: estimateTokens(inputText), outputTokens: estimateTokens(`${reply.reasoning ?? ''}${reply.text ?? ''}`) },
    };
    throwIfAborted(request.signal);
    yield { type: 'done', stopReason: reply.stopReason ?? (toolCalls.length ? 'tool_use' : 'end') };
  }

  async listModels(_signal?: AbortSignal): Promise<ModelInfo[]> {
    return [{ id: TEST_MODEL, provider: this.id, label: 'NEO Test', capabilities: this.capabilities(TEST_MODEL) }];
  }

  async test(_signal?: AbortSignal): Promise<ProviderTestResult> {
    return { ok: true, latencyMs: 0, models: [TEST_MODEL] };
  }
}
