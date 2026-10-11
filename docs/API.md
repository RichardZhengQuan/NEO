# NEO server API

Base path `/api`. JSON in and out. Types and request schemas live in `@neo/protocol` (api.ts, events.ts). Every route except `GET /api/health` requires `Authorization: Bearer <token>`, where the token is the owner token or a device token. Errors use `ErrorShape` (`{ code, message, details?, retryable? }`) with the status from `httpStatusForCode`. Request bodies are validated with the listed zod schema, and validation failures return `400 bad_request` with `details` = `z.treeifyError`.

## Routes

| Method & path | Body (schema) | Response |
|---|---|---|
| `GET /api/health` (public) | | `HealthResponse` |
| **Conversations** | | |
| `GET /api/conversations?limit&before&archived&query` | | `ListResponse<Conversation>` |
| `POST /api/conversations` | `CreateConversationRequestSchema` | `201 Conversation` |
| `GET /api/conversations/:id?limit&before` | | `ConversationWithMessages` (newest `limit`, default 100) |
| `PATCH /api/conversations/:id` | `UpdateConversationRequestSchema` | `Conversation` |
| `DELETE /api/conversations/:id` | | `204` (cancels any running turn first) |
| `POST /api/conversations/:id/messages` | `SendMessageRequestSchema` | `202 SendMessageResponse`, or with `Accept: text/event-stream` an SSE stream of this turn's `AgentEvent`s (`event: <type>`, `data: <json>`), ending after `turn.finished`/`turn.failed`. A client disconnect does **not** cancel the turn |
| `POST /api/conversations/:id/cancel` | `{ turnId? }` | `{ cancelled }` |
| `POST /api/conversations/:id/ui-action` | `UiActionRequestSchema` | `UiActionResponse` |
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
| `POST /api/memory/approve` | `IdsRequestSchema` | `{ count }` |
| `POST /api/memory/reject` | `IdsRequestSchema` | `{ count }` |
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
| `GET /api/providers` | | `ProvidersResponse` (config-file + app-added providers; secrets redacted to `hasApiKey`) |
| `POST /api/providers` | `CreateProviderRequestSchema` | `201 ProviderView`. `apiKey` is stored in the SecretStore as `provider:<id>` and replaced by `apiKeySecret`. A missing `id` is derived from the kind (`openai`, `openai-2`, …). If no default model is set yet, it becomes `{ provider: id, model: defaultModel }` |
| `PATCH /api/providers/:id` | `UpdateProviderRequestSchema` | `ProviderView` (config-file providers: 409) |
| `DELETE /api/providers/:id` | | `204` (config-file providers: 409; clears defaultModel/memoryModel that pointed at it) |
| `GET /api/providers/:id/models` | | `ListResponse<ModelInfo>` |
| `POST /api/providers/:id/test` | | `ProviderTestResult` |
| `POST /api/providers/test` | `TestProviderRequestSchema` | `ProviderTestResult` (draft, nothing saved) |
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

Query lists such as `kinds=fact,preference` and `status=scheduled,fired` are comma-separated. Booleans are `true`/`false`/`1`/`0`.

## Tool confirmations

A model tool call that requires approval emits `tool.confirmation` with a `ToolConfirmation`. Pending items are also available from `GET /api/confirmations`. Answer with `POST /api/confirmations/<confirmation.id> { "approve": true, "always": false }` (or `approve: false` to decline). The `id` is a server-generated, single-use `cnf_…` nonce. The provider's `toolCallId` identifies the call in the transcript and events; it is not an approval id, because providers can reuse it across turns and conversations. Expired, cancelled, unknown or answered nonces return `404 not_found`.

UI actions have a separate confirmation round trip:

1. Send `POST /api/conversations/:id/ui-action` with `{ messageId, uiId, actionId, values? }`. The server resolves the stored action and validates its tool input. A denied tool returns `tool_denied`; a tool with `confirm` permission or `dangerous` risk returns `{ kind: "confirm", confirmation: { token, tool, title, description, risk, expiresAt } }` without executing it.
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
