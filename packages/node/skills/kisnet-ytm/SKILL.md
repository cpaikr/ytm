---
name: kisnet-ytm
description: Use when retrieving Korean KIS-NET YTM Matrix rows or listing supported bond kinds through the @sjunepark/ytm Node toolset.
---

# KIS-NET YTM

Import `createKisnetYtmToolset` from `@sjunepark/ytm/toolset`. The package is a
Rust-backed Node SDK and does not declare or distribute a CLI. Publication of
the rewritten package is not yet authorized.

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
import { createKisnetYtmToolset } from "@sjunepark/ytm/toolset";

const toolset = createKisnetYtmToolset();
const validation = toolset.validateInput("matrix", {
  baseDate: "2026-06-08",
  kind: "회사채(사모)"
});
if (!validation.valid) throw validation.error;
const result = await toolset.execute("matrix", validation.normalizedInput);
```
