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
| `form` | `title`, `description`, `fields[]`, `submitLabel` | submit sends the action id `__submit` with `values` |
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
| `memory` | `title`, `note`, `nodes[{id,kind,label,content,status}]` | Forget (active) |

Limits: at most 50 top-level blocks, 300 blocks per message, nesting depth 8, action ids unique within a message. Tones are `neutral | accent | info | success | warning | danger`. Icons are lucide-style names (`bell`, `calendar`, `check-circle`, `map-pin`, `brain`…) or a single emoji.

## Actions

`UIAction = { id, label, style?, icon?, confirm?, kind, … }`:

| kind | extra | What happens |
|---|---|---|
| `message` | `text` | sent as the user's next message |
| `event` | `payload?` | new turn whose user message contains a `ui_event` part. The model sees `<ui_event>The user activated "…" …</ui_event>` |
| `tool` | `tool`, `input?` | the server runs the tool directly (`origin: 'ui'`) after any required server confirmation, and the client shows the result summary. No model round trip |
| `link` | `url` | open (in-app for `neo://…`, browser otherwise) |
| `copy` | `text` | copy to clipboard |

The model-written `confirm` text can provide an extra client prompt, but it never authorizes execution. For live widgets the client sends the reserved ids from `widgetActionId` (`task.toggle:<id>`, `reminder.snooze:<min>`, `reminder.complete`, `memory.forget:<id>`). The server resolves them against the **stored** block with `resolveWidgetAction`, so a client can only touch items the block actually shows.

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

## Prompting the model (core system prompt excerpt)

> You can show rich UI with the `render_ui` tool: cards, lists, tables, charts, stats, forms, buttons, timelines, and more. Use it when structure helps: comparisons (table), numbers over time (chart), options to choose from (buttons with `message` actions), collecting details (form), plans (timeline). Keep text answers for simple replies. After `render_ui`, don't repeat its content in prose; add at most one sentence. Reminders, tasks and memories you create are shown automatically.
