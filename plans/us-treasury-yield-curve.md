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

## Proposed behavior

- **CLI:** a new `ytm treasury` command with `--base-date <date>...` or
  `--start-date`/`--end-date`, `--fallback previous-available`,
  `--lookback-days`, the existing retry/pacing/timeout/progress controls, and
  `--format json|csv|tsv|xlsx` with the existing publication rules. Existing
  `matrix`, `kinds`, and `history` are unchanged.
- **SDKs:** a dedicated Treasury method and input/result types per surface
  (Rust `TreasuryInput`/`TreasuryCurveResult`, Node `treasuryCurve`, Python
  `treasury_curve`; final names settle in the SPEC change).
- **Result:** per requested date, `requestedBaseDate`, `actualBaseDate`,
  `attemptedDates`, `usedFallback`, and ordered `tenors` of
  `{ label, months, yield, yieldText }`, where `label` is the source header,
  `months` is the parsed maturity, and `yield` is a percent number or `null`.
  Source provenance names the Treasury dataset and the files read.
- **Tenors:** only those the source publishes for that date, ordered by
  maturity. No interpolation, KIS tenor mapping, or derived curves.
- **Fallback:** a missing row in a successfully read year file is confirmed
  absence and may advance previous-available lookup, crossing into the prior
  year's file when needed. A requested date after the source's latest published
  date is reported as unavailable, distinct from a holiday. Transport, format,
  and validation failures stop retrieval as they do for KIS-NET.
- **Requests:** one request per distinct year, cached within the invocation.
  Bounded recovery applies with Treasury's exact origin and path allowlist.

## Owner decisions

Accepted by the owner on 2026-11-26.

| ID | Question | Decision |
| --- | --- | --- |
| D1 | Product boundary. [SPEC](../SPEC.md#capability) defines KIS-NET as the only capability, and [ARCHITECTURE](../ARCHITECTURE.md#purpose-and-boundary) places alternate providers outside the boundary. | Amend both to a two-source product with separate surfaces, keeping the repository name. |
| D2 | Wire format: yearly CSV or monthly XML. | Yearly CSV: about 12× fewer requests for history and a smaller parser. Header-label drift is handled by a contract-owned label table that fails closed on unknown headers. |
| D3 | Surface order: all four surfaces in one goal, or core and CLI first. | All four in one goal, delivered as sequential PRs, so that parity never lapses in a release. |
| D4 | Provider qualification for Treasury. | A separate Treasury record under `docs/` states public-domain status, bounded sequential access, and no body retention, and marks the source production-suitable. |

## Delivery slices

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

## Next action

Start slice 1 on a branch from `codex/us-treasury-integration`: author
`contracts/treasury/openapi.yaml` and fictional fixtures for each observed
header set.
