# Release

No product release is authorized by this document. Selecting or publishing an
exact version remains a separate approval. The repository implements one
product lifecycle for the Rust core, standalone CLI, Node SDK, and Python SDK; this is the
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
- the Bun workspace lock entries;
- the Python package version and binding lock entry.

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
4. CLI archives, npm packages, and Python wheels are rebuilt from that verified
   SHA on their claimed native runners. Complete candidates are installed
   without repacking on every declared target and supported runtime version.
5. A second protected `release` job assembles one canonical candidate with
   `release-assets.json`: exact version, source SHA, names, sizes, and SHA-256
   digests. It proves registry absence before first visibility, reconciles draft
   assets byte for byte, uploads only missing assets, and re-downloads and
   verifies the complete set before making GitHub public.
6. The protected `npm` and separately enabled `pypi` jobs independently download
   those canonical bytes. A complete matching projection is verified and left
   intact; a wholly absent projection may publish through trusted identity.
   Partial, conflicting, or unknown registry state fails closed.

Both workflows remain disabled by repository variables, and no unified
post-rewrite lifecycle release has been run. Historical `v0.1.1`,
`node-v0.2.0`, and `python-v0.2.0` releases predate this lifecycle.
`RELEASE_PLEASE_ENABLED=true` enables release-PR preparation;
`RELEASE_ENABLED=true` permits the publication workflow to reach its protected
environment gates. `PYPI_RELEASE_ENABLED=true` separately admits the PyPI
projection. Enabling these variables or approving an environment is
an operational authorization, not a repository-code change.

For an approved version `X.Y.Z`, dispatch `release.yml` from the exact merged
release-PR head on `main` with `expected_version=X.Y.Z`. If the immutable tag and
draft already exist and the workflow must be recovered after `main` advances,
dispatch the same workflow from ref `vX.Y.Z` with the same expected version. A
tag-ref recovery can add missing assets only when every retained draft asset is
byte-identical to the rebuilt candidate. It cannot replace assets or reopen a
public Release. After GitHub visibility, an exact-tag rerun rebuilds and verifies
all unchanged canonical assets and checks each registry independently. An exact
completed projection remains intact; a wholly absent projection can proceed.
Local upload logs cannot prove registry absence after a lost response.

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
| Draft exists; build or validation failed | Draft is unavailable to normal consumers | Rerun the exact tagged source only with byte-identical retained assets and absent registry versions. Add only missing assets. |
| GitHub public; either projection absent | Canonical assets are immutable | Rebuild and verify the exact public set. Verify any completed projection and publish only the wholly absent projection. |
| Either projection partially failed or conflicts | GitHub and any completed projection remain intact | Approve a new product version. Never overwrite bytes or skip individual existing files. |
| Registry response is unknown | No absence or completeness claim | Resolve the read failure, then reclassify. Do not infer state from a local upload exit code. |

The workflow fails closed on divergent tag/source/version identity, edited
changelog-derived metadata, missing or unexpected assets, checksum conflicts,
and unknown or partial registry state. It never deletes tags or drafts:
those are recovery evidence. Before first canonical visibility, npm and an
enabled PyPI projection must be wholly absent. After visibility, exact completed
registry versions are allowed and are not republished. Post-publication checks
poll for up to two minutes with cache bypass, allowing absent or matching partial
results and transient read failures to settle. Conflicting bytes fail immediately.
The deadline never permits repair or another upload; recovery requires a fresh
state classification under the table above.

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
6. Before separately enabling PyPI, create an equally protected `pypi`
   environment and configure the `kisnet-ytm` trusted publisher for owner
   `cpaikr`, repository `ytm`, workflow `release.yml`, environment `pypi`.
   The job uses scoped OIDC; no long-lived PyPI token is required.

Repository settings are operational prerequisites, not repository code. This
implementation records and validates their required shape but does not mutate
them or authorize a release.

## Node assembly and npm projection

[`native-targets.json`](../native-targets.json) currently owns the Node-API
matrix: Linux GNU x64/ARM64, macOS ARM64, and Windows x64. GNU/Linux artifacts
target glibc 2.28 or newer. CI builds every target on its declared
GitHub-hosted runner and clean-installs the packed root and native packages
under Node 22, 24, and 26.

The tagged workflow aggregates those exact tarballs and installs them on all
target/Node-major combinations. Canonical GitHub assets include the root and
native tarballs. The npm job downloads them again, verifies the complete
canonical manifest, and queries every exact package version. Completed tarballs
must match downloaded registry bytes. A wholly absent projection publishes
native packages before the root, with provenance, then verifies the whole set.

## Python wheels and PyPI projection

[`python-targets.json`](../python-targets.json) owns the Python target and
interpreter matrix: conventional CPython 3.11–3.14, GNU/Linux x64 and ARM64 at
glibc 2.28, macOS ARM64 at 11.0, and Windows x64. Alternative interpreters,
free-threaded builds, and future stable versions need evidence before joining
that matrix. One `cp311-abi3` mixed wheel serves each target.

CI and tagged builds share `python-candidate.yml`. Pinned maturin builds twice
from fresh native output directories and requires identical wheel bytes. Build
inputs use the source commit timestamp, normalized source paths, LF package
files on every host, and the macOS deployment floor. Source attribution rejects
tracked changes and untracked build inputs before and after building, and when
validating the complete set. Generated artifact directories remain separate. Optional generated SBOM output is disabled because its random
IDs, timestamps, and host paths vary; canonical license notices remain required.
Linux uses the pinned Zig toolchain and maturin's embedded cargo-zigbuild
wrapper, with a manylinux 2.28 dependency audit. The repository-installed
cargo-zigbuild CLI used by Node/CLI builds is a separate wrapper.

Wheel checks enforce native architecture and system dependencies, ABI/platform
tags, metadata/version, exact facade and typing files, legal notices, every
`RECORD` digest, and fresh native bytes. Per-target evidence binds the untouched
wheel and native SHA-256 to the source commit. Aggregation rejects missing or
extra files. Every target/interpreter consumer installs the exact wheel outside
the checkout with no Rust on PATH, checks native identity, public lifecycle,
safe errors and strict typing, and proves release injection variables have no
effect. Separate fixture builds test source behavior, cancellation and panic
containment on each native host.

The complete wheel set and evidence join `release-assets.json` before GitHub
visibility. The independently gated PyPI job downloads canonical assets, checks
that exact version's full filename/digest set, and publishes only when absent.
It never uses `skip-existing`. Post-upload verification requires the complete
matching wheel set; a partial upload needs a new approved version.

Historical PyPI `0.2.0` and `python-v*` tags remain unchanged and expose a
different API. Rewritten PyPI publication requires a separately approved version
greater than `0.2.0`; this implementation selects and publishes no version.

## Validation

Install the pinned validation tools documented in the
[repository validation](../README.md#repository-validation), install frozen
JavaScript dependencies, and run `bun run validate` on the exact candidate
commit. Ordinary CI and the tagged-source root-package job invoke that same
complete uncredentialed gate. `bun run release:check` is its targeted release
subset and includes product-version, Release Please, release-state failure
injection, draft-asset recovery, native-package, exact-distributable, and
publishing-boundary checks. These checks do not publish or change external
release state.

`bun run pack:node` rebuilds tracked Node distribution files before inspecting
the dry-run tarball; use `bun run build:check` when the checkout must remain
byte-for-byte unchanged.
