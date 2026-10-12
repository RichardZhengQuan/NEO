# NEO architecture

NEO is an open-source personal AI assistant you can make your own:

- **You choose the AI.** Claude, OpenAI, Gemini, any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, Groq…). The global Text capability in Settings → AI selects the model for every turn. Fresh installs have no providers; connect an AI in Settings → AI before chatting.
- **You choose what it remembers.** Every memory is visible, editable, pinnable and forgettable. NEO remembers what matters automatically; you can review, edit or forget it and go off the record. Memories marked *sensitive* are by default only shared with models running on your own infrastructure.
- **You choose where it runs.** *On-device*: the desktop app embeds the NEO server and stores everything locally. *Self-hosted*: run the same server on your own machine or VPS (Node or Docker), then connect the web app, phone and CLI to it.
- **A net of memories, like a person.** Memories are nodes of different kinds joined by weighted associations. Recall spreads activation through the net. Unused memories fade, recalled ones get stronger, and idle-time consolidation turns experiences into knowledge.
- **Personality grows from memory.** NEO adapts its voice, reply language and way of helping through conversations. Tell it how you prefer answers or what to call you; those preferences become memories. Settings customize only its avatar, and its display name is always NEO.
- **Tools that get things done.** Reminders backed by a reliable scheduler and notifications on every platform, tasks, notes, time, calculator, web fetch/search, memory tools and plugins.
- **Generated UI everywhere.** The assistant answers with native UI (cards, tables, charts, forms, task and reminder widgets…) that renders on web, desktop and mobile, with a text fallback in the CLI.

## Monorepo

```
packages/
  protocol   shared contracts: zod schemas, types, pure helpers (isomorphic)   ← everything depends on this
  tunnel     isomorphic Noise NK channels, framed HTTP/WS transport and server dispatch
  relay      Node WebSocket relay: authenticated registrations and opaque ciphertext forwarding
  storage    node:sqlite database, migrations, conversation/settings/secret/device/push/provider-config stores
  providers  model adapters (Anthropic SDK; raw fetch for OpenAI-compatible & Gemini) + internal test double
  memory     the memory net (graph store, embeddings, recall, write path, consolidation)
  tools      tool registry, productivity stores, reminder scheduler, built-in tools, plugins
  core       agent runtime (turn loop, context assembly, confirmations, memory write-back)
  server     composition root, Hono HTTP API, WebSocket events, auth, notifications, web push
  client     typed API client (HTTP + WS + SSE), used by every app
  ui         React components: generative-UI renderer, chat, memory graph, theme, i18n
  cli        `neo` command: serve, chat, init, pair, memory export/import
apps/
  web        Vite + React PWA (the one UI codebase)
  desktop    Electron: embeds the server (on-device mode) and shows the web build
  mobile     Capacitor: wraps the web build for iOS/Android, connects to your server
```

Dependency direction (no cycles):

```
protocol ← storage ← memory ─┐
protocol ← storage ← tools ──┤
protocol ← providers ────────┼─ server ← cli
protocol ← core ─────────────┘     ↑
protocol ← client ← ui ← web ← desktop (loads the web build; imports server + client)
protocol ← tunnel ──────────┬─ server
                            ├─ relay (standalone ciphertext forwarder)
                            └─ web (encrypted phone transport)
```

`core` depends only on `protocol` interfaces (`ConversationStore`, `ProviderRegistry`, `MemoryService`, `ToolRegistry`, `SettingsStore`). The server wires the concrete implementations together. This is why every package can be built and tested on its own with fakes.

### Build & module conventions

- TypeScript 5.9, ESM only, `module/moduleResolution: NodeNext`. **Relative imports carry `.js` extensions.**
- Each package exports `{ "neo-source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }`.
  - `tsc --noEmit` (typecheck), vitest and Vite use the `neo-source` condition, so they read sibling packages' **sources** and need no build step.
  - `tsc -p tsconfig.build.json` emits `dist/` against dependencies' `dist` d.ts. `pnpm build` runs in topological order.
