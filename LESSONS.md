# Lessons

Mistakes NEO has already made, and a few things that went right, so no agent makes them twice. Read this before you start work.

The nightly lessons loop ([docs/AGENT_LOOPS.md](docs/AGENT_LOOPS.md)) adds entries from what merged that day. A lesson seen on three different days becomes a rule in [CONTRIBUTING.md](CONTRIBUTING.md) and leaves this file. Each entry looks like this:

```
## <One sentence: the rule>

- <What happened, with PRs, commits or CI runs, and what it cost>
- Fixed in <PR or commit>.
- Done right: <an example of doing it right, if there is one>
- Seen N× (YYYY-MM-DD, ...).
```

## Get the independent review before merging, not after

- #1 put the whole codebase on `main`; Codex's auto-review landed at 2026-10-11T01:13:00Z and the merge went in 22 seconds later at 01:13:22Z. A separate independent review afterwards found 11 bugs, 8 of them P1, including a client-supplied `apiKeySecret` that let a paired device send another provider's key to any URL, and sensitive memories replayed to cloud models. #3 fixed them.
- #56 and #58 were merged on 2026-10-14 with no `Agent review @ <sha>` comment on the PR at all; the only review on either was Codex's auto-review (empty on #56, two P2 findings on #58). Both PR bodies claimed the review was done in a Claude session, but with nothing posted there is no record of what was reviewed, when, or what verdict it reached — the merge cannot be checked against a review that is not on the PR.
- Seen 2× (2026-10-11, 2026-10-14).

## When you fix one case of a flaky pattern, find every case and fix them all in the same PR

- #6 replaced one `vi.waitFor` poll in the relay session-cap test while its own stress run showed another poll in the same file failing 3 times in 24. #9 had to come back for that poll, and #11 for the rest.
- Single-sample wall-clock assertions in the memory and tools tests failed under load one at a time, and took #5, #8 and #10 to replace.
- Done right: #11 converted every remaining wait in the file and showed with stress runs that the old waits failed and the new ones didn't.
- Seen 1× (2026-10-12).

## In async tests, await a promise registered on the event itself instead of polling with `vi.waitFor`

