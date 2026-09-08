# Count-based YTM history

## Outcome

Request the latest N distinct dates containing numeric yield data across Rust,
Node, Python sync/async, and CLI JSON/CSV/TSV/Excel exports. Preserve missing
cells and all category outcomes within selected dates; insufficient history
fails without a partial export.

## Current state

Complete and delivered through [PR #38](https://github.com/cpaikr/ytm/pull/38)
into `codex/count-history-integration` on 2026-09-08. Implementation `0ee948c`
and review fixes `368eb5b` are preserved by merge `0bf5b3b`.
The [goal contract](../goals/count-based-ytm-history.md) is complete.

The [public history contract](../SPEC.md#multi-date-history) owns selection,
qualification, search bounds, errors, ordering, and export metadata. The
[architecture](../ARCHITECTURE.md#runtime-flows) owns shared full-day retrieval
and cache lifetime. Release preparation and publication remain separate.

## Validation and review

- Full local `PYO3_PYTHON=/opt/homebrew/bin/python3.13 bun run validate` passed.
- [Final cross-platform CI](https://github.com/cpaikr/ytm/actions/runs/34229652522)
  passed the repository gate and declared CLI/Node/Python consumers.
- Independent core and surface fixtures cover 180-date success, numeric and
  null-only data, gaps, partial categories, full-date failures, all search
  boundaries including the 2,000th candidate, invalid inputs, cancellation,
  ordering, counters, export parity, and destination preservation.
- [Synthetic capacity](../docs/history-capacity.md#count-selection): 1,620
  requests for 180 selected dates; 18,000 requests for 2,000 null-only dates.
  Rejected matrices do not accumulate. These are not live-provider guarantees.
- Independent local review and Codex review completed. Both CodeRabbit findings
  were fixed and resolved: shared-limit recovery hints and correct synchronous
  history-close test dispatch. Follow-up tests, pinned Clippy, Python installed
  wheels/typing, and refreshed CI passed. Affected documentation is reconciled.

## Next action

None — implementation and PR delivery complete. This item is no longer active.
