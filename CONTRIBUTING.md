# Contributing to NEO

Thanks for helping make NEO better! This guide gets you from clone to pull request.

## Setup

Requirements: Node.js ≥ 22.13 and pnpm (`corepack enable`).

```bash
pnpm install
pnpm typecheck
pnpm test
```

Run the server and the web app with hot reload in two terminals:

```bash
pnpm dev        # builds the CLI and its dependencies, then runs `neo serve` on :7777
pnpm dev:web    # Vite dev server; proxies /api to :7777
```

Connect a provider during onboarding, or choose **Skip for now** and connect later in **Settings → AI**. Fresh installs have no providers. Offline tests inject a scripted mock adapter explicitly; it is unavailable through user configuration or the API.

## How the code is organized

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- `packages/protocol` holds every shared contract (zod schemas + types). Change contracts here first, then the packages that implement them.
- Each package owns one concern and depends only on the packages "below" it (see the dependency graph in the architecture doc).
- Packages are typechecked and tested **from source** via the `neo-source` export condition, so you never need to build before running tests.

## Conventions

- TypeScript strict, ESM. Relative imports end in `.js` (`import { x } from './x.js'`), and type-only imports use `import type`.
- Throw `NeoError` (from `@neo/protocol`) across package boundaries. Inject `Clock` and `Logger` instead of calling `Date.now()` or `console` in library code.
- Tests use vitest, sit next to the code (`src/**/*.test.ts`), and run **offline and deterministic**: fake clocks, fake fetch, in-memory SQLite.
- The one exception, a Docker image smoke test (`packages/cli/src/docker.test.ts`), builds and runs the real image; it only runs with `NEO_DOCKER_TEST=1`.
- The memory recall benchmarks ("recall stays fast", at 10k nodes in `packages/memory/src/review.test.ts` and at 1000 nodes in `memory.test.ts`) assert a median wall-clock time, so by default they only fail above 1 s and 2 s: parallel suites (`pnpm -r test`, CI) slow them several-fold. When you change recall or the memory schema, check the real 200 ms budget (20 ms at 1000 nodes, since recall scales linearly) on an otherwise idle machine with `NEO_PERF_STRICT=1 pnpm --filter @neo/memory test -t "recall stays fast"`.
- Keep transcripts append-only. Per-turn context goes into the user message's `context` part, never into the system prompt (see "Context assembly" in the architecture doc).
- Privacy is a feature: anything touching memory must respect the policy table at the end of [docs/MEMORY.md](docs/MEMORY.md).
- For performance, assert the property itself rather than a wall-clock time where you can: the recurrence catch-up test counts the candidates `nextOccurrence` checks, and the `htmlToText` linearity test compares equal amounts of work at two input sizes. Parallel suites (`pnpm -r test`, CI) slow every timing sample several-fold, so tests that do time things take the median of several runs after a warm-up and by default only fail on a gross regression. `NEO_PERF_STRICT=1` applies the tight bounds, for an otherwise idle machine: `NEO_PERF_STRICT=1 pnpm --filter @neo/tools test -t "is linear"`.

## Adding features and UI

- Add features as tools that return existing blocks, or use `render_ui`. See [When to add a block](docs/GENERATIVE_UI.md#when-to-add-a-block) for the rules and checklist.
- Don't build a screen, route or React component for one request or scenario. App screens are for the timeline, memory, tasks, notes, reminders and settings.
- People tell NEO what they want and NEO uses its tools. Screens allow viewing, editing, checking off and deleting; don't add forms or buttons for creating tasks, notes, reminders or memories by hand.
- Prefer optional props and compositions. A new type needs either a live widget for NEO's own data used by more than one feature, or real examples of the model repeatedly building it badly from existing blocks. Say which in the PR.
- Every block type is a permanent public contract. Keep old messages rendering, support every client, and return data rather than HTML, CSS or scripts.

## Pull requests

1. Open an issue first for larger changes, so we can agree on the approach.
2. Keep PRs focused. Include tests that fail without your change, and say in the PR which test fails when you put the old code back (the red check).
3. `pnpm typecheck && pnpm test` must pass (CI runs them plus `pnpm build`).
4. Update the relevant doc in `docs/` when you change behavior.
5. New block types need the [block checklist](docs/GENERATIVE_UI.md#when-to-add-a-block).
6. Fill in the template's Verification section: what you ran and on which commit, the red check, what you tried for real, and what you didn't run. A check you didn't run is listed as not run, never left out.
7. Code that talks to a real service or device (AI providers, Sign in with ChatGPT, the relay, phone pairing) is tried against the real thing before anything is built on it. Until then the PR says so under Not run, and nobody calls it working.

The owner merges only after CI has finished green on the PR's head commit (a cancelled run doesn't count), with `gh pr merge <N> --merge --match-head-commit <sha>` so nothing pushed after the review gets in.

AI agents working on NEO also follow [AGENTS.md](AGENTS.md), [LESSONS.md](LESSONS.md) and [docs/AGENT_LOOPS.md](docs/AGENT_LOOPS.md).

## Rules from lessons

Rules that started as entries in [LESSONS.md](LESSONS.md) and were seen on three different days. Every review checks them. None yet.

## Reporting security issues

Please don't open a public issue for vulnerabilities. Use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab).
