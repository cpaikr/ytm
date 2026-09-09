# Goal: Bounded retrieval recovery and offline acceptance

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Implement issue #45’s bounded retrieval recovery across Rust, CLI, Node, and Python, preserving data semantics and all-or-error output.
- Goal state: /Users/sejunpark/IT/ytm/goals/resilient-history-retrieval-offline.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Shared retries and retrieval deadlines, interface options and structured errors, compatibility documentation, and deterministic offline acceptance — /Users/sejunpark/IT/ytm/plans/resilient-history-retrieval.md, through “Align contracts and complete offline validation.”
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes. Keep issue #45 open and full live acceptance explicitly pending.
- Excluded: The full 180-observation live acceptance milestone.
- Authority: Execute only included results and necessary supporting work; record anything else and ask before scope expansion or external actions not covered by this contract and Delivery.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice. Preserve and include existing in-scope planning edits.

## Authorized amendments

_None._

## Execution status

### Completed included results
_None._

### Current in-scope result
Shared retries and retrieval deadlines, followed by interface projections and offline validation.

### Next in-scope action
Reproduce transient history failure through the real HTTP path, then implement one connected recovery slice across core and interfaces.

### Evidence and blockers
- Integration branch: `codex/retrieval-recovery-integration`; branch creation and push preflight passed. Protected `main` is reserved for reviewed delivery.
- Existing in-scope planning edits were committed externally as `afa54f3` during initialization and are preserved in this branch.
- Candidate implementation, interface contracts, deterministic tests, documentation reconciliation, and PR review are included or necessary under the contract. Full live acceptance is excluded and remains pending; issue #45 must remain open.
- Use the fewest reviewable PRs: one connected implementation PR into the integration branch, then reviewed integration delivery to main if required by repository protection. No release publication is authorized.
