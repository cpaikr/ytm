---
name: kisnet-ytm
description: Use when retrieving Korean KIS-NET YTM Matrix rows or listing supported bond kinds through the @sjunepark/ytm Node SDK.
---

# KIS-NET YTM

Import `YtmClient` and the operation-specific validation helpers from
`@sjunepark/ytm`. The package is a Rust-backed Node SDK and does not declare or
distribute a CLI. Publication of the rewritten package is not yet authorized.

- For the latest N observation dates, use `history({ count: N, endDate: "YYYY-MM-DD" })`,
  with optional inclusive `startDate`. Count is 1–2000; the exact backward scan
  stops within 2000 calendar days. Do not combine count with a date list or
  previous-available fallback. A shortfall raises `insufficient_history`.
- A numeric yield anywhere qualifies a date; missing cells may remain. Report
  `requestedDates.length` as the selected date count and preserve `countSelection`.
  `availableCount` counts date/category pairs, not dates.
- Dates accept `YYYY-MM-DD`, `YYYY.MM.DD`, or `YYYYMMDD`.
- Kind accepts a source code or Korean label. The canonical catalog includes
  `80` 회사채(사모), distinct from `70` 회사채(무보증).
- Exact-date lookup is the default. Use `previous-available` only when the
  caller authorizes walking backward through calendar dates.
- Retry fallback only after confirmed unavailable data. Transport, protocol,
  and source-format failures stop immediately.
- Failures expose structured recovery metadata; inspect it before retrying.
- Report requested and resolved dates, kind, tenors, and rows by 적용대상채권.
  Source `-` or empty yields become `null` while raw text remains available.

```js
import { YtmClient, validateMatrixInput } from "@sjunepark/ytm";

const client = new YtmClient();
const validation = validateMatrixInput({
  baseDate: "2026-06-08",
  kind: "회사채(사모)"
});
if (!validation.ok) throw validation.error;
const result = await client.matrix(validation.input);
```
