# KIS-NET YTM Matrix Node Surface Spec

`@sjunepark/ytm` provides the `ytm` CLI and the runtime-neutral `./toolset`
SDK. The agent-facing contract is English while source-native terms such as
`기준일`, `종류`, `국채`, and `회사채(사모)` remain unchanged.

The repository's [product contract](https://github.com/sjunepark/ytm/blob/main/SPEC.md),
[wire authority](https://github.com/sjunepark/ytm/blob/main/contracts/kisnet/openapi.yaml), and
[architecture](https://github.com/sjunepark/ytm/blob/main/ARCHITECTURE.md) are normative. This package document
summarizes only the installed Node surface and deliberately does not copy HTTP
or XML details.

## CLI

```sh
ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv] [--pretty]
ytm kinds [--base-date <기준일>] [--format json|csv|tsv] [--pretty]
```

- `baseDate` accepts `YYYY-MM-DD`, `YYYY.MM.DD`, or `YYYYMMDD`.
- `kind` accepts a source code, numeric-looking value, or Korean label.
- Matrix lookup is exact-date unless `previous-available` is requested.
- Previous-available lookup tries the requested date first, then prior calendar
  dates in order. `lookbackDays` defaults to 10 and is limited to 1–31.
- JSON is the default. Success and failure each print exactly one structured
  object to stdout; failures exit nonzero. CSV and TSV are deterministic
  success-only projections.

## Toolset

`@sjunepark/ytm/toolset` exports `createKisnetYtmToolset()` with `help`,
`listOperations`, `getOperation`, `getCommandHelp`, `validateInput`, `execute`,
and `serializeError`.

Discovery, help, schemas, examples, and validation are network-free. Execution
accepts cancellation through `AbortSignal`. The cutover API does not accept a
custom JavaScript fetch implementation; Rust owns all source transport.

Matrix results include `baseDate`, `requestedBaseDate`, `dateResolution`,
`kind`, deterministic `tenors`, normalized `rows`, and `source` metadata.
Missing source yield cells are `null` while their original text and open raw
columns are retained.

Failures preserve structured validation recovery metadata or one of
`source_data_unavailable`, `source_transport_error`, `source_protocol_error`,
and `source_format_error`.

## Kind 80 acceptance

The cutover catalog includes `{ "code": "80", "name": "회사채(사모)" }`.
It remains supported even if live discovery omits it. Code, numeric value,
exact label, and whitespace-normalized label resolve to code 80; the product
does not alias it to code 70 or synthesize results.
