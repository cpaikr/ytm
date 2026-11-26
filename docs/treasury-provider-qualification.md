# US Treasury provider qualification

## Decision

Status: **production-suitable for bounded use**, decided by the owner on
2026-11-26 (plan decision D4).

The daily par yield curve is published by the US Department of the Treasury.
Works of the US federal government are not subject to US copyright, and no
automated-use restriction was found for the yearly CSV download. The project
uses it within the bounds below; this record does not cover other Treasury
datasets or sustained bulk collection.

This decision is separate from KIS-NET, whose
[qualification](provider-qualification.md) remains not production-qualified.

## Operating bounds

- One GET per calendar year read in an invocation, sequential, with the shared
  bounded retry and pacing policy and no redirects or proxies.
- At most 2,000 requested dates per call, and at most eight yearly files
  including fallback into a prior year. Fixed lists that would touch more
  years are rejected before any request.
- No retained response bodies, rows, or yields in the repository or evidence;
  live checks record metadata only.
- Stop and revisit this decision if Treasury publishes terms restricting
  automated access, returns sustained 403/429 responses, or changes the CSV
  shape so that the strict parser rejects published files.

## Evidence ledger

| Classification | Evidence |
| --- | --- |
| Observed | 2026-11-26: yearly CSV files for 1989–2027 returned HTTP 200 `text/csv; charset=UTF-8` without authentication. 1989 and 2027 returned empty bodies; 1990–2026 contained one row per published business day. |
| Observed | Uncached yearly files took about 19 seconds to first byte; recently requested years returned in under a second. |
| Observed | All 39 downloaded files parse under the contract's strict profile: seven header sets, 14 distinct tenor labels, LF line endings, no BOM, blank cells in nine years, and no non-numeric values. |
| Observed | Values for 2025-09-12 and 2025-09-30 match those used in an existing valuation workbook exactly. |
| Project decision | Wire facts live only in [`contracts/treasury/openapi.yaml`](../contracts/treasury/openapi.yaml); fixtures are fictional. |
| Project decision | The per-attempt ceiling is 60 seconds; the retrieval timeout, retries, and pacing follow the shared [recovery contract](../SPEC.md#bounded-retrieval-recovery). |

## Live verification

The product CLI (debug build, default HTTP transport) ran one bounded live
retrieval on 2026-11-26 for 2025-01-01, 2025-09-12, 2025-09-30, and 2026-11-26
with `previous-available` and a 5-day lookback. All four dates resolved:
2025-01-01 fell back across the year boundary to 2024-12-31 (13 tenors, the
2024 column set), the two September dates resolved exactly (14 tenors), and
2026-11-26 fell back to 2026-11-25, the reported `latestObservationDate`. It
read three yearly files (2024: 250, 2025: 249, 2026: 226 observations) with
three physical attempts, no retries, in about 5 seconds. Only this metadata
was retained.
