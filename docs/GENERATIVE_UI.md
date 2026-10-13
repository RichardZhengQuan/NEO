# Generative UI

NEO answers with **native UI**, not just text. The model describes UI as data (`UIBlock` trees, defined with zod in `packages/protocol/src/ui.ts`). Each client renders the data with its own components: React (`@neo/ui` `BlockRenderer`) on web, desktop and mobile, and plain text (`uiBlockToText`) in the CLI and notifications. There is no HTML and no scripts, so a malicious or confused model cannot run code on your device.

## How the model produces UI

1. **`render_ui` tool** (preferred): `{ blocks: UIBlock[] }`. Invalid blocks come back as a tool error with the validation message, and the model fixes them.
2. **Tool results**: tools attach `ui` blocks (for example, `create_reminder` returns a live `reminder` widget, `list_tasks` a `tasks` widget, `remember` a `memory` card).
3. **Inline fallback** for models without tool calling: a fenced block in the text. Core strips it out with `extractInlineUI` and stores the blocks as `ui` parts.
   ````
   ```neo-ui
   {"type":"callout","tone":"success","text":"Saved!"}
   ```
   ````

Every rendered block becomes a `ui` part `{ type: 'ui', id: 'ui_…', block, toolCallId? }` in the assistant message, in order with the text around it.

## Block catalogue

| Type | Key props | Notes |
|---|---|---|
| `text` | `text` (Markdown) | GFM, no raw HTML |
| `heading` | `text`, `level` 1-3 | |
| `card` | `title`, `subtitle`, `icon`, `imageUrl`, `tone`, `children[]`, `actions[]`, `footer` | container |
| `list` | `title`, `ordered`, `items[{id,title,subtitle,icon,imageUrl,meta,badge,tone,action}]` | |
| `table` | `caption`, `columns[{key,label,align,format}]`, `rows[]` | `format`: number, currency, percent, date (epoch ms) |
| `chart` | `kind` bar/line/area/pie/donut, `series[{name,data[{x,y}]}]`, `title`, `xLabel`, `yLabel`, `unit`, `stacked` | SVG, themed palette |
| `stat` | `label`, `value`, `unit`, `delta`, `deltaLabel`, `caption`, `tone`, `icon` | KPI tile |
| `progress` | `label`, `value` 0-1, `caption`, `tone` | |
| `form` | `title`, `description`, `fields[]`, `submitLabel` | submit sends a target-aware id from `formSubmitActionId` with `values` |
| `buttons` | `actions[]`, `layout` | |
| `image` / `gallery` | `url`, `alt`, `caption` | https or `data:image/(png|jpeg|gif|webp|avif)` only |
| `callout` | `tone`, `title`, `text`, `icon` | |
| `code` | `code`, `language`, `filename` | copy button |
| `quote` | `text`, `cite` | |
| `divider` | `label` | |
| `grid` | `columns` 1-4, `children[]` | collapses to 1 column on phones |
| `stack` | `direction`, `gap`, `children[]` | |
| `tabs` | `tabs[{id,label,icon,children}]` | |
| `accordion` | `items[{id,title,open,children}]` | |
| `link` | `url`, `title`, `description`, `imageUrl`, `siteName` | link preview card |
| `timeline` | `items[{time,title,description,icon,tone}]` | |
| `keyvalue` | `title`, `items[{key,value}]` | |
| `tags` | `items[{label,tone,icon}]` | |
| `countdown` | `label`, `until` (epoch ms), `doneText` | live ticking |
| `reminder` | `reminderId`, `title`, `dueAt`, `timezone`, `recurrenceText`, `status` | **live widget**: Snooze 10 min / 1 h, Done |
| `tasks` | `title`, `listId`, `tasks[{id,title,done,dueAt,priority}]` | **live widget**: checkboxes |
| `changes` | `title`, `note`, `timezone`, `items[{id,kind,status,…}]` | **live widget**: review before → after and apply selected changes |
| `memory` | `title`, `note`, `nodes[{id,kind,label,content,status}]` | Forget (active) |

