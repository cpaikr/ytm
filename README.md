# KIS-NET YTM

Language-native access to the KIS-NET YTM Matrix, with exact-date lookup by
default and explicit previous-available date resolution.

## Packages

- [`@sjunepark/ytm`](packages/node): Node.js 20.18.1+ CLI and runtime-neutral
  toolset SDK
- [`kisnet-ytm`](packages/python): typed, synchronous Python 3.11+ API that does
  not invoke Node.js

Both packages send the same deterministic Nexacro requests and share fixtures
for source parsing, missing values, unavailable dates, protocol statuses,
fallback order, and failure classification. Their language-specific result
shapes are documented in [SPEC.md](SPEC.md).

## Quick start

Node CLI:

```sh
npx -y @sjunepark/ytm matrix --base-date 2026-06-08 --kind 국채 --format json
```

Python:

```python
from datetime import date
from kisnet_ytm import fetch_matrix

matrix = fetch_matrix(date(2026, 6, 8), "국채")
print(matrix.rows[0].yields["10Y"])
```

Current releases are available on
[npm](https://www.npmjs.com/package/@sjunepark/ytm) and
[PyPI](https://pypi.org/project/kisnet-ytm/).

## Repository validation

```sh
bun install --frozen-lockfile
uv sync --locked --project packages/python
bun run validate
bun run test
bun run build
bun run pack:node
bun run pack:python
```

Live KIS-NET smoke checks are scheduled and manually dispatchable rather than
pull-request gates. See [docs/release.md](docs/release.md) for the lockstep
release flow and publisher configuration.
