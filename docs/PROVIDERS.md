# Providers ("you choose the AI")

Contracts: `ProviderAdapter`, `ChatRequest`, `ChatStreamEvent`, `ProviderRegistry`, `Embedder`, `PROVIDER_PRESETS` in `@neo/protocol` (providers.ts), and capability settings/default selection in ai.ts. Implementation: `@neo/providers`.

## Connect an AI

Onboarding and **Settings → AI** offer two ways to connect:

- **Sign in with ChatGPT** lets eligible Plus and Pro users authorise text requests against their ChatGPT plan when NEO runs on this computer. **Sign in with OpenRouter** opens the browser to authorize an OpenRouter account, which can provide Claude, GPT, Gemini and other models. Claude and Gemini use API keys.
- **Use an API key**, in **Simple** or **Advanced** mode. Simple needs one key: NEO detects its provider, verifies the connection by listing models, saves the encrypted key, and assigns defaults from that provider's available models. Unknown key formats show a provider selector. Advanced lets each capability use its own connected provider and model.

Key detection checks `sk-ant-` → Anthropic, `sk-or-` → OpenRouter, `AIza` → Gemini, then `sk-proj-`, `sk-svcacct-` or `sk-` → OpenAI. Other keys are unknown. OpenRouter uses `kind: 'openai-compatible'` with `baseUrl: 'https://openrouter.ai/api/v1'`, rather than a separate adapter kind.

Custom or local servers are configured only in Advanced using **Custom endpoint (OpenAI-compatible)**, a base URL and an optional key. Ollama's OpenAI endpoint is typically `http://127.0.0.1:11434/v1`; LM Studio, vLLM, Groq and other compatible servers use their own base URL. Connected accounts and keys appear in a compact list with Disconnect. Disconnecting an app-added provider removes its encrypted credentials and clears assignments that used it. Config-file providers are managed in the config file.

Fresh installs have no providers. The **Connect an AI** state and typed `no_provider` error remain until a usable text provider is available; the former demo mode is not available.

## Capability settings and defaults

`NeoSettings.ai` is the canonical runtime configuration:

```json
{
  "mode": "simple",
  "search": { "mode": "auto", "engine": null },
  "capabilities": {
    "text": { "provider": "openai", "model": "gpt-5" },
    "embedding": { "provider": "openai", "model": "text-embedding-3-small" },
    "speechToText": null,
    "textToSpeech": null,
    "image": null,
    "video": null
  }
}
```

Each assignment is `{ provider, model }` or `null`. **Text** serves chat, conversation titles and memory extraction. **Memory** selects the embedding model; when it is null, memory uses the built-in local hashing embedder. **Voice** has separate speech-to-text and text-to-speech assignments. **Image** and **Video** select generation models. Voice, image and video assignments are stored for future features; configuring them does not enable those features today.

Existing settings without `ai` migrate to Simple mode, using `defaultModel ?? memoryModel` for Text and `embedding` for Memory; all other capabilities start null. `defaultModel` and `memoryModel` remain readable compatibility mirrors of Text, and `embedding` mirrors Memory. Legacy clients can still update these aliases; current server model selection reads the capability assignments. The migration happens while loading settings and does not alter an existing database migration.

The shared `DEFAULT_AI_MODELS` table and `pickDefaultCapabilities` helper select only models returned by the provider at connection time:

| Provider | Text preference | Memory preference |
|---|---|---|
| Anthropic | `claude-sonnet-5-5`, then `claude-opus-5-5`, `claude-fable-5-1`, `claude-haiku-5-5` | None: Anthropic does not provide embeddings |
| OpenAI | Newest listed general GPT model; fallback preferences `gpt-5`, `gpt-4.1`, `gpt-4o` | `text-embedding-3-small`, then `text-embedding-3-large` |
| Gemini | Newest listed general Pro/Flash model; fallback preferences `gemini-2.5-pro`, `gemini-2.5-flash` | `gemini-embedding-001`, then `text-embedding-004` |
| OpenRouter | `anthropic/claude-sonnet-5-5`, then `openai/gpt-5`, `google/gemini-2.5-pro` | Listed embedding model, if explicitly offered |
| Custom endpoint | Listed text model | Listed embedding model, if offered |

When a preference is absent, selection falls back to an available model for that capability. Speech, image and video defaults require clear support in the model listing; otherwise they remain null. OpenRouter's `architecture.input_modalities` and `output_modalities` distinguish input understanding from output generation: image input alone does not make a model an image generator. Dedicated transcription, speech generation, image generation, video generation, realtime/audio and moderation model IDs are excluded from ordinary Text choices.

