# Workflows

## ci.yml

Runs typecheck, test, and build on pull requests and pushes to `main`.

## release-desktop.yml

To cut a macOS release:

1. Bump `version` in `apps/desktop/package.json` to `X.Y.Z`.
2. Merge that change to `main`.
3. Run `git tag desktop-vX.Y.Z` on that commit.
4. Run `git push origin desktop-vX.Y.Z`.

The tag must match the package version or the job fails at the version guard.

electron-builder uploads the arm64 and x64 DMGs to a draft GitHub Release for that version. The owner publishes it. Mark the first release as a pre-release before publishing.

Builds are unsigned and un-notarized until signing lands (owner deferred this in #63). Gatekeeper will warn.
