# Release

Release creation is disabled. The repository has no Release Please workflow,
configuration, or manifest, and no workflow creates release PRs, tags, or
GitHub Releases. The registry release at `0.2.0` predates the rewrite; the
checkout retains that version until selecting a new version, creating a tag,
and publishing are separately authorized.

The repository now contains a public Rust SDK, a standalone Rust/Clap CLI, and
an SDK-only npm package. This document describes only the implemented Node
release path.
Crates.io publication remains outside the approved scope. Public GitHub Release
distribution of CLI binaries, installers, and checksums is now an approved
implementation target in the
[`standalone CLI release distribution plan`](../plans/standalone-cli-release-distribution.md),
but none of it is implemented here yet. Selecting a version, creating a tag or
release, and publishing remain separately authorized operations.

## Node package assembly

[`native-targets.json`](../native-targets.json) owns the supported matrix:
Linux GNU x64/ARM64, macOS ARM64, and Windows x64. The root package and all four
native packages share one version. GNU/Linux artifacts target glibc 2.28 or
newer. Their build policy pins Zig 0.14.1 and `cargo-zigbuild` 0.23.0, including
the downloaded Zig archive checksums; CI rejects ELF symbol requirements above
the declared floor before assembly.

CI builds every target on its native GitHub-hosted image and
clean-installs the packed root and native packages under Node 22, 24, and 26.
The root artifact contains no `.node` binary and declares no CLI `bin`. Each
platform package contains exactly one native artifact plus the repository
license and generated third-party dependency notices. Platform packages
publish before the root.

The retained [`release.yml`](../.github/workflows/release.yml) is manually
dispatched from `main` with an existing `node-vX.Y.Z` tag. It does not choose a
version or create the tag, and it rejects tags whose commit is not on `main`.
All release build, packaging, validation, and npm OIDC jobs use GitHub-hosted
runners so publishable bytes do not cross a self-hosted runner trust boundary.

## Prerequisites for a future release

Before creating any tag:

1. Explicitly approve the version and update `packages/node/package.json`.
   Regenerate native package manifests and the Bun lock, then review the exact
   artifacts.
2. Configure npm Trusted Publishing for `@sjunepark/ytm` and each of its four
   `@sjunepark/ytm-*` native packages with owner `cpaikr`, repository `ytm`,
   workflow `release.yml`, and environment `npm`.
3. Confirm the `npm` GitHub environment protections and current `main` branch
   protection. Self-review is forbidden, so a release initiator and reviewer
   must be two distinct authorized users. No long-lived npm token is required.
4. Pass the repository validation and supported-target native consumer matrix
   on the exact release commit.
5. Create the immutable `node-vX.Y.Z` tag only after the release action is
   separately authorized. Then dispatch `release.yml` from `main` with that tag
   as its required input. A different authorized user must approve the
   protected `npm` environment.

The tag workflow validates the tag against the root version, rebuilds the four
native artifacts from the immutable tag commit, validates and packs the root,
and publishes all native packages before the root package. It refuses to start
publishing if any package already exists at that version. Repair a partial
publish with a newly approved version; never move a tag or replace an immutable
registry version.

## Historical Python release

Python source, CI, smoke, and PyPI publishing are absent from the active
repository. Existing PyPI artifacts and `python-v*` tags remain historical and
unchanged. Deprecating the PyPI project is outside this cutover.

## Validation

Run the complete [repository validation](../README.md#repository-validation) on
the exact candidate commit. That recipe includes release-policy checks,
generated-artifact freshness, Rust and public-surface tests, dependency policy,
judge sensitivity, and Node package inspection.

These checks do not publish or change external release state. `bun run
pack:node` does rebuild the tracked Node distribution files before inspecting
the dry-run tarball; use `bun run build:check` alone when the local checkout must
remain byte-for-byte unchanged.

`bun run release:check` enforces the absence of Release Please and Python
release machinery, version alignment across native packages, manual release
authorization from `main`, immutable tag ancestry, native-before-root assembly,
GitHub-hosted artifact builders, and npm's OIDC boundary.