## OpenRouter sign-in

The owner calls `POST /api/auth/openrouter/start`. The server generates a random state and a 64-character PKCE verifier, stores them only in memory for 10 minutes, and returns `{ url, state, expiresAt }`. The authorization URL uses `https://openrouter.ai/auth`, `key_label=NEO`, an S256 challenge and a callback at `<server.publicUrl or request origin>/api/auth/openrouter/callback`. Localhost callbacks can use any port. The UI opens the URL through the platform's external-browser operation and waits for `provider.connected` or a refreshed provider list.

The public callback requires an exact, unexpired state and consumes it before exchanging the code. It posts `{ code, code_verifier, code_challenge_method: 'S256' }` to `https://openrouter.ai/api/v1/auth/keys`. After the exchange, the server verifies the model list, stores the returned key through encrypted secret storage, applies Simple defaults, publishes `provider.connected`, and returns a small styled HTML confirmation: “NEO is connected to OpenRouter. You can close this tab.” No key or verifier is returned to the browser, API clients or logs.

States are single-use even when an exchange fails. Invalid, expired, replayed or cancelled states are rejected. Upstream 403 errors become a safe connection error without reflecting the upstream body. `POST /api/auth/openrouter/cancel` with `{ state }` cancels a pending attempt and is owner-only. Pending attempts also disappear on server restart. Self-hosted servers should set `server.publicUrl` to the externally reachable origin before sign-in.

## Sign in with ChatGPT

ChatGPT connections use `kind: 'chatgpt'`, OAuth PKCE and the public OpenAI Responses API. This is separate from an OpenAI API key. Only text generation is supported: Simple mode selects the newest available general GPT model from the listed models, keeps embeddings on the local fallback, and leaves voice, image and video unassigned. Advanced preserves existing assignments and permits ChatGPT only for Text.

The owner starts sign-in with `POST /api/auth/chatgpt/start`. NEO first listens on `127.0.0.1` on an ephemeral port; the redirect URI is exactly `http://127.0.0.1:<port>/callback`. Each attempt has fresh state, nonce and S256 PKCE verifier, is single-use, and expires after ten minutes. Cancel closes the listener and aborts an exchange in progress. The listener serves only `GET /callback`, independently of the NEO API port.

The issuer is `https://auth.openai.com`, with authorization at `/api/accounts/authorize`, form-encoded token exchange/refresh at `/api/accounts/oauth/token`, JWKS at `/.well-known/jwks.json`, and discovery at `/.well-known/openid-configuration`. NEO pins these endpoints rather than requiring discovery on every sign-in. Authorization requests use `response_type=code`, `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, and `resource=https://api.openai.com/v1`.

The first sign-in sends `client_id=dynamic_agent_client`, `agent_name_hint=NEO` and a stable random `ext_agent_host_id` stored encrypted per installation. The callback's `client_id` query parameter supplies the issued `oaiapp_…` registration; it is used for exchange, refresh and subsequent authorization. Later authorization omits the name hint and supplies the previous `id_token_hint`. To keep that token out of NEO API responses, subsequent starts return a one-time loopback launch URL: it redirects the browser to OpenAI with the hint. Treat start URLs as private sign-in links. The required non-secret host identifier is part of the initial authorization URL.

NEO verifies RS256 ID-token signatures using JWKS and Node crypto, and checks issuer, issued-client audience, expiration and nonce. Account identity is issuer + issued client id + subject. Client id, subject, ID/access/refresh tokens, granted scopes, expiry metadata and host id are encrypted through the existing AES-GCM SecretStore, never included in provider views or logs. Refresh runs on demand before expiry, respects `earliest_refresh_at`, serializes concurrent requests, and saves each replacement refresh token. Disconnect removes the account credential bundle; the installation host id remains stable.

Text requests stream from `POST https://api.openai.com/v1/responses` with bearer authorization, `store: false` and `stream: true`. `temperature` and `max_output_tokens` are omitted. Discovery uses `GET /v1/models`, selects only `visibility: "list"` entries and uses their `slug`. NEO never calls ChatGPT `backend-api`. Function tools are mapped using the normal Responses API contract; their operation with plan tokens remains unverified against the live service. Hosted file-search/code-interpreter tools and embeddings, images, audio and video are unsupported.

Weekly sharing limits, temporary unavailability and Plus/Pro eligibility errors have specific guidance. Invalid users and refresh `invalid_grant` mark the encrypted account as needing re-authorisation, and Settings shows **Sign in again**. Callback failures are exposed as safe typed errors through owner-only `GET /api/auth/chatgpt/status?state=…`; tokens and upstream error bodies are never reflected.

