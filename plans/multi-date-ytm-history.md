# Multi-date YTM history and Excel export

Status: active — implementation authorized by goals/multi-date-ytm-history.md.

## Outcome

Users can retrieve all YTM categories and pricing-group rows for selected
dates or an inclusive daily date range through the Rust, Node, and Python SDKs
and the standalone CLI. The CLI can save the combined history as a filterable
Excel workbook. Users do not have to spell rating or pricing-group selectors
correctly; source labels and codes remain available for downstream filtering.

The primary workload is daily history over months or a few years. Exact-date
retrieval keeps available observations and explicitly accounts for unavailable
date/category combinations. Previous-available lookup is opt-in and always
exposes the actual observation date.

## Current state

The feature branch implements history across Rust, Node, Python sync/async and
CLI, with three-sheet Excel export. Independent history/regression scenarios,
installed Python consumers, Rust consumers, strict Node type checks, actual CLI
interrupt/file-safety checks and Excel filter/freeze QA passed. Bounded review
findings were fixed; the full repository gate passed.

[SPEC](../SPEC.md) owns the implemented behavior and
[architecture](../ARCHITECTURE.md) owns retrieval structure.
[Capacity evidence](../docs/history-capacity.md) records monthly, three-year,
maximum-lookback and 2,000-date workloads, including full CLI JSON allocation.
The feature is not delivered until PR feedback, native CI and the dev merge
finish. No production provider enablement or release publication is included.

The sections below retain the accepted scope and acceptance criteria. The
completion checklist and next action own the remaining delivery work.

## Confirmed scope and design decisions

The user confirmed both date-list and inclusive-range selection, retrieval in
the CLI and all three SDKs, keeping available data with explicit missing-data
reporting, optional previous-date fallback, and a combined Excel table.

The following implementation decisions make that scope concrete:

- Add an additive `history` operation. Preserve the existing `matrix` and
  `kinds` input, output, error, and workbook contracts.
- History always retrieves all canonical categories plus dated live additions,
  including all returned pricing groups and maturities. Do not add kind,
  rating, tenor, fuzzy-match, or free-text filtering in this feature.
- Sort normalized unique requested dates chronologically; preserve catalog
  order within each date and source row order within each category.
- Model confirmed unavailability as an ordinary history outcome. Transport,
  protocol, malformed-source, cancellation, and internal failures remain
  operation failures; they must never become missing-data rows.
- Apply optional fallback independently to each requested date/category pair.
  A combined result may therefore contain different actual dates. It is not
  a guarantee that all categories share one market-date snapshot.
- Keep retrieval orchestration in the core and workbook generation in the CLI.
  Reuse existing private seams rather than introducing a generic job system.

These accepted choices are implemented; delivery validation remains below.

## Public behavior

### Date selection

Accept exactly one selection form: a nonempty list of dates, or a start/end
range with both bounds present. Reuse the existing accepted date spellings and
calendar validation, normalize to ISO dates, reject reversed ranges and mixed
selection forms, and reject invalid inputs before any source request.

Range expansion includes every calendar day and both endpoints. Do not guess
holidays or silently exclude weekends. Repeated list entries coalesce after
normalization. A one-date history request remains valid.

The maximum is 2,000 raw list entries before deduplication or 2,000 inclusive
range days per invocation, sufficient for several years of daily history. Validate range length before expansion and
bound raw list input before allocating a large normalized collection. Publish
the limit through capabilities, help, SDK documentation, and consistent errors.
This is a product resource bound, not a claim about provider quotas or historical
availability. The synthetic capacity evidence verifies this bound for the stated sample; an
evidence-driven change must update this plan and the public contract together.

### What “all” includes

Discover the merged catalog for each requested date. Canonical categories
remain included even when omitted by live initialization; specifically,
`80` / 회사채(사모) remains distinct from `70` / 회사채(무보증). Include live-only
codes in their source order after canonical entries. Preserve existing conflict
validation rather than accepting inconsistent labels for the same code.

Use each requested date's catalog to define the pairs that need outcomes.
Do not infer that the whole date is missing from an empty individual category,
or infer that an omitted canonical category should not be requested.
Do not construct a cross-date Cartesian product that invents historical
membership for live-only categories seen on other dates.

Empty initialization is a confirmed discovery-unavailable outcome in the
current core. For that requested date, use the canonical catalog as the known
target set, explicitly record that dated discovery was unavailable, and do not
claim coverage of unknown live-only categories. Exact mode marks those pairs
unavailable at the discovery stage without issuing matrix requests. Optional
fallback may search earlier dates for those canonical targets. An empty
candidate-date initialization likewise advances fallback without matrix
requests; malformed or failed initialization remains fatal. Live-only kinds
found exclusively on fallback dates do not expand the requested target set.

