# NEO server API

Base path `/api`. JSON in and out, except the OpenRouter callback's HTML confirmation. Types and request schemas live in `@neo/protocol` (api.ts, events.ts). Every route except `GET /api/health` and `GET /api/auth/openrouter/callback` requires `Authorization: Bearer <token>`, where the token is the owner token or a device token. Errors use `ErrorShape` (`{ code, message, details?, retryable? }`) with the status from `httpStatusForCode`. Request bodies are validated with the listed zod schema, and validation failures return `400 bad_request` with `details` = `z.treeifyError`.

Fresh installs have no configured AI provider. Message sends without a usable provider return `400 no_provider` with connection guidance before any user or assistant message is appended. Connect a provider in **Settings → AI** and retry.

Provider creation, draft tests, updates that enable or use `kind: mock`, and settings model selections for internal mock providers return `400 bad_request`. Mock adapters are reserved for explicitly injected tests.

## Routes

| Method & path | Body (schema) | Response |
|---|---|---|
| `GET /api/health` (public) | | `HealthResponse` |
| **Timeline** | | |
| `GET /api/timeline?before&limit&around` | | `TimelinePage`: `{ items: TimelineMessage[], episodes: EpisodeBoundary[], nextCursor }`; newest page by default, oldest-first in each page; every message includes `episodeId`. Episode blocks stay contiguous. `before` is an opaque cursor; `around` is a message id or an ISO timestamp; do not combine `before` and `around` |
| `POST /api/timeline/messages` | `SendMessageRequestSchema`: `{ text?, parts?, offRecord? }`; no conversation id or model override | `202 SendMessageResponse` including `episodeId`, or with `Accept: text/event-stream` an SSE stream of this turn's `AgentEvent`s ending after `turn.finished`/`turn.failed`. A disconnect does not cancel the turn |
| `POST /api/timeline/cancel` | `{ turnId? }` | `{ cancelled }`; absent id cancels the running timeline turn |
| `POST /api/timeline/ui-action` | `UiActionRequestSchema` | `UiActionResponse`; message/event actions start a timeline turn, tool actions resolve the stored source message |
| `GET /api/timeline/search?q&limit` | | `ListResponse<TimelineSearchHit>` with `{ messageId, episodeId, createdAt, snippet: { text, highlights } }`; full-text search of visible message text; snippet ranges are described below |
| `DELETE /api/timeline/messages/:id` | | `TimelineDeleteResult`: `{ deleted, messageIds, derivedMemories }`; deletes message parts and FTS rows and closes the touched episode |
| `DELETE /api/timeline?from&to` | | `TimelineDeleteResult`; at least one ISO bound required, inclusive timestamps, `from <= to`. Derived memories remain |
| `GET /api/timeline/off-record` | | `OffRecordState`: `{ active, episodeId, startedAt }`; inactive ids/timestamps are null |
| `POST /api/timeline/off-record/start` | `{}` | `OffRecordState`; idempotently closes the normal episode and enters persisted private mode, creating an empty private episode without needing a provider |
| `POST /api/timeline/off-record/end` | | `{ deleted }` episode count; settles private work then deletes new ephemeral off-record episodes and their messages/FTS rows; without a private session it is a no-op |
| `GET /api/confirmations` | | `ListResponse<ToolConfirmation>` |
| `POST /api/confirmations/:id` | `ConfirmToolRequestSchema` | `{ ok }` (404 when unknown, expired, cancelled or already answered) |
| **Memory** | | |
| `GET /api/memory?query&kinds&status&tags&pinned&limit&offset&sort` | (comma-separated lists) | `ListResponse<MemoryNode>` with `total` |
| `POST /api/memory` | `CreateMemoryRequestSchema` | `201 MemoryNode` (`source.by = 'user'`) |
| `GET /api/memory/stats` | | `MemoryStats` |
| `GET /api/memory/graph?centerId&depth&limit&kinds&includeArchived` | | `MemoryGraph` |
| `GET /api/memory/journal?limit` | | `ListResponse<ConsolidationReport>` |
| `POST /api/memory/consolidate` | | `ConsolidationReport` (force) |
| `GET /api/memory/export?embeddings=1` | | `MemoryExport` (`Content-Disposition: attachment; filename=neo-memory-<date>.json`) |
| `POST /api/memory/import` | `ImportMemoryRequestSchema` | `ImportReport` |
| `POST /api/memory/forget-by-source` | `ForgetBySourceRequestSchema`: `{ messageIds: string[] }` | `{ deleted }`; forgets memories sourced by those messages and derived summaries, with their superseded history |
| `POST /api/memory/forget` | `IdsRequestSchema` | `{ deleted }` |
| `POST /api/memory/find-for-forget` | `ForgetMatchingRequestSchema` | `ListResponse<MemoryNode>` |
| `POST /api/memory/links` | `LinkMemoryRequestSchema` | `MemoryEdge` |
| `DELETE /api/memory/links/:edgeId` | | `{ ok }` |
| `GET /api/memory/:id` | | `MemoryNodeDetail` |
| `PATCH /api/memory/:id` | `UpdateMemoryRequestSchema` | `MemoryNode` |
| `DELETE /api/memory/:id` | | `{ deleted }` |
| **Reminders** | | |
| `GET /api/reminders?status&from&to&limit` | | `ListResponse<Reminder>` |
| `POST /api/reminders` | `CreateReminderRequestSchema` (timezone defaults to settings.timezone) | `201 Reminder` |
| `GET /api/reminders/:id` · `PATCH` · `DELETE` | `UpdateReminderRequestSchema` | `Reminder` / `204` |
| `POST /api/reminders/:id/snooze` | `SnoozeRequestSchema` | `Reminder` |
| `POST /api/reminders/:id/complete` | | `Reminder` |
| **Tasks** | | |
| `GET /api/task-lists` · `POST` | `CreateTaskListRequestSchema` | `ListResponse<TaskList>` / `201 TaskList` |
| `PATCH /api/task-lists/:id` · `DELETE` | `UpdateTaskListRequestSchema` | `TaskList` / `204` (inbox → 400) |
| `GET /api/tasks?listId&done&query&limit` · `POST` | `CreateTaskRequestSchema` | `ListResponse<Task>` / `201 Task` |
| `PATCH /api/tasks/:id` · `DELETE` | `UpdateTaskRequestSchema` | `Task` / `204` |
| **Notes** | | |
| `GET /api/notes?query&tag&limit` · `POST` | `CreateNoteRequestSchema` | `ListResponse<Note>` / `201 Note` |
| `GET /api/notes/:id` · `PATCH` · `DELETE` | `UpdateNoteRequestSchema` | `Note` / `204` |
| **Notifications** | | |
| `GET /api/notifications?unread&limit` | | `ListResponse<Notification>` |
| `POST /api/notifications/read` | `MarkReadRequestSchema` | `{ count }` |
| **Providers & models** | | |
| `GET /api/providers` | | `ProvidersResponse` (config-file + app-added providers, `ai` capability settings and legacy `defaultModel`; secrets redacted to `hasApiKey`) |
| `POST /api/providers` | `CreateProviderRequestSchema` | `201 ProviderView`. `apiKey` is stored in the SecretStore as `provider:<id>` and replaced by `apiKeySecret`. A missing `id` is derived from the kind (`openai`, `openai-2`, …). With `simple: true`, the server verifies the live model list before saving and assigns capability defaults in Simple mode. Otherwise a provider `defaultModel` becomes Text when no Text assignment exists |
| `PATCH /api/providers/:id` | `UpdateProviderRequestSchema` | `ProviderView` (config-file providers: 409) |
| `DELETE /api/providers/:id` | | `204` (config-file providers: 409; deletes encrypted credentials and clears all capability assignments that pointed at it) |
| `GET /api/providers/:id/models` | | `ListResponse<ModelInfo>` |
| `POST /api/providers/:id/test` | | `ProviderTestResult` |
| `POST /api/providers/test` | `TestProviderRequestSchema` | `ProviderTestResult` (draft, nothing saved) |
| **AI account sign-in** | | |
| `POST /api/auth/chatgpt/start` (owner only, local mode) | `StartChatGPTRequestSchema`: `{ providerId? }` | `ChatGPTStartResponse`: `{ url, state, expiresAt }`; starts a loopback listener before returning. First sign-in returns the authorize URL; re-authorisation returns a one-time loopback launch URL to keep `id_token_hint` out of API JSON. Server mode → `403 forbidden` with local-run guidance |
| `GET http://127.0.0.1:<ephemeral-port>/callback?code&state&client_id` (loopback only) | | Small HTML confirmation; state is single-use and expires after ten minutes; issued client id, PKCE and ID-token validation required. This listener is separate from the NEO API |
| `GET /api/auth/chatgpt/status?state` (owner only) | | `ChatGPTStatusResponse`: `{ status: 'waiting' \| 'connected' \| 'failed' \| 'cancelled', provider?, error? }`, with a redacted provider or typed safe error; attempts are retained briefly after completion |
| `POST /api/auth/chatgpt/cancel` (owner only) | `CancelChatGPTRequestSchema`: `{ state }` | `{ cancelled: boolean }`; closes pending listeners and aborts active exchanges |
| `POST /api/auth/openrouter/start` (owner only) | | `OpenRouterStartResponse`: `{ url, state, expiresAt }` (`expiresAt` is epoch milliseconds) |
| `GET /api/auth/openrouter/callback?code&state` (public) | | HTML confirmation on success; invalid, expired, replayed or cancelled state → `400 bad_request`; upstream rejected code/verifier → `provider_auth` |
| `POST /api/auth/openrouter/cancel` (owner only) | `CancelOpenRouterRequestSchema`: `{ state }` | `{ cancelled: boolean }` |
| **Settings & tools** | | |
| `GET /api/settings` | | `NeoSettings` |
| `PATCH /api/settings` | `UpdateSettingsRequestSchema` (deep partial) | `NeoSettings` (publishes `settings.updated`; memory policy and tool permissions apply immediately) |
| `GET /api/tools` | | `ListResponse<ToolInfo>` |
| `PUT /api/tools/:name/permission` | `SetToolPermissionRequestSchema` | `ToolInfo` (persists to settings.tools.permissions) |
| **Devices & push** | | |
| `GET /api/devices` | | `ListResponse<Device>` |
| `POST /api/devices` | `CreateDeviceRequestSchema` | `201 CreateDeviceResponse` (owner token only) |
| `DELETE /api/devices/:id` | | `204` (owner device: 400) |
| `GET /api/push/vapid-public-key` | | `VapidKeyResponse` |
| `POST /api/push/subscribe` | `PushSubscribeRequestSchema` | `{ ok }` |
| `POST /api/push/unsubscribe` | `{ endpoint }` | `{ ok }` |
| **Events** | | |
| `GET /api/ws` (WebSocket upgrade) | first message `{type:'auth', token}` within 10 s | see below |