Limits: at most 50 top-level blocks, 300 blocks per message, nesting depth 8, action ids unique within a message. Tones are `neutral | accent | info | success | warning | danger`. Icons are lucide-style names (`bell`, `calendar`, `check-circle`, `map-pin`, `brain`…) or a single emoji.

## When to add a block

UI is data. A feature shows UI by returning blocks in a tool result or through `render_ui`. Don't build a screen, route or React component for one request or scenario. App screens exist only for what NEO keeps for the user: the timeline, memory, tasks, notes, reminders and settings.

The normal way to add a feature is a tool that returns existing blocks. `create_reminder` returns a live `reminder` widget, `list_tasks` a `tasks` widget, and `remember` a `memory` card. A read-only tool can answer with a `card`, `list` or `table`.

Add a new block type only when one of these holds, and say which in the PR:

1. It shows or changes NEO's own data through NEO's tools, like the live `reminder`, `tasks` and `memory` widgets, and more than one feature will use it.
2. The model keeps building the same thing badly from existing blocks. Include real examples in the PR.

Prefer a new optional prop on an existing block over a new type. Topic cards are compositions, not new types: a weather, flight or recipe card is `card` + `grid` + `stat`/`keyvalue`.

The block catalogue is a public contract: every client must render every type. Each block type costs:

- **Forever:** blocks are stored in the append-only timeline, so a type can never be removed or renamed, and existing props can't become required or change meaning. Old messages must keep rendering. It's the same rule as storage migrations: never change one that may already have run.
- **Every request:** each type adds a line to `BLOCK_PROPS` in `packages/tools/src/builtins/render_ui.ts`, sent to the model on every turn. More look-alike types make the model pick the wrong one more often.
- **Every client:** a React renderer in `@neo/ui` for web, desktop and mobile, a `uiBlockToText` rendering for the CLI and notifications, and an implementation in any future native client.

Models and plugins never ship HTML, CSS or scripts. Third-party code returns data and NEO draws it, which keeps a confused model or an untrusted plugin from running code on the user's device.

NEO is modeled on a person: people tell NEO what they want and NEO does it with its tools. Don't add forms or buttons where users create tasks, notes, reminders or memories by hand. The screens show what NEO keeps and allow viewing, editing, checking off and deleting.

Checklist for a PR that adds a block type:

- The zod schema and `UIBlock` union member in `packages/protocol/src/ui.ts`, plus `UI_BLOCK_TYPES`, `childBlocks` (containers only) and `uiBlockToText`.
- Widget controls through `widgetActionId` and `resolveWidgetAction` in the same file. The server resolves every action against the stored block, so a client can only act on what the block shows. Add live-widget patching in `packages/core/src/ui-actions.ts` if a tool result should update the stored block.
- A catalogue line in `BLOCK_PROPS` in `packages/tools/src/builtins/render_ui.ts`.
- The React renderer in `packages/ui/src/blocks.tsx`. It must work at 360 px, be accessible and never throw. Add en and zh-CN strings in `packages/ui/src/i18n.tsx`.
- Tests next to each change.
- A row in the Block catalogue table above.

## Actions

`UIAction = { id, label, style?, icon?, confirm?, kind, … }`:

| kind | extra | What happens |
|---|---|---|
| `message` | `text` | sent as the user's next message |
| `event` | `payload?` | new turn whose user message contains a `ui_event` part. The model sees `<ui_event>The user activated "…" …</ui_event>` |
| `tool` | `tool`, `input?` | the server runs the tool directly (`origin: 'ui'`) after any required server confirmation, and the client shows the result summary. No model round trip |
| `link` | `url` | open (in-app for `neo://…`, browser otherwise) |
| `copy` | `text` | copy to clipboard |

