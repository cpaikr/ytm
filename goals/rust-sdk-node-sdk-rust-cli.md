# Goal: Deliver a Rust SDK, Rust-backed Node SDK, and standalone Rust CLI

Status: delivery complete on the integration branch; publication excluded
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

- Public Rust SDK — PR #16 merged into the integration branch as
  `cbf2b314`. It provides typed request/result/source contracts, default HTTP
  construction, advanced cancellation and transport seams, crate docs and
  examples, public-API tests, a detached locked consumer, and Node-owned DTO
  projection over the same Rust implementation.
- Rust-backed Node SDK cutover — PR #17 keeps the complete Node SDK and native
  matrix over `ytm-core` while removing the npm `bin`, JavaScript CLI source,
  distribution file, scripts, and package claims.
- Standalone Rust CLI parity — PR #17 adds the Rust/Clap `ytm` binary over the
  public SDK with the approved commands, validation, help, JSON/CSV/TSV,
  fallback, diagnostics, and exit behavior frozen across 29 CLI scenarios.
- Cross-surface validation and truthful documentation — architecture, product,
  judge, package, release, smoke, skill, plan, and roadmap records describe the
  three separated surfaces and the unchanged publication boundary.

### Current in-scope result

Delivery — PRs #16 and #17 complete the authorized initiative on
`codex/rust-sdk-node-sdk-rust-cli` with reviewed commits preserved.

### Next in-scope action

None — complete. crates.io, npm, binary or installer publication, version and
tag selection, CLI release-channel design, and GitHub Releases remain excluded.

### Evidence and blockers

- Boundary check: Standalone Rust CLI parity and Rust-backed Node SDK cutover
  were combined as the fewest safe reviewable slices because Node CLI removal
  was gated on Rust CLI parity.
- Cancellation decision: ordinary Rust consumers receive token-free calls,
  while an advanced cancellable API preserves explicit cancellation for the
  Node `AbortSignal` adapter and CLI interruption. This keeps Node/Tokio
  mechanics out of the ordinary SDK contract without weakening cancellation.
- PR #16 completed required review and feedback handling: all 10 inline review
  threads were resolved, all 14 GitHub checks passed, and the merge preserved
  both reviewed commits.
- PR #17 completed independent code review and the full PR feedback lifecycle.
  Its review hardening makes help scanning option-aware, reports failed output
  writes, preserves missing-field and numeric-kind JSON semantics, diagnoses an
  unavailable judge binary, and enforces one shared Node CLI-artifact policy.
- Final evidence covers seven CLI-library tests, one CLI-binary output test, 33
  core tests, one public API test, six Node adapter tests, the Rust doctest and
  detached consumer, locked packaging, formatting, strict workspace Clippy,
  dependency and advisory policy, release fixture guards, generated-artifact
  and license freshness, a 10-file SDK-only npm package, deliberate
  broken-oracle and unavailable-binary proofs, all 95 public judge scenarios, all
  66 Node-only scenarios, and all 12 supported native consumer jobs.
- Blockers: none.
