# Release

No product release is authorized by this document. Selecting or publishing an
exact version remains a separate approval. The repository implements one
product lifecycle for the Rust core, standalone CLI, and Node SDK; this is the
runbook for that disabled-by-default lifecycle.

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

## Release lifecycle

The release lifecycle has these stages:

1. Release Please proposes one release PR against `main`. The PR reconciles
   every product-version copy and generates the root changelog entry.
2. Reviewers validate the exact proposed version and complete artifact plan.
   Merging that specific PR requires explicit approval of that version.
3. A separately authorized job in the protected `release` environment accepts
   only an exact stable version from the merged Release Please PR head. It
   creates exactly that immutable `vX.Y.Z` tag and a deterministic draft GitHub
   Release whose name and body come from the tagged changelog. This narrow
   mutation cannot create another pending Release Please candidate. On recovery
   it may finish a missing draft after exact tag creation or resolve an existing
   matching draft. Version, manifest, changelog, workflow checkout, tag, main
   ancestry, and draft identity must all agree.
4. Every CLI archive and npm native package is rebuilt from that verified tagged
   SHA on its claimed native runner. Aggregation produces one exact CLI candidate
   and one exact five-tarball npm candidate. The CLI candidate is tested on every
   claimed target; the npm candidate is installed without repacking on every
   target and supported Node major.
5. A second protected `release` job reconciles existing draft assets byte for
   byte, uploads only missing assets, re-downloads and validates the complete
   draft, and makes the GitHub Release public. This is the canonical completion
   point. Only then may the protected `npm` job publish the same version and
   source through trusted publishing with provenance.

Both workflows remain disabled by repository variables and no product release
has been run. `RELEASE_PLEASE_ENABLED=true` enables release-PR preparation;
`RELEASE_ENABLED=true` permits the publication workflow to reach its protected
environment gates. Enabling either variable or approving either environment is
an operational authorization, not a repository-code change.

For an approved version `X.Y.Z`, dispatch `release.yml` from the exact merged
release-PR head on `main` with `expected_version=X.Y.Z`. If the immutable tag and
draft already exist and the workflow must be recovered after `main` advances,
dispatch the same workflow from ref `vX.Y.Z` with the same expected version. A
tag-ref recovery can add missing assets only when every retained draft asset is
byte-identical to the rebuilt candidate. It cannot replace assets or reopen a
public Release. If GitHub is already public but npm has not started, the same
tag-ref workflow may rebuild and revalidate the unchanged public assets and
continue the npm projection only while every npm package version remains absent.
Any visible npm package makes that version non-recoverable.

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
an existing executable or receipt. A successful install writes a strict
adjacent receipt containing version, target, executable name, canonical GitHub
release source, and installed executable digest.

A downstream matrix downloads that exact aggregated candidate onto every
declared native runner. Each clean consumer serves the untouched assets over
loopback HTTP, runs the platform installer, compares the installed executable
with the archived bytes, validates the exact receipt, and executes version and
help identity. It also rejects failed downloads and corrupted archives without
publishing state and exercises managed replacement with the unmodified
candidate. Single-anchor temporary copies of that validated generated installer
inject replacement, receipt, interruption, restoration, and Windows terminal
status-publication faults while asserting either the restored pair or the fixed
recovery evidence, retained helper diagnostic, and Windows status; no test
failpoint is shipped in the candidate.

`ytm upgrade --check` is read-only and checks only the latest public stable
GitHub Release after validating the managed pair. `ytm upgrade` additionally
verifies release assets, the checksum manifest, the platform installer, and its
pinned archive digest before invoking that installer in managed mode. Unix
replacement preserves and rolls back the prior executable/receipt pair;
Windows schedules an out-of-process helper, exclusively claims an adjacent
in-progress marker, replaces any stale result with a `scheduled` status, waits
at most 120 seconds for the exact parent process to exit, fails closed when
identity cannot be confirmed, and atomically writes adjacent no-BOM UTF-8
status states. Interrupted upgrades
either restore the verified pair or retain fixed marker/`.previous` evidence;
when recovery is required, the command reports the paths to inspect. These
capabilities are wired into the tagged publication workflow, but they are not a
public installation path until an exact version is separately approved and the
resulting GitHub Release is made public.

