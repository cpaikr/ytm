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
Deliver the feature PR to dev through initial
review, complete feedback intake, native compatibility CI and merge.

### Evidence and blockers
- Candidate: history feature validation and PR delivery. Classification: included;
  contract basis: complete history feature and PR lifecycle. Proceed.
- dev is unprotected with push/admin permission; initialization was committed and
  pushed as 1a06c62 before the feature branch. Terminal metadata may be pushed
  directly to dev after the final PR merge.
- Core, Node, Python sync/async and CLI history are implemented on
  codex/multi-date-ytm-history, including three-sheet Excel export.
- Bounded core/surface review completed. Fixed cached observation-date labels,
  sparse Node arrays and cancellation immediately before file publication;
  regression coverage passes. A strict TypeScript consumer also found and fixed
  a result-type reference; it now runs in validate:node.
- Full independent judge passed 198 scenarios and a complete golden refresh.
  Existing golden changes are limited to root help and added Node surface.
  Focused core/CLI, external Rust, installed Python and Node types passed.
- Actual CLI SIGINT/PTY checks pass: machine-readable failure, interactive-only
  progress, no later fetch or partial file. Excel opened the final synthetic
  workbook without repair; filtering and frozen panes worked.
- Capacity evidence in docs/history-capacity.md verifies monthly, three-year,
  sparse maximum-lookback and 2,000-date workloads. Maximum measured JSON RSS
  was 2,739,224,576 bytes on a 16 GB host; workbook RSS 2,193,014,784 bytes.
- Affected documentation is harmonized. The full repository gate passed;
  PR feedback, native CI and merge are pending. No live bulk retrieval,
  production provider enablement or release publication was performed.