Memory remembers automatically. `MemoryPolicy` has no `mode` or blocked-topic fields; obsolete fields in older settings are dropped when parsed. Memory statuses are `active`, `archived` and `superseded`. `memory.written` reports `created` and `updated` summaries. Sensitive-memory sharing and recall controls still apply, including read-only recall off the record.

`NeoSettings.persona` contains only `{ avatar: string | null }`; its default is `{ avatar: null }`. For example, `PATCH /api/settings` accepts `{ "persona": { "avatar": "neo-avatar:…" } }`. Legacy `name`, `tagline`, `tone`, `traits`, `instructions`, `language` and `greeting` fields are dropped during validation. Startup migrates non-default names, tone, traits, instructions and reply language from stored settings into `preference` memories tagged `assistant-style` once. NEO's UI display name stays fixed; its conversational style and names follow remembered user preferences supplied in user-message context.

Query lists such as `kinds=fact,preference` and `status=scheduled,fired` are comma-separated. Booleans are `true`/`false`/`1`/`0`.

## AI settings

`NeoSettings.ai` contains `mode: 'simple' | 'advanced'` and `capabilities`. Each of `text`, `embedding`, `speechToText`, `textToSpeech`, `image` and `video` is `{ provider: string, model: string } | null`. For example:

```json
{
  "ai": {
    "mode": "advanced",
    "capabilities": {
      "text": { "provider": "anthropic", "model": "claude-sonnet-5-5" },
      "embedding": { "provider": "openai", "model": "text-embedding-3-small" },
      "speechToText": null,
      "textToSpeech": null,
      "image": null,
      "video": null
    }
  }
}
```

