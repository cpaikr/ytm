---
name: kisnet-ytm
description: "Retrieve Korean KIS-NET YTM Matrix data through the @sjunepark/ytm Node SDK. Use when requests ask for KIS-NET bond yields for a date, yield history over dates or the latest N observations, or supported bond kinds. Excludes general yield-to-maturity calculations, investment advice, other data providers, and repository maintenance. Excludes standalone CLI tasks."
---

# KIS-NET YTM

Import `YtmClient` and the operation-specific validation helpers from
`@sjunepark/ytm`. The package is a Rust-backed Node SDK and does not declare or
distribute a CLI. This is a private development package; the release pipeline
does not publish it to npm.

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
- Date fallback runs only after confirmed unavailable data. Eligible transient
  transport failures retry within bounded attempt and retrieval budgets;
  exhausted transport failures, protocol failures, and source-format failures
  abort retrieval rather than selecting an earlier date.
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
