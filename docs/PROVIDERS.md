# Providers ("you choose the AI")

Contracts: `ProviderAdapter`, `ChatRequest`, `ChatStreamEvent`, `ProviderRegistry`, `Embedder`, `PROVIDER_PRESETS` in `@neo/protocol` (providers.ts). Implementation: `@neo/providers`.

## Streaming contract (all adapters)

- `chat()` yields `text` and `reasoning` deltas as they arrive. It accumulates tool-call argument JSON internally and yields **one** complete `tool_call` per call, with `input` parsed. When the JSON is invalid or truncated, the adapter yields `input: { __invalid_json: "<raw>" }` so the registry rejects it and the model retries. It yields `reasoning_part` once per finished reasoning block that carries replay data, then optional `usage`, then exactly one `done`.
- Failures throw `NeoError`: `provider_auth` (401/403), `rate_limited` (429, `retryable`, `details.retryAfterMs`), `provider_error` (5xx/network, `retryable`), `cancelled` (abort), `bad_request`-like 4xx → `provider_error` with the provider's message.
- Before the first byte, retry `429/5xx/network` up to 2 times (backoff 0.5 s, 1.5 s; honor `retry-after` ≤ 10 s). Never retry mid-stream.
- `request.signal` aborts the HTTP request and ends the iterator with `NeoError('cancelled')`.
- Forced tool choice is never sent (several current models reject it). `toolChoice` is `auto` or `none`.
- `isLocal` = `config.local ?? (kind === 'ollama' || kind === 'mock' || isLocalUrl(baseUrl))`.
- API key: `config.apiKey ?? resolveSecret(config.apiKeySecret)`. A missing key for a provider whose preset `needsKey` throws `provider_auth` with a friendly message.
- **Replay rule:** reasoning parts are replayed only when `part.provider === config.kind` and `part.model === request.model`, and only if the adapter understands `part.data`. Otherwise they are dropped.

## Anthropic (`kind: 'anthropic'`): official SDK

Uses `@anthropic-ai/sdk` (TypeScript). Read the bundled Claude API skill docs (typescript/claude-api/README.md, streaming.md, tool-use.md) for exact SDK usage. Never guess SDK names.

- `new Anthropic({ apiKey, baseURL: config.baseUrl, fetch, maxRetries: 2 })`. Stream with `client.messages.stream({...})` (or `create({stream:true})`) and translate raw events: `content_block_start` (text / thinking / redacted_thinking / tool_use), `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`), `content_block_stop`, `message_delta` (stop_reason, usage), `message_stop`.
- Default model `claude-opus-5-5`. Suggested: `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`.
- **Thinking**: for current models (`claude-opus-5*`, `claude-sonnet-5*`, `claude-haiku-5*`, `claude-fable-5*`, `claude-opus-4-[678]`, `claude-sonnet-4-6`) send `thinking: { type: 'adaptive', display: 'summarized' }`. Map `request.reasoning` to `output_config.effort` (`off|low` → `low`, `medium` → `medium`, `high` → `high`). Never send `budget_tokens`, never send `thinking: {type:'disabled'}` to Opus 5.5 / Sonnet 5.5 / Fable, and never send `temperature` to models that reject sampling params (all of the above). Older models (e.g. `claude-haiku-4-5`): no thinking field, and temperature is allowed.
- **Replay**: thinking blocks become reasoning parts with `data: { type: 'thinking', signature }` or `{ type: 'redacted_thinking', data }`. They are replayed **unchanged** within and across turns for the same model. If the API answers 400 with a thinking-signature / "bound to a different conversation" error, strip every thinking block from the history and retry once.
- Messages: user `text`/`image` (`source: base64` or `url`), assistant `thinking`/`text`/`tool_use`, tool results as a user message of `tool_result` blocks (`content` = string; objects JSON-stringified; `is_error`). Merge consecutive same-role messages, with tool results first.
- Tools: `{ name, description, input_schema, eager_input_streaming: true }`. Validate parsed input downstream (the registry does).
- Caching: top-level `cache_control: { type: 'ephemeral' }` (automatic caching of the stable prefix).
- `responseFormat: 'json'`: append "Respond with a single JSON object only." to the system prompt. Prefill is not supported on current models, so don't use it.
- Stop reasons: `end_turn|stop_sequence|pause_turn` → `end`, `tool_use` → `tool_use`, `max_tokens` → `max_tokens`, `refusal` → `refusal` (yield a short text note if no text was produced).
- `options.refusalFallback` (default **true**, Claude API only): send beta `server-side-fallback-2026-07-01` with `fallbacks: 'default'` for `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-fable-5-1`. If the API rejects the field (400 mentioning fallback/beta), retry once without it and disable it for the adapter's lifetime.
- `listModels`: `client.models.list()`. Map `max_input_tokens` → contextWindow, `max_tokens` → maxOutputTokens, and capabilities when present. No embeddings.
- Errors: map the SDK's typed errors (`AuthenticationError`, `PermissionDeniedError` → provider_auth; `RateLimitError` → rate_limited; `APIConnectionError`, `InternalServerError` → provider_error retryable; `APIUserAbortError` → cancelled).

