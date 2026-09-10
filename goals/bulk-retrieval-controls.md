# Goal: Observable and configurable bulk retrieval

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract
- Outcome: Make bulk YTM retrieval observable and configurable across CLI, Rust, Node, and Python while preserving default request behavior and data selection.
- Goal state: goals/bulk-retrieval-controls.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Bounded retry configuration and optional request pacing — plans/bulk-retrieval-controls.md
  - Metadata-only progress and final retrieval statistics on every public surface — plans/bulk-retrieval-controls.md
  - Deterministic 180-date acceptance, interface validation, and contract documentation — plans/bulk-retrieval-controls.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Release publication.
- Authority: Execute only included results and necessary supporting work; record anything else and ask before scope expansion or external actions not covered by this contract and Delivery.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

_None._

## Execution status

### Completed included results

_None._

### Current in-scope result

Bounded retry configuration and optional request pacing, with the shared
statistics contract required by the public adapters.

### Next in-scope action

Inspect the shared execution/transport and public adapter contracts, then
implement the connected enhancement slice on a work branch.

### Evidence and blockers

- Native goal created in task `01a08b2a-0b94-7063-854d-5041fce8e61c`.
- Clean startup checkout was exactly preparation commit
  `ff9bad63bcda132bf1132af377bf9a506d48b806`; preparation ancestry and unchanged
  plan/roadmap verified after selecting `codex/bulk-controls-integration`.
- Integration branch pushed successfully; repository permissions allow push
  and the repository reports no rulesets. Terminal metadata will use this branch.
- Repository skills are retained under `.claude/skills`, replacing the
  handoff's stale `.agents/skills` location; global progress skill is available.
- Candidate: integration setup and contract initialization. Classification:
  necessary. Contract basis: Delivery and Resume. Action: proceed.
- Candidate: connected core, CLI, Node, Python and acceptance implementation.
  Classification: included. Contract basis: all three named results. Action:
  proceed after durable initialization.
- No release publication or additional live bulk run is authorized.
