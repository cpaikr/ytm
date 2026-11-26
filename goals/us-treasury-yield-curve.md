# Goal: US Treasury yield curve retrieval

Status: complete
Planning scope: ROADMAP.md

## Original contract

Goal contract
- Outcome: Deliver US Treasury daily par yield curve retrieval as a source separate from KIS-NET across Rust, CLI, Node, and Python, with its own commands, types, wire contract, and provider record, while leaving KIS-NET behavior unchanged.
- Goal state: goals/us-treasury-yield-curve.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Treasury wire contract, fixtures, and core source with strict yearly-CSV parsing, a header-to-maturity table, previous-available fallback, and public Rust types, plus the two-source SPEC and ARCHITECTURE amendments — plans/us-treasury-yield-curve.md (D1, D2; delivery slice 1).
  - `ytm treasury` CLI with JSON/CSV/TSV/XLSX output, judge scenarios, and exact-binary consumer smoke — plans/us-treasury-yield-curve.md (slice 2).
  - Node and Python sync/async Treasury surfaces with errors, cancellation, and typing — plans/us-treasury-yield-curve.md (D3; slice 3).
  - Bounded live acceptance, Treasury provider qualification record, and README, CHANGELOG, and ROADMAP reconciliation — plans/us-treasury-yield-curve.md (D4; slice 4).
- Complete when: Every included result achieves its cited outcome and the plan's acceptance criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Release publication; tenor interpolation or KIS-layout output; spread or credit-curve sources including FRED; bootstrapping, discount factors, or zero curves; other Treasury datasets; persistence or scheduled collection; KIS-NET production provider enablement.
- Authority: Execute only included results and necessary supporting work; the owner delegates remaining implementation decisions within the plan's accepted D1–D4 and scope boundaries; record anything else and ask before scope expansion or external actions not covered by this contract and Delivery.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice. Target the temporary integration branch codex/us-treasury-integration cut from origin/main, then merge it into main through one reviewed integration PR after the final slice.

## Authorized amendments

_None._

## Execution status

### Completed included results

- Slices 1-4: Treasury wire contract, fixtures, and core source; `ytm
  treasury` CLI; Node and Python surfaces; live acceptance, provider record,
  and documentation. Delivered in one implementation PR, cpaikr/ytm#54,
  merged into `codex/us-treasury-integration` on 2026-11-26.

### Current in-scope result

_None._ Delivery finishes when the integration PR merges
`codex/us-treasury-integration` into `main`.

### Next in-scope action

_None._

### Evidence and blockers

- Owner accepted plan decisions D1–D4 on 2026-11-26.
- `origin/dev` is stale relative to `main`, so delivery uses a temporary
  integration branch from `origin/main`, following the precedent of the
  bulk-retrieval and retrieval-recovery integration branches.
- PR #54 CI passed at `63bc350`. Review findings from Codex and CodeRabbit
  were fixed and answered in-thread. The branch also carries fixes `main`
  needed for CI: a bulk-controls judge race, RustSec dependency updates, and
  three owner-approved `deny.toml` ignores for unmaintained crates with no
  successor (2026-11-26).
- Follow-up outside this goal: replacing `chrono` so its ignore can be removed.
- No blockers.
