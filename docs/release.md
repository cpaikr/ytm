# Release

The release pipeline distributes the standalone CLI through GitHub Releases.
Local `release-it` prepares the version, changelog, commit, and tag. Manual
dispatch on a stable `vX.Y.Z` tag starts certification and publication. npm and PyPI
publication have been removed. SDK source, local packaging, and development
CI remain supported.

The [delivery plan](../plans/release-delivery.md) records the original migration
evidence. [v0.5.0](https://github.com/cpaikr/ytm/releases/tag/v0.5.0) was published
on 2026-09-10 at 17:21:50 UTC; GitHub Releases and Actions own subsequent
publication status. Historical releases and registry packages remain unchanged.

## CI platform policy

Automatic pushes, pull requests (including `main` and `dev`), merge-queue runs,
and scheduled smoke checks use only Linux x64 on
`blacksmith-2vcpu-ubuntu-2404`. Changed paths never enable other platforms.
[`ci-platform-policy.mjs`](../scripts/ci-platform-policy.mjs) selects Linux x64
from the CLI and Node manifests unless the initiating event is manual dispatch.

`Platform compatibility` remains the required aggregate check. Automatic CI
runs the complete repository gate (including Python wheel consumers), inspects
and executes the Linux CLI archive, and tests exact Node tarballs on the
declared Node versions. Only the complete CLI set, installer consumers, and
cross-platform Python candidate are skipped in this mode.

Cross-platform builds are a manual-only cost exception for release certification.
Manual dispatch of [`ci.yml`](../.github/workflows/ci.yml) or
[`cross-platform-candidate.yml`](../.github/workflows/cross-platform-candidate.yml)
builds and consumes every declared CLI, Node, and Python target without
publication. The latter calls the same reusable CI workflow; automatic callers
retain Linux-only coverage. The reusable Python candidate is reached only in
manual full-platform mode. These runs retain native macOS, Windows, and ARM
runners and the Python candidate's GitHub-hosted runners.

[`release.yml`](../.github/workflows/release.yml) is also manual-only. Dispatch
on a branch certifies the full CLI candidate; dispatch on a version tag certifies
and publishes it. Tag pushes alone schedule no release jobs.

## Prepare a release

Rust consumers upgrading from before `0.5.0` must apply the
[retrieval compatibility changes](../SPEC.md#compatibility). Release certification
remains separate from the provider's live qualification.

From a clean `main` checkout tracking `origin/main`, install the frozen
JavaScript dependencies and the [validation prerequisites](../README.md#repository-validation),
cache both Cargo dependency graphs, then prepare the approved stable version
locally without pushing. Replace `X.Y.Z` with that exact version and select the
configured Python 3.11+ interpreter through `PYO3_PYTHON`:

```sh
cargo fetch --locked
cargo fetch --locked --manifest-path tests/rust-sdk-consumer/Cargo.toml
bun run release X.Y.Z --ci --no-git.push
```

The upstream hook fetches `origin/main` and requires the local commit to match
it before preparation. Release-it validates, commits, and creates the local
tag. `--no-git.push` leaves the commit and tag unpublished.

Use the pull-request path for protected `main`. Push the prepared commit to a
candidate branch without pushing its tag, then open a PR to `main`:

```sh
git push origin HEAD:refs/heads/codex/release-X.Y.Z
gh pr create --base main --head codex/release-X.Y.Z
```

Wait for required checks and review, then merge while preserving the prepared
commit (no squash or rebase). Fetch and fast-forward local `main` to the merge
result. Verify that the local tag still identifies the original certified
release commit and that this commit is reachable from `origin/main`:

```sh
git fetch origin main
git merge --ff-only origin/main
git rev-parse 'refs/tags/vX.Y.Z^{commit}'
git merge-base --is-ancestor 'refs/tags/vX.Y.Z^{commit}' origin/main
```

Compare the printed SHA with the prepared commit certified in the PR. Only
after the PR has landed and these checks pass, push the original tag and
explicitly dispatch the release:

```sh
git push origin refs/tags/vX.Y.Z
gh workflow run release.yml --ref vX.Y.Z
```

The manual dispatch starts CLI certification and publication. Keep the tag on the
prepared release commit; do not move it to the PR merge commit or bypass branch
protection. If integration requires changes to the prepared commit, reconcile
and certify the release candidate before publishing its tag.

The private root [`package.json`](../package.json) owns release-it's version.
The Conventional Commits plugin writes the root [`CHANGELOG.md`](../CHANGELOG.md).
After that update, a hook synchronizes [`VERSION`](../VERSION), Cargo versions
and internal requirements, Node and Python package versions, generated native
manifests, and workspace/consumer lockfiles. It runs `bun run validate` before
release-it stages, commits, tags, or pushes. SDK version copies identify local
builds; they do not create registry release channels.

Only stable semantic versions are accepted. `bun run release:version:check`
checks all version copies and the changelog head. Historical component
changelogs and tags remain records of earlier releases; new entries belong in
the root changelog.

## Certification and publication

[`release.yml`](../.github/workflows/release.yml) validates the source and tag
identity, builds every declared CLI target, and tests the exact aggregated
archives and installers on every target. It requires the tagged commit to be
reachable from `origin/main` and the tag to equal `v` plus the product version.
The publishing job downloads that same candidate after all consumers pass.

Manual dispatch from a branch performs certification only. Dispatch from a
version tag publishes after certification; tag identity and main ancestry are
validated before building. There are no automatic tag triggers, release-enablement
variables, or protected environments. The default token is read-only, and only
the publisher receives `contents: write`. Release tags must remain protected
against replacement or deletion. Older tags retain their original workflow
configuration; use this procedure for release commits containing the manual-only
workflow.

The publisher creates a changelog-derived draft, uploads only missing assets,
and downloads the complete set to verify its bytes before making it public.
It verifies remote tag identity and confirms public metadata and assets after
publication. The canonical assets contain only CLI archives, the generated
installers, and `SHA256SUMS`; Node tarballs and Python wheels are development
CI artifacts.

## Standalone CLI candidate assets

[`cli-targets.json`](../cli-targets.json) owns the supported targets independently
of the Node-API package matrix: GNU/Linux x64 and ARM64 at glibc 2.28, macOS ARM64, and
Windows x64. Full-platform CI derives its matrix from that file, builds on native
runners, executes the exact binary's `--version` and `--help`, enforces the Linux
symbol floor, and packages only the executable plus the canonical license
files. Archive order and metadata are normalized by repository code.

After all full-platform target jobs pass, CI generates version-pinned
`install.sh` and
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
help identity. The installed executable also exports undated kinds to XLSX,
checks its receipt and ZIP signature, rejects an existing destination, and
replaces it only with `--overwrite`. Publication failure tests preserve prior
bytes and check staging cleanup using an exclusively locked destination on
Windows and an unwritable parent on non-root Unix consumers. These tests need
no Excel installation and add no runtime dependency to the binary.

Consumer checks also resolve the command name to the selected executable and
run version/help in a shell and its newly launched child with inherited PATH.
These checks establish usability in the runner's filesystem context, not outside
a packaged application's private view. They do not mutate persistent user PATH.
The release subset executes the documented Windows PATH transformations with
isolated registry I/O when PowerShell is available (otherwise it reports a skip),
and parses the generated installer and documentation examples.

For redirected Windows installation contexts, retain separate evidence from an
independent ordinary terminal using the [consumer verification procedure](windows-installation.md#consumer-verification).
Record unavailable independent validation explicitly; launching another shell
under the installer is insufficient. The checkout's fresh Windows installer
reports this unverified boundary and points to recovery guidance without claiming
to detect redirection or modifying the selected destination, PATH, or profiles.
The published v0.5.0 installer includes this message. It does not close the
independent Windows consumer validation gap; the immutable v0.4.0 installer
predates the message.

The consumer also rejects failed downloads and corrupted archives without
publishing state and exercises managed replacement with the unmodified
candidate. Single-anchor temporary copies of that validated generated installer
inject replacement, receipt, interruption, restoration, and Windows terminal
status-publication faults while asserting either the restored pair or the fixed
recovery evidence, retained helper diagnostic, and Windows status; no test
failpoint is shipped in the candidate.

Managed upgrade selection, verification, replacement, and recovery semantics
are defined in the [CLI contract](../SPEC.md#public-sdk-and-cli-surfaces).
See the [README installation guide](../README.md#installation) for installer,
PATH, and upgrade commands.

## Visibility and recovery

| State | Recovery |
| --- | --- |
| Local preparation fails before commit | Inspect the version/changelog edits and fix the failed gate before continuing. |
| Manual release build or consumer fails | Inspect the failed run. Retry the original manual tag run only if the unchanged source can pass; code corrections require a new version. |
| Draft has some assets | Rerun the original manual tag run. Existing assets must match the verified candidate byte for byte; only missing assets may be added. |
| Release is public | A rerun verifies the complete unchanged set and metadata. It cannot repair or replace public assets. |
| Tag, metadata, inventory, or bytes conflict | Stop and investigate; corrections require a new version. |

Rerun the original manual tag workflow for publication recovery. Never move an existing tag, replace
published bytes, or delete a draft to hide recovery evidence. Unknown GitHub
responses fail closed and must be resolved before retrying. No registry
credentials, trusted publishers, or npm/PyPI environments are used by this
pipeline; any legacy remote settings are outside the repository migration.

## SDK development candidates

The Node SDK and generated native packages are private. Full-platform CI
builds the [`native-targets.json`](../native-targets.json) targets and installs
exact local tarballs under the declared Node versions. Local package assembly
and consumers remain part of the repository gate; the release workflow does
not publish them.

[`python-targets.json`](../python-targets.json) owns the Python target and
interpreter matrix: conventional CPython 3.11–3.14, GNU/Linux x64 and ARM64 at
glibc 2.28, macOS ARM64 at 11.0, and Windows x64. Alternative interpreters,
free-threaded builds, and future stable versions need evidence before joining
that matrix. One `cp311-abi3` mixed wheel serves each target.

Manual full-platform development CI uses `python-candidate.yml`. Pinned maturin
builds twice from fresh native output directories and requires identical wheel bytes. Build
inputs use the source commit timestamp, normalized source paths, LF package
files on every host, and the macOS deployment floor. Source attribution rejects
tracked changes and untracked build inputs before and after building, and when
validating the complete set. Generated artifact directories remain separate.
Optional generated SBOM output is disabled because its random
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

Python wheels likewise remain local/development CI artifacts and are not
attached to CLI releases or uploaded to PyPI. Historical PyPI `0.2.0` exposes
a different API.

## Validation

`bun run validate` is the complete uncredentialed gate for local preparation,
ordinary CI, and tagged-source verification. `bun run release:check` is its
targeted release subset: real release-it preparation in a disposable local Git
repository, product-version synchronization, CLI artifact policy,
publication recovery, CI platform policy, and workflow boundaries. These tests
do not publish or change external state. Credentialed live source checks remain
separate.

`bun run pack:node` rebuilds tracked Node distribution files before inspecting
the dry-run tarball; use `bun run build:check` when the checkout must remain
byte-for-byte unchanged.