- On a loaded machine Node runs overdue timers before the I/O that delivers the event, so a 1 s `vi.waitFor` deadline expires even though the code is right. #4 wrote the relay and tunnel test waits this way; #6, #9 and #11 had to replace them after stress runs failed 48 of 48, 43 of 48 and 43 of 192 times.
- Done right: register the promise on the event source before triggering the work, then prove it with a stall injection: the old wait fails and the new one passes (#9, #11).
- Seen 2× (2026-10-11, 2026-10-12).

## Serve and cache assets so a failure can't stick

- Since #1 the server answered every missing path with `index.html` and 200, and the service worker cached `/assets/*` by URL without checking the response type. When a figure image went missing during a rebuild, its HTML stand-in was cached as the image, and the figure image (from #13) never retried, so the onboarding figure stayed broken after the file came back.
- Fixed in #20: the server 404s a missing path that has a file extension, the service worker never caches `text/html` under an asset URL (cache bumped to `neo-shell-v4`), and the figure retries on its own.
- Seen 1× (2026-10-12).

## Write a test's expected value from what the user must see, not from what the code produces now

- #13's avatar orbit test asserted that a hovered rear portrait had z-index `'1'`: the buggy value. The portrait stayed hidden behind the figure (z-index 2–3) while the test passed. #21 fixed the line and asserts the hovered portrait sits above the figure.
- Seen 1× (2026-10-12).

## When you change an animation, check the still state too: `animated={false}` and prefers-reduced-motion

- #2 moved the girl's speaking mouth onto the lip-flap frames the boy and dog already used. Those frames start at opacity 0 and only the animation shows them, so with motion off none of the three has a mouth while speaking (`packages/ui/src/avatar/styles.ts`). Codex flagged it on #2.
- Fixed in #36: both `.neo-av--still[data-state=speaking] .neo-av-flap-half` and the `prefers-reduced-motion` media query force `opacity: 1` on the flap frame, so the half-open mouth shows while motion is off.
- Seen 1× (2026-10-11).

## Do expensive per-connection work when the protocol first needs it, not in the constructor

- #4's Noise responder generated its ephemeral key and re-derived its static key in the constructor, which ran for every relay Open before the phone had sent anything. A burst of 256 Opens blocked the event loop for 0.3–0.9 s on an idle machine and 2–5 s under load.
- Fixed in #7: the key is generated in `writeMessage2` and the static-key check is cached per key pair.
- Done right: #7's test counts curve operations through a pass-through mock, so it fails the same way on any machine.
- Seen 1× (2026-10-11).

## Before delegating UI work, put the rules and the target blocks in the brief

- Codex built #22 as a dedicated Plan tomorrow screen, with its own route, state, strings and phrase matcher, against the then-unwritten rule that features are tools returning existing blocks. #23 wrote the rule down and #24 replaced the screen with a reusable `changes` block.
- Seen 1× (2026-10-12).

## Done right: when parallel branches edit the same file, say in the PR which branch owns it and which merge folds in the other

- #15 named `feat/memory-net-3d` as the owner of `NetTab.tsx` and said the later merge would fold in the other's change. #16 did exactly that, with no conflict and no regression.
- Seen 1× (2026-10-12).

## A test that doesn't exercise the code under test is not a check: assert path execution, not just the output

- On 2026-10-17, #115's first commit `9fa6638` cleared stored credentials when `PATCH /api/providers/:id` changed `baseUrl`, but its embedding-refresh test ran against a fixture whose adapter never made an embedding request, so the assertion that "the refresh does not send the old key" held with zero calls — a vacuous pass, not an incorrect oracle. Codex flagged it as P2 on the same head; `b263852` switched the fixture to `kind: 'openai-compatible'` and asserted `live.fetch.mock.calls.length > 0`, turning the test back into a real check that the fix was exercised.
- On 2026-10-22, #494's first two commits `b276343` and `7d7a09f` added `AccordionRenderer` and `ChangesRenderer` guards for reserved-ID prototype lookups, but the accompanying tests asserted the renderer never *re-rendered* after a reserved ID was pushed into the block — a shape that would have passed on the pre-fix code too, because the pre-fix bug was a prototype-walk at *lookup* time, not a re-render loop. Codex (`has_unresolved_findings: true` on head `823edbf`) and the loop runner noticed that the test's oracle was shaped around the fix, not the bug. The third commit `823edbf` ("test(ui): replace vacuous accordion tests with rerender-based red-check") made both tests actually rerender with a reserved-ID handler and assert the rendered output changed, so the test fails on `__proto__`/`constructor` passing through the lookup, exactly the pre-fix behaviour.
- Seen 2× (2026-10-17, 2026-10-22).

## When your fix reuses a shared "refresh" helper, check every field that helper writes

- #118's first commit `8f0d200` reused `refreshEpisodePreview` from the delete paths to refresh the preview on parts-only updates. That helper also writes `last_message_at` from the newest message's `created_at`, so an edited-widget update would stomp the completion-clock value `TurnRunner.finish` had just set (`turn.ts:956–964`). `sendTimeline` reads `last_message_at` for episode gap and 24-hour continuity (`runtime.ts:189–212`), so the preview fix could rotate episodes early or lose context carry-over. Codex flagged it as P2 on the same head; `39b042e` split out `refreshEpisodePreviewOnly` that writes only `preview` and `updated_at`, left the delete paths on the full helper, and added a regression test asserting `last_message_at` stays at the completion-clock value after a parts patch. The pattern: a helper named "refresh X" writes more than X, and reusing it on a path that doesn't own those extra fields clobbers whatever another writer put there.
- Seen 1× (2026-10-17).

## When two Agent reviews on the same head commit disagree, the stricter verdict wins — don't merge while any Changes-needed review is unaddressed

- PR #283 ("add timezone edit to uiBlockToText reminder.update branch") received two Agent reviews on head `aacfbaa` within 4 min on 2026-10-20. The first at 17:47:06Z was **Changes needed**: it cited the already-promoted sibling-case rule and showed `packages/ui/src/blocks.tsx:1151-1165` (`ChangeDetails`) also renders `reminder.update` and has no `timezone` branch, so a timezone-only reminder-reschedule renders an empty change card in the browser/app approval UI (`uiBlockToText` was the CLI/text fallback the PR did fix). The second at 17:50:44Z was **Ready** and did not mention the sibling case; Codex's own PR summary comment carried `has_unresolved_findings: true` on that same commit at merge time. The PR merged at 18:29:01Z. The sibling bug is still on main — `ChangeDetails` still has no `item.kind === 'reminder.update' && item.after.timezone !== undefined` branch — so a user who asks NEO to reschedule a reminder into a different timezone sees an approval card with no visible change to approve.
- The fix for the sibling case is tracked in #320.
- Done right: once an `Agent review @ <sha>` on the current head says Changes needed and cites a specific defect, a later review on the same head must either address the earlier review's finding or quote it and say the owner has deferred it (same shape as the already-promoted "read every review comment, from people or bots" rule). A silent "Ready" from a parallel reviewer must not land the PR.
- Seen 1× (2026-10-20).

## The sibling-case check crosses package boundaries, even when the issue scopes the bug to one package

- Issue #459 (2026-10-21) scoped the TaskRow timezone bug to `apps/web/src/screens/TasksScreen.tsx:154` and listed only that file plus its test under **Files**. Codex implemented #474 ("fix(web): use session timezone in task row date rendering") strictly in-scope on 2026-10-22. The Claude review on head `7550e55` found that `TasksRenderer` in `packages/ui/src/blocks.tsx:1140` renders AI-generated task-list chat blocks and also passes `undefined` for the timezone argument — the same `formatDate(ms, locale, undefined, 'short')` shape, a different package not touched by the brief, and `TasksBlockSchema` in `packages/protocol/src/ui.ts:337` carries no `timezone` field at all. The fix for the sibling case spans `@neo/protocol` (add `timezone` to the schema), `@neo/ui` (pass it to `formatDate`) and `@neo/tools` (set it when the tool emits the block), so it is genuinely out of scope for #474 — but the broader class of bug is still on main.
- The fix for the sibling case is tracked in #485.
- Done right: Claude's review flagged the sibling in `packages/ui` as **not blocking #474** (the issue's scope was honored) and opened #485 with the concrete expected test ("`timezone: 'Asia/Tokyo'` with a `dueAt` crossing midnight in `America/New_York`") while #474 was still open, so the broader bug has a tracking issue instead of being carried forward silently. The pattern extends the already-promoted sibling-case rule: when the issue text names one file, the reviewer still greps every call site of the same shared helper across packages, and when a cross-package sibling cannot fit in the current PR it goes to a new issue before merge.
- Seen 1× (2026-10-22).

