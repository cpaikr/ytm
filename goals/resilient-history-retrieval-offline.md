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
- Core retry/deadline mechanism and interface options/error projections implemented; targeted core and real-HTTP CLI, Node, Python sync/async acceptance pass. Repository validation, bounded independent review and documentation reconciliation are complete; PR delivery remains.

### Current in-scope result
Align contracts and complete offline validation, then deliver the implementation PR.

### Next in-scope action
Deliver the one implementation PR through feedback resolution, required checks and merge. All repository gate steps pass, including affected reruns after timeout-help snapshot and validation-stderr test corrections; independent reviews found no actionable issues.

### Evidence and blockers
- Integration branch: `codex/retrieval-recovery-integration`; branch creation and push preflight passed. Protected `main` is reserved for reviewed delivery.
- Existing in-scope planning edits were committed externally as `afa54f3` during initialization and are preserved in this branch.
- Candidate implementation, interface contracts, deterministic tests, documentation reconciliation, and PR review are included or necessary under the contract. Full live acceptance is excluded and remains pending; issue #45 must remain open.
- Delivery decision: one connected implementation PR targeting protected `main`, including the initialized goal and preserved planning commit. After it merges, fast-forward the preflighted integration branch to that result and push only terminal planning/goal metadata there. This satisfies the goal lifecycle without a redundant second implementation PR; no release publication is authorized.
- Real-HTTP regression first failed at lookup 17, date `2026-06-09`, category `70`, HTTP 503. Recovery, initialization and interrupted-body scenarios now produce identical complete histories and exactly one replay.
- Bounded dependency choice: pinned Hyper supplies typed framing-error discrimination; existing fastrand supplies non-cryptographic jitter without an extra entropy/crypto stack; httpdate handles HTTP-date parsing. MSRVs/licenses were inspected and the generated license inventory updated. Context7 lacked relevant pinned error/date coverage, so cached official crate source supplied precise evidence.
- Targeted validation: core regression/selection/deadline tests; CLI and Node real-HTTP recovery/exhaustion/timeout/export checks; Python 3.13 installed fixture wheel behavior plus sync/async real-HTTP acceptance. Complete gate steps passed, with affected reruns for reviewed harness/golden corrections. System Python 3.9 is below the supported minimum; use `PYO3_PYTHON=/opt/homebrew/bin/python3.13`.