- Runtime Node code (server, cli, desktop main) runs from `dist/`.
- Tests: vitest, **offline**, colocated as `src/**/*.test.ts(x)`.
- `node:sqlite` (Node ≥ 22.13) is the only database. No native modules.

## One timeline, bounded episodes

NEO has one continuous timeline: a relationship with one assistant does not need a chat list, new chats, pins or archives. Memory carries long-term context. Internally, each `conversations` row is an **episode** and its `messages` stay together as a contiguous block. Episodes bound model context and give prompt caches a stable system prompt and toolset without making the user manage threads.

The server selects the episode on each send. It starts a new episode when the gap since its last message is at least `timeline.episodeGapMinutes` (60 by default), its history plus the incoming turn would exceed `agent.contextTokenBudget`, a user deletion closed it, or off-record mode changes. The episode's system prompt and toolset are frozen once; a new episode can adopt changed tool permissions. Every turn uses the global AI Text capability, with no per-episode model override or generated title.

If the immediately previous episode ended less than 24 hours ago, the first user message includes a hidden context part quoting the last at most six messages with timestamps. It is rendered once, persisted, and replayed verbatim. Recalled memories still accompany every turn. Recent context follows the same sensitive-content policy as memory context and is never put in the system prompt. Off-record text never carries into a normal episode.

Storage migration v5 preserves existing conversations and messages, using the first message's time as the episode start (creation time for empty episodes). Existing pinned, archived and incognito conversations become closed past episodes; overlapping episodes stay as contiguous blocks ordered by start time rather than interleaving their messages. Legacy incognito episodes are marked off-record but non-ephemeral, so cleanup cannot delete existing data. The original ids remain memory provenance ids. Message FTS indexes visible text, with triggers maintaining it on append, streaming updates and deletion.

Storage migration v6 adds a singleton `timeline_state` row with the private session's original start time and current episode id. `POST /api/timeline/off-record/start` closes the normal episode and creates an empty private episode. Repeated starts return the existing state. Episode closure, deletion and rotation cannot disable private mode; only explicit end or the existing 12-hour purge does so. `GET /api/timeline/off-record` restores client state, and the global `timeline.off_record { active }` event updates other devices.

New off-record episodes are ephemeral. They allow recall without reinforcement or association writes, but no memory extraction or memory writes. Every send, UI action and confirmation uses the persisted mode, even when its source is an older normal message. Result messages and updated widget copies go into the active private episode. Normal source messages retain their pre-start content. A pending normal turn's continuation moves into the private episode when start takes effect. `POST /api/timeline/off-record/end` cancels and settles private work, then hard-deletes all ephemeral off-record episodes, messages and FTS rows. Startup and a minute timer expire the whole session strictly after 12 hours from its original start, including its newer rotated episodes. Deleting timeline messages keeps derived memories and reports their count; source-based forgetting is a separate user action.

Dependency Rule: Frameworks & Drivers (SQLite and HTTP) → Interface Adapters (stores and routes) → Use Cases (core episode selection and turns) → Entities (protocol contracts). Core depends on protocol abstractions, so episode policy has no dependency on the concrete server or database.

## A timeline turn

```
client ──POST /api/timeline/messages──▶ server ──▶ runtime.sendTimeline()
                                                            │ 0. resolve a usable provider; fail with no_provider before transcript writes if none
                                                            │ 1. persist user message (with a context part, see below)
                                                            │ 2. recall memories (unless recall off; no reinforcement off the record)
                                                            │ 3. resolve global Text model; freeze system prompt + toolset on episode first turn
                                                            │ 4. loop ≤ maxSteps:
                                                            │      provider.chat(stream) → text/reasoning deltas → events
                                                            │      tool calls → permission → (confirm?) → execute → results/ui parts
                                                            │ 5. persist assistant message; turn.finished
                                                            │ 6. async: memory.observe(turn) unless off-record → memory.written event
client ◀──────────── WebSocket events (all devices) ◀───────┘   (and/or SSE for this turn)
```

### Context assembly (append-only transcript)

