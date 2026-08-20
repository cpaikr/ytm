---
name: kisnet-ytm
description: Use when answering requests for KIS-NET YTM Matrix or Korean bond yield curves/rates by 기준일/base date and 종류/kind; routes agents to the @sjunepark/ytm CLI/toolset or native kisnet-ytm Python API.
---

# KIS-NET YTM Matrix

Use this skill for KIS-NET YTM Matrix data or Korean bond yield rates by
`기준일`/base date and `종류`/kind.

Use the published `@sjunepark/ytm` CLI for shell-based retrieval. Use the native
`kisnet_ytm` API when working inside Python. Both reproduce the deterministic
KIS-NET mobile Nexacro request directly. Reserve browser inspection for source
diagnosis after both direct package surfaces fail.

## CLI

```sh
npx -y @sjunepark/ytm@0.2.0 kinds --format json
npx -y @sjunepark/ytm@0.2.0 matrix --base-date 2026-06-08 --kind 국채 --format json --pretty
npx -y @sjunepark/ytm@0.2.0 matrix --base-date 2026-06-07 --kind 국채 --fallback previous-available --lookback-days 10 --format json --pretty
```

- Dates accept `YYYY-MM-DD`, `YYYY.MM.DD`, or `YYYYMMDD`.
- Kind accepts a source code or Korean label.
- JSON is the default and is preferred for agent parsing.
- Failures print one JSON object and exit non-zero. Inspect its code and
  recovery metadata before retrying.

## Python

```python
from datetime import date
from kisnet_ytm import fetch_matrix, list_kinds

kinds = list_kinds()
matrix = fetch_matrix(date(2026, 6, 8), "국채")
```

Use `previous_available_days=N` only when the caller explicitly requests the
closest prior available date; `N` must be between `0` and `31`. Python returns
Pydantic models with `Decimal | None` yields and raises typed `YtmError`
subclasses.

## Shared behavior

- Exact-date lookup is the default; never silently substitute a date.
- Previous-available lookup tries earlier calendar dates in order and reports
  the attempted and resolved dates.
- Retry fallback only for confirmed unavailable data. Transport, nonzero
  Nexacro protocol status, and source-format failures stop immediately.
- Report requested and resolved dates, kind, tenors, and rows by
  `적용대상채권`.
- Source `-` or empty yields are null-like in parsed values and preserved in
  raw text.

Known kinds are `10` 국채, `20` 지방채, `30` 특수채, `40` 통안채, `50`
은행채, `60` 기타금융채, and `70` 회사채(무보증). Preserve official Korean
terms when they clarify the source data.

## JavaScript toolset

```js
import { createKisnetYtmToolset } from "@sjunepark/ytm/toolset";

const toolset = createKisnetYtmToolset();
const validation = toolset.validateInput("matrix", {
  baseDate: "2026-06-08",
  kind: "국채"
});
if (!validation.valid) throw validation.error;
const result = await toolset.execute("matrix", validation.normalizedInput);
```
