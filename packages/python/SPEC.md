# Python API

The `kisnet_ytm` import is the typed Python facade for the Rust core. Distribution
name: `kisnet-ytm`. This replaces the historical Python API without compatibility
aliases. This source is not yet published; installed historical 0.2.0 packages
have a different API.

## Calls and values

`Client` is synchronous; `AsyncClient` exposes the same operations as coroutines:

- `history(*, base_dates: list[str] | tuple[str, ...] | None = None,
  start_date: str | None = None, end_date: str | None = None,
  fallback: Literal["exact", "previous-available"] = "exact",
  lookback_days: int | None = None, count: int | None = None,
  operation_timeout_seconds: int | None = None)` returns `HistoryResult`.
- `matrix(*, base_date: str, kind: str | int, fallback: Literal["exact",
  "previous-available"] = "exact", lookback_days: int | None = None,
  operation_timeout_seconds: int | None = None)` returns
  `MatrixResult`.
- `kinds(*, base_date: str | None = None,
  operation_timeout_seconds: int | None = None)` returns `KindsResult`. Omitting the
  date returns the Rust-owned canonical catalog without network access.

Arguments are keyword-only. Python checks call shapes (including rejecting
booleans as integers); Rust owns date syntax/calendar validity, kind resolution,
fallback, transport, and parsing. Unsupported keywords raise normal `TypeError`.
Dates are canonical strings, preserving the Rust domain including year zero.
Results are frozen dataclasses with tuples and read-only mappings: `Kind`,
`MatrixRow`, `DateResolution`, `SourceMetadata`, `SourceRequest`, and
`SourceParameters`. Yields are floats or `None`; original yield text and raw
columns are preserved. Field names are snake_case and retain all core information.

History accepts a nonempty list/tuple or complete inclusive range,
normalizes and orders dates, and enforces the shared 2,000-entry/day bound.
It returns every category and pricing group; there is no `kind` filter.
`HistoryResult` contains `requested_dates`, `discovery`, `entries`,
`available_count`, `unavailable_count`, `data_row_count`, `mode`, and
`lookback_days`, and optional `count_selection` (None for fixed selections). `HistoryDiscovery` records requested-date catalog availability.
`HistoryEntry` is a union of `AvailableHistoryEntry` (with a `matrix`) and
`UnavailableHistoryEntry` (requested date, kind, attempted dates, mode, lookback,
reason, and `stage`). They use literal `availability` tags and immutable values.
Count selection uses `count` with an explicit `end_date` and optional
`start_date`, exact fallback only. It returns exactly N dates containing numeric
yields or raises `InsufficientHistoryError`; missing cells can remain. Frozen
`CountSelectionMetadata` contains `count`, `end_date`, `start_date` (None when
omitted), `scanned_start_date`, and `scanned_date_count`.
Confirmed unavailable pairs remain successful entries within selected dates; operational failures
and cancellation abort the call. The shared [history contract](../../SPEC.md#multi-date-history)
owns all-category targeting, fallback, ordering, and provenance semantics.

`operation_timeout_seconds` is a positive integer representable by the core
clock; booleans, fractions, non-finite values and overflow fail before source
I/O. `None` uses the core's finite 30-minute default. The deadline starts after
the per-client queue and covers retrieval, including retries, across all dates
and categories. Expiry raises `SourceTransportError` with timeout/stop metadata
and leaves the caller token and client usable. It is distinct from close or
asyncio cancellation. See the [shared recovery contract](../../SPEC.md#bounded-retrieval-recovery)
for compatibility and attempt policy.

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
`SourceDataUnavailableError`, `InsufficientHistoryError`, `RequestCancelledError`, `ClientStateError`, and
`DefectError`. Each exposes `code` and immutable `details` with safe core error
metadata, including attempted dates, recovery fields and the optional nested
`retry` mapping (`attemptCount`, `maxAttempts`, `sourceOperation`, `stopReason`). Error
messages never expose binding exceptions, panic payloads, or dependency errors.

Unwinding Rust panics are translated to `DefectError` under the release unwind
profile. Native aborts, allocation failure, and interpreter shutdown cannot be
translated. Tests inject panics only in fixture builds. Release builds reject the
fixture feature at compile time and contain no environment-selected injection.
