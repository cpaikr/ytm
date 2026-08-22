# Goal: Deliver a Rust SDK, Rust-backed Node SDK, and standalone Rust CLI

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Deliver a consumable Rust SDK, a Rust-backed Node SDK, and a standalone Rust/Clap CLI over one KIS-NET implementation, with the Node package no longer owning or distributing the CLI.
- Goal state: goals/rust-sdk-node-sdk-rust-cli.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Public Rust SDK — plans/rust-sdk-node-sdk-rust-cli.md; ARCHITECTURE.md
  - Rust-backed Node SDK cutover — plans/rust-sdk-node-sdk-rust-cli.md; packages/node/SPEC.md; SPEC.md
  - Standalone Rust CLI parity — plans/rust-sdk-node-sdk-rust-cli.md; SPEC.md; judge/README.md
  - Cross-surface validation and truthful documentation — plans/rust-sdk-node-sdk-rust-cli.md; ROADMAP.md; docs/release.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: crates.io or npm publication, version or tag selection, CLI release-channel design, binaries or installers, and GitHub Releases.
- Authority: Execute only included results and necessary supporting work; resolve remaining decisions within that closed outcome using best judgment; record anything else and ask before scope expansion or external authority.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

_None._

## Execution status

### Completed included results

_None._

### Current in-scope result

Public Rust SDK.

### Next in-scope action

Harden `ytm-core` into an ergonomic public SDK, using token-free ordinary calls
and a separate advanced cancellable API, then validate an external Rust
consumer before the first implementation PR.

### Evidence and blockers

- Boundary check: Public Rust SDK is included directly by the contract; proceed.
- Cancellation decision: ordinary Rust consumers receive token-free calls,
  while an advanced cancellable API preserves explicit cancellation for the
  Node `AbortSignal` adapter and CLI interruption. This keeps Node/Tokio
  mechanics out of the ordinary SDK contract without weakening cancellation.
- Preflight: `main` is protected and requires PR delivery. The dedicated
  non-production integration branch is `codex/rust-sdk-node-sdk-rust-cli`.
- The pre-existing uncommitted planning/specification edits are intentional
  input to the successor initiative and remain unstaged during goal
  initialization.