The model-written `confirm` text can provide an extra client prompt, but it never authorizes execution. For live widgets the client sends ids from `widgetActionId`. The server resolves them against the **stored** block with `resolveWidgetAction`, so a client can only touch items the block actually shows.

| Control | Action id |
|---|---|
| Task toggle | `task.toggle:<taskId>` |
| Reminder snooze | `__neo:reminder.snooze:<encodedReminderId>:<minutes>` |
| Reminder done | `__neo:reminder.complete:<encodedReminderId>` |
| Memory forget | `memory.forget:<nodeId>` |
| Proposed change apply | `change.apply:<itemId>` |
| Form submit (with block `id`) | `__neo:form.submit:id:<encodedBlockId>` |
| Form submit (without block `id`) | `__neo:form.submit:path:<path>` |

`__neo:` is reserved for built-in controls: `validateUIBlocks` rejects model-authored action ids with that prefix. Authored ids otherwise allow arbitrary characters, are 1–64 characters long and must be unique within a message. Target ids use `encodeURIComponent`, so colons in a reminder or form id cannot change the action's meaning. Stored block schemas and fields are unchanged.

Forms use `formSubmitActionId(form, path)`, built on `uiBlockKey(block, path)`. `walkUIBlocks(root)` yields `{ block, path, key }`, with `[]` for the root and zero-based child indexes in `childBlocks` order; tabs and accordion sections flatten their children in declaration order, including hidden sections. Paths are dot-separated indexes (`0.2.1`), or `root` for the root block. A block id takes precedence over its path. The server finds exactly that form and forwards only its declared field values in a `ui_event`, preserving the submitted action id and the form's submit label. Duplicate form ids are ambiguous and rejected.

Older clients may send `reminder.snooze:<minutes>`, `reminder.complete` or `__submit`. The server accepts a legacy reminder id only when the stored UI tree contains exactly one reminder block, and `__submit` only when it contains exactly one form. Multiple matches return `not_found` with an ambiguous-action message; the server never chooses the first match. Missing targets remain undeclared actions.

Request: `POST /api/timeline/ui-action { messageId, uiId, actionId, values?, confirmationToken? }`.

Privacy comes from persisted server mode, so this request needs no client privacy field. After `POST /api/timeline/off-record/start`, actions and approvals from older normal messages execute privately. Message/event results and direct tool widget copies belong to the active ephemeral private episode, leaving the normal source unchanged. Memory writes are rejected, including tokens issued before start; recall does not reinforce or associate memories. End settles this work and deletes the private messages. Reloads read `GET /api/timeline/off-record`; connected clients receive `timeline.off_record { active }`.

For a tool whose permission is `confirm` or risk is `dangerous`, the first request validates the tool input and returns a server-written confirmation without executing:

```json
{
  "kind": "confirm",
  "confirmation": {
    "token": "opaque-server-token",
    "tool": "forget",
    "title": "Forget memories",
    "description": "Forget “Window seats”",
    "risk": "dangerous",
    "expiresAt": 1791720120000
  }
}
```

The client shows this `title` and `description` and, after the user approves, repeats the exact action request and form values with `confirmationToken` set to the returned token. The description comes from the tool's `describeCall(validatedInput)` or a fallback of its title and compact input JSON, never from the model's action label or `confirm` string. A valid token executes once and returns `{ kind: 'tool', output, isError, summary? }`. The server binds tokens to the conversation, message, UI part, action, tool, validated input and form values. Tokens expire after `agent.confirmationTimeoutSec` and are consumed on use, including a failed execution. Reused, mismatched or expired tokens return `bad_request` or `conflict`; denial at execution time returns `tool_denied`. Declining requires no second request. `auto` tools with non-dangerous risk execute on the first request.

Setting a tool to `deny` cancels its pending model confirmations and permanently revokes outstanding UI tokens. Re-enabling the tool requires a new UI confirmation. Approved UI tools execute the exact validated input covered by their token.

