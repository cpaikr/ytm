# Goal: Count-based YTM history

Status: complete
Planning scope: ROADMAP.md

This is a completed delivery record. The original contract and execution
evidence below are historical; [ROADMAP](../ROADMAP.md) owns remaining work
and links to current behavior and release operations. Exclusions and pending
items below describe this goal at completion, not later project status.

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
All included retrieval, Rust/Node/Python integration, CLI exports, regression coverage, documentation, validation, review, and PR delivery results are complete.

### Current in-scope result
None — goal complete.

### Next in-scope action
None — goal complete.

### Evidence and blockers
- [PR #38](https://github.com/cpaikr/ytm/pull/38) merged into `codex/count-history-integration` on 2026-09-08 as `0bf5b3b`, preserving implementation `0ee948c` and feedback fix `368eb5b`.
- Full local `PYO3_PYTHON=/opt/homebrew/bin/python3.13 bun run validate` passed. Targeted follow-up core tests, pinned Clippy, installed Python wheels and strict typing passed.
- [Final cross-platform CI](https://github.com/cpaikr/ytm/actions/runs/34229652522) passed on `368eb5b`, covering the repository gate and declared CLI, Node, and Python consumers.
- Independent local review completed. Codex completed with no findings; both CodeRabbit findings were fixed, replied to, and resolved. The final feedback surface had no active reviews or unresolved actionable findings. Generic docstring coverage and the bot's failed Clippy invocation were explicitly dispositioned in the PR.
- [Capacity evidence](../docs/history-capacity.md#count-selection) records deterministic 180-date success and 2,000-candidate null-only exhaustion; no live-provider throughput claim is made.
- Terminal metadata is committed directly on the preflighted non-production integration branch. No release preparation, publication, or next queued project item was started. No blockers remain.