Prompt caching and preserved thinking (for example, Anthropic models bind thinking blocks to the exact conversation prefix) both need the transcript to be **append-only**. Each request must be a byte-identical prefix of the next one. So:

1. **System prompt** = fixed NEO identity and behavior + tool/UI guidance. It is built **once**, at the first turn, and stored on the episode (`conversation.systemPrompt`). It never contains the time, memories or anything else that changes. Personality grows from recalled `assistant-style` preference memories in per-turn context, rather than settings or system-prompt edits.
2. **Toolset** is frozen at the first turn (`conversation.toolset`). It is the set of tool names whose permission was not `deny`. A tool that is later set to `deny` stays declared, and calls to it are refused at execution time. Tools added later are offered only in new episodes.
3. **Per-turn context** (current date/time/timezone and recalled memories) is rendered **once** into a `context` part at the start of the user message (`<neo_context>…</neo_context>`). It is persisted and replayed verbatim. Clients hide context parts.
4. **Episode boundaries** keep history bounded before a user message is appended. Ordinary timeline turns replay the complete current episode; persisted history is never rewritten. Internal legacy callers retain front-only whole-turn trimming.
5. **Model switches**: reasoning parts carry `provider`/`model`. Adapters replay opaque reasoning data only to the same provider+model and drop it otherwise. If a provider rejects replayed reasoning anyway (signature/prefix mismatch), the adapter strips reasoning blocks from the history and retries once.

### Generative UI

The model shows UI by calling the `render_ui` tool with `{ blocks: UIBlock[] }`. Blocks are validated against `UIBlockSchema` plus depth, size and URL safety limits. Valid blocks are appended to the assistant message as `ui` parts, and the tool result tells the model what was shown. Models without tool calling may emit ```neo-ui fenced JSON instead; core extracts it with `extractInlineUI`. Tools may also return `ui` blocks directly (for example, `create_reminder` returns a live reminder widget).

User interactions go to `POST /api/timeline/ui-action` with `{messageId, uiId, actionId, values}`. The server looks the action up **in the stored message**; client-sent action definitions are never trusted. Then:

- `message`: a new turn with that text.
- `event`: a new turn whose user message holds a `ui_event` part (the model sees a description of it).
- `tool`: the tool runs directly with permission checks (`origin: 'ui'`), with no LLM round trip. This is how task checkboxes and "Snooze 10 min" buttons are instant.
- `link` / `copy`: returned to the client to perform.

### Reminders and notifications

`ReminderStore` persists reminders. `ReminderScheduler` keeps one timer for the next due reminder (capped at 60 s, so sleep and clock jumps self-correct). It also catches up on start: anything overdue fires immediately, and anything later than the grace period (15 min) is flagged `missed`. Recurring reminders advance in their own IANA timezone, which keeps them DST-safe. On fire, the server's notifier:

1. stores a `Notification` and publishes `reminder.fired` and `notification.created` over WebSocket,
2. sends **Web Push** (VAPID) to every subscribed browser/PWA, so it works when the tab is closed,
3. the **desktop** app shows an OS notification from its main process,
4. the **mobile** app also schedules reminders as on-device local notifications, so they fire even when the server is unreachable.

Reminder and notification links use `{ messageId }` and `neo://timeline/<messageId>`, so following a source opens the message in the timeline instead of a chat. Legacy reminder links are backfilled by tools migration v6, retaining their original storage column.

### Memory

See [MEMORY.md](MEMORY.md). Recall happens before the model call, and write-back happens after the turn (async, never blocks the reply). Consolidation runs on a timer (`memory.consolidation.intervalHours`) and on demand.

## Phones: pairing and the encrypted tunnel

The owner opens **Settings → Devices → Pair a phone**. A v2 QR link carries a
one-time code (five-minute expiry) and a public server address and/or a tunnel
route. Tunnel links include the server's id, pinned static public key and
reachable LAN addresses and/or a configured relay URL. A phone claims the code for its own revocable bearer
token. Public HTTPS is preferred; otherwise the phone uses a present tunnel
route, or a direct HTTP address when no tunnel is provided.

