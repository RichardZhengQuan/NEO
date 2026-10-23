# Workflows

## ci.yml

Runs typecheck, test, and build on pull requests and pushes to `main`.

## mobile.yml

Builds the iOS app unsigned for the simulator (job `ios-build`) and the Android
debug APK (job `android-build`) on pull requests and pushes to `main` that touch
mobile-related paths or the workflow itself. The exact build commands come from
[apps/mobile/README.md](../../apps/mobile/README.md). The Android APK is
uploaded as the `android-debug-apk` workflow artifact.

## release-desktop.yml

To cut a macOS release:

1. Bump `version` in `apps/desktop/package.json` to `X.Y.Z`.
2. Merge that change to `main`.
3. Run `git tag desktop-vX.Y.Z` on that commit.
4. Run `git push origin desktop-vX.Y.Z`.

The tag must match the package version or the job fails at the version guard.

electron-builder uploads the arm64 and x64 DMGs to a draft GitHub Release for that version. The owner publishes it. Mark the first release as a pre-release before publishing.

Builds are unsigned and un-notarized until signing lands (owner deferred this in #63). Gatekeeper will warn.
