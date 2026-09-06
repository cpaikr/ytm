# kisnet-ytm

Typed synchronous and asyncio Python clients over the shared Rust YTM core.
This new source API is not published yet; historical PyPI 0.2.0 is a different
implementation. Portable release wheels and PyPI integration remain in progress.

Build from the repository root with conventional CPython 3.11+ and Rust:

```sh
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install ./packages/python
```

On Windows, activate `.venv\Scripts\Activate.ps1` in PowerShell instead.
Building uses the pinned maturin backend in `pyproject.toml`. An installed wheel
needs no Rust toolchain. `PYO3_PYTHON` selects the interpreter for
`bun run validate:python`, which builds fixture and release wheels and runs
isolated behavior and strict installed-package typing checks.

```python
from kisnet_ytm import Client

with Client() as client:
    catalog = client.kinds()  # Offline Rust-owned canonical catalog.
    print(catalog.kinds)
```

```python
import asyncio
from kisnet_ytm import AsyncClient

async def main():
    async with AsyncClient() as client:
        print((await client.kinds()).kinds)

asyncio.run(main())
```

`matrix(base_date="2026-06-08", kind="국채")` makes a source request; all
arguments are keyword-only. `fallback="previous-available"` permits a bounded
search, with optional `lookback_days`. See [the API contract](SPEC.md) for
results, errors, cancellation, and lifecycle behavior. Source availability does
not establish provider authorization or production qualification.
