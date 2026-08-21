# Release

Release creation is disabled. The repository has no Release Please workflow,
configuration, or manifest, and no workflow creates release PRs, tags, or
GitHub Releases. The current `0.2.0` package version is historical; selecting a
new version, creating a tag, and publishing require separate authorization.

## Node package assembly

[`native-targets.json`](../native-targets.json) owns the supported matrix:
Linux GNU x64/ARM64, macOS ARM64, and Windows x64. The root package and all four
native packages share one version.

CI builds every target on its native GitHub-hosted image and
clean-installs the packed root and native packages under Node 22, 24, and 26.
The root artifact contains no `.node` binary. Each platform package contains
exactly one native artifact plus the repository license and generated
third-party dependency notices. Platform packages publish before the root.

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

## Read-only validation

```sh
cargo install --locked --features cli cargo-about --version 0.9.2
bun install --frozen-lockfile
bun run validate
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
bun run test
bun run pack:node
```

`bun run release:check` enforces the absence of Release Please and Python
release machinery, version alignment across native packages, manual release
authorization from `main`, immutable tag ancestry, native-before-root assembly,
GitHub-hosted artifact builders, and npm's OIDC boundary.
