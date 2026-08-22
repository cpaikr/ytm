---
name: kisnet-ytm
description: Use when retrieving Korean KIS-NET YTM Matrix rows or listing supported bond kinds through the @sjunepark/ytm CLI or toolset.
---

# KIS-NET YTM

Use the Node-only `@sjunepark/ytm` product. Publication of the rewrite is not
yet authorized. In the repository checkout, build once with `bun run build`
and replace `ytm` below with `bun run cli --`. After installation from an
authorized artifact, use the package-provided `ytm` command directly. For an
in-process integration, import `createKisnetYtmToolset` from
`@sjunepark/ytm/toolset`.

These instructions describe the current checkout. The approved migration will
replace the package-provided JavaScript CLI with a standalone Rust/Clap binary
while keeping the Node toolset as a Rust-backed SDK; do not assume that target
is available until the repository documentation marks the migration complete.

```sh
ytm kinds --format json
ytm matrix --base-date 2026-06-08 --kind 국채 --format json --pretty
ytm matrix --base-date 2026-06-07 --kind 80 --fallback previous-available --lookback-days 10 --format json
```

- Dates accept `YYYY-MM-DD`, `YYYY.MM.DD`, or `YYYYMMDD`.
- Kind accepts a source code or Korean label. The canonical catalog includes
  `80` 회사채(사모), distinct from `70` 회사채(무보증).
- Exact-date lookup is the default. Use `previous-available` only when the
  caller authorizes walking backward through calendar dates.
- Retry fallback only after confirmed unavailable data. Transport, protocol,
  and source-format failures stop immediately.
- JSON is the default agent-readable output. Failures are structured JSON;
  inspect their recovery metadata before retrying.
- Report requested and resolved dates, kind, tenors, and rows by 적용대상채권.
  Source `-` or empty yields become `null` while raw text remains available.

```js
import { createKisnetYtmToolset } from "@sjunepark/ytm/toolset";

const toolset = createKisnetYtmToolset();
const validation = toolset.validateInput("matrix", {
  baseDate: "2026-06-08",
  kind: "회사채(사모)"
});
if (!validation.valid) throw validation.error;
const result = await toolset.execute("matrix", validation.normalizedInput);
```
