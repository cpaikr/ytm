# Goal: Deliver cutover-ready Node-only ytm

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Deliver cutover-ready Node-only ytm with a Rust HTTP core, Node-API binding, and thin Node adapters.
- Goal state: goals/rust-node-rewrite.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Baseline/workspace — ROADMAP.md; plans/rust-node-rewrite.md
  - Judge and Rust feasibility — plans/rust-node-rewrite.md; SPEC.md
  - Wire authority, architecture, provider qualification — plans/rust-node-rewrite.md
  - Rust core and Node product — plans/rust-node-rewrite.md; SPEC.md
  - Parity, packaging, kind 80 — plans/rust-node-rewrite.md; contracts/kisnet/; GitHub issue #7
  - Node cutover and legacy retirement — plans/rust-node-rewrite.md; docs/release.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Final main/release PR merge, npm publication, PyPI deprecation, and any replacement Python implementation or API.
- Authority: Execute only included results and necessary supporting work; resolve remaining decisions within that closed outcome using best judgment; record anything else and ask before scope expansion or external authority.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
  - Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

- 2026-08-20 — The user authorized transferring the GitHub repository from
  `sjunepark` to the `cpaikr` organization and migrating GitHub Actions to
  Blacksmith using the lowest compute tier suitable for each runner image.
  Repository references, active PR delivery, and validation may be updated as
  necessary to complete that move; publication and the final main PR merge
  remain excluded.
- 2026-08-20 — The user chose a simple native CI matrix over Intel macOS
  emulation. The cutover supports Linux GNU x64/ARM64, macOS ARM64, and Windows
  x64; Intel macOS is unclaimed rather than cross-built or run through Rosetta.
- 2026-08-20 — The user removed Release Please automation for now. Release-PR
  and tag creation stay disabled; future release procedure and publication
  require separate authorization.

## Execution status

### Completed included results

- Baseline/workspace — PR #8 merged to `main` as `81a60e0`; the exact commit passed the full validation and package-artifact suite, is archived at `archive/pre-rewrite-2026-08-20`, and anchors `codex/rewrite-vnext` in `/Users/sejunpark/IT/ytm-rewrite`.
- Judge and Rust feasibility — PR #9 merged to `codex/rewrite-vnext` as `63282fc`; its 56-scenario public judge, deliberate-failure proof, disposable rustls/live probe, and five-target selection passed all applicable gates.
- Wire authority, architecture, provider qualification — PR #9 established the enforced OpenAPI/Nexacro authority, target module boundaries, protocol-feasible/not-production-qualified decision, compatibility decisions, and Node-only release design.

### Current in-scope result

Rust core and Node product; parity, packaging, and kind 80 — delivery pending

### Next in-scope action

Finish the final-head PR #10 Blacksmith CI and feedback lifecycle, merge the
reviewed implementation into `codex/rewrite-vnext`, then start the atomic
Node-only cutover and legacy retirement.

### Evidence and blockers

- Boundary check: `Baseline/workspace` is included by the original contract; proceed.
- Delivery base: `dev` is the established non-production integration branch. GitHub reports it is unprotected and has no branch rules, so direct initialization and terminal metadata pushes are permitted.
- Baseline plan commit `ec40038` is present locally on `dev` and precedes this goal initialization.
- Baseline validation passed on 2026-08-20: frozen Bun and uv dependency sync, `bun run validate`, `bun run test` (90 Python tests passed; 3 opt-in live tests skipped), `bun run build`, `bun run pack:node`, `bun run pack:python`, and `git diff --check`.
- Baseline delivery completed through PR #8 and its full Codex/CodeRabbit feedback lifecycle; follow-up `a3aadd8` resolved both findings and all CI checks passed.
- The landed merge commit `81a60e0` repeated the complete local baseline validation before archive tag and rewrite-branch creation.
- Planning ownership: the rewrite worktree exclusively edits the ordinary `ROADMAP.md`, plan, and goal state while the `main` worktree remains read-only; no planning files are concurrently owned.
- Boundary check: the foundation PR combines the explicitly included `Judge and Rust feasibility` and `Wire authority, architecture, provider qualification` results because they share the same pre-implementation acceptance boundary; proceed.
- The reviewed black-box judge passes 56 public CLI/toolset scenarios against the archived package and rejects a deliberate missing-value null-to-zero mutation.
- A disposable Rust 1.92 probe reproduced both live operations with reqwest 0.13.4, rustls, quick-xml 0.41.0, and no browser impersonation. Only sanitized metadata is retained; the temporary source and all bodies were discarded.
- `contracts/kisnet/openapi.yaml` now owns the exact two-operation wire contract and Nexacro profile; fixtures remain independent evidence, and `contracts:check` enforces the boundary and native target selection.
- Target decisions are recorded: Rust-only transport, exact HTTP 200, no redirects or automatic retries, 20-second per-call deadline, 1 MiB decoded limit, Node 22 floor, four native targets after the Blacksmith simplification, removal of public `context.fetch`, canonical kind 80, and protocol-feasible/not-production-qualified provider status.
- Foundation validation passed on 2026-08-20: frozen Bun and uv sync, `bun run validate`, `bun run test` (90 passed; 3 opt-in live tests skipped), `bun run judge`, deliberate-failure proof, `bun run build`, both package checks, and `git diff --check`.
- Foundation delivery completed through PR #9 at merge commit `63282fc`; all repository and security checks passed, no actionable review threads were filed, and CodeRabbit's attached run was skipped after the progress-metadata head update because automatic reviews are disabled. Repository policy forbids a manual retrigger.
- Blockers: none.
- Boundary check: the Rust core/Node product and parity/packaging/kind-80
  results share one candidate artifact and validation boundary, so they are
  delivered in one reviewable PR; proceed.
