# Goal: Count-based YTM history

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Implement count-based YTM history so requesting 180 returns the latest 180 distinct dates containing numeric yield data across all supported SDKs and CLI exports.
- Goal state: /Users/sejunpark/IT/ytm/goals/count-based-ytm-history.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Count-based retrieval, SDK/CLI integration, exports, regression coverage, and documentation — /Users/sejunpark/IT/ytm/plans/count-based-ytm-history.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Release preparation and publication.
- Authority: Execute only included results and necessary supporting work; record anything else and ask before scope expansion or external actions not covered by this contract and Delivery.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

_None._

## Execution status

### Completed included results
_None._

### Current in-scope result
Count-based retrieval, SDK/CLI integration, exports, regression coverage, and documentation.

### Next in-scope action
Implement one connected slice and deliver its PR into `codex/count-history-integration`.

### Evidence and blockers
- Clean starting commit: `5386c0a`. The project current release work remains outside this goal.
- Temporary non-production integration branch `codex/count-history-integration` starts at current main; remote push succeeded. Existing dev predates current implementation. Final metadata will be pushed directly to this integration branch after the slice PR merges.
- Candidate: count history implementation and required validation/review. Classification: included and necessary under the named result and completion criteria. No release preparation or publication.