Send that object, or a deep partial such as `{ "ai": { "capabilities": { "image": null } } }`, to `PATCH /api/settings`. Text is used for every timeline turn and memory extraction; episodes have no model override and titles are not generated. Null embeddings select the local hashing embedder. The voice, image and video assignments are persisted for future features and do not enable those features today.

Stored settings without `ai` are upgraded on load: `defaultModel ?? memoryModel` becomes Text, `embedding` becomes the embedding assignment, mode is Simple and the remaining assignments are null. `defaultModel` and `memoryModel` are compatibility mirrors of Text; `embedding` mirrors the embedding assignment. Legacy patches to these aliases are accepted when an `ai` patch is absent. New code should read and write `ai`. See [Providers](PROVIDERS.md#capability-settings-and-defaults) for model selection and capability detection.

## OpenRouter sign-in

Start and cancel require the owner token; paired device tokens cannot initiate account authorization. Start creates a random state and server-side PKCE verifier with a 10-minute TTL. Only the S256 challenge is placed in the authorization URL, together with `callback_url`, `key_label=NEO` and `state`. The callback URL uses `config.server.publicUrl` when set, otherwise the request origin; local desktop ports can vary.

The public callback consumes an exact, unexpired state once, before contacting OpenRouter. It exchanges the code at `/api/v1/auth/keys` using `{ code, code_verifier, code_challenge_method: 'S256' }`. The key is verified, stored encrypted and used to select Simple-mode defaults from the provider's model list. Success emits `{ type: 'provider.connected', provider: ProviderView, state }` and `settings.updated`; the state lets the waiting client identify its attempt. Clients can also poll `GET /api/providers` while the authorization tab is open.

The callback returns “NEO is connected to OpenRouter. You can close this tab.” without credentials. API responses expose only `hasApiKey`, and upstream error bodies are not reflected or logged. Cancellation invalidates a pending state; expiry or a server restart requires a new start request. A consumed state cannot be retried after an upstream error. ChatGPT account sign-in uses the separate `/api/auth/chatgpt` routes.

## Tool confirmations

A model tool call that requires approval emits `tool.confirmation` with a `ToolConfirmation`. Pending items are also available from `GET /api/confirmations`. Answer with `POST /api/confirmations/<confirmation.id> { "approve": true, "always": false }` (or `approve: false` to decline). The `id` is a server-generated, single-use `cnf_…` nonce. The provider's `toolCallId` identifies the call in the transcript and events; it is not an approval id, because providers can reuse it across turns and conversations. Expired, cancelled, unknown or answered nonces return `404 not_found`.

UI actions have a separate confirmation round trip:

1. Send `POST /api/timeline/ui-action` with `{ messageId, uiId, actionId, values? }`. The server resolves the stored action and validates its tool input. A denied tool returns `tool_denied`; a tool with `confirm` permission or `dangerous` risk returns `{ kind: "confirm", confirmation: { token, tool, title, description, risk, expiresAt } }` without executing it.
2. Show the returned `title` and `description` and ask the user to approve. These are generated from the tool definition and validated input, rather than the model's labels or `confirm` text.
3. On approval, repeat the same request with `confirmationToken: confirmation.token`. The token is bound to the conversation, message, UI part, action, tool, validated input and form values, and expires after `agent.confirmationTimeoutSec`. It permits one execution and is consumed even if the execution fails. The server re-checks tool permission before executing and returns the usual `{ kind: "tool", output, isError, summary? }` response.

Invalid, expired, mismatched, revoked or reused UI tokens return `400 bad_request` or `409 conflict`. Setting a tool to `deny` cancels its pending model confirmations and permanently revokes its outstanding UI tokens, even if it is later re-enabled. If the user declines, do not resend the request; the token expires. `auto` tools with non-dangerous risk execute immediately. UI tokens are submitted to the `ui-action` route, not `/api/confirmations/:id`.

## WebSocket

1. Client connects to `/api/ws` and sends `{"type":"auth","token":"…"}`.
2. Server replies `{"type":"ready","serverVersion":"0.1.0","seq":<current seq>}`. An invalid token gets `{"type":"error",…}` and the socket closes with code 4401.
3. Server pushes `{"type":"event","envelope":{seq, at, event}}` for every `ServerEvent`. Conversation-scoped events are filtered by the socket's subscription (default `'all'`).
4. Client may send `{"type":"subscribe","conversations":[…]|"all"}` and `{"type":"ping","id"}` (answered by `pong`). The server sends a ping frame every 30 s.

`seq` is monotonic per server process. After a reconnect, a gap means events were missed and the client should refetch state.

## Static app

When `server.webDir` is set, the server serves the built web app at `/` with SPA fallback to `index.html` for non-`/api` paths. It also serves `/manifest.webmanifest` and `/sw.js` with the correct content types and `Cache-Control: no-cache` for `sw.js` and `index.html`.

## Security headers & CORS

`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a CSP for the static app: `default-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' ws: wss: https:; style-src 'self' 'unsafe-inline'; script-src 'self'`. CORS allows the server's own origin, `server.corsOrigins`, and in local mode `http://localhost:*`, `http://127.0.0.1:*`, `capacitor://localhost` and `app://neo`.

## Auth details

- The owner token comes from `config.server.authToken`, else is read from `<dataDir>/token`, else is generated on first boot and written there (mode 0600). It is registered as the owner device (`owner: true`) so `verify` works uniformly.
- `POST /api/devices` returns a new token once, plus `pairingUrl = buildPairingUrl(publicUrl ?? requestOrigin, token)`.
- Failed auth attempts are rate-limited per IP (10/min, then `429`).

## Timeline episodes and events

Timeline search returns `snippet: TimelineSearchSnippet` as plain text with explicit match ranges, for example for `q=window seats`:

```json
{
  "text": "I prefer window seats, with literal [brackets].",
  "highlights": [[9, 15], [16, 21]]
}
```

Each `[start, end]` range uses UTF-16 code-unit offsets into `text`, with an inclusive start and exclusive end, matching JavaScript's `text.slice(start, end)`. Ranges are sorted and nonoverlapping. The text contains no injected markup or match markers; literal brackets remain ordinary text. Clients render only the supplied ranges as highlights and treat every text segment as text, without interpreting HTML.

Episodes are an internal storage and model-context boundary. The server starts one on a gap of at least `settings.timeline.episodeGapMinutes` (default 60), history budget overflow, a deletion in the current episode, or an off-record toggle. If the prior episode ended less than 24 hours ago, its last at most six messages are quoted with timestamps in a persisted context part of the next episode's first user message. Memory recall runs on every turn under the current memory policy.

WebSocket and SSE turn events keep their names and include `episodeId`; `episode.started` announces a new boundary. `conversation.updated` remains an event name for compatibility but its payload is an `Episode`, without title/model/pinned/archived fields. Provenance retains `conversationId` internally as the episode id; message links use `messageId`.

Off-record mode is server-wide and persisted independently of episode boundaries. Start broadcasts `timeline.off_record` with `{ active: true }`; end and expiry broadcast `{ active: false }` to every connected device, regardless of episode subscriptions. All sends, generated-UI actions and confirmations use this mode until explicit end. The legacy send field `offRecord: true` enters private mode; false or omission cannot exit it. Reloads read the state endpoint, and sessionStorage is only a client cache.

New off-record episodes allow read-only recall without reinforcement or association writes and prohibit extraction and memory writes. Actions on older normal messages append their resulting messages to the active private episode. Direct tool widget results also belong to that private episode; they do not update the normal source message. A pending normal turn continues in the private episode after start, retaining its pre-start normal transcript. Memory confirmations issued before start are rechecked under private policy.

Explicit end settles private work and hard-deletes all ephemeral off-record episodes, messages and FTS rows. The persisted session expires strictly after 12 hours from its original start; idempotent starts and episode rotations do not extend it. Startup and a minute timer purge expired sessions, including empty ones. Migrated incognito data is retained as non-ephemeral past off-record episodes. The `/api/conversations` CRUD, send, cancel and UI-action endpoints are removed and return 404. `agent.autoTitle` is removed; the title column remains unused in storage. There is no conversation export/import endpoint; memory export/import remains `neo-memory` and keeps episode/message provenance.
