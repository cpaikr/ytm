# `@sjunepark/ytm`

Rust-backed KIS-NET YTM Matrix SDK for Node.js.

This package exports a typed `YtmClient` and uses the shipped platform
Node-API loader internally. It has no `bin` entry or JavaScript CLI; the
standalone `ytm` executable is the Rust/Clap workspace binary in
`crates/ytm-cli`.

Node.js 22 or newer is required. Supported native targets are Linux GNU
x64/ARM64 with glibc 2.28 or newer, macOS ARM64, and Windows x64.

This rewrite has not been published yet. For the current checkout, follow the
root README instead of installing the historical npm `latest` release.

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

`ytm.history({ baseDates: ["2026-06-08", "2026-06-09"] })` or
`ytm.history({ startDate: "2026-06-01", endDate: "2026-06-08" })` retrieves all
categories and pricing groups. Selections normalize, sort, and deduplicate
within the 2,000-entry/day limit. Optional `fallback: "previous-available"`
resolves each pair independently; unavailable pairs remain result entries.
Methods accept `{ signal }` as the second argument for cancellation. See the
[history contract](https://github.com/cpaikr/ytm/blob/main/SPEC.md#multi-date-history)
for complete results and error semantics.

The source is protocol-feasible but not production-qualified. See the
repository [`SPEC.md`](https://github.com/cpaikr/ytm/blob/main/SPEC.md),
[`ARCHITECTURE.md`](https://github.com/cpaikr/ytm/blob/main/ARCHITECTURE.md),
and [provider qualification record](https://github.com/cpaikr/ytm/blob/main/docs/provider-qualification.md)
before high-volume, retained, or redistributed use.
