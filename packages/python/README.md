# kisnet-ytm

`kisnet-ytm` provides typed, synchronous Python access to the KIS-NET YTM
Matrix. It requires Python 3.11 or newer and never invokes Node.js or drives a
browser.

Install from PyPI:

```sh
python -m pip install kisnet-ytm
```

## Matrix lookup

```python
from datetime import date

from kisnet_ytm import fetch_matrix

matrix = fetch_matrix(date(2026, 6, 8), "국채")
print(matrix.base_date)
print(matrix.rows[0].yields["10Y"])
```

Exact-date lookup is the default. Pass `previous_available_days=N` only when a
caller explicitly wants the requested date followed by at most `N` earlier
calendar dates. `N` must be between `0` and `31`:

```python
matrix = fetch_matrix(
    date(2026, 6, 7),
    "국채",
    previous_available_days=10,
)

print(matrix.requested_date)
print(matrix.date_resolution.attempted_dates)
print(matrix.date_resolution.used_previous_available)
```

Fallback continues only when KIS-NET confirms that matrix data is unavailable.
Transport, nonzero Nexacro protocol statuses, and source-format errors stop
immediately.

## Kinds and results

```python
from datetime import date

from kisnet_ytm import list_kinds

known_kinds = list_kinds()                 # static known source values
current_kinds = list_kinds(date.today())  # refresh from KIS-NET
```

`fetch_matrix` returns a frozen Pydantic `Matrix` containing `Kind`,
`DateResolution`, and `MatrixRow` models. Dates are `datetime.date` values and
yields are `Decimal | None`. Source `-` and empty yield cells become `None` in
`yields` and remain available in `yield_text`; every row also retains its raw
source columns.

Kinds and tenors are source-compatible strings so KIS-NET can add values
without requiring a package interface change.

## Errors and logging

All public package errors inherit `YtmError`:

- `InvalidInputError`: invalid date, kind, or fallback window
- `DataUnavailableError`: no data for every attempted date; exposes
  `requested_date` and `attempted_dates`
- `SourceTransportError`: request or HTTP failure
- `SourceProtocolError`: nonzero Nexacro `ErrorCode`; exposes the source
  `error_code` and `error_message`
- `SourceFormatError`: malformed XML, missing required columns, or invalid data

The package uses standard-library logging under `kisnet_ytm` and installs no
handlers. It logs request decisions and metadata, never raw response bodies.

## Development

From the repository root:

```sh
uv sync --locked --project packages/python
bun run validate:python
bun run test:python
bun run build:python
```

The regular suite does not use the network. To exercise the public API against
the live KIS-NET service, run:

```sh
bun run test:python:live
```

Live tests default to today's date, `국채`, and a 10-calendar-day fallback. Run
pytest directly with `--live-base-date`, `--live-kind`, or `--live-lookback` to
override those values. The live suite also samples three generated combinations
across recent dates and known kinds; it disables Hypothesis deadlines and
shrinking to keep external traffic bounded.

Offline contract tests use Hypothesis for generated parser, numeric-validation,
and fallback-resolution coverage. They remain fixture-backed and make no network
requests.

The supported Python 3.11-3.14 matrix and clean-wheel import run in CI.
The source distribution also contains the tests and shared contract fixtures.
After extracting it, downstream packagers can run the same locked suite with:

```sh
uv sync --locked
uv run --locked pytest
```
