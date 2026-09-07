# Goal: Multi-date YTM history and Excel export

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Deliver multi-date, all-category YTM retrieval across the CLI and Rust, Node, and Python SDKs, with usable combined Excel export.
- Goal state: /Users/sejunpark/IT/ytm/goals/multi-date-ytm-history.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Complete YTM history feature: date selection, availability and fallback, shared retrieval, SDK/CLI integration, Excel export, capacity verification, compatibility, and documentation — /Users/sejunpark/IT/ytm/plans/multi-date-ytm-history.md.
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Production provider enablement and release publication.
- Authority: Execute only included results and necessary supporting work; record anything else and ask before scope expansion or external actions not covered by this contract and Delivery.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice. Target dev and merge each PR preserving individual commits.

## Authorized amendments

_None._

## Execution status

### Completed included results
_None._

### Current in-scope result
Complete YTM history feature as defined in plans/multi-date-ytm-history.md.

### Next in-scope action
Implement and validate the additive history contract, shared retrieval, SDK/CLI integration and combined workbook in one coherent feature PR targeting dev.

### Evidence and blockers
- Candidate: history feature implementation and its required validation/review. Classification: included; contract basis: complete YTM history feature. Proceed.
- dev is unprotected, has no applicable rules, and repository permissions permit push/admin; dry-run push succeeded. Direct initialization and terminal metadata commits are supported.
- Existing local commit 6e8d44d contains only the included plan and roadmap. Carry it unchanged in the initialization push.
- Production provider enablement and release publication remain excluded.

