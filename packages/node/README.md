# `@sjunepark/ytm`

Rust-backed KIS-NET YTM Matrix SDK for Node.js.

This package exports a typed `YtmClient` and uses the shipped platform
Node-API loader internally. It has no `bin` entry or JavaScript CLI; the
standalone `ytm` executable is the Rust/Clap workspace binary in
`crates/ytm-cli`.

Node.js 22 or newer is required. Supported native targets are Linux GNU
x64/ARM64 with glibc 2.28 or newer, macOS ARM64, and Windows x64.

This package and its native packages are private development packages. The
release pipeline publishes only the standalone CLI. Follow the root README
for local use; historical npm releases expose an earlier implementation.

```js
import { YtmClient, validateMatrixInput } from "@sjunepark/ytm";

const ytm = new YtmClient();
const validation = validateMatrixInput({
  baseDate: "2026-06-08",
  kind: "국채"
});
if (!validation.ok) throw validation.error;
const result = await ytm.matrix(validation.input);
```

`validateHistoryInput()`, `validateMatrixInput()`, and `validateKindsInput()` return either
`{ ok: true, input }` or `{ ok: false, error }` without network I/O. `YtmError`
and `serializeYtmError()` preserve stable `name` and `message` fields alongside
the source `code`, `reason`, and tagged `recoveryAction`.

`ytm.history({ count: 180, endDate: "2026-09-08" })` returns the latest 180
distinct dates containing numeric yields, with optional inclusive `startDate`.
Missing cells can remain. Count mode is exact-only and fails with
`insufficient_history` if its bounded scan cannot satisfy the count.
`countSelection` records the scan; ordinary results omit it.

`ytm.history({ baseDates: ["2026-06-08", "2026-06-09"] })` or
`ytm.history({ startDate: "2026-06-01", endDate: "2026-06-08" })` retrieves all
categories and pricing groups. Selections normalize, sort, and deduplicate
within the 2,000-entry/day limit. Optional `fallback: "previous-available"`
resolves each pair independently; unavailable pairs remain result entries.
Methods accept execution options as the second argument:

```js
import { RetrievalProgress } from "@sjunepark/ytm";
const progress = new RetrievalProgress();
const pending = ytm.history({ count: 180, endDate: "2026-09-08" }, {
  maxRetries: 4, baseBackoffMs: 500, maxBackoffMs: 2_000,
  minRequestIntervalMs: 100, progress
});
// Read progress.snapshot() from your application's timer while pending.
const history = await pending;
console.log(history.statistics);
```

`progress.snapshot()` returns `null` before retrieval starts, then a
detached latest snapshot. Use a fresh handle for each call. Updates coalesce
and no callback executes inside retrieval. Every successful call returns final
`statistics`; retrieval errors retain them in `details.statistics`.
Options also accept `signal` and `operationTimeoutMs`.
`operationTimeoutMs` must be a positive safe integer; omission uses the core's
30-minute retrieval timeout. For example, `{ operationTimeoutMs: 3_600_000 }`
permits an hour. Optional typed `error.details.retry` retains physical attempt
count and stop reason. See [bounded recovery and compatibility](https://github.com/cpaikr/ytm/blob/main/SPEC.md#bounded-retrieval-recovery)
for retry eligibility and the shared timeout boundary. See the
[history contract](https://github.com/cpaikr/ytm/blob/main/SPEC.md#multi-date-history)
for complete results and error semantics.

The source is protocol-feasible but not production-qualified. See the
repository [`SPEC.md`](https://github.com/cpaikr/ytm/blob/main/SPEC.md),
[`ARCHITECTURE.md`](https://github.com/cpaikr/ytm/blob/main/ARCHITECTURE.md),
and [provider qualification record](https://github.com/cpaikr/ytm/blob/main/docs/provider-qualification.md)
before high-volume, retained, or redistributed use.
