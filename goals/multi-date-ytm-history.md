# Goal: Multi-date YTM history and Excel export

Status: complete
Planning scope: ROADMAP.md

This is a completed delivery record. The original contract and execution
evidence below are historical; [ROADMAP](../ROADMAP.md) owns remaining work
and links to current behavior and release operations. Exclusions and pending
items below describe this goal at completion, not later project status.

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
Complete YTM history feature: date selection, availability/fallback, shared
retrieval, Rust/Node/Python/CLI integration, combined Excel export, capacity
verification, compatibility, documentation and authorized PR delivery.

### Current in-scope result
None — all included results complete.

### Next in-scope action
None — goal complete.

### Evidence and blockers
- [PR #35](https://github.com/cpaikr/ytm/pull/35) merged into dev on 2026-09-07
  as 9367a86, preserving 63ff49f (feature), 84ca230 (documentation), and
  3d4f371 (review fixes). Initial Codex and CodeRabbit reviews completed;
  all seven actionable findings were handled and every inline thread resolved.
- Full repository validation passed locally and on
  [latest-head CI](https://github.com/cpaikr/ytm/actions/runs/34105713662),
  including supported native targets, Node 22/24/26, Python 3.11–3.14,
  standalone CLI consumers and 198 independent public-surface scenarios.
- Actual CLI SIGINT/PTY and file-safety checks passed. Excel opened the
  synthetic three-sheet workbook without repair; filtering, frozen identities,
  numeric/literal fidelity and provenance were verified.
- [Capacity evidence](../docs/history-capacity.md) covers monthly, three-year,
  maximum-lookback and 2,000-date workloads. Maximum measured JSON RSS was
  2,739,224,576 bytes; workbook RSS was 2,193,014,784 bytes on a 16 GB host.
- Goal completion and planning metadata are recorded directly on the
  preflighted dev branch after the final PR merge. No blockers remain.
- Production provider enablement, live bulk retrieval and release publication
  were not performed. The separate provider task remains queued.
