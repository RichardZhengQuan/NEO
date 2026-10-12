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

With no API key, pick **Demo mode** during onboarding. The offline demo brain exercises reminders, tasks, notes, memory and generated UI without any model.

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
- The memory recall benchmark ("recall stays fast" in `packages/memory/src/review.test.ts`) asserts a median wall-clock time, so by default it only fails above 1 s: parallel suites (`pnpm -r test`, CI) slow it several-fold. When you change recall or the memory schema, check the real 200 ms budget on an otherwise idle machine with `NEO_PERF_STRICT=1 pnpm --filter @neo/memory test -t "recall stays fast"`.
- Keep transcripts append-only. Per-turn context goes into the user message's `context` part, never into the system prompt (see "Context assembly" in the architecture doc).
- Privacy is a feature: anything touching memory must respect the policy table at the end of [docs/MEMORY.md](docs/MEMORY.md).

## Pull requests

1. Open an issue first for larger changes, so we can agree on the approach.
2. Keep PRs focused. Include tests that fail without your change.
3. `pnpm typecheck && pnpm test` must pass (CI runs them plus `pnpm build`).
4. Update the relevant doc in `docs/` when you change behavior.

## Reporting security issues

Please don't open a public issue for vulnerabilities. Use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab).
