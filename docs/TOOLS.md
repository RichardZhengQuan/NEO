# Tools

Contracts: `ToolDefinition`, `ToolRegistry`, `ToolContext`, `ToolResult` in `@neo/protocol` (tools.ts). Implementation: `@neo/tools`.

## Permissions

Every tool has a **risk** (`read | write | external | dangerous`) and a **default permission**. The user can override the permission per tool in Settings → Tools (`settings.tools.permissions[name]`):

| Permission | Meaning |
|---|---|
| `auto` | runs without asking |
| `confirm` | the turn pauses with a `tool.confirmation` event. The user approves or denies it (optionally "always allow"). It times out as denied after `agent.confirmationTimeoutSec` |
| `deny` | the tool is not offered to new episodes, and calls are refused |

Defaults: `dangerous` tools are `confirm`, everything else is `auto`. Tools marked `uiOnly` are never offered to the model. They run only from UI actions (`origin: 'ui'`). For UI-origin calls, `confirm` permissions and dangerous tools require a server-issued, single-use confirmation token, while `deny` still refuses.

`ToolRegistry.execute` validates the input against the zod schema and catches every error. A failure comes back as `{ isError: true, output: { error: string, issues? } }` so the model can correct itself. It never throws.

Untrusted output (`untrustedOutput: true`: web fetch/search) is wrapped with `wrapUntrusted(source, text)` before it reaches the model.

## Built-in tools (`createBuiltinTools`)

