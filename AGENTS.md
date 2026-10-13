# AGENTS.md

Instructions for AI agents working on NEO. Everything in [CONTRIBUTING.md](CONTRIBUTING.md) applies to you too; this file adds what an agent needs on top.

## Before you start

1. Read [LESSONS.md](LESSONS.md): mistakes this repo has already made.
2. Find your area below and read its docs before you change it.
3. Running one of the loops? Follow [docs/AGENT_LOOPS.md](docs/AGENT_LOOPS.md).

## Where to look

Check a package with `pnpm --filter <package> typecheck && pnpm --filter <package> test`. Before opening a PR, run `pnpm typecheck && pnpm test` (CI also runs `pnpm build`).

| Area | Code | Read first | Package |
|---|---|---|---|
| Shared contracts | `packages/protocol` | [ARCHITECTURE](docs/ARCHITECTURE.md#monorepo) (Monorepo). Contracts change first, then everything downstream, so run the root typecheck. | `@neo/protocol` |
| Storage and migrations | `packages/storage` | [ARCHITECTURE](docs/ARCHITECTURE.md#one-timeline-bounded-episodes) (One timeline, bounded episodes) | `@neo/storage` |
| Memory | `packages/memory` | [MEMORY](docs/MEMORY.md), including the privacy rules at the end. Recall or schema changes: the `NEO_PERF_STRICT=1` check in CONTRIBUTING. | `@neo/memory` |
| Tools, reminders, search engines | `packages/tools` | [TOOLS](docs/TOOLS.md); tools that return UI: [When to add a block](docs/GENERATIVE_UI.md#when-to-add-a-block) | `@neo/tools` |
| Agent runtime | `packages/core` | [ARCHITECTURE](docs/ARCHITECTURE.md#a-timeline-turn) (A timeline turn, Context assembly), [GENERATIVE_UI](docs/GENERATIVE_UI.md#actions) (Actions) | `@neo/core` |
| AI providers, sign-in, native search | `packages/providers`, `packages/server` | [PROVIDERS](docs/PROVIDERS.md). Real use needs the owner's accounts. | `@neo/providers`, `@neo/server` |
| Server and API | `packages/server` | [API](docs/API.md), [ARCHITECTURE](docs/ARCHITECTURE.md#security-model) (Security model, Deployment modes) | `@neo/server` |
| Phone pairing, tunnel, relay | `packages/tunnel`, `packages/relay`, `packages/server/src/tunnel` | [ARCHITECTURE](docs/ARCHITECTURE.md#phones-pairing-and-the-encrypted-tunnel) (Phones), [DEPLOYMENT](docs/DEPLOYMENT.md#self-hosting-a-relay) (relay). Real use needs a phone. | `@neo/tunnel`, `@neo/relay`, `@neo/server` |
| Client SDK | `packages/client` | [API](docs/API.md) | `@neo/client` |
| UI blocks and the avatar | `packages/ui` | [GENERATIVE_UI](docs/GENERATIVE_UI.md), all of it | `@neo/ui` |
| Web app | `apps/web` | [GENERATIVE_UI](docs/GENERATIVE_UI.md#rendering-guidelines-neoui) (Rendering guidelines). Look at the change in a browser at desktop and phone widths. | `@neo/web` |
| CLI | `packages/cli` | [ARCHITECTURE](docs/ARCHITECTURE.md#deployment-modes) (Deployment modes) | `@neo/cli` |
| Desktop app | `apps/desktop` | [DEPLOYMENT](docs/DEPLOYMENT.md#1-on-device-desktop-app) (On-device) | `@neo/desktop` |
| Mobile app | `apps/mobile` | [apps/mobile/README.md](apps/mobile/README.md). The native projects aren't committed. | `@neo/mobile` |
| Homepage | `site/` (static, no build) | [site/README.md](site/README.md). Look at it in a browser. | none |
| CI | `.github/workflows/ci.yml` | CONTRIBUTING (Pull requests) | none |

## Decisions you don't reverse

These were decided on purpose. A PR doesn't undo them unless the owner says so in the issue. If a task seems to need one changed, stop and ask (label `needs-owner`).

- No demo mode. A fresh install has no AI until the user connects one ([PROVIDERS](docs/PROVIDERS.md#internal-scripted-test-double)).
- Memory is automatic: no approve or off modes, no blocked topics. There's no manual add for memories, tasks, notes or reminders; people tell NEO and NEO uses its tools (#13, #14, #19).
- No persona settings. NEO's personality grows from memory, its name is always NEO, and the avatar is the only appearance choice ([MEMORY](docs/MEMORY.md#assistant-style-preferences)).
- One continuous timeline, split into episodes internally. No chat list or new-chat button; "off the record" instead of incognito ([ARCHITECTURE](docs/ARCHITECTURE.md#one-timeline-bounded-episodes)).
- Connecting an AI means Sign in with ChatGPT or OpenRouter, or an API key in Simple or Advanced mode. Local models only as an Advanced custom endpoint ([PROVIDERS](docs/PROVIDERS.md#connect-an-ai)).
- Onboarding is avatar → AI → notifications → done, one screen per step (#13).
- People use the desktop app, never the CLI, so UI copy doesn't mention commands. Phones pair by QR code and work away from home through the encrypted relay (#4).
- A small, stable block catalogue: features are tools that return existing blocks, and a block type is permanent ([When to add a block](docs/GENERATIVE_UI.md#when-to-add-a-block)).
- Generative UI is data only: no HTML, CSS or scripts from models or plugins ([GENERATIVE_UI](docs/GENERATIVE_UI.md)).
- Transcripts are append-only, and per-turn context goes in the user message, never the system prompt. Shared contracts live in `@neo/protocol` ([Context assembly](docs/ARCHITECTURE.md#context-assembly-append-only-transcript)).
- A storage migration that may already have run is never changed; add a new one.
- Web search needs no setup: it uses the connected AI's own search, and engines are an Advanced fallback ([PROVIDERS](docs/PROVIDERS.md#native-web-search)).
- The self node (`mem_self`, shown as "You") can't be edited or forgotten directly ([MEMORY](docs/MEMORY.md#the-self-node)).
- NEO is modeled on a person. Copy doesn't sell it as a product where "you choose X" (#12, #14).

## Working with other agents

- Several agents work on NEO at once. Work in your own worktree from `origin/main`, never in another session's checkout.
- Stay inside the files your brief or issue names. If you need more, stop and say what and why.
- If another open branch edits a file you edit, say in your PR which branch owns it and which merge folds in the other.
- Never merge a PR or push to `main`; the owner merges.
- Lessons about the agent tools or the machine rather than NEO itself (a tool's sandbox, machine load, synced folders) don't go in this repo.
