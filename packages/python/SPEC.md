# Python API

The `kisnet_ytm` import is the typed Python facade for the Rust core. Distribution
name: `kisnet-ytm`. This replaces the historical Python API without compatibility
aliases. This source is not yet published; installed historical 0.2.0 packages
have a different API.

## Calls and values

`Client` is synchronous; `AsyncClient` exposes the same operations as coroutines:

- `matrix(*, base_date: str, kind: str | int, fallback: Literal["exact",
  "previous-available"] = "exact", lookback_days: int | None = None)` returns
  `MatrixResult`.
- `kinds(*, base_date: str | None = None)` returns `KindsResult`. Omitting the
  date returns the Rust-owned canonical catalog without network access.

Arguments are keyword-only. Python checks call shapes (including rejecting
booleans as integers); Rust owns date syntax/calendar validity, kind resolution,
fallback, transport, and parsing. Unsupported keywords raise normal `TypeError`.
Dates are canonical strings, preserving the Rust domain including year zero.
Results are frozen dataclasses with tuples and read-only mappings: `Kind`,
`MatrixRow`, `DateResolution`, `SourceMetadata`, `SourceRequest`, and
`SourceParameters`. Yields are floats or `None`; original yield text and raw
columns are preserved. Field names are snake_case and retain all core information.

## Ownership and cancellation

Clients lazily own one Rust service and serialize calls per instance. Independent
clients may run independently. `Client` is thread-safe and releases the Python
interpreter while blocking; it never runs a Python event loop. Blocking calls
should not be used on an event-loop thread. A shared process-lifetime Tokio
runtime services both APIs; no per-call runtime or nested asyncio runner exists.

`AsyncClient` binds to the running event loop on first use. Later use or close
from another loop raises `ClientStateError`. Construction needs no event loop.
`Client.close()` and `await AsyncClient.aclose()` atomically reject new calls,
cancel active and queued operations, wait for Rust work to leave, and release
the service. Close is idempotent. Context managers perform the same cleanup.
Dropping a client cancels remaining work, but deterministic cleanup requires a
context manager or explicit close. Forked-process reuse is unsupported; construct
clients after process creation using the spawn start method.

Cancelling an asyncio task cancels that call's Rust token and retains
`asyncio.CancelledError`. Client close causes active calls to finish with
`RequestCancelledError`. Cancellation of `aclose()` still leaves the client
closed and cancellation requested; calling it again drains outstanding work.

## Errors and native boundary

All expected failures use `YtmError` subclasses: `InvalidParameterError`,
`SourceTransportError`, `SourceProtocolError`, `SourceFormatError`,
`SourceDataUnavailableError`, `RequestCancelledError`, `ClientStateError`, and
`DefectError`. Each exposes `code` and immutable `details` with safe core error
metadata, including attempted dates and recovery fields when supplied. Error
messages never expose binding exceptions, panic payloads, or dependency errors.

Unwinding Rust panics are translated to `DefectError` under the release unwind
profile. Native aborts, allocation failure, and interpreter shutdown cannot be
translated. Tests inject panics only in fixture builds. Release builds reject the
fixture feature at compile time and contain no environment-selected injection.
