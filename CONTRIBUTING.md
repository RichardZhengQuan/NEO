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

Rules that started as entries in [LESSONS.md](LESSONS.md) and were seen on three different days. Every review checks them.

### Wait for CI green on the PR's head commit, and merge one PR at a time

Only merge a PR after its CI run on the exact head commit has finished green (a cancelled run doesn't count), and wait for its merge-commit CI run on `main` to finish before merging the next PR. #27 stopped `main` runs from cancelling once they start, but GitHub still drops a run that is only queued when the next merge lands, so back-to-back merges leave one merge commit untested on `main` — #19's chain on 2026-10-12 and #56 on 2026-10-14 are examples. Branch protection requiring the `check` status is the belt-and-braces fix and is tracked in #33.

### Read every review comment, from people or bots, before merging, and fix each finding or say in the PR why it waits

Codex and other automated reviewers post findings on the PR's head commit, often minutes before the Ready review goes up; if the agent review doesn't acknowledge them, the PR ships with those bugs on `main`. #1 merged 22 s after Codex posted three inline findings (2026-10-11), and a later independent review found 11 bugs including 8 P1s. On 2026-10-13/14, #43, #48, #50 and #58 merged 16 min, 1 h 32 min, 12 min and 9 h 29 min after Codex findings on their head commits, none acknowledged in the PRs (#58 had no agent review at all). On 2026-10-14, #66, #82 and #84 merged with Codex findings posted 3–5 min before the Ready review and never acknowledged. On 2026-10-15, Codex posted a P2 at `apps/web/src/App.tsx:186` at 12:52:14Z ("Avoid adding the Android WebView origin to tunnel links" — on Android Capacitor shell `androidScheme: 'https'` makes `window.location.origin` `https://localhost`, which `pairingConnection` prefers over the tunnel, so tunnel-only pair links still fail); #94 merged at 12:54:54Z (2 min 40 s later) without the Ready review mentioning it. Every agent review must enumerate the automated-review findings on the head commit it saw and, for each, either address it in the PR or cite the comment and say why the owner has deferred it; silence on a bot finding means the review did not read it.

### When a PR lists a real-use check as not run, open a tracking issue for it before merging, so it isn't forgotten

PRs said honestly what they hadn't tried, but nothing tracked it, and more was built on top. #4 never ran phone pairing on a phone (2026-10-11). #13's Sign in with ChatGPT and OpenRouter only met local fakes, and #18 then added native web search for five providers without calling any of them (2026-10-11); as of 2026-10-13 no PR showed NEO talking to a live AI provider at all. #16's 3D memory net was never seen rendering because the browser pane was hidden and the scene doesn't draw while hidden (2026-10-12). On 2026-10-16, #106 (parseSSE abort fix) merged with its live-provider streaming check listed under "Not run" and no tracking issue opened; the Ready review itself noted "tracking issue does not yet appear in the repo … the loop runner should open it" but merged anyway (#107 opened after the fact by the next loop run). A "Not run" bullet that names a **real-use check** (a service, device, browser or external system the test suite can't exercise) with no accompanying open issue, from either side (the implementer PR or the Ready review), is a silent carry-forward of an unverified feature. Every Ready review must list each such real-use "Not run" item and, for each, either cite the issue tracking it (by number) or open one and cite that one, before the merge command. Local tooling items under "Not run" that CI runs on the merge (full `pnpm test`, build) are not real-use checks and do not need a tracking issue.

### When you fix one case of a bug, find every other spelling, type, or code path that reaches the same logic and cover each with the fix and a test

Across seven PRs on three days, every multi-commit PR in the window had the same root cause: the brief or the implementer named one case and stopped there, and Codex named the next one. On 2026-10-17 #110 canonicalized plain IPv6 but left scoped IPv6 (`fe80::1%eth0`) keying a separate per-IP bucket (the exact bypass #109 was filed to stop), and #120 added abort-cancel for the upload body but kept trusting `chunk.value.length` on every chunk when a string or `DataView` chunk would silently coerce to zero bytes. On 2026-10-19 #138 severed the direct sensitivity back-pointer and still had to come back twice because activation that had already spread through the ineligible intermediate was never recomputed. On 2026-10-20 #152 added `chmodSync` after write/mkdir but left a race window a `write-then-rename` closed, #153 surfaced provider-list failures in `neo doctor` but detected 404 via a message-string regex instead of `NeoApiError.httpStatus`, and #155 passed `undefined` onAction to `BlockList` but left button, form and card renderers rendering enabled controls. In every case the second input shape failed deterministically — it was not flaky, it was just untested. Before closing a bug fix, enumerate every other spelling, type, or code path that reaches the same logic and confirm each is covered by both the fix and a test; #143 (one commit covering both success `response.text()` and error `response.json()` body paths for the client timeout) is the shape to copy.

## Reporting security issues

Please don't open a public issue for vulnerabilities. Use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab).