## OpenAI and OpenAI-compatible (`openai`, `openai-compatible`, `ollama`): raw fetch

- `POST {base}/chat/completions` with `stream: true` (+ `stream_options: { include_usage: true }` for `openai`). Ollama: `base = <baseUrl>/v1` (preset baseUrl has no `/v1`).
- Messages: system → `{role:'system'}`. User → string content when text-only, else `[{type:'text'},{type:'image_url',image_url:{url}}]` (base64 → data URL). Assistant → `{ role:'assistant', content: text||null, tool_calls:[{id,type:'function',function:{name,arguments}}] }` (reasoning dropped). Tool results → one `{role:'tool', tool_call_id, content}` each.
- Tools: `[{type:'function', function:{name, description, parameters}}]`. JSON mode: `response_format:{type:'json_object'}` (openai, ollama).
- Tokens: `openai` → `max_completion_tokens`, others → `max_tokens`. Reasoning models (`/^(o\d|gpt-5)/`): `reasoning_effort` (`off|low` → low, `medium`, `high`) and no `temperature`.
- Stream parsing via `parseSSE`: `choices[0].delta.content`, `delta.reasoning_content ?? delta.reasoning` (→ reasoning), `delta.tool_calls[]` accumulated by `index`, `finish_reason` (`stop`→end, `tool_calls`→tool_use, `length`→max_tokens, `content_filter`→refusal), the final `usage` chunk, and `[DONE]`.
- `listModels`: `GET {base}/models`. Ollama: `GET <baseUrl>/api/tags` (names), with capabilities guessed from the name (vision: `llava|vision|-vl|gemma3|llama3.2-vision|qwen2.5vl|gpt-4o|gpt-5`; contextWindow from a small table, default 32k).
- `embed`: `POST {base}/embeddings {model, input}` → `data[].embedding`. Ollama: `POST <baseUrl>/api/embed {model, input}` → `embeddings`.
- Network errors produce helpful messages, e.g. "Can't reach Ollama at http://127.0.0.1:11434. Is it running? (`ollama serve`)".

## Gemini (`gemini`): raw fetch

- `POST {base}/models/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key`.
- `systemInstruction`, `contents` (`user`/`model`; parts `text`, `inlineData`, `functionCall {name,args}`, `functionResponse {name, response:{result}}`), `tools:[{functionDeclarations}]` with schemas **sanitized** to the OpenAPI subset (drop `$schema`, `additionalProperties`, `$ref`/`$defs` (inline), `const`→`enum`, `anyOf [X, null]` → X + `nullable`), `toolConfig.functionCallingConfig.mode` `AUTO|NONE`, `generationConfig` (`maxOutputTokens`, `temperature`, `responseMimeType: 'application/json'` for JSON, `thinkingConfig: {includeThoughts: true}` for 2.5+ models).
- Parts with `thought: true` → reasoning. `functionCall` → tool_call (id generated). `thoughtSignature` on a part is kept in `data` and replayed on the same part type for the same model. `finishReason`: `STOP` → end (or tool_use if calls were emitted), `MAX_TOKENS` → max_tokens, `SAFETY|RECITATION|PROHIBITED_CONTENT|BLOCKLIST` → refusal. `usageMetadata` → usage (`thoughtsTokenCount` → reasoningTokens).
- `listModels`: `GET {base}/models?pageSize=200`, filtered to `generateContent`. `embed`: `:batchEmbedContents`.

## Mock (`mock`): offline demo brain and test double

`MockProvider` streams a `MockReply` (text in `chunkSize` chunks, optional `delayMs`, tool calls, usage). `options.mockScript` decides replies. The default `defaultMockScript` makes NEO explorable without any AI:

- `metadata.purpose === 'memory-extract'`: parse the exchange from the prompt and return extraction JSON using simple rules ("my name is X", "I like/love X", "I don't like X", "remember that X", "my <relation> is X", "I live in X", "I work at X", 我叫/我喜欢/记住).
- `metadata.purpose === 'memory-consolidate'`: `{ "summary": { "label": "...", "content": "...", "importance": 0.5 }, "facts": [] }` from the episode labels.
- `metadata.purpose === 'title'`: the first few words of the first user text.
- The last message is `tool` → a friendly confirmation per tool (create_reminder: "Done! I'll remind you …", list_tasks: "Here are your tasks.", render_ui: "Here you go.", errors: "That didn't work: …").
- User text intents (only when the tool exists in `request.tools`): remind me … → `create_reminder` (`when` parsed as "in N minutes/hours", "tomorrow 9:00", default "in 10 minutes"); add X to my list / todo: X → `create_task`; my tasks → `list_tasks`; remember (that) X → `remember`; what do you remember/know about X → `recall`; forget X → `forget`; note: X → `create_note`; time/date → `get_datetime`; arithmetic → `calculate`; show (me) a demo/dashboard/chart → `render_ui` with a showcase (card + stats + chart + buttons); a URL → `web_fetch`.
- Otherwise: a short friendly reply that says it's demo mode, echoes the gist, and mentions up to two memories found in the `<neo_context>` block ("I remember: …"), so the memory net is visible even offline.