## Codex's PR summary comment is a two-field machine signal; the inline P2s and the `has_unresolved_findings` state are the authoritative version

- On 2026-10-22, #544 and #545 both merged with Codex's PR-summary state-JSON carrying `has_unresolved_findings: true` on the exact head the Agent review had approved. #544 head `6abf282`: Codex posted a P2 inline at `packages/providers/src/gemini.ts:140` warning that `sanitizeGeminiSchema` builds an unsatisfiable schema when a `type` array mixes `"object"` or `"array"` with another primitive and the schema has sibling `properties`/`required`/`items` — the Agent review on the same head wrote "Ready" and discussed only the Gemini-specific `nullable` rewrite the PR fixed, with no mention of the sibling-case P2; the owner merged at 2026-10-22T09:22:42Z. #545 head `04e5850`: Codex posted a P2 inline at `packages/memory/src/consolidate.ts:429` warning that the new `if (items.length === 0) continue` guard also treats valid `{"summary":null,"facts":[]}` replies as "retry forever", starving the 20-cluster abstraction queue with permanent zombies — the Agent review on the same head wrote "Ready" with no mention of the inline finding; the owner merged at 2026-10-22T09:17:43Z.
- For #544 the follow-up issue #553 was opened at 2026-10-22T09:27:16Z (5 min after merge) and the fix landed in #562 (merged 2026-10-22T10:11:02Z), so the regression lived on `main` for 49 min and never shipped past the next AI-provider PR. For #545 the Codex finding was NOT filed as a follow-up issue by the subsequent loop runs; today's nightly loop opened it as #590 (2026-10-23T03:49Z Shanghai) once the pattern was traced, but 18 h 32 min of production consolidation had already run against the current `packages/memory/src/consolidate.ts:429` guard, where a connected AI that correctly says "nothing lasting here" would keep the same 20 clusters pinned to the top of the queue indefinitely — exactly the "paid model calls repeat every run; newer episodes starve" cost Codex described.
- The reviewer's eye tracks the Codex *summary* paragraph ("Codex Review Summary · Code Review · Completed"), which is a progress line, not a verdict. The verdict is the `<!-- codex-review-state:v1 … "has_unresolved_findings": true/false … --> ` HTML comment at the top of that same summary, and the inline P2 pinned to the specific file:line. The already-promoted "Read every review comment, from people or bots" rule is already written against this shape; the mechanical check this adds is: before posting an Agent review on a PR whose Codex auto-review has completed, open the summary comment and grep its HTML body for `has_unresolved_findings`; if the value is `true`, enumerate every `codex-code-review-finding:v1` inline comment on that head and treat each as a required address-or-defer entry.
- Done right: when `has_unresolved_findings=true` on a head and the loop runner wants the fix to land anyway, open the follow-up issue BEFORE the merge command and cite its number in the review (same shape as the "Not-run tracking issue" rule) — not after, as happened with #544→#553.
- Seen 1× (2026-10-22).
