# kisnet-ytm

Typed synchronous and asyncio Python clients over the shared Rust YTM core.
This new source API is not published yet; historical PyPI 0.2.0 is a different
implementation. The repository builds portable wheel candidates; installation
from PyPI uses the new API only after a separately authorized release.

The declared target/interpreter matrix is owned by
[`python-targets.json`](../../python-targets.json): conventional CPython
3.11–3.14 on GNU/Linux x64/ARM64 (glibc 2.28+), macOS ARM64 (11.0+), and
Windows x64. The [delivery plan](../../plans/rust-backed-python-sdk.md) tracks
native CI acceptance evidence. Free-threaded and alternative interpreters are
not claimed.

Install an exact candidate wheel without a build toolchain:

```sh
python -m pip install --no-index --no-deps /path/to/kisnet_ytm-<version>-cp311-abi3-<platform>.whl
```

Or build from the repository root with conventional CPython 3.11+ and Rust:

```sh
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install ./packages/python
```

On Windows, activate `.venv\Scripts\Activate.ps1` in PowerShell instead.
Building uses the pinned maturin backend in `pyproject.toml`. An installed wheel
needs no Rust toolchain. `PYO3_PYTHON` selects the interpreter for
`bun run validate:python`, which builds fixture and release wheels and runs
isolated behavior, wheel-integrity failure injection, and strict installed-package
typing checks. CI builds each target twice from fresh native output, requires
identical bytes, and exercises every declared interpreter against the untouched
aggregate. [Release documentation](../../docs/release.md#python-wheels-and-pypi-projection)
owns integrity policy and disabled publication gates.

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
