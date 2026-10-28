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

This is the owner-controlled publication path. As of 2026-10-29 there are no
public desktop releases; local arm64 artifact receipts are tracked in
[#557](https://github.com/RichardZhengQuan/NEO/issues/557). The bounded PR/manual
packaging and runtime check remains work in
[#692](https://github.com/RichardZhengQuan/NEO/issues/692).

When the owner accepts the source, artifacts and remaining release checks:

1. Bump `version` in `apps/desktop/package.json` to `X.Y.Z`.
2. Merge that change to `main`.
3. Run `git tag desktop-vX.Y.Z` on that commit.
4. Run `git push origin desktop-vX.Y.Z`.

The tag must match the package version or the job fails at the version guard.

The workflow is configured to build and upload the declared arm64 and x64 DMGs
to a draft GitHub Release. That configuration is not evidence that either
architecture's artifacts or runtime have passed acceptance. The owner reviews
the exact assets and publishes the release. Mark the first release as a
pre-release before publishing. Update-feed installation is tracked separately
in [#88](https://github.com/RichardZhengQuan/NEO/issues/88).

Builds are unsigned and un-notarized until signing lands (owner deferred this in #63). Gatekeeper will warn.
