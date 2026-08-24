# Release

No product release is authorized by this document. Selecting or publishing an
exact version remains a separate approval. The repository is implementing one
product lifecycle for the Rust core, standalone CLI, and Node SDK; this section
states the accepted authority and the current implementation checkpoint.

## Release authority

Release Please owns release PR preparation from Conventional Commits. One root
component named `ytm` updates:

- [`VERSION`](../VERSION), the human-readable product version authority;
- the root [`CHANGELOG.md`](../CHANGELOG.md), the product changelog;
- the Release Please manifest;
- the Cargo workspace version, internal `ytm-core` dependency requirements,
  workspace and clean-consumer lockfiles;
- the Node root and native package versions and optional dependency versions;
- the Bun workspace lock entries.

`bun run release:version:check` fails when any version copy, changelog head, or
configured Release Please update path diverges. The root private JavaScript
workspace is not a published component. The historical
`packages/node/CHANGELOG.md` remains a record of the pre-unification Node tags;
new product entries belong only in the root changelog.

The Release Please preparation workflow is deliberately gated by the
`RELEASE_PLEASE_ENABLED` repository variable and invokes the action with
`skip-github-release: true`. It may create or update a release PR, but it cannot
create a tag or GitHub Release. Its `RELEASE_PLEASE_TOKEN` must be a narrowly
scoped GitHub App or fine-grained token whose pull requests trigger required
checks. Keep the variable `false` until release preparation is explicitly
authorized.

## Accepted target lifecycle

The release implementation will follow these stages:

1. Release Please proposes one release PR against `main`. The PR reconciles
   every product-version copy and generates the root changelog entry.
2. Reviewers validate the exact proposed version and complete artifact plan.
   Merging that specific PR requires explicit approval of that version.
3. **Planned:** A separately authorized job in the protected `release`
   environment runs the Release Please release phase for the merged PR. It
   creates the immutable `vX.Y.Z` tag and a draft GitHub Release. The submitted
   expected version must match `VERSION`, the manifest, changelog, tag, and
   tagged checkout.
4. **Partially implemented:** CI builds and validates all CLI archives,
   checksums, and installers on GitHub-hosted runners. Tagged orchestration and
   npm tarball integration remain planned; no candidate is uploaded to a draft
   Release yet.
5. **Planned:** Publishing the draft GitHub Release is the canonical completion
   point. npm publication may begin only afterward, from the same source SHA and
   version, through the protected `npm` environment and trusted publishing.

The disabled preparation mechanics for stage 1 and reusable CLI artifact
mechanics for part of stage 4 exist today. Stages 3 and 5, plus tagged
orchestration and the npm portion of stage 4, remain future implementation
slices. The current `.github/workflows/release.yml` is still the transitional,
manually dispatched `node-vX.Y.Z` npm publisher. It does not create or publish a
GitHub Release. Do not use it for a new product release. Its replacement,
receipts, managed upgrades, and exact-distributable installer tests are
subsequent slices of the active plan.

## Standalone CLI candidate assets

[`cli-targets.json`](../cli-targets.json) owns four targets independently of the
Node-API package matrix: GNU/Linux x64 and ARM64 at glibc 2.28, macOS ARM64, and
Windows x64. CI derives its matrix from that file, builds on each declared
runner, executes the exact binary's `--version` and `--help`, enforces the Linux
symbol floor, and packages only the executable plus the canonical license
files. Archive order and metadata are normalized by repository code.

After all target jobs pass, CI generates version-pinned `install.sh` and
`install.ps1`, embeds the exact selected archive digest in each, creates sorted
`SHA256SUMS` for every archive and installer, and validates the complete file
set before retaining it as a CI artifact. The fresh-install scripts reject
unsupported platforms, verify SHA-256 before extraction, and refuse to replace
an existing executable. They intentionally do not write a receipt or implement
upgrade yet, so they are not a public installation path.

## Visibility and failure policy

Release state is monotonic and corrections use a new approved version:

| State | Visibility | Permitted recovery |
| --- | --- | --- |
| Release PR open | Reviewers only | Update or close the PR; no tag exists. |
| Tag/draft creation failed | No public release | Fix the workflow and rerun only if the tag and release are still absent. |
| Draft exists; build or validation failed | Draft is unavailable to normal consumers | Preserve the immutable tag and draft evidence, repair automation, and rerun against the same tagged source only while no asset was replaced and no canonical release or npm package exists. |
| GitHub Release published | Canonical release is public and immutable | Never move the tag or replace assets; correct with a new version. |
| npm projection partially failed | Canonical GitHub Release remains public; npm is explicitly incomplete | Report the failed packages and correct with a new version. Never repair a partially published version in place. |

The release workflow must fail closed when it cannot prove tag ancestry,
version and source identity, complete expected assets, checksums, installer
selection, or npm-version absence. It must not delete a draft or tag
automatically: those are recovery evidence and destructive cleanup requires a
separate decision.

## Required GitHub settings

Before enabling release preparation or approving a release:

1. Protect `main` with the complete repository validation as a required check.
2. Add a `v*` tag ruleset that blocks updates and deletion and permits creation
   only by the release automation identity.
3. Create a `release` environment with required reviewers, prevent self-review,
   disallow administrator bypass, and restrict deployment to protected `main`.
4. Keep the existing `npm` environment equally strict. Its current single
   reviewer plus administrator bypass does not provide two-person approval and
   must be corrected before publication.
5. Configure npm Trusted Publishing for `@sjunepark/ytm` and all native
   packages with owner `cpaikr`, repository `ytm`, workflow `release.yml`, and
   environment `npm`. No long-lived npm token is required.

Repository settings are operational prerequisites, not repository code. This
implementation records and validates their required shape but does not mutate
them or authorize a release.

## Transitional Node assembly

[`native-targets.json`](../native-targets.json) currently owns the Node-API
matrix: Linux GNU x64/ARM64, macOS ARM64, and Windows x64. GNU/Linux artifacts
target glibc 2.28 or newer. CI builds every target on its declared
GitHub-hosted runner and clean-installs the packed root and native packages
under Node 22, 24, and 26.

The retained npm workflow rebuilds those packages from an existing
`node-vX.Y.Z` tag, rejects versions already visible in npm, and publishes all
native packages before the root. It remains useful implementation material but
is superseded as a release entry point by the accepted product lifecycle. A
failure after its first npm publish can leave a partial registry version; this
is why the final workflow publishes npm only after the canonical GitHub
Release and reports partial projection failures explicitly.

## Historical Python release

Python source, CI, smoke, and PyPI publishing are absent from the active
repository. Existing PyPI artifacts and `python-v*` tags remain historical and
unchanged. Deprecating the PyPI project is outside this cutover.

## Validation

Run the complete [repository validation](../README.md#repository-validation) on
the exact candidate commit. `bun run release:check` includes product-version,
Release Please, transitional workflow, native-package, and publishing-boundary
checks. These checks do not publish or change external release state.

`bun run pack:node` rebuilds tracked Node distribution files before inspecting
the dry-run tarball; use `bun run build:check` when the checkout must remain
byte-for-byte unchanged.