`@neo/tunnel` uses `Noise_NK_25519_ChaChaPoly_SHA256`. NK fits this pairing flow:
the phone already knows the server's pinned static X25519 key, so the handshake
authenticates the server and establishes fresh session keys with forward
secrecy. The phone's identity is authenticated afterward by its bearer token
inside the encrypted channel. A wrong pinned key cannot open the channel.

Each outer WebSocket binary message carries one Noise message. Encrypted
plaintext frames have a type byte, a four-byte stream id and payload. Separate
streams multiplex HTTP requests, streamed responses (including SSE), and text
messages for the existing `/api/ws` event connection. Protocol contracts and
limits live in `packages/protocol/src/tunnel.ts`; crypto and framing live in
`packages/tunnel`.

When phone access is enabled, the server opens a separate LAN listener at
`ws://<address>:7778/v1/tunnel` by default. Every ordinary HTTP request on that
listener receives 404. It accepts only the encrypted tunnel protocol and
dispatches decrypted requests into the same Hono app; routes, bearer auth,
body limits and errors are reused. Tunneled event sockets run the existing
first-message auth, subscriptions, rate limits and revocation handler. Turning
phone access off closes the listener and all its LAN sessions. If the preferred
port is occupied, an available port is advertised in the QR instead.

For away-from-home access, `@neo/relay` is a separate, self-hostable Node
WebSocket server. Both the computer and the phone connect out to it. The
computer opens `/v1/server`, receives a fresh 32-byte challenge, and registers
by signing `RELAY_REGISTER_CONTEXT` plus that challenge with its Ed25519 key.
The relay verifies the signature and that `serverId` is derived from the
signing public key using `SERVER_ID_CONTEXT`. An earlier signature cannot be
replayed, and another key cannot claim the id. A genuine new registration
replaces the previous socket and closes its phones.

Phones open `/v1/connect/<serverId>`. The relay allocates an id per live phone,
announces `Open` (phone IP for limits), and wraps each Noise message in a
five-byte `Data` header; `Close` ends that phone connection. The computer
creates a separate `MessageLink` and Noise session for each phone, dispatching
through the same HTTP and event handlers as LAN. The relay only pipes opaque
bytes: pairing codes, bearer tokens, API requests and conversations remain
encrypted between phone and computer. The relay can see IP addresses, server
ids, traffic timing and sizes, and can interrupt availability.

