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

_None._

### Current in-scope result

Baseline/workspace

### Next in-scope action

Open the validated documentation-only `dev` baseline PR to `main` and complete its review-feedback lifecycle before creating the rewrite branch.

### Evidence and blockers

- Boundary check: `Baseline/workspace` is included by the original contract; proceed.
- Delivery base: `dev` is the established non-production integration branch. GitHub reports it is unprotected and has no branch rules, so direct initialization and terminal metadata pushes are permitted.
- Baseline plan commit `ec40038` is present locally on `dev` and precedes this goal initialization.
- Baseline validation passed on 2026-08-20: frozen Bun and uv dependency sync, `bun run validate`, `bun run test` (90 Python tests passed; 3 opt-in live tests skipped), `bun run build`, `bun run pack:node`, `bun run pack:python`, and `git diff --check`.
- Blockers: none.