Return every source row with its identity, numeric yields, original yield text,
and raw normalized columns in SDK/JSON results. Preserve source labels rather
than inventing a rating taxonomy or renaming groups. “All” refers to YTM Matrix
categories and rows, not other provider products or individual bond records.

### Availability and fallback

Each requested date/category pair has exactly one tagged outcome:

- `available`: the existing matrix observation content, including requested
  date, actual date, category, rows, tenors, resolution details, and source.
- `unavailable`: requested date, category, attempted dates, fallback policy,
  and the established unavailable-data reason; no fabricated yield rows.

Use a discriminated result type so an unavailable entry cannot accidentally
contain a successful matrix. The outer result includes normalized requested
dates, ordered entries, and explicit available/unavailable pair counts. Counts
describe pairs, not rows; the data-row count is separate. A date's status can be
derived from its entries without maintaining a second conflicting status list.
Record requested-date catalog availability separately from observation
availability: successful fallback observations do not prove that discovery
succeeded on the requested date. Expose this distinction in JSON/SDK results
and workbook provenance, and carry a discovery-stage reason in unavailable
text rows.

Exact mode attempts only the requested date. Previous-available mode follows
the current bounded calendar lookback policy and advances only on confirmed
empty source data, including unavailable discovery. Keep the same category
code throughout fallback. Catalog omission on an earlier date does not
authorize changing that code; a category
validated on the requested date can be fetched by its resolved code. Still
validate every fetched candidate-date catalog for source conflicts.

Two requested dates resolving to one observation remain two explicit outcomes,
with both requested dates preserved. Reuse the underlying fetch within the
invocation, but do not erase either request or relabel an earlier yield as an
exact-date observation. Preserve each pair's logical attempted-date sequence
even when a lookup is satisfied from invocation-local reuse.

If all pairs are unavailable, return a completed history result with no yield
rows and a complete availability report. Missing data alone is not a fatal
operation error. A whole-call failure stops further requests and prevents
workbook publication; include the failed requested date/category and attempted
date context in its structured error. Do not return a misleading successful
partial batch after an operational failure. Partial recovery/checkpointing is
outside this feature.

### CLI and SDK surfaces

Planned CLI syntax:

```sh
ytm history --base-date 2025-12-31 --base-date 2026-06-30 --format json
ytm history --start-date 2024-01-01 --end-date 2026-06-30 --format xlsx --output history.xlsx
ytm history --base-date 2026-06-07 --fallback previous-available --lookback-days 10 --format json
```

Repeated `--base-date` is intentional for `history` only. Preserve duplicate-flag
validation in existing commands. Expose JSON, CSV, TSV, and XLSX on history;
retain the current `--output`, `--overwrite`, and `--pretty` format rules.
Help must work without execution inputs and without network access.

JSON and SDK results carry the complete tagged entries. CSV/TSV use a shared
history table with an `availability` column: available rows contain yields;
each unavailable pair contributes one clearly tagged row with blank yields and
no pricing-group identity. This keeps missingness visible even when text output
is redirected without stderr. A blank yield in an available row remains a
missing tenor value, not an unavailable observation.

CLI exit status is 0 for a fully executed history operation, including reported
unavailability; fatal retrieval, cancellation, export, and output failures use
nonzero status. XLSX receipts include data-row and available/unavailable pair
counts so saved output cannot be mistaken for complete coverage. Use stderr
for concise periodic date/pair progress during interactive CLI retrieval;
stdout remains exclusively the selected output or final receipt. Do not log
source bodies or yields. Avoid a public event/callback subsystem for this need.

Rust exposes typed date selection, history inputs, outcomes, and cancellation
through the public crate root. Node adds typed input validation, result types,
and `history()` with the existing `AbortSignal` behavior. Python adds equivalent
immutable models and `history()` to both `Client` and `AsyncClient`, preserving
close/drain and per-call cancellation semantics. Boundary validation handles
language shapes; the core owns domain rules and date expansion. No adapter
implements its own per-date loop or source policy.

### Excel workbook

History workbooks contain three visible sheets:

1. `History`: available yield rows combined across all dates/categories. Use
   the existing matrix identity columns followed by maturity columns. Freeze
   the header and identity columns, enable filters, and retain readable widths.
2. `Availability`: one row per requested date/category, including status,
   actual date when available, fallback flag, row count, and missing-data reason.
   An all-unavailable request still produces this populated report and a
   header-only `History` sheet.
3. `Metadata`: selection, normalized dates, fallback settings, summary counts,
   and per-pair source/resolution provenance, including ordered attempted dates.

Requested dates and actual dates remain explicit ISO text; codes remain text
with leading zeros preserved; yields remain unscaled numeric cells using the
existing `0.000` display; absent yields stay blank. Preserve Korean labels and
literal formula-like strings. Do not add formulas, charts, macros, external
links, pivot tables, or one worksheet per date/category.

