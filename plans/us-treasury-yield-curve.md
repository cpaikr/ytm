# Add US Treasury yield curve retrieval

Status: active under the [goal contract](../goals/us-treasury-yield-curve.md);
owner decisions D1–D4 accepted 2026-11-26; implementation not started.

## Outcome

Users can retrieve the US Treasury daily par yield curve for one or more base
dates through a dedicated Treasury surface on the Rust SDK, Node SDK, Python
SDK, and CLI, with the same exact/previous-available date semantics, bounded
recovery, timeout, progress, and export guarantees that KIS-NET retrieval has.

KIS-NET and Treasury are separate products behind one core: separate commands,
SDK methods, request and result types, wire contracts, fixtures, and provider
records. Neither reshapes its output to resemble the other. Shared machinery
(date parsing, fallback traversal, transport recovery, retrieval context,
statistics, CLI publication) is reused internally, not exposed as a common
result model.

## Motivation

RCPS and convertible valuation workbooks for US-referenced instruments take the
risk-free curve from the Treasury
[daily par yield curve](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve)
by hand: values are copied per base date, missing tenors are averaged in the
workbook, and the curve feeds a bootstrap sheet. On 2026-11-26 the copied values
for 2025-09-12 and 2025-09-30 matched the Treasury CSV exactly. Retrieval is the
error-prone manual step; tenor filling and bootstrapping remain workbook
valuation-method choices and stay out of this product.

## Observed source facts

Observed 2026-11-26 with plain `curl` (default user agent, no authentication).
These are planning observations; the new wire contract becomes their authority.

| Fact | Observation |
| --- | --- |
| Yearly CSV | `GET /resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv` on `home.treasury.gov` returns `200 text/csv; charset=UTF-8`, about 15–19 KB per year, newest date first, `MM/DD/YYYY` dates. |
| Monthly XML | `.../interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=YYYYMM` returns an Atom/OData feed with typed fields (`NEW_DATE`, `BC_3MONTH`, …). |
| Columns vary by year | 2026: `1 Mo, 1.5 Month, 2 Mo, 3 Mo, 4 Mo, 6 Mo, 1 Yr, 2 Yr, 3 Yr, 5 Yr, 7 Yr, 10 Yr, 20 Yr, 30 Yr`. 2020 lacks `1.5 Month` and `4 Mo`; 2005 also lacks `2 Mo` and `30 Yr`. Header label style is inconsistent (`1.5 Month` vs `Mo`). |
| Units | Percent, two decimals, bond-equivalent par yields (CMT). |
| Absence | Non-business days have no row. Dates after the latest publication have no row. |
| Rights | US federal government work; no automated-use restriction was found, but that is not yet recorded as a qualification decision. |

## Behavior

The [Treasury contract](../SPEC.md#us-treasury-yield-curve) owns implemented
behavior; [`contracts/treasury/openapi.yaml`](../contracts/treasury/openapi.yaml)
owns wire facts. Implementation decisions made under the goal's delegated
authority:

- **Not-yet-published dates:** results expose `latestObservationDate` (the
  newest observation in any file read) instead of a separate unavailable
  reason, because a year file alone cannot distinguish a year-end holiday from
  a date the source has not published yet.
- **Per-attempt ceiling:** 60 seconds for Treasury (KIS-NET keeps 20), since
  uncached yearly files took about 19 seconds to first byte.
- **Statistics:** the shared shape is reused; `scannedDateCount` counts
  requested dates, physical attempts count yearly requests, and the KIS-NET
  discovery and matrix counters stay zero.

## Owner decisions

Accepted by the owner on 2026-11-26.

| ID | Question | Decision |
| --- | --- | --- |
| D1 | Product boundary. [SPEC](../SPEC.md#capability) defines KIS-NET as the only capability, and [ARCHITECTURE](../ARCHITECTURE.md#purpose-and-boundary) places alternate providers outside the boundary. | Amend both to a two-source product with separate surfaces, keeping the repository name. |
| D2 | Wire format: yearly CSV or monthly XML. | Yearly CSV: about 12× fewer requests for history and a smaller parser. Header-label drift is handled by a contract-owned label table that fails closed on unknown headers. |
| D3 | Surface order: all four surfaces in one goal, or core and CLI first. | All four in one goal, delivered as sequential PRs, so that parity never lapses in a release. |
| D4 | Provider qualification for Treasury. | A separate Treasury record under `docs/` states public-domain status, bounded sequential access, and no body retention, and marks the source production-suitable. |

## Delivery slices

All four slices ship together in one PR into `codex/us-treasury-integration`,
as the owner asked for PRs in large chunks; one integration PR then merges the
branch into `main`.

1. **Contract and core:** add `contracts/treasury/openapi.yaml` with fictional
   CSV fixtures and `cases.json`. Add a Treasury source module with strict CSV
   parsing, a header-to-maturity table, a year-file cache, fallback, and public
   Rust types. Add the SPEC and ARCHITECTURE amendments from D1.
2. **CLI:** add `ytm treasury` with parsing, help, JSON/CSV/TSV, an XLSX
   workbook with its own layout and provenance sheet, judge scenarios, and
   exact-binary consumer smoke.
3. **SDKs:** add the Node-API projection and typed facade, and the Python
   sync/async methods with errors, cancellation, and typing.
4. **Acceptance:** bounded live check, provider record, README and CHANGELOG,
   and ROADMAP routing.

## Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| Separation | KIS-NET commands, types, golden outputs, and judge results are unchanged. Treasury types share no public result model with KIS-NET. |
| Parsing | Fixtures cover each historical header set, blank cells, unknown or duplicate headers, malformed dates or numbers, BOM or CRLF variance, and an empty year. Unknown structure fails explicitly. |
| Dates and fallback | Exact, weekend, holiday, cross-year lookback, beyond-latest-publication, and lookback-exhaustion cases. Request captures prove one fetch per year. |
| Recovery and bounds | Existing retry, timeout, cancellation, body-size, and pacing scenarios run against the Treasury origin. Other origins and redirects are rejected. |
| Surfaces | Rust, Node, Python, and CLI produce the same values for the same fixtures. The CLI XLSX opens without repair and preserves typed numbers and provenance. |
| Live | One bounded live retrieval reproduces published values for two known dates, keeping metadata only. |
| Gate | `bun run validate` passes, with bounded review and harmonized docs. |

## Scope boundaries

Excluded: tenor interpolation or KIS-layout output; spread or credit-curve
sources such as FRED high-yield option-adjusted spreads, which carry ICE
licensing terms; bootstrapping, discount factors, or zero curves; real-yield,
bill-rate, or other Treasury datasets; persistence or scheduled collection;
release publication.

## Current state

All four slices are implemented and validated locally: workspace tests,
clippy, doc tests, the external Rust consumer, contract checks, the KIS-NET
judge (only intended help and client-surface goldens changed), the Treasury
judge across CLI, Node, and installed Python, and a bounded live acceptance
recorded in the [provider record](../docs/treasury-provider-qualification.md).
Release notes come from the Conventional Commit at release time.

## Next action

Open the implementation PR into `codex/us-treasury-integration`, address
review, merge, then merge the integration branch into `main`.
