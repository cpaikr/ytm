# Standalone CLI release distribution

Status: complete

## Purpose

This completed plan records the delivery boundary for the standalone CLI
distribution lifecycle. [`docs/release.md`](../docs/release.md) owns current
release operations, [`ARCHITECTURE.md`](../ARCHITECTURE.md) owns the implemented
system shape, and [`SPEC.md`](../SPEC.md) owns public product behavior.

## Outcome

GitHub Releases are the canonical distribution channel for the standalone
`ytm` CLI. Each authorized immutable product release is built in CI from tagged
source with a prebuilt archive for every claimed target, SHA-256 checksums, and
generated shell and PowerShell installers. The Rust core, CLI, and Node SDK use
one reconciled product version; npm is a synchronized secondary projection of
that same version and source.

The lifecycle is implemented but disabled. This plan did not select or publish
an actual version, enable production release providers, or change external
release state.

## Delivered scope

1. `VERSION`, the root `CHANGELOG.md`, Release Please, the unified `vX.Y.Z` tag,
   deterministic GitHub draft, visibility transition, and partial-failure
   policy form one mechanically reconciled lifecycle.
2. [`cli-targets.json`](../cli-targets.json) owns every supported standalone
   target. CI builds and executes each exact binary, creates deterministic
   archives, and derives both installers and the sorted checksum manifest from
   that target authority.
3. Toolchain-free installers publish a strict adjacent receipt. Explicit
   `upgrade --check` and `upgrade` validate canonical assets and preserve or
   restore the prior executable and receipt across supported failure states.
4. Native consumers download the exact aggregate without rebuilding it and
   exercise identity, integrity rejection, managed replacement, rollback,
   interruption, restoration, and Windows terminal-status failure behavior.
5. The gated tagged-source workflow creates only the explicitly approved tag
   and draft, rebuilds the complete CLI and five-tarball npm candidates from
   that immutable SHA, publishes GitHub canonically, and then projects the same
   version to npm through OIDC.
6. `bun run validate` is the complete uncredentialed repository gate used by
   local development, ordinary CI, and immutable tagged-source validation.
   Repository checks enforce its command policy and workflow delegation.

## Decisions and invariants

- GitHub publication is the canonical completion point; npm can begin only
  afterward and must retain the same version and source identity.
- Release Please prepares the version and changelog but cannot create the tag
  or GitHub Release. The separately authorized publication workflow owns those
  exact mutations.
- Tags, public Release assets, and registry versions are immutable. Recovery
  may add only missing byte-identical draft assets; corrections use a newly
  approved version.
- The CLI and Node native matrices are independently owned. Shared runner,
  architecture, and Linux glibc-floor facts are mechanically reconciled.
- Exact distributables, rather than local repacks, cross every clean-consumer
  boundary.
- Generated installers require no repository clone, language toolchain,
  package manager, or `gh`, and verify SHA-256 before publishing install state.
- Normal commands never perform release checks. `--version` and
  `upgrade --check` are side-effect-free.
- Credentialed live source checks remain separate from the complete repository
  gate.

## Excluded authority

- Selecting, tagging, or publishing an actual release version.
- Enabling Release Please, the publication workflow, protected environments,
  npm Trusted Publishing, or any other production provider state.
- crates.io publication, PyPI changes, historical artifact removal, support
  matrix expansion, or additional package-manager channels.