The phone tries advertised LAN addresses first, then the relay. The computer
reconnects with jittered exponential backoff after relay failures. A configured
relay URL remains in status and pairing routes while connecting so phones can
retry. Only the owner changes the relay setting: null selects the server's
default, an empty string disables it, and a URL overrides it. NEO has no public
relay yet, so `tunnel.relayUrl` defaults to an empty string. See
[self-hosting a relay](DEPLOYMENT.md#self-hosting-a-relay).

The relay caps registrations, concurrent connections, message sizes and each
phone's combined byte rate in both directions. It disconnects idle phones,
terminates servers that miss a ping, and closes slow phone connections when
destination queues exceed their cap. Limits apply per IP, per server and
globally. Logs contain events and counts, never payloads, and truncate server
ids to eight characters. The NEO connector also caps concurrent relay sessions
at 256. A relay or LAN session does no X25519 work until the phone's first
handshake message arrives (the static key is checked once, not per session),
so Opens or connections that never handshake cost no curve operations before
their handshake timeout. Disabling phone access closes both
listeners/connectors and their live sessions.

The data-directory file `tunnel-identity.json` stores the static X25519 and
Ed25519 signing keys, written atomically with mode 0600. Corrupt identities are
quarantined and replaced with a warning; existing phones must pair again.
In-memory test services create a fresh identity without writing a file.

## Deployment modes

| | On-device (`mode: local`) | Self-hosted (`mode: server`) |
|---|---|---|
| Runs | inside the desktop app, or `neo serve` on your laptop | `neo serve` / Docker on your server |
| Binds | 127.0.0.1 (random port in the desktop app) | `server.host` (e.g. 0.0.0.0) behind TLS (Caddy/nginx) |
| Phone access | encrypted LAN listener (7778 by default), with an optional outbound relay | public HTTPS first, or LAN-first encrypted tunnel with relay fallback |
| Auth | owner token (desktop app injects it); paired phones use device tokens inside the tunnel | owner token + per-device tokens (one-time pairing QR) |
| Models | local (Ollama) or cloud | local or cloud |
| Data | `~/.neo` or the app's userData dir | `dataDir` volume |

The data directory holds `neo.db` (SQLite; WAL), `key` (32-byte master key for secrets, mode 0600), `token` (owner token), `vapid.json` (web push keys), `tunnel-identity.json` (static tunnel and relay-signing keys, mode 0600) and `plugins/`. Back up the whole directory.

## Security model

- Single owner per server. Every API route except `/api/health`, the single-use `/api/pairing/claim` and the single-use-state-protected OpenRouter OAuth callback requires `Authorization: Bearer <token>` (owner or device token). OpenRouter sign-in starts and cancellation require the owner token. The WebSocket authenticates with its first message. Device tokens are stored hashed and are revocable.
- Phone access is off by default and only the owner can change it. Pairing on an on-device server enables it. The LAN port serves no plaintext API; Noise authenticates the pinned server key, then existing bearer authentication runs inside the channel. Forwarded headers from tunnel clients are discarded, and connections, streams, bodies and auth failures are bounded.
- Relay registration proves ownership of the Ed25519 key that derives the server id, using a fresh challenge. Relay payloads stay end-to-end encrypted; the relay sees routing and traffic metadata, never bearer tokens or conversations, and never logs payloads. Connection, rate, idle and queue limits bound resource use. Proxy IP headers are trusted only when explicitly configured behind a trusted proxy.
- API keys entered in the app are encrypted at rest (AES-256-GCM, key file in the data dir) and never returned to clients.
- ChatGPT plan sign-in is local-mode only. Owner-only start/status/cancel routes manage a separate one-shot `127.0.0.1:<port>/callback` listener, PKCE and verified ID tokens. OAuth credentials stay in encrypted secret storage; re-authorisation opens a one-time loopback redirect so the ID-token hint never appears in NEO API JSON. The Responses adapter receives access tokens from a serialized refresh manager.
- Tools have a risk class and a per-tool permission (`auto` / `confirm` / `deny`). `dangerous` tools default to `confirm`. Confirmations time out as denied.
- Third-party content (web pages, search results) is wrapped in `<untrusted_content>` and the system prompt tells the model to treat it as data. Memory extraction only reads user and assistant text, never raw tool output, which limits memory poisoning.
- `web_fetch` blocks private, loopback and link-local addresses unless running in local mode with `allowPrivateNetwork`. It also caps size and time.
- Generative UI is declarative data only: no HTML or scripts, and URLs are restricted to http(s), safe `data:image/*` and in-app `neo://` routes.
- In server mode, CORS is restricted to `server.corsOrigins` plus the server's own origin.

## Key decisions

1. **TypeScript monorepo.** One language from server to phone, so the contracts are shared and checked by the compiler.
2. **node:sqlite.** Zero native builds, with FTS5 and JSON1 included. One file is easy to back up.
3. **Contracts first.** `@neo/protocol` and frozen package APIs let independent agents and contributors work in parallel.
4. **One UI codebase.** React web app, wrapped by Electron and Capacitor. Generative UI is a declarative schema rendered by `@neo/ui`.
5. **Provider-neutral streaming contract.** The agent loop never branches on the vendor. The Anthropic adapter uses the official SDK; the others use `fetch` + SSE.
6. **Append-only transcripts.** Context is injected per turn into user messages, never into the system prompt.
7. **Memory as a graph in SQL.** Nodes and edges tables with brute-force vector search over in-memory Float32 arrays (fast to about 100k nodes) plus FTS5. No external vector DB.
