# Workflows

## ci.yml

Runs typecheck, test, and build on pull requests and pushes to `main`.

## mobile.yml

Builds the iOS app unsigned for the simulator (job `ios-build`) and the Android
debug APK (job `android-build`) on pull requests and pushes to `main` that touch
mobile-related paths or the workflow itself. The exact build commands come from
[apps/mobile/README.md](../../apps/mobile/README.md). The Android APK is
uploaded as the `android-debug-apk` workflow artifact.

## desktop-package.yml

This PR/manual workflow is a partial build and static-check phase of
[#692](https://github.com/RichardZhengQuan/NEO/issues/692). It never launches NEO
and cannot establish native startup or runtime acceptance. Its first completed
run must be checked before claiming its CI artifact path works.

Changes to desktop/web/workspace packages, dependency manifests or the workflow
trigger it on pull requests; it can also be run manually. It checks out the
event's exact PR head (or manual-run commit), without persisted Git credentials.
The `package-arm64` job uses `macos-15`; only after it succeeds does `package-x64`
use `macos-15-intel`. Each job has a 20-minute timeout and private per-run
pnpm/Electron/builder stores and caches, with the pinned package manager, frozen
lock and existing dependency policies. Build subprocesses use an allowlisted
environment without release/signing/account tokens. Repository permission is
`contents: read`.

Both jobs build web and desktop workspace dependencies, then call
`electron-builder --mac dmg --arm64|--x64 --publish never` with
`CSC_IDENTITY_AUTO_DISCOVERY=false`. They run the structural inspector, check
every physical Mach-O binary's architecture with `lipo`, verify the DMG, and
compare its read-only-mounted app against the original file/hash/mode/link
inventory. Disabling identity discovery does not certify the resulting signature: arm64
binaries can retain linker ad hoc signatures. Bundle-signature acceptance and
notarization remain unverified.

Only checked successes upload `neo-macos-<arch>-<source-sha>` artifacts containing:

- An architecture-named DMG and `.app.tar.gz`; the tar preserves app modes and
  symlinks through GitHub's artifact ZIP transport.
- SHA256 sums, exact source SHA/tree, architecture and tool versions.
- Structural/Mach-O reports, complete app inventory and build/verification logs.
- An explicit `runtimeProven: false` acceptance boundary.

Failures upload diagnostics under a separate `*-failure-*` artifact name, rather
than presenting partially checked app/DMG outputs as successes. The success
artifacts expire after 14 days; failure logs expire after 7 days.

Fresh/relaunch Chromium profile acceptance, native first-choice/onboarding,
remote mode, tray behavior, native missing-resource smoke and x64 runtime remain
tracked in #692/#557. Public release, notarization and update-feed installation
are separate. Successful build/static jobs do not satisfy those checks.

## release-desktop.yml

This is the owner-controlled publication path. As of 2026-10-29 there are no
public desktop releases; local architecture-specific artifact receipts are tracked in
[#557](https://github.com/RichardZhengQuan/NEO/issues/557). The bounded PR/manual
build/static workflow is described above; remaining runtime acceptance is in
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