## Visibility and failure policy

Release state is monotonic and corrections use a new approved version:

| State | Visibility | Permitted recovery |
| --- | --- | --- |
| Release PR open | Reviewers only | Update or close the PR; no tag exists. |
| Tag/draft creation failed | No public release | Fix the workflow and rerun. If the exact tag was committed but draft creation failed, the same tagged source may create only its missing deterministic draft. |
| Draft exists; build or validation failed | Draft is unavailable to normal consumers | Preserve the immutable tag and draft evidence. Rerun against the same tagged source only while the Release is still draft, every existing asset is byte-identical, and no npm package exists; the workflow adds only missing assets. |
| GitHub Release published; npm absent | Canonical release is public and immutable | Never move the tag or replace assets. Rebuild and byte-verify the public assets, then retry the npm projection only while all five npm versions are still absent. |
| npm projection partially failed | Canonical GitHub Release remains public; npm is explicitly incomplete | Report the failed packages and correct with a new version. Never repair a partially published version in place. |

The release workflow must fail closed when it cannot prove tag ancestry,
version and source identity, changelog-derived Release metadata, complete
expected assets, checksums, installer selection, or npm-version absence. It
must not delete a draft or tag
automatically: those are recovery evidence and destructive cleanup requires a
separate decision.

## Required GitHub settings

Before enabling release preparation or approving a release:

1. Protect `main` with the complete repository validation as a required check.
2. Add a `v*` tag ruleset that blocks updates and deletion and permits creation
   only by the release automation identity.
3. Create a `release` environment with required reviewers, prevent self-review,
   disallow administrator bypass, and restrict deployment to protected `main`
   plus protected `v*` tags so an immutable tagged draft can be recovered after
   `main` advances.
4. Keep the existing `npm` environment equally strict. Its current single
   reviewer plus administrator bypass does not provide two-person approval and
   must be corrected before publication.
5. Configure npm Trusted Publishing for `@sjunepark/ytm` and all native
   packages with owner `cpaikr`, repository `ytm`, workflow `release.yml`, and
   environment `npm`. No long-lived npm token is required.

Repository settings are operational prerequisites, not repository code. This
implementation records and validates their required shape but does not mutate
them or authorize a release.

## Node assembly and npm projection

[`native-targets.json`](../native-targets.json) currently owns the Node-API
matrix: Linux GNU x64/ARM64, macOS ARM64, and Windows x64. GNU/Linux artifacts
target glibc 2.28 or newer. CI builds every target on its declared
GitHub-hosted runner and clean-installs the packed root and native packages
under Node 22, 24, and 26.

The release workflow rebuilds those packages from the unified `vX.Y.Z` tagged
source, aggregates the exact tarballs, and clean-installs that untouched set on
all target and Node-major combinations before GitHub publication. It proves all
five package versions absent immediately before making GitHub canonical and
again at the npm boundary, then publishes all native packages before the root.
A failure after its first npm publish can still leave a partial registry
version; the job records packages already published and requires correction in
a newly approved product version.

## Historical Python release

Python source, CI, smoke, and PyPI publishing are absent from the active
repository. Existing PyPI artifacts and `python-v*` tags remain historical and
unchanged. Deprecating the PyPI project is outside this cutover.

## Validation

Run the complete [repository validation](../README.md#repository-validation) on
the exact candidate commit. `bun run release:check` includes product-version,
Release Please, release-state failure injection, draft-asset recovery,
native-package, exact-distributable, and publishing-boundary checks. These
checks do not publish or change external release state.

`bun run pack:node` rebuilds tracked Node distribution files before inspecting
the dry-run tarball; use `bun run build:check` when the checkout must remain
byte-for-byte unchanged.