Sign-in is disabled in `mode: 'server'`: **Available when NEO runs on this computer; use an API key or OpenRouter on a remote server.** A loopback callback reaches the browser's computer, so credential transfer to a VM or remote host is out of scope. Live OpenAI sign-in, account eligibility, actual model availability, refresh timestamp format and plan-token function tools need a manual test; automated coverage uses local fake services only.

## Native web search

Search defaults to `ai.search: { mode: 'auto', engine: null }`, in Simple and Advanced mode. Auto uses the current Text model's `capabilities.nativeWebSearch`, then a configured engine, then no search. Advanced exposes Search settings; Simple needs no extra setup. `engine` forces the configured engine, and `off` disables both paths. An app-configured engine overrides the boot `webSearch` engine; null retains that boot default. Keys entered in settings are encrypted and never returned.

| Text provider/model | Native search | Upstream request field |
|---|---|---|
| Anthropic supported Claude 3.5/3.7 and 4/5 families, official endpoint | Supported | Append `{ type: 'web_search_20250305', name: 'web_search', max_uses? }` to `tools`; `max_uses` is sent when `request.webSearch.maxUses` is provided |
| OpenAI `*-search-*` models, official Chat Completions endpoint | Supported | `web_search_options: {}` |
| Other OpenAI Chat Completions models (including general GPT models) | None | No search field |
| ChatGPT sign-in, Responses API | **Unverified for plan tokens** | Append `{ type: 'web_search' }` to `tools` |
| Gemini 2.x and newer text models, official endpoint | Supported | Append `{ google_search: {} }` to `tools` |
| OpenRouter (`openai-compatible`, `https://openrouter.ai/api/v1`) | Supported | `plugins: [{ id: 'web' }]` |
| Other compatible/custom endpoints, Ollama, internal mocks | None | No search field |

Supported describes the implemented API contract and offline fake coverage, not a live API certification. Native search, citations, grounding, model eligibility and combinations with function tools have not been tested against live APIs. Custom base URLs do not inherit hosted-search support. OpenAI model eligibility lives in the documented `supportsOpenAIWebSearch()` predicate in `packages/providers/src/openai.ts`; update that function when Chat Completions support changes.

Only chat turns set `request.webSearch`; title, memory extraction and consolidation calls never do. Adapters normalize Anthropic server search results/text citations, Responses `web_search_call`/`url_citation`, Chat Completions URL annotations and Gemini `groundingChunks` to `sources` events. Hosted search is never dispatched as a NEO function tool. Anthropic and Responses retain hidden, model-scoped `provider_part` data for append-only replay; source link rows are presentation data and are not added to user context or the system prompt.

A search-specific ChatGPT HTTP or stream rejection throws the nonretryable typed `search_unavailable` error once. That adapter then reports native search unavailable for its lifetime and omits hosted search on subsequent requests; Auto can fall back to an engine. Authentication, subscription limits and transient failures keep their existing error guidance and do not disable search.

The official OpenAI `gpt-4o-search-preview` and `gpt-4o-mini-search-preview` families (including dated variants) advertise `tools: false` and omit function tools, tool choice, temperature and `response_format`. JSON callers retain a textual JSON instruction. This narrow compatibility guard has offline fake coverage; it is also unverified against the live API. General GPT, OpenRouter and custom endpoint behavior is preserved.

## Streaming contract (all adapters)

- `chat()` yields `text` and `reasoning` deltas as they arrive, optional normalized `sources`, and scoped `provider_part` replay data. It accumulates tool-call argument JSON internally and yields **one** complete `tool_call` per call, with `input` parsed. When the JSON is invalid or truncated, the adapter yields `input: { __invalid_json: "<raw>" }` so the registry rejects it and the model retries. It yields `reasoning_part` once per finished reasoning block that carries replay data, then optional `usage`, then exactly one `done`.
- Failures throw `NeoError`: `provider_auth` (401/403), `rate_limited` (429, `retryable`, `details.retryAfterMs`), `provider_error` (5xx/network, `retryable`), `cancelled` (abort), `bad_request`-like 4xx → `provider_error` with the provider's message.
- API-key adapters retry `429/5xx/network` before the first byte up to 2 times (backoff 0.5 s, 1.5 s; honor `retry-after` ≤ 10 s). The ChatGPT plan adapter surfaces its specific limit/auth/availability guidance immediately. Never retry mid-stream.
- `request.signal` aborts the HTTP request and ends the iterator with `NeoError('cancelled')`.
- Forced tool choice is never sent (several current models reject it). `toolChoice` is `auto` or `none`.
- `isLocal` = `config.local ?? (kind === 'ollama' || kind === 'mock' || isLocalUrl(baseUrl))`.
- API key: `config.apiKey ?? resolveSecret(config.apiKeySecret)`. A missing key for a provider whose preset `needsKey` throws `provider_auth` with a friendly message.
- **Replay rule:** reasoning parts are replayed only when `part.provider === config.kind` and `part.model === request.model`, and only if the adapter understands `part.data`. Otherwise they are dropped.