Model tool-call approvals use a separate server-generated `ToolConfirmation.id` nonce from the `tool.confirmation` event or `GET /api/confirmations`. Respond at `POST /api/confirmations/:id`; never use the provider's `toolCallId` or a UI confirmation token there.

## Rendering guidelines (`@neo/ui`)

- Calm, modern and legible. Use system font stack + Inter if available, 8-pt spacing, rounded-2xl cards, soft borders, and subtle shadows in light mode and none in dark. Accent violet `#7C5CFF`. Kind colors for memory: episode amber, fact sky, entity emerald, preference pink, skill indigo, goal orange, summary slate.
- Everything works at 360 px wide. Grids collapse, tables scroll horizontally inside their card, and charts resize.
- Accessible: semantic elements, focus rings, `aria-label` on icon buttons, charts have a visually hidden data table, and contrast ≥ 4.5:1.
- Streaming: blocks appear when their part arrives (tool results). Text streams token by token with a caret.
- Never throw. An invalid block (it can't happen after server validation, but old data might) renders a small "Can't display this content" fallback with the text rendering inside `<details>`.

### Unfinished chat input

Within the current app session, leaving the timeline or switching generated tabs and accordion sections preserves composer text and image attachments, form edits, field selections, and the current generated view. A pending form submission remains pending after returning, so navigation does not enable a duplicate submission. Failed chat sends restore their draft unless newer input has replaced it.

The app owns an in-memory `RetainedStateProvider` store; generated controls are scoped by message, UI part, and nested block identity. Standalone `@neo/ui` controls retain their normal local-state behavior unless wrapped in this provider. No draft is written to browser storage or synchronized to another device, and reloading or restarting the app clears it. Disconnecting or changing the connected session clears all drafts. Recorded and off-record composer drafts are separate; ending an off-record exchange or deleting a message removes its retained input and invalidates pending writes to that input.

### Proposed changes

For planning or reorganizing saved tasks and reminders, NEO first reads the relevant items with `list_tasks` and `list_reminders`, describes a short plan, then calls the read-only `propose_changes` tool. It returns one reusable `changes` live widget with concrete task updates, one-off reminder creations and reminder updates. Each update includes the current values of exactly the fields being changed and their proposed values. Dates are shown in the block's timezone; no task durations or calendar availability are inferred. A single direct edit uses the regular task or reminder tool.

Nothing changes until the user selects pending items and applies them. The widget runs selected items sequentially through the UI-only `apply_change` tool using `change.apply:<id>` actions; the server resolves each item from the stored block. Task and reminder updates compare the current store values against the proposed `before` snapshot, and reminder updates also require a scheduled reminder. Changed or deleted items require a fresh proposal. Successful items are marked applied and are never run again by the widget; partial failures show individual errors and retry only remaining selected items. Checkbox choices survive navigation within a `RetainedStateProvider`.

Each proposed reminder creation has an opaque UUID `creationKey`. The store persists the key and its payload fingerprint: a matching repeat returns the existing reminder, a different payload fails, and deleting the reminder leaves its key consumed so delayed replay cannot recreate it. New reminder due times must still pass the future-time rule when applied. The key is separate from user-visible notes.

Only tools create `changes` blocks, through `propose_changes`. Model-authored `render_ui` and inline UI cannot create them, including inside nested containers. Existing episodes retain their frozen toolset and prompt; new episodes receive the planning tool and guidance.

## Prompting the model (core system prompt excerpt)

> You can show rich UI with the `render_ui` tool: cards, lists, tables, charts, stats, forms, buttons, timelines, and more. Use it when structure helps: comparisons (table), numbers over time (chart), options to choose from (buttons with `message` actions), collecting details (form), plans (timeline). Keep text answers for simple replies. After `render_ui`, don't repeat its content in prose; add at most one sentence. Reminders, tasks and memories you create are shown automatically.