Times: tools accept `when`/`due` strings parsed by `parseDateTime(input, now, timezone)`. Accepted forms are epoch ms, ISO 8601 with offset, ISO without offset (taken as the user's local time), `"in 10 minutes"`, `"in 2 hours"`, `"in 3 days"`, `"tomorrow 9:00"`, `"tomorrow at 9am"`, `"tonight"` (20:00) and `"today 18:30"`. Outputs include both epoch ms and a local ISO string so the model can confirm naturally.

| Name | Risk / default | Input | Does / returns |
|---|---|---|---|
| `get_datetime` | read / auto | `{ timezone? }` | `{ epochMs, iso, local, timezone, weekday }` |
| `calculate` | read / auto | `{ expression }` | `{ result }` via `evaluateExpression` (no eval) |
| `create_reminder` | write / auto | `{ title, when, recurrence?: {freq, interval?, byWeekday?, byMonthDay?, count?, until?}, notes? }` | creates a reminder in the user's timezone. Output `{ reminder }` + **ui**: `reminder` block (the client draws Snooze/Done controls) |
| `list_reminders` | read / auto | `{ status?: 'upcoming'\|'fired'\|'completed'\|'all', limit? }` | reminders + up to 10 top-level live `reminder` widgets; overflow adds a Show all link to `neo://reminders`; empty results show only the summary |
| `update_reminder` | write / auto | `{ id, title?, when?, recurrence?: … \| null, notes? }` | updated reminder + ui `reminder` |
| `snooze_reminder` | write / auto | `{ id, minutes }` | reminder |
| `complete_reminder` | write / auto | `{ id }` | reminder |
| `cancel_reminder` | write / auto | `{ id }` | status `cancelled` |
| `create_task` | write / auto | `{ title, list?: name or id, due?, priority?: 0-3, notes?, tags? }` | creates the task (an unknown list name creates the list). Ui: `tasks` block for that list |
| `list_tasks` | read / auto | `{ list?, done?, query?, limit? }` | tasks + ui `tasks` |
| `update_task` | write / auto | `{ id, title?, done?, due?: string\|null, priority?, notes?, list? }` | task (used by task checkboxes) |
| `delete_task` | dangerous / confirm | `{ id }` | `{ deleted }` |
| `propose_changes` | read / auto | `{ title?, note?, changes: [{ kind: 'task.update', taskId, due?, title?, priority?, done? } \| { kind: 'reminder.create', title, when, notes? } \| { kind: 'reminder.update', reminderId, when?, title? }] }` | snapshots current values and returns proposed edits + **ui**: `changes` block; nothing is written |
| `apply_change` (UI-only) | write / auto | `{ item: ChangeItem }` | applies one stored proposed item after checking its before state; output `{ change: { id, status: 'applied', reminderId? }, task? , reminder? }`. Reminder creation is idempotent through its `creationKey` |
| `create_note` | write / auto | `{ title?, content, tags? }` | note + ui `card` preview (bounded title and ~1000-character Markdown excerpt) with an Open link |
| `search_notes` | read / auto | `{ query?, tag?, limit? }` | notes (title + 200-char excerpt) + ui `list` with Open actions to `neo://notes/<id>` |
| `get_note` | read / auto | `{ id }` | full note + bounded ui `card` preview with an Open link |
| `update_note` | write / auto | `{ id, title?, content?, append?, tags? }` | updates title/tags, or appends `content` when `append: true`; preserves existing text and refuses full-content replacement; bounded ui `card` preview with an Open link |
| `replace_note` | dangerous / confirm | `{ id, content }` | replaces all note content after confirmation, including clearing it; title and tags stay unchanged; bounded ui `card` preview with an Open link |
| `delete_note` | dangerous / confirm | `{ id }` | `{ deleted }` |
| `remember` | write / auto | `{ content, kind?, label?, importance?, entities?, pinned? }` | `memory.remember({ …, source: { by: 'tool', conversationId, messageId } })`, where `conversationId` is the episode id. Unavailable off the record. Ui: `memory` block (active → Forget) |
| `recall` | read / auto | `{ query, limit?, show? }` | `memory.recall({ text, limit, allowSensitive: ctx.allowSensitive })` → `[{ id, kind, label, content, reason }]`; `show: true` adds a `memory` block when results exist. Use it for requests about what NEO remembers; omit it for NEO's own lookups |
| `forget` | dangerous / confirm | `{ query?, ids? }` | resolves ids (`findForForget(query)` when no ids). `describeCall` names them. Then `memory.forget(ids)` → `{ forgotten: [labels], ids }` so stored memory widgets stay forgotten |
| `web_fetch` | external / auto | `{ url, maxChars? (default 20 000) }` | GET with 10 s timeout, 2 MB cap, only http(s). HTML → readable text (strip script/style/nav/footer, decode entities, collapse whitespace, keep title and link URLs). Output `{ url, title, text, truncated? }` with untrusted text. Titles are bounded to 300 characters. `maxChars` bounds the complete serialized JSON output, including metadata and escaping; `truncated: true` marks any omitted content. Text is shortened first, then title and unusually long URL metadata if necessary. **SSRF guard** (`src/net.ts`): resolve DNS through the system resolver and refuse loopback, private, link-local, CGNAT, metadata, unspecified and multicast addresses, including IPv4 embedded in IPv6, unless `allowPrivateNetwork`. The default transport pins the connection to the vetted addresses (no DNS-rebinding window). Redirects are followed manually (≤ 5) with the same check. `198.18.0.0/15` is allowed because some local proxies hand out fake IPs from it |
| `web_search` | external / auto | `{ query, count? (≤ 10) }` | registered at runtime when AI search resolves to an engine. Supports SearXNG (`/search?format=json`), Brave (`api.search.brave.com/res/v1/web/search`) and Tavily (`api.tavily.com/search`). Output `{ query, results: [{ title, url, snippet }] }` (untrusted) + assistant `sources` part |
| `render_ui` | read / auto | `{ blocks: object[] }` | validates with `validateUIBlocks`. Invalid input returns `isError` with the zod message so the model retries. Output `{ shown: true, text: uiBlocksToText(blocks).slice(0, 1000) }` + **ui**: the blocks |

The `render_ui` input schema is deliberately loose (`blocks: z.array(z.record(z.string(), z.unknown())).min(1).max(20)`), because the full recursive union would bloat every request. Its description carries a compact catalogue of block types and their key props, generated from `UI_BLOCK_TYPES` plus a hand-written cheat sheet; see [GENERATIVE_UI.md](GENERATIVE_UI.md).

## Productivity stores (`createProductivityStores`, migration namespace `tools`)

```sql
CREATE TABLE reminders (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due_at INTEGER NOT NULL, anchor_at INTEGER NOT NULL,
  timezone TEXT NOT NULL, recurrence TEXT, status TEXT NOT NULL, fired_count INTEGER NOT NULL DEFAULT 0, last_fired_at INTEGER,
  conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX reminders_due ON reminders (status, due_at);
CREATE TABLE task_lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, icon TEXT, position REAL NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES task_lists (id), title TEXT NOT NULL, notes TEXT, done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER, due_at INTEGER, priority INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', position REAL NOT NULL,
  parent_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE notes_fts USING fts5 (note_id UNINDEXED, title, content, tags);
CREATE TABLE notifications (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, data TEXT,
  created_at INTEGER NOT NULL, read_at INTEGER);
```

- The inbox list `INBOX_LIST_ID = 'list_inbox'` (name "Inbox") is created by the migration and cannot be deleted. Deleting another list moves its tasks to the inbox.
- `anchor_at` is the first due time and fixes the time of day for recurrences. Snoozing changes `due_at` only.
- Store `onChange` listeners fire after every mutation (the server forwards them as events and the scheduler re-arms).
- `markFired(id, firedAt)` increments `firedCount` and sets `lastFiredAt`. A recurring reminder gets `dueAt = nextOccurrence(rule, anchor, max(firedAt, dueAt), tz, firedCount)` and stays `scheduled`; when the rule is exhausted it becomes `fired`. A one-shot becomes `fired`. It returns the `ReminderFiring` (`occurrenceAt` = the dueAt that fired, and `missed` is decided by the scheduler).
- `snooze(id, minutes)` sets `dueAt = now + minutes` and `status = 'scheduled'`. `complete(id)` sets `status = 'completed'` (for recurring ones, the whole series stops).

## Reminder scheduler (`createReminderScheduler`)

- `start()`: `tick(now)` immediately (catch-up), then `arm()`.
- `arm()`: clear the timer, look at `nextDue()`, and `setTimeout(tick, clamp(dueAt − now, 0, maxTimerMs))`. The 60 s default cap self-corrects after sleep and clock changes. Timers are `unref()`'d.
- `tick(now)`: for each `due(now)` reminder, call `markFired`. Set `missed = now − occurrenceAt > graceMs` (15 min). Emit `onFire` listeners (errors in listeners are logged, never break the loop), then re-arm. A reminder that fires a recurrence many times over a long downtime fires **once** (catch-up collapses missed occurrences: advance past `now` in one go).
- The store's `onChange` triggers `reschedule()` (debounced via microtask).

## Timezones & recurrence

No date library is used. `utcToZoned` uses `Intl.DateTimeFormat(…, { timeZone, hourCycle: 'h23', … }).formatToParts`. `zonedTimeToUtc` guesses UTC, measures the offset, corrects, and re-checks once. In a DST gap it moves forward by the gap; for ambiguous times it takes the earlier instant.

`nextOccurrence(rule, anchor, after, tz, fired)`: take the anchor's local wall-clock time (h:m:s) and step in local calendar units:

- `hourly`: anchor + k·interval hours (UTC arithmetic).
- `daily`: local date + k·interval days at the anchor time.
- `weekly`: within each week (interval-week stride from the anchor week; weeks start on Monday as in RFC 5545's default `WKST=MO`), the `byWeekday` days (default: the anchor's weekday).
- `daily` + `byWeekday`: every day matching one of those weekdays (e.g. "every weekday at 8:00").
- `monthly`: `byMonthDay` (default: the anchor's day; −1 = last day; days that don't exist in a month are skipped, e.g. the 31st).
- `yearly`: the anchor's month/day (Feb 29 → only leap years).

The result is the first occurrence strictly after `after`. It is null when `count` would be exceeded (`fired + 1 > count`) or the result is past `until`. Tests must cover DST transitions in `America/New_York` and `Europe/Berlin`, month ends, leap years and `Asia/Shanghai` (no DST).

## Plugins

With `plugins.enabled`, `loadPlugins(<dataDir>/plugins)` imports every `*.mjs`/`*.js` file. The default export must be a `NeoPlugin` (`{ name, version?, description?, tools?: ToolDefinition[] }`). Plugins run in-process with full privileges, so enable them only for code you trust. Plugin tools are registered with source `plugin`, risk taken from the definition, and default permission `confirm` unless the plugin's tool says `read`.

Example (`~/.neo/plugins/weather.mjs`):

```js
import { z } from 'zod';
export default {
  name: 'weather',
  tools: [{
    name: 'get_weather', title: 'Weather', description: 'Current weather for a city.',
    inputSchema: z.object({ city: z.string() }), risk: 'external', defaultPermission: 'auto', untrustedOutput: true,
    async execute({ city }) {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`).then((x) => x.json());
      const c = r.current_condition[0];
      return { output: { city, tempC: c.temp_C, desc: c.weatherDesc[0].value },
               ui: [{ type: 'stat', label: city, value: `${c.temp_C}°C`, caption: c.weatherDesc[0].value, icon: 'cloud-sun' }] };
    },
  }],
};
```

MCP client support (exposing tools from MCP servers as NEO tools) is planned. Its contract is the same `ToolDefinition`.

## Search modes

`settings.ai.search.mode` defaults to `auto`: use the Text model's built-in search when supported, otherwise use the configured engine, otherwise offer no search. `engine` always uses the engine, and `off` uses neither. `ai.search.engine` is an app-configured SearXNG, Brave or Tavily engine; null keeps the boot `webSearch` engine as a fallback. Brave and Tavily require a saved key. Settings → AI → Advanced exposes these choices; Simple adds no search controls.

The runtime updates `web_search` registration from settings without restarting. Timeline search availability changes start a new bounded episode to preserve its frozen system prompt and tool declarations. A disabled search tool cannot execute through an older episode. Provider-hosted search instead uses `ChatRequest.webSearch` and adapter capability flags; it is never a NEO function call. Memory extraction, consolidation and title generation do not request search.

Engine results and native citations become assistant `sources` parts, rendered as compact external links and numbered CLI sources. Engine output retains its `<untrusted_content>` wrapper. Native search results/citations are also untrusted; the stable system guidance covers them, and assistant text from turns that request native search or use untrusted tools is withheld from automatic memory extraction. The original user text can still be remembered. Source and opaque replay parts never become user-authored text.
