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

_None._

## Execution status

### Completed included results

- Baseline/workspace — PR #8 merged to `main` as `81a60e0`; the exact commit passed the full validation and package-artifact suite, is archived at `archive/pre-rewrite-2026-08-20`, and anchors `codex/rewrite-vnext` in `/Users/sejunpark/IT/ytm-rewrite`.
- Judge and Rust feasibility — PR #9 merged to `codex/rewrite-vnext` as `63282fc`; its 56-scenario public judge, deliberate-failure proof, disposable rustls/live probe, and five-target selection passed all applicable gates.
- Wire authority, architecture, provider qualification — PR #9 established the enforced OpenAPI/Nexacro authority, target module boundaries, protocol-feasible/not-production-qualified decision, compatibility decisions, and Node-only release design.

### Current in-scope result

Rust core and Node product

### Next in-scope action

Create the next branch from `63282fc` and implement the Rust core, Node-API
binding, and thin Node product against the frozen authority and judge.

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
- Target decisions are recorded: Rust-only transport, exact HTTP 200, no redirects or automatic retries, 20-second per-call deadline, 1 MiB decoded limit, Node 22 floor, five native targets, removal of public `context.fetch`, canonical kind 80, and protocol-feasible/not-production-qualified provider status.
- Foundation validation passed on 2026-08-20: frozen Bun and uv sync, `bun run validate`, `bun run test` (90 passed; 3 opt-in live tests skipped), `bun run judge`, deliberate-failure proof, `bun run build`, both package checks, and `git diff --check`.
- Foundation delivery completed through PR #9 at merge commit `63282fc`; all repository and security checks passed, no actionable review threads were filed, and CodeRabbit's attached run was skipped after the progress-metadata head update because automatic reviews are disabled. Repository policy forbids a manual retrigger.
- Blockers: none.
