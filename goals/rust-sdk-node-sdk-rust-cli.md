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

- Public Rust SDK — PR #16 merged into the integration branch as
  `cbf2b314`. It provides typed request/result/source contracts, default HTTP
  construction, advanced cancellation and transport seams, crate docs and
  examples, public-API tests, a detached locked consumer, and Node-owned DTO
  projection over the same Rust implementation.
- Standalone Rust CLI parity and Node SDK-only cutover — the current reviewed
  slice adds `ytm-cli`, moves the 88-scenario black-box CLI contract to the
  Rust binary, and removes the npm `bin` and JavaScript CLI implementation.
- Cross-surface validation and truthful documentation — architecture, product,
  judge, package, release, smoke, and skill documentation now describe the
  three separated surfaces and the unchanged release boundary.

### Current in-scope result

Final review and PR delivery for the CLI/Node cutover slice.

### Next in-scope action

Resolve independent review findings, finish the final PR through feedback, and
merge it into the integration branch with reviewed commits preserved.

### Evidence and blockers

- Boundary check: Standalone Rust CLI parity and Rust-backed Node SDK cutover
  are included directly by the contract. Combining them is the fewest safe
  reviewable slices because Node CLI removal is gated on Rust CLI parity.
- Cancellation decision: ordinary Rust consumers receive token-free calls,
  while an advanced cancellable API preserves explicit cancellation for the
  Node `AbortSignal` adapter and CLI interruption. This keeps Node/Tokio
  mechanics out of the ordinary SDK contract without weakening cancellation.
- Preflight: `main` is protected and requires PR delivery. The dedicated
  non-production integration branch is `codex/rust-sdk-node-sdk-rust-cli`.
- The pre-existing uncommitted planning/specification edits are intentional
  input to the successor initiative and are included with the first reviewed
  slice.
- PR #16 completed required review and feedback handling: all 10 inline review
  threads were resolved, all 14 GitHub checks passed, and the merge preserved
  both reviewed commits.
- Final public SDK evidence: 33 core tests, one public API test, six Node
  adapter tests, the Rust doctest, detached consumer, formatting, workspace
  Clippy, dependency policy, release fixture guard, build/contract freshness,
  npm package check, deliberate broken-oracle check, and all 79 public judge
  scenarios passed.
- Final-slice local evidence: six Rust CLI tests, 33 core tests, one public API
  test, six Node adapter tests, the Rust doctest and detached consumer, locked
  packaging, formatting, workspace Clippy, dependency and advisory policy,
  release fixture guards, generated-artifact and license freshness, Node SDK
  package inspection, deliberate broken-oracle proof, and all 88 public judge
  scenarios pass. Independent code review and hosted PR checks remain.
