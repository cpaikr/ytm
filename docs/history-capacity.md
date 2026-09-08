# History capacity verification

Measured on 2026-09-07 using synthetic data on macOS arm64, 16 GB RAM,
Rust 1.92 debug builds. This is resource evidence for the 2,000-date input
bound, not live-source throughput or historical coverage. Provider qualification
remains in [its separate record](provider-qualification.md).

## Workloads and results

Every requested date has eight canonical categories, ten rows per category,
and fifteen numeric tenors. Sparse data exists only on the first of each month;
31-day previous-available lookup reuses those observations across requested dates.
All runs completed without truncation or swap. Peak RSS is the process-wide
maximum from macOS `/usr/bin/time -l`; it includes result and export allocations.

| Workload | Dates | Pairs | Data rows | Physical requests | Retrieval ms | Core JSON ms / bytes | XLSX ms / bytes | Peak RSS bytes |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| Month | 31 | 248 | 2,480 | 279 | 480 | 67 / 2,050,201 | 651 / 213,184 | 53,329,920 |
| Three years | 1,096 | 8,768 | 87,680 | 9,864 | 16,838 | 2,381 / 72,479,718 | 24,739 / 7,403,792 | 1,335,902,208 |
| Input limit | 2,000 | 16,000 | 160,000 | 18,000 | 42,540 | 4,607 / 132,262,144 | 44,511 / 13,587,568 | 2,193,014,784 |
| Sparse three years | 1,096 | 8,768 | 87,680 | 9,864 | 2,110 | 2,760 / 74,273,292 | 28,184 / 9,327,075 | 1,537,425,408 |

The separate CLI JSON runs include its actual result-to-JSON-value conversion,
number normalization and envelope serialization, rather than only core serde:

| Dates | Retrieval ms | CLI serialization ms | JSON bytes | Peak RSS bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1,096 | 16,970 | 12,268 | 72,479,762 | 2,295,709,696 |
| 2,000 | 30,736 | 23,005 | 132,262,188 | 2,739,224,576 |

The existing in-memory design completes the measured multi-year workload on
this host. Returned rows remain proportional to requested-date mappings even
when fallback reuses source fetches. The cache retains only the active lookback
window, but the complete result, JSON projection and workbook still require
memory proportional to output size. Ten rows per category is a stated synthetic
sample, not a bound on provider row counts. Large real results can consume more
memory or exceed Excel dimensions; request smaller ranges when necessary.

## Count selection

Measured on 2026-09-08 on the same macOS ARM64 host with Rust 1.92 debug
builds. Each candidate returns eight categories and ten rows per category.
The success fixture has numeric yields on every date; exhaustion returns
null-only rows on every date. The tests assert exact request counts and no
post-target requests.

| Workload | Scanned dates | Selected dates | Physical requests | Retrieval ms | Peak RSS bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Count 180 | 180 | 180 | 1,620 | 2,641 | 128,172,032 |
| Count 180, null-only exhaustion | 2,000 | 0 (error) | 18,000 | 28,006 | 12,533,760 |

Neither run swapped. Rejected matrices are dropped per candidate; retained
memory grows with selected output, rather than the entire scanned history.
These synthetic measurements establish no live-provider latency or quota guarantee.
Run the built CLI test binary with `capacity::count_success --ignored --nocapture`
or `capacity::count_exhaustion --ignored --nocapture` under `/usr/bin/time -l`.

## Reproduction and acceptance

The ignored `capacity::measure` CLI test uses a generated public `Transport` and
asserts counts and physical request reuse. Run a built test binary under
`/usr/bin/time -l`, selecting its path from `cargo test -p ytm-cli --lib --no-run`:

```sh
YTM_CAPACITY_END=2020-01-31 /usr/bin/time -l <test-binary> capacity::measure --ignored --nocapture
YTM_CAPACITY_END=2022-12-31 /usr/bin/time -l <test-binary> capacity::measure --ignored --nocapture
YTM_CAPACITY_END=2025-06-22 /usr/bin/time -l <test-binary> capacity::measure --ignored --nocapture
YTM_CAPACITY_SPARSE=1 /usr/bin/time -l <test-binary> capacity::measure --ignored --nocapture
YTM_CAPACITY_CLI_JSON=1 /usr/bin/time -l <test-binary> capacity::measure --ignored --nocapture
```

A delayed transport test cancelled a 200 ms request after 30 ms with measured
292 microseconds completion latency and no second request. The executable
[CLI lifecycle acceptance](../judge/history-cli-lifecycle.py) waits for a real
fixture request before SIGINT: fatal JSON on stdout, progress only on terminal
stderr, no subsequent requests, unchanged destination and no staging residue.
POSIX signal checks are skipped on Windows; portable export checks still run.
The transport regression asserts that the cancellation branch ran and reports
latency diagnostically, avoiding a scheduler-sensitive wall-clock pass threshold.

Excel application QA used a two-date synthetic workbook with 15 available pairs
and one unavailable pair. Excel opened all three visible sheets without repair;
filtering Availability to unavailable showed exactly one of sixteen records.
Navigating to V50 retained the History header and seven identity columns.
Korean labels, literal `=한글`, leading-zero code `001`, numeric yields, integer
row counts and Metadata provenance were visible and readable. Automated OOXML
checks independently compare complete workbook cells with JSON results, including
all-unavailable and fallback cases; application QA complements those checks.
