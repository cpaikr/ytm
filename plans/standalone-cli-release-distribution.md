# Standalone CLI release distribution

## Outcome

Public GitHub Releases are the canonical distribution channel for the standalone
`ytm` CLI. Each immutable product release is built in CI from tagged source and
contains a prebuilt archive for every claimed CLI target, SHA-256 checksums, and
generated shell and PowerShell installers. The Rust core, CLI, and Node SDK use
one reconciled product version; npm remains a secondary projection of that same
versioned release rather than an independent release line.

## Current state

The disabled-by-default publication workflow now accepts one explicitly
approved stable version, creates only that changelog-derived tag and draft in a
protected environment, resolves the immutable unified `vX.Y.Z` identity, and
rebuilds both the standalone CLI and Node SDK candidates from that tagged SHA.
It does not choose a version, and it has not been enabled or run for an actual
product release.

The complete workflow keeps immutable source-SHA resolution, GitHub-hosted
builders, pinned actions, npm OIDC, protected publication environments, native
target validation, dependency and license checks, and clean Node consumers. It
adds exact aggregate consumers, recoverable byte-identical draft uploads,
canonical GitHub publication before npm, and explicit partial npm failure
reporting. No post-rewrite product release exists, and the five-package npm
projection has not yet been exercised.

The current checkout remains at the pre-existing `0.2.0`; no new release
version has been selected. One root Release Please component, `VERSION`, and the
root `CHANGELOG.md` now define the product authority, and repository validation
reconciles every Cargo, Node, native-package, Bun, and consumer-lock copy. The
preparation workflow remains disabled and cannot create tags or Releases. The
separate release workflow is also gated and requires protected `release` and
`npm` approvals before it can change external state.

`native-targets.json` owns the Node-API matrix. The independent
`cli-targets.json` now owns four CLI targets. CI builds normalized archives,
executes their binary identity, generates version-pinned shell and PowerShell
installers, and validates a complete sorted checksum set without creating
external release state. The CLI has a side-effect-free version command plus
strict adjacent install receipts and explicit managed upgrade behavior.
Native clean consumers now download the aggregated candidate on every claimed
target, install its exact archive through the generated platform installer,
verify the executable and receipt, and exercise integrity and recoverable
upgrade failures. Tagged orchestration now rebuilds and tests those exact assets,
publishes GitHub canonically only after full validation, and then projects the
same candidate to npm; no actual public release has been authorized.

## Decisions

- Public GitHub Releases are the canonical standalone CLI channel. Source
  checkouts remain a development path.
- One product release identity, using `vX.Y.Z` tags, covers the Rust core, Rust
  CLI, and Node SDK.
- npm publication may continue only at the same product version and from the
  same tagged source as the canonical GitHub Release.
- The CLI owns an explicit target definition separate from the Node-API package
  matrix. Asset names, checksums, and both installers derive from that one CLI
  authority.
- Release candidates build on GitHub-hosted runners from one immutable tagged
  commit. The complete candidate is validated before the canonical release is
  made available.
- Published tags, GitHub Release assets, and registry versions are immutable.
  Corrections use a newly approved version.
- Exact distributables, not locally repacked equivalents, are installed and
  exercised in clean consumers for every claimed target.
- Release Please is the selected version, changelog, and release-PR authority.
  The separately authorized publication phase creates only the exact approved
  tag and deterministic changelog-derived draft, avoiding Release Please's
  manifest-wide release mutation. The old linked Node/Python configuration must
  not be restored.
- No release, tag, registry publish, or external release-state change occurs
  during implementation without separate approval of the exact version.

## Scope

1. Define the release authority and lifecycle, including the Release Please
   decision, version-file ownership, changelog ownership, tag creation, release
   visibility, partial failure reporting, and protected tag/environment rules.
2. Add one CLI target definition and deterministic generators for archive names,
   checksum metadata, shell installer, and PowerShell installer. Keep the Node
   and CLI matrices independently supportable while sharing facts deliberately.
3. Add standalone CLI release assembly for every claimed target, including
   archive inspection, executable identity, version/source reconciliation,
   license contents, SHA-256 generation, and absence of private material.
4. Add toolchain-free installation with a receipt recording version, target,
   executable, release source, and installed digest. Expose `ytm --version`,
   `upgrade --check`, and recoverable `upgrade` without affecting structured
   command output or noninteractive execution.
5. Exercise the exact archives, installers, receipts, checksums, and upgrade
   path in clean consumers. Inject download, checksum, replacement, receipt
   write, interruption, restoration, and Windows terminal-status publication
   failures and assert the state left behind.
6. Build the tagged-source release workflow. Publish the validated GitHub
   Release as the canonical completion point, then project the same version and
   source identity to npm through trusted publishing when authorized.
7. Consolidate complete local and CI validation behind one repository command.
   After cutover, remove superseded manual-tag/npm-only paths and validators,
   and update current architecture, release runbooks, installation docs, and
   GitHub settings to match the implemented state.

## Non-goals

- Selecting or publishing an actual release version.
- crates.io publication, PyPI changes, or deprecation of historical packages.
- Production qualification of KIS-NET or changes to provider access policy.
- Expanding the support matrix beyond targets the project explicitly claims
  and verifies.
- Adding Homebrew or another package-manager lifecycle before demonstrated
  consumer demand.
- Signing or provenance mechanisms beyond immutable source identity, trusted
  publishing, and checksums unless the threat model is separately revised.

## Acceptance

- One mechanically checked authority reconciles tag, product version, Cargo
  metadata, internal Rust dependency versions, Node package metadata, native
  manifests, lockfiles, changelog, and checkout SHA.
- Every claimed CLI target has exactly one expected archive in the GitHub
  Release, and both installers select only assets declared by the same target
  authority.
- Installers require no repository clone, language toolchain, package manager,
  or `gh`; they verify SHA-256 before installation and write a truthful receipt.
- `ytm --version` is side-effect-free. `upgrade --check` does not install, and
  normal noninteractive or CI commands do not wait for update checks or change
  structured stdout and exit status because of them.
- The exact release archives and installers pass clean-consumer tests on every
  claimed target. Failed installation or upgrade leaves or restores the prior
  executable and receipt, or reports the exact recoverable state.
- The canonical GitHub Release becomes available only after its complete asset
  set, checksums, installers, and source identity validate.
- Any npm packages use the same version and tagged source, publish through OIDC,
  and pass a post-aggregation clean-consumer check before publication.
- Local development and CI invoke the same repository-owned complete validation
  command, with credentialed live checks remaining separate.
- Documentation distinguishes the accepted target, active implementation plan,
  current release runbook, and historical releases without presenting planned
  behavior as already implemented.

## Next action

Consolidate the complete local and CI validation path, remove superseded
release-only checks and wording, and reconcile the roadmap, architecture,
installation guidance, and release runbook with the implemented lifecycle.