History CSV/TSV and XLSX share the typed projection for successful rows; the
text availability rows and workbook availability sheet are format-specific
presentations of the same outcomes. Reuse the existing workbook writer and
safe publication path. Existing single-matrix and kinds workbooks retain their
exact two-sheet contract.

Preflight the destination before source work. Validate every sheet's dimensions
and cell limits, render completely, and then publish from same-directory staging
with the existing overwrite protections. An oversized workbook fails clearly
without truncation or replacing the destination; tell callers to request smaller
date ranges. Do not silently split workbooks or implement append/update.

## Acceptance and validation

| Requirement | Required evidence |
| --- | --- |
| Dates | Valid spellings, deduplication, ordering, inclusive leap-day ranges, one-date range, empty/mixed/reversed/oversized selection; invalid input makes zero requests. |
| All categories | Canonical omissions including code 80, live additions varying by date, empty requested/candidate discovery, explicit unknown catalog coverage, label conflicts, all source rows/tenors, and unchanged codes/labels/raw values. |
| Missing data | Available, partially unavailable, and all-unavailable histories; missing category differs from a missing tenor; pair counts and table/workbook coverage agree. |
| Fallback | Opt-in only, bounded calendar attempts, category never substituted, mixed actual dates explicit, repeated resolved observation retains every requested-date mapping, exhaustion reported unavailable. |
| Fatal failure | Transport, protocol, malformed source, date-boundary underflow, cancellation, and export failure cannot become missing-data success; no later requests or partial workbook publication. |
| Request reuse | One catalog fetch per visited date and at most one successful/empty fetch per date/code; adjacent fallback requests reuse observations without corrupting provenance. |
| SDK parity | External Rust consumer, Node judge/type checks, installed Python sync/async consumer and immutable models; validation and cancellation retain existing ergonomics. |
| CLI | Help, repeated history dates, format rules, machine-readable stdout, progress on stderr, receipts, missing-data exit 0, fatal nonzero statuses. |
| Excel | Independent XML/ZIP comparison with JSON, three history sheets, numeric fidelity, literal strings, filters/freeze panes, all-unavailable export, limits and file safety; synthetic Excel application QA. |
| Regression | Existing matrix/kinds SDK, CLI, fallback, two-sheet workbooks, packaging, and release fixture guards remain valid. |
| Capacity | Synthetic monthly/three-year daily and limit-boundary workloads; measured requests, time, memory, file sizes, and cancellation; no live bulk test needed. |

Use focused core/adapter/judge checks while implementing, then the documented
`PYO3_PYTHON=<supported interpreter> bun run validate` repository gate. Use the
existing Platform compatibility workflow for the supported native targets and
installed SDK consumers when delivery is authorized. Do not add fixture
transport to release artifacts merely to test history on installed binaries.

## Compatibility, exclusions, and operational boundary

Retain permanently: the single-matrix API, canonical category policy, strict
source parsing, fallback-only-on-empty rule, cancellation semantics, sequential
transport, typed output fidelity, and safe workbook publication. They have
existing public contracts and consumers; this feature does not replace them.

Consolidate private fetch and table behavior where history needs the same rules.
Do not add independent adapter loops, repeated per-pair initialization, a second
parser, a local rating vocabulary, or a separate workbook publication path.
No temporary compatibility layer or migration is required for an additive
operation; no existing persisted data is changed.

Out of scope: server/UI development, selectable ratings/categories, provider
switching, persistent cache/database, durable jobs, checkpoints/resume,
background schedules, parallel source requests, automatic retries, workbook
append/update, SDK workbook-writing dependencies, publication, and production
provider enablement. A failed long run can be rerun as smaller explicit ranges;
automatic partial-output recovery is not promised.

Provider qualification and historical coverage remain unresolved external
facts, tracked by the existing
[provider enablement task](../tasks/resolve-production-provider-enablement.md)
and [qualification record](../docs/provider-qualification.md). Implementation
and capacity checks use synthetic data. Supporting a multi-year input range
does not establish provider permission, pacing entitlement, or available
historical coverage. Keep that existing task separate; this plan does not
schedule a live backfill or change the monitoring/retention policy.

## Completion checklist

- [x] Additive history contract and independent fixtures.
- [x] Core orchestration, typed outcomes, request reuse, and cancellation.
- [x] Rust, Node, Python sync/async, and CLI retrieval parity.
- [x] Combined Excel workbook, availability/provenance, and file safety.
- [x] Capacity measurements and public input/resource limits verified.
- [x] Focused checks, full repository gate, bounded review, and affected docs.
- [ ] Authorized delivery validation and truthful final planning state.

## Next action

Deliver one feature PR to dev with initial
CodeRabbit review, complete feedback intake, native compatibility checks and a
merge preserving commits. Record terminal planning metadata on dev after merge.
Production enablement and release publication remain excluded.