- The staged implementation contains the sole Rust HTTP/Nexacro conformer, a
  panic-contained Node-API binding, a wire-ignorant Node facade/CLI, and a
  compile-time-only judge transport absent from release builds.
- Rust gates pass with 19 tests, including OpenAPI request conformance, the
  independent XML corpus, protocol precedence, localhost HTTP headers/status,
  redirect refusal, decompressed-size bounds, and in-flight cancellation.
  Formatting, Clippy with warnings denied, RustSec audit, cargo-deny license,
  source, and wildcard policy all pass; only the reported transitive syn 2/3
  duplication remains a non-blocking warning.
- The public judge passes 67 legacy-parity, boundary, CLI, package, and issue
  #7 scenarios and still rejects the deliberate null-to-zero mutation.
- A production binding smoke completed both live operations on 2026-08-20
  without retaining bodies, rows, or yields. It exposed optional live
  ColumnInfo metadata; the authority, fictional evidence, and parser now agree
  that this metadata is allowed and ignored.
- The local macOS ARM64 release artifact passed package assembly and a clean
  npm consumer install under Node 26. The PR workflow will build all four
  selected native targets and clean-install each under Node 22, 24, and 26
  before any support claim is made.
- Final pre-delivery validation passes: frozen JavaScript/Python dependency
  state, contract/release checks, Rust gates, 76-scenario candidate judge,
  deliberate-failure proof, candidate freshness, legacy Node/Python validation
  and tests (91 Python passed; 3 live tests skipped), both legacy package
  artifact checks, workflow YAML parsing, diff checks, and source/TODO review.
- PR #10 is open against `codex/rewrite-vnext`. Its first CI run passed every
  Rust, parity, legacy, and non-Windows native job; all Windows native builds
  succeeded, while the clean-consumer harness exposed a Windows `.cmd` spawn
  incompatibility rather than a product artifact failure.
- All 26 initial Codex and CodeRabbit inline comments were assessed. The
  candidate now incorporates the 25 applicable fixes and hardening changes;
  the remaining exact native-target-order comment was already enforced by the
  contract validator and required no code change.
- The review-hardened implementation passes 19 Rust core tests, the expanded
  76-scenario public judge, a release-build fixture exclusion proof, contract
  and generated-artifact freshness checks, and a clean macOS ARM64 package
  consumer. The Windows harness now routes both npm and generated CLI batch
  launchers through a bounded `cmd.exe` invocation for the repeated matrix.
- The first repeated Windows consumers proved native build and assembly but
  exposed Node escaping the wrapper's nested quote characters before npm ran.
  The follow-up retains the validated command/argument quoting and enables
  verbatim Windows argument transmission; the next native matrix is the
  required platform proof.
- Transfer preparation is locally complete: active repository references use
  `cpaikr/ytm`; compatible jobs use the lowest Blacksmith Linux, ARM Linux,
  macOS, and Windows runners; npm publishing retains its required GitHub-hosted
  runner; Release Please automation is absent and enforced; Intel macOS is
  unclaimed. Contract, release, generated-build, 76-scenario judge, YAML,
  syntax, diff, and macOS ARM64 clean-consumer checks passed before transfer.
- GitHub repository `1264066471` transferred successfully to `cpaikr/ytm` with
  PR #10, issue #7, branches, secrets, environments, main protection, and
  Actions settings intact. The shared Git remote now uses the canonical URL.
  Release Please is disabled at GitHub, its guard variable is false, and its
  workflow is deleted on the PR head. Commit `6a29065` started the four-target
  Blacksmith matrix; this terminal progress commit becomes the final PR head.
