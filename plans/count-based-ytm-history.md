# Count-based YTM history

## Outcome

Allow users to request the most recent N distinct dates containing yield data,
so a request for 180 returns 180 observation dates rather than 180 calendar
days. Support this selection through the Rust, Node, and Python SDKs and the
CLI, including existing JSON, CSV, TSV, and Excel outputs.

The user explicitly wants dates, not separately sized or aligned series, and
expects missingness across maturities to be uncommon. The implementation rule
is therefore date-level: one numeric yield anywhere in the day's full history
data qualifies the date. Preserve individual missing values and unavailable
categories; do not imply that every series has N numeric observations.

## Current state

Implementation active under [the goal contract](../goals/count-based-ytm-history.md). One connected PR targets `codex/count-history-integration`; release work remains queued and excluded.

Repository evidence:

- [The current history contract](../SPEC.md#multi-date-history) accepts explicit
  dates or an inclusive range, capped at 2,000 calendar dates. It retrieves all
  categories, pricing groups, and tenors without series filters.
- `crates/ytm-core/src/model.rs` materializes sorted dates in `DateSelection`;
  `HistoryRequest` is the common wire input for CLI and native SDK adapters.
- `crates/ytm-core/src/service.rs` orchestrates history, distinguishes source
  unavailability from operational errors, and preserves per-category outcomes.
  Its existing cache eviction assumes ascending traversal.
- Existing `availableCount` and `unavailableCount` count date/category pairs;
  `dataRowCount` counts pricing-group rows. None is a valid-date count.
- Previous-available fallback can repeat an observation for several requested
  dates, so it cannot provide the requested distinct-observation guarantee.

## Next action

Push the validated narrow CodeRabbit fixes on [PR #38](https://github.com/cpaikr/ytm/pull/38), close feedback, merge, and persist terminal goal/roadmap metadata.

## Public behavior

### Selection and boundaries

Add a count selection to the existing history operation:

```sh
ytm history --end-date 2026-09-08 --count 180 --format json
ytm history --start-date 2025-01-01 --end-date 2026-09-08 --count 180 --format xlsx --output history.xlsx
```

Node uses `history({ endDate: "2026-09-08", count: 180 })`; Python sync and
async clients use `history(end_date="2026-09-08", count=180)`. Optional start
dates use their existing naming conventions. Rust exposes a validated count
selection through the core's public history API.

- Require an explicit inclusive end date. This keeps results reproducible and
  avoids introducing a timezone-dependent default as part of this feature.
- Without `count`, preserve existing explicit-date and range behavior.
- With `count`, require an integer from 1 through 2,000, an end date, and an
  optional inclusive start date. Reject `baseDates`/`--base-date` together with
  count. Reject missing end dates, invalid dates, reversed bounds, fractional
  values, booleans, zero, negatives, overflow, and duplicate count flags before
  source I/O. Preserve existing wire-type rules rather than coercing strings.
- Inspect dates backward from the end date. A supplied start date is a hard
  boundary: never silently extend the range to satisfy the count.
- Bound the candidate search to 2,000 inclusive calendar days, using the
  existing resource envelope. Reject explicitly supplied ranges exceeding
  that bound. Without a start date, stop after 2,000 inspected dates or at the
  earliest representable date, whichever comes first. A requested count within
  the allowed range can still be unattainable within this search budget.
- Count mode is exact-date only. Accept an omitted fallback or explicit
  `exact`; reject previous-available and any `lookbackDays`. Keep the existing
  1–31-day fallback policy for ordinary history unchanged.

### What counts as a valid date

Fetch the date's complete target catalog and category outcomes using current
history discovery, canonical-category, and live-only-category rules. Count a
date exactly once if at least one normalized yield is numeric in any returned
pricing-group row. Zero and negative numeric yields qualify; null does not.

An empty discovery, entirely unavailable matrices, or rows containing only
null yields do not qualify. Discovery success or nonempty rows alone are not
sufficient. Do not infer availability from weekdays or a holiday calendar.

Once a date qualifies, retain all its category outcomes and all source rows,
including missing cells and unavailable categories. Finish fetching and
validating the entire date before accepting it. A source error in a later
category must still fail the operation even if an earlier category supplied a
numeric yield. Individual series need not contain N numeric values.

Stop immediately after completing the Nth qualifying date; do not fetch older
dates. Return the selected dates oldest first, with existing catalog and row
ordering within each date. Actual and requested observation dates coincide;
every selected matrix has `usedFallback: false`.

### Insufficient data and failures

A successful count request guarantees exactly N selected dates. Reaching the
start boundary, search limit, or date floor first produces a structured
`insufficient_history` error, including when zero qualifying dates exist.

Use the existing error envelope: `expected` identifies the requested count;
`actual` reports the found count, scanned date interval and count, and stop
reason. Give a concrete recovery hint appropriate to the exhausted boundary.
The SDK rejects/raises the normal typed error; the CLI returns runtime exit 1.
Do not return a shorter successful result or publish a partial export. Existing
files must survive a failed count request, including with `--overwrite`.

Transport, protocol, malformed-source, conflicting-catalog, and cancellation
failures retain their original error identities and context. They never become
missing dates or insufficient-history errors. Invalid input keeps CLI exit 2;
existing cancellation and Ctrl-C behavior remains intact.

### Result and export contract

For count results, existing `requestedDates`, `discovery`, and `entries` describe
only the selected qualifying dates. Thus `requestedDates.length === count` on
success. Preserve the existing meanings of all pair and row counters; derive
the date count from `requestedDates` rather than redefining `availableCount`.

Add one optional `countSelection` object to the history result, omitted for
ordinary date/range requests. It records requested `count`, `endDate`, optional
user-supplied `startDate`, actual `scannedStartDate`, and `scannedDateCount`.
The scan is contiguous and inclusive, so these fields and selected dates make
the skipped dates derivable without retaining every discarded matrix or adding
a second results collection. Document that missing cells can remain.

- JSON/SDK results expose the selection metadata and retain source provenance.
- CSV/TSV retain current columns and contain only selected-date outcomes,
  including unavailable-category rows within those dates.
- Excel retains `History`, `Availability`, and `Metadata`. The first two cover
  only selected dates; Metadata adds the count-selection fields and selected
  date count. Add the same selection context and date count to count-mode file
  receipts. Ordinary output and receipt shapes remain unchanged.
- Retain existing interactive discovery/fetch-count progress, stderr policy,
  and cancellation scope. The transport-level reporter cannot observe date
  qualification, so do not label started requests as selected dates or add a
  progress observer API for this feature. Results and receipts report the
  completed selection. Keep progress off machine-readable stdout.

## Implementation shape

Keep selection, qualification, bounds, and failure policy in `ytm-core`.
Adapters translate input and output; they do not implement backward searches.

1. Extend the validated selection model to distinguish explicit dates from a
   count search without materializing guessed observation dates. Preserve
   existing public date/range constructors and their callers. Keep methods
   promising an already-known date slice restricted to fixed selections;
   never make `as_dates()` silently return candidate dates for a count search.
   Use the smallest typed integration into `HistoryInput` that preserves those
   contracts, not a second public retrieval operation or compatibility wrapper.
2. Share dated discovery, category fetching, normalization, and outcome
   construction between existing history and the count path. Keep a direct
   backward loop and one day-level qualification predicate. Avoid calling the
   public `history()` recursively for every candidate or duplicating parsing.
3. Preserve ascending fixed-date/fallback traversal and its cache lifetime.
   Count mode needs only the current candidate's transient data and retained
   selected results; it must not reuse ascending-only eviction assumptions or
   retain rejected matrices. Use existing request sequencing, transport limits,
   and cancellation checks; no new speculative prefetch or parallel requests.
4. Collect accepted days newest first, then order whole day groups ascending.
   Never reverse a flat row list, which would reverse category or pricing-group
   ordering. Calculate existing counters over selected outcomes only.
5. Extend the shared request validation, result serialization, error envelope,
   capability/help declarations, and adapter shape checks together. No new
   external dependency, persistent cache, database, or business calendar is
   needed.

Primary integration points:

| Surface | Files or area |
| --- | --- |
| Core model, service, errors, exports | `crates/ytm-core/src/{model,service,error,lib}.rs` |
| CLI flags, validation, receipts | `crates/ytm-cli/src/lib.rs` |
| Tables, Excel, progress, capacity | `crates/ytm-cli/src/{table,xlsx,progress,capacity}.rs` |
| Node types, validation, native bridge | `packages/node/src/{client.js,client.d.ts}`, `crates/ytm-node/src/lib.rs` |
| Python sync/async, immutable models, bridge | `packages/python/src/kisnet_ytm/{client,models,errors}.py`, `crates/ytm-python/src/lib.rs` |
| Behavioral evidence | `crates/ytm-core/tests/history.rs`, `judge/history.mjs`, lifecycle judges, SDK consumers |

## Work and acceptance checklist

- [x] **Contract and fixtures:** update the current specification for the new
  selection, validity predicate, error, metadata, and limits. Add deterministic
  fixtures with numeric, empty, null-only, and partially available dates;
  expected dates and request counts must be independent of the implementation.
- [x] **Core:** implement typed input, exact backward retrieval, date grouping,
  error reporting, and metadata. Exercise the public core API and transport
  fixtures, including stopping at the Nth valid day and bounded memory behavior.
- [x] **SDK parity:** wire Node and Python sync/async inputs and immutable
  results; update type declarations and shape validators. Preserve invalid-input
  rejection, AbortSignal, per-call cancellation, and Python close/drain behavior.
  Update Rust and installed/local SDK consumer checks for old and new inputs.
- [x] **CLI and exports:** implement count parsing/help, progress, receipts,
  tables and Excel metadata. Validate output consistency and atomic publication
  through the existing independent judges and lifecycle harnesses.
- [x] **Review and documentation:** perform one bounded code review, including
  an independent reviewer for the shared public behavior. Resolve material
  findings and reconcile the root/core/Node/Python README and SPEC files,
  capability/help output, bundled Node skill, and capacity documentation where
  affected. Keep historical completed plans historical. Follow applicable
  documentation reconciliation instructions at implementation time.
- [x] **Validation and completion:** run the repository gate once after focused
  checks pass; record actual evidence, limitations, and next action here.
  Remove this item from the active queue only when implementation and required
  checks are complete. PR, release, and live provider qualification are separate
  from this planning request.

Required behavioral cases:

| Scenario | Required evidence |
| --- | --- |
| N=1 and N=180 | Exactly N distinct selected dates; newest possible set; ascending output |
| End date empty, weekend-like gaps, longer outages | Exact backward scan, no copied values or calendar assumptions |
| Validity | Numeric zero/negative qualify; null-only rows do not; partial maturity/category data qualifies and remains intact |
| Full-date retrieval | Later-category source failure aborts, even on the Nth otherwise qualifying date |
| Bounds | Inclusive start/end, one-day range, leap day, 2,000th candidate, representable date floor, oversize rejection |
| Shortfall | Zero or fewer than N valid dates fails with accurate counts, interval, reason, and no published output |
| Input parity | Mixed forms, unsupported fallback/lookback, invalid count types/values, missing end, duplicates rejected before source I/O |
| Ordering and counters | Whole dates ascend; category/row order preserved; pair counts differ correctly from selected-date count |
| Errors and lifecycle | Transport/protocol/format failures remain fatal; cancellation prevents later requests and partial publication |
| Exports | JSON, CSV/TSV, and independently inspected XLSX agree on selected dates, values, nulls, provenance, and metadata |
| Regression | Existing fixed dates, ranges, fallback, matrix/kinds, output shapes, SDK consumers, and cancellation remain valid |
| Capacity | Deterministic 180-date success and 2,000-candidate exhaustion measure requests, elapsed time, and memory; no post-target requests |

Use targeted core tests and the existing SDK/CLI judge suites while developing.
The final uncredentialed gate is `PYO3_PYTHON=<supported interpreter> bun run
validate` as documented in the root README. Synthetic capacity evidence must
not be presented as a measured live-provider latency or quota guarantee.

## Scope and end-state decisions

- Retain ordinary range/list selection and its fallback permanently: they are
  existing public behaviors for different retrieval needs.
- Consolidate source retrieval and normalization in the core; add only the
  selection policy required for date counting.
- Exclude per-series counts, category/tenor filters, complete-case alignment,
  volatility or interest calculations, automatic today defaults, filling missing
  values, partial-success switches, and provider concurrency changes.
- No temporary compatibility mode or migration is planned. Existing consumers
  retain their documented behavior; new count callers opt into the new contract.
- The acceptance matrix covers the count guarantee, retained contracts,
  boundaries, consumers, and errors. No unresolved consequential assumption
  prevents implementation after authorization.

## Execution evidence

- Core targeted history suite passes, including 180 dates and acceptance of the
  2,000th candidate. Node/CLI independent assertions and updated golden
  expectations cover gaps, null-only dates, partial categories, shortfalls,
  cancellation, and JSON/CSV/TSV/XLSX consistency. Existing golden changes are
  limited to count-aware help/recovery wording.
- Python fixture and release-wheel validation and strict typing pass; Node
  consumer typing passes. CLI PTY/redirected cancellation preserves destinations.
- One independent bounded code review found an omitted Node error-code type;
  it was fixed with a consumer assertion. No unresolved findings. Affected
  root/core/Node/Python docs and bundled skill have been reconciled.
- [Capacity evidence](../docs/history-capacity.md#count-selection): 180-date
  success used 1,620 requests; null-only 2,000-candidate exhaustion used 18,000.
  This is synthetic evidence, not live-provider qualification.
- Full `PYO3_PYTHON=/opt/homebrew/bin/python3.13 bun run validate` passed on 2026-09-08, including all repository-required checks. PR delivery remains pending.
- PR #38 passed full cross-platform CI and Codex review. Two CodeRabbit findings are being fixed: shared-constant recovery hints and synchronous count-history close-fixture dispatch.
