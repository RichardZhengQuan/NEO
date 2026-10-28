# Agent loops

Most of NEO is written by AI agents. Three loops do the routine work: building, reviewing and learning. The owner decides what NEO is, merges, does the checks that need real accounts or devices, and spends a few minutes each night on the UI.

Loops keep no state of their own. Everything they know is on GitHub (issues, labels, pull requests, review comments) or in [LESSONS.md](../LESSONS.md), so any run can pick up where the last one stopped, and any agent can run them.

## Who does what

| | Does | Never |
|---|---|---|
| Loop runner (an agent, usually Claude Code) | Picks the work, writes the brief, reviews the diff, runs the checks, opens the PR, writes the lessons | Merges, pushes to `main`, changes repo settings |
| Implementer (an agent, usually Codex) | Writes the code for one scoped brief | Widens its own scope |
| Second reviewer | The model that did *not* write a PR reviews it line by line | Approves its own work |
| Owner | Product decisions, merging, checks that need real accounts or devices, the nightly UI pass | |

## Labels

- `agent-ready`: scoped well enough that an agent may build it without asking. The issue says what done looks like and which files are in scope.
- `agent-working`: an agent has claimed it, in a loop run or any other session ([how to claim](../AGENTS.md#working-with-other-agents)). Remove it when the PR opens or when you give up.
- `needs-owner`: waiting for the owner: a product decision, a real account or device, a merge, or a security call. Loops don't take an issue with this label until the owner removes it.

## Rules for every run

1. Read [AGENTS.md](../AGENTS.md) and [LESSONS.md](../LESSONS.md) first.
2. Work in a fresh worktree from `origin/main` (or from the PR's head commit when reviewing). Never work in another session's checkout.
3. One item per run. Finish open work before starting new work: a PR with changes requested comes before a new issue.
4. Never merge, push to `main`, force-push a branch you didn't create, or change repository settings.
5. Stop and add `needs-owner`, with a comment saying exactly what is needed, when the work needs a product decision, a real account or device, a security call, or more scope than the issue gives.
6. If the same item fails twice, stop. Comment what you tried and add `needs-owner`.
7. Machines running loops are often busy. Run test suites one at a time, and treat a timing failure as load until it reproduces alone.

## Build loop

Runs every few hours.

1. If an open PR has an agent review saying **Changes needed**, fix that PR and stop. Follow the [PR repair claim lifecycle](#pr-repair-claims) before editing; work delegated by the repair claimant shares its claim.
2. Otherwise take the oldest open `agent-ready` issue that has neither `agent-working` nor `needs-owner`, no open PR and no pushed `agent/<N>-*` branch, and claim it as [AGENTS.md](../AGENTS.md#working-with-other-agents) describes. No such issue: stop.
3. Write the implementer a brief: the issue, what done looks like, the files it may edit, the AGENTS.md route for that area, and the LESSONS.md entries that apply.
4. Review the diff area by area against the brief. Run the area's checks from AGENTS.md. Do the red check: put the old code back, and a new test must fail, naming the broken behaviour.
5. Open the PR with the template filled in honestly (`Closes #N`), then remove `agent-working`.

### PR repair claims

A repair claim belongs to the session named in a PR comment `Fixing by <session>`.
It remains active until that session posts a later `Released repair by <session>`
comment. A release ends only that session's preceding claims; it does not end a
claim posted after it. A new commit does not release a claim.

1. Read the PR's repair claims and releases before editing. If another session has
   an active claim, leave the repair to it, unless it delegated the work to you.
2. Otherwise post `Fixing by <your session>`, then read the comments again. The
   earliest active claim in GitHub comment order wins. If another session won,
   post `Released repair by <your session>` and leave; do not release its claim
   or remove its label.
3. When you finish updating the PR, or stop for any reason, post
   `Released repair by <your session>`, even if you made no commit. Include the
   resulting head or saved checkpoint and remaining work.
4. If the claimant is unavailable and has not released its claim, ask the owner
   for a handoff. Record that approval on the PR before proceeding. An approved
   `Repair handoff from <old session> to <new session>` comment ends the old
   session's preceding claim; the new session still claims and re-reads as above.
   Do not infer a handoff from elapsed time or from a commit.

Check these cases when changing the rule; they supplement the original issue
claim fixtures and do not substitute for the live races tracked in #739:

| PR repair history | Next session's action |
|---|---|
| No active repair claim | Post its claim, then re-read before editing. |
| A claims, then commits without a release | Leave A's active claim alone. |
| A claims, then stops without a commit and posts its release | Claim and re-read; A no longer blocks the repair. |
| A claims before B; both claims remain active | B releases only its own claim and leaves A's work alone. |
| A delegates the repair to B | B works under A's claim; A releases it when the delegated work finishes or stops. |
| A releases, then makes a new claim | Treat the new claim as active; the earlier release does not end it. |
| A is unavailable without a release | Obtain and record the owner's handoff before making a new claim. |

## Review loop

Runs every hour. For each open PR whose head commit has no agent review yet:

1. Check out the head commit in a fresh worktree. Run the checks for the areas it touches; run `pnpm typecheck && pnpm test` when it touches a shared package.
2. Do the red check yourself; don't trust the PR's word for it.
3. Get the second review: the model that didn't write the PR reads every line against the issue, AGENTS.md and LESSONS.md. Run anything it doubts.
4. Check the PR description: Ran, Red check, Real use and Not run are all there and true.
5. Post one comment headed `Agent review @ <short sha>` with a verdict:
   - **Ready**: only when CI has finished green on that commit (a cancelled run doesn't count). Include the merge command: `gh pr merge <N> --merge --match-head-commit <sha>`. If someone pushes after the review, the merge fails instead of taking unreviewed code.
   - **Changes needed**: each problem with its file and line, and how you know.
   - **Needs owner**: what the owner has to decide or check. Add the label too.

## Nightly lessons

Runs once a day.

1. Read everything merged since LESSONS.md last changed: commits, PRs, review comments and CI runs.
2. Look for three things only: fixes that came back, merges that shouldn't have happened, and verification too weak to show the change worked. Note what went right too.
3. For each, add an entry to LESSONS.md or add today's date to the entry it repeats. Entries use the format at the top of LESSONS.md, with the PRs and commits as evidence.
4. When an entry has been seen on three different days, move its rule into the "Rules from lessons" section of [CONTRIBUTING.md](../CONTRIBUTING.md) and delete the entry. From then on, every review checks it.
5. Lessons about the agent tools or the machine rather than NEO (a tool's sandbox, machine load, synced folders) don't belong in this repo.
6. If CI on `main` is red, open an `agent-ready` issue for it at the top of the queue: a failing test on `main` is a bug to fix now.
7. Open one PR, `lessons/YYYY-MM-DD`, with the changes. Nothing found: no PR.

## The owner's part

- Merge with the command in the agent review. That merge is where unreviewed code is stopped.
- Answer `needs-owner` issues.
- Run the real-use checks a PR lists as not run, and say what happened in the PR.
- Nightly UI pass: say what's wrong in a sentence ("this button is too loud"). The loop turns it into an issue and keeps your words in it.
