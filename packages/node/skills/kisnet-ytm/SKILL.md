---
name: kisnet-ytm
description: Use when answering requests for KIS-NET YTM Matrix or Korean bond yield curves/rates by 기준일/base date and 종류/kind; guides agents to run @sjunepark/ytm with npx, bunx, ytm CLI, or the SDK.
---

# KIS-NET YTM Matrix

Use this skill when a user asks for KIS-NET YTM Matrix data, Korean bond yield matrix/rates, or yields for `국채`, `지방채`, `특수채`, `통안채`, `은행채`, `기타금융채`, or `회사채(무보증)` by `기준일`/base date.

Prefer the published `@sjunepark/ytm` CLI when shell access is available. It reproduces the deterministic KIS-NET mobile Nexacro POST shape directly; do not scrape the browser unless the CLI cannot answer the task.

## CLI usage

Use one of these forms:

```sh
npx -y @sjunepark/ytm@0.2.0 --help
npx -y @sjunepark/ytm@0.2.0 kinds --format json
npx -y @sjunepark/ytm@0.2.0 matrix --base-date 2026-06-08 --kind 국채 --format json --pretty
npx -y @sjunepark/ytm@0.2.0 matrix --base-date 2026-06-07 --kind 국채 --fallback previous-available --format json --pretty

bunx @sjunepark/ytm@0.2.0 --help
bunx @sjunepark/ytm@0.2.0 matrix --base-date 2026-06-08 --kind 회사채\(무보증\) --format json --pretty

ytm matrix --base-date 2026-06-08 --kind 10 --format tsv
```

- `matrix` fetches YTM Matrix rows for a `baseDate`/`기준일` and `kind`/`종류`.
- `kinds` lists accepted `kind` codes and Korean labels. Run it when the requested category is ambiguous.
- Accepted date forms are `YYYY-MM-DD`, `YYYY.MM.DD`, and `YYYYMMDD`.
- `kind` accepts either a source code or Korean label.
- Exact-date behavior is the default: if KIS-NET returns no rows, the CLI fails with `source_data_unavailable` instead of silently changing the date.
- Use `--fallback previous-available` only when the user wants the closest prior available date. It tries the requested date first, then walks backward; `--lookback-days` defaults to 10.
- Do not retry fallback after `source_protocol_error`: nonzero Nexacro statuses, including positive warnings, fail closed and preserve `sourceErrorCode` and `sourceErrorMessage`.
- JSON is the default and prints one JSON object. Use JSON for agent parsing; use CSV/TSV only when the user explicitly wants a table/export.
- Failures print one JSON object and exit non-zero. Read `code`, `parameter`, `expected`, `recoveryHint`, and `recoveryAction` before retrying.

Known `종류` values:

| code | name |
| --- | --- |
| 10 | 국채 |
| 20 | 지방채 |
| 30 | 특수채 |
| 40 | 통안채 |
| 50 | 은행채 |
| 60 | 기타금융채 |
| 70 | 회사채(무보증) |

## Result handling

For `matrix`, report `requestedBaseDate`, resolved `baseDate`, `dateResolution.usedFallback`, resolved `kind`, tenor labels, and rows by `적용대상채권`. Numeric yield cells are in `yields`; the raw source text is in `yieldText`. Source `-` cells mean unavailable data and are represented as `null` in `yields`.

Preserve official Korean terms such as `기준일`, `종류`, and `적용대상채권` when they clarify the source data.

## Toolset SDK

For in-process JavaScript/TypeScript integration:

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

The SDK exposes `help()`, `listOperations()`, `getOperation()`, `getCommandHelp()`, `validateInput()`, `execute()`, and `serializeError()`.