## Anthropic (`kind: 'anthropic'`): official SDK

Uses `@anthropic-ai/sdk` (TypeScript). Read the bundled Claude API skill docs (typescript/claude-api/README.md, streaming.md, tool-use.md) for exact SDK usage. Never guess SDK names.

- `new Anthropic({ apiKey, baseURL: config.baseUrl, fetch, maxRetries: 2 })`. Stream with `client.messages.stream({...})` (or `create({stream:true})`) and translate raw events: `content_block_start` (text / thinking / redacted_thinking / tool_use), `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`), `content_block_stop`, `message_delta` (stop_reason, usage), `message_stop`.
- Simple-mode default text model `claude-sonnet-5-5` when listed. Suggested alternatives: `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`.
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
- `listModels`: `GET {base}/models`. Dedicated OpenAI embedding, transcription, speech, image and video IDs advertise their own capabilities instead of Text. Compatible-server metadata (`architecture` modalities, `supported_parameters`, `context_length`, `top_provider.max_completion_tokens`) overrides name hints when present. Ollama: `GET <baseUrl>/api/tags` (names), with capabilities guessed from the name (vision: `llava|vision|-vl|gemma3|llama3.2-vision|qwen2.5vl|gpt-4o|gpt-5`; contextWindow from a small table, default 32k).
- `embed`: `POST {base}/embeddings {model, input}` → `data[].embedding`. Ollama: `POST <baseUrl>/api/embed {model, input}` → `embeddings`.
- Network errors produce helpful messages, e.g. "Can't reach Ollama at http://127.0.0.1:11434. Is it running? (`ollama serve`)".

## Gemini (`gemini`): raw fetch

- `POST {base}/models/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key`.
- `systemInstruction`, `contents` (`user`/`model`; parts `text`, `inlineData`, `functionCall {name,args}`, `functionResponse {name, response:{result}}`), `tools:[{functionDeclarations}]` with schemas **sanitized** to the OpenAPI subset (drop `$schema`, `additionalProperties`, `$ref`/`$defs` (inline), `const`→`enum`, `anyOf [X, null]` → X + `nullable`), `toolConfig.functionCallingConfig.mode` `AUTO|NONE`, `generationConfig` (`maxOutputTokens`, `temperature`, `responseMimeType: 'application/json'` for JSON, `thinkingConfig: {includeThoughts: true}` for 2.5+ models).
- Parts with `thought: true` → reasoning. `functionCall` → tool_call (id generated). `thoughtSignature` on a part is kept in `data` and replayed on the same part type for the same model. `finishReason`: `STOP` → end (or tool_use if calls were emitted), `MAX_TOKENS` → max_tokens, `SAFETY|RECITATION|PROHIBITED_CONTENT|BLOCKLIST` → refusal. `usageMetadata` → usage (`thoughtsTokenCount` → reasoningTokens).
- `listModels`: `GET {base}/models?pageSize=200`, following page tokens. Includes `generateContent`/`streamGenerateContent` text models and `embedContent`/`batchEmbedContents` embedding models, with capabilities taken from those supported methods. Clearly identified TTS, Imagen and Veo entries advertise future generation capabilities rather than ordinary Text. `embed`: `:batchEmbedContents`.

## Internal scripted test double

`mock` is reserved for offline tests. It has no preset, cannot be created, enabled or selected through user APIs, and is excluded from boot-time user provider configuration. Fresh installs have `providers: []`; connect a supported provider before chatting. Missing providers return the typed `no_provider` error before any transcript messages are appended.

`MockProvider` streams an explicitly supplied `MockReply` script (text chunks, optional delays, tool calls and usage). Adapters require `options.mockScript`; server tests supply `mockProviders` and a script through start/service options. The neutral model name is `neo-test`.

The former built-in conversation script lives only in `packages/providers/src/testing/scripted-brain.ts`, excluded from the production build. Provider and server tests explicitly import it to retain memory extraction, consolidation, title, tool-use and transcript boundary coverage. Production adapters never load it.
