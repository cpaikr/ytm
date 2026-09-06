"""Typed clients; Rust owns all product operations and domain validation."""
import asyncio
import json
from types import MappingProxyType, TracebackType
from typing import Any, Self

from . import _native
from .errors import (
    ClientStateError, DefectError, InvalidParameterError, RequestCancelledError,
    SourceDataUnavailableError, SourceFormatError, SourceProtocolError,
    SourceTransportError, YtmError,
)
from .models import (
    DateResolution, Fallback, Kind, KindsResult, MatrixResult, MatrixRow,
    SourceMetadata, SourceParameters, SourceRequest,
)

_ERRORS: dict[str, type[YtmError]] = {
    "invalid_parameter": InvalidParameterError,
    "source_transport_error": SourceTransportError,
    "source_protocol_error": SourceProtocolError,
    "source_format_error": SourceFormatError,
    "source_data_unavailable": SourceDataUnavailableError,
    "request_cancelled": RequestCancelledError,
    "client_closed": ClientStateError,
    "internal_error": DefectError,
}


def _shape(base_date: str | None, kind: str | int | None = None,
           fallback: str | None = None, lookback_days: int | None = None,
           *, matrix: bool = False) -> str:
    if (base_date is not None and type(base_date) is not str) or (matrix and base_date is None):
        raise InvalidParameterError("invalid_parameter", "base_date must be a string.")
    if matrix and type(kind) not in (str, int):
        raise InvalidParameterError("invalid_parameter", "kind must be a string or integer.")
    if (matrix or fallback is not None) and type(fallback) is not str:
        raise InvalidParameterError("invalid_parameter", "fallback must be a string.")
    if lookback_days is not None and type(lookback_days) is not int:
        raise InvalidParameterError("invalid_parameter", "lookback_days must be an integer.")
    try:
        return json.dumps(dict(base_date=base_date, kind=kind, fallback=fallback,
                               lookback_days=lookback_days))
    except ValueError:
        raise InvalidParameterError("invalid_parameter", "Integer input exceeds the serialization limit.") from None


def _decode(encoded: str) -> dict[str, Any]:
    envelope = json.loads(encoded)
    if not envelope["ok"]:
        details = envelope["error"]
        code = details["code"]
        error_type = _ERRORS.get(code)
        if error_type is None:
            raise DefectError("implementation_defect", "Native operation failed.")
        raise error_type(code, details["reason"], details)
    return dict(envelope["value"])


def _source(value: dict[str, Any]) -> SourceMetadata:
    request = value.get("request")
    projected = None
    if request is not None:
        parameters = request["parameters"]
        projected = SourceRequest(request["format"], request["inDatasets"], request["outDatasets"],
                                  SourceParameters(parameters["calBaseDt"], parameters["cboYtmSort"]))
    return SourceMetadata(value["pageUrl"], value.get("endpoint"), value.get("method"),
                          projected, value.get("inspectedWorkflow"), value.get("note"))


def _kinds(value: dict[str, Any]) -> KindsResult:
    return KindsResult(value["baseDate"], tuple(Kind(**item) for item in value["kinds"]), _source(value["source"]))


def _matrix(value: dict[str, Any]) -> MatrixResult:
    resolution = value["dateResolution"]
    rows = tuple(MatrixRow(row["groupName"], row["pricingGroupCode"], row["pricingGroupName"],
                           MappingProxyType(row["yields"]), MappingProxyType(row["yieldText"]),
                           MappingProxyType(row["raw"])) for row in value["rows"])
    return MatrixResult(value["baseDate"], Kind(**value["kind"]), tuple(value["tenors"]), rows,
                        _source(value["source"]), value["requestedBaseDate"],
                        DateResolution(resolution["mode"], resolution["requestedBaseDate"],
                                       resolution["resolvedBaseDate"], resolution["usedFallback"],
                                       tuple(resolution["attemptedDates"]), resolution["lookbackDays"]))


class Client:
    """Synchronous, thread-safe client; use a context manager for cleanup."""
    def __init__(self) -> None:
        self._native = _native.NativeClient()

    def matrix(self, *, base_date: str, kind: str | int, fallback: Fallback = "exact",
               lookback_days: int | None = None) -> MatrixResult:
        """Retrieve a matrix, with an optional bounded previous-date search."""
        return _matrix(self._run("matrix", _shape(base_date, kind, fallback, lookback_days, matrix=True)))

    def kinds(self, *, base_date: str | None = None) -> KindsResult:
        """Return the canonical catalog, or merge source discovery for a date."""
        return _kinds(self._run("kinds", _shape(base_date)))

    def _run(self, operation: str, payload: str) -> dict[str, Any]:
        try:
            encoded = self._native.run_sync(operation, payload)
        except RuntimeError:
            raise DefectError("implementation_defect", "Native operation failed.") from None
        return _decode(encoded)

    def close(self) -> None:
        """Cancel and drain active calls, release resources, and reject new calls."""
        try:
            self._native.close_sync()
        except RuntimeError:
            raise DefectError("implementation_defect", "Native cleanup failed.") from None

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None,
                 traceback: TracebackType | None) -> None:
        self.close()


class AsyncClient:
    """Asyncio client bound to the event loop of its first operation or close."""
    def __init__(self) -> None:
        self._native = _native.NativeClient()
        self._loop: asyncio.AbstractEventLoop | None = None

    def _check_loop(self) -> None:
        loop = asyncio.get_running_loop()
        if self._loop is None:
            self._loop = loop
        elif self._loop is not loop:
            raise ClientStateError("wrong_event_loop", "Client belongs to another event loop.")

    async def matrix(self, *, base_date: str, kind: str | int, fallback: Fallback = "exact",
                     lookback_days: int | None = None) -> MatrixResult:
        """Retrieve a matrix without blocking the event loop."""
        return _matrix(await self._run("matrix", _shape(base_date, kind, fallback, lookback_days, matrix=True)))

    async def kinds(self, *, base_date: str | None = None) -> KindsResult:
        """Return the canonical catalog, or merge source discovery for a date."""
        return _kinds(await self._run("kinds", _shape(base_date)))

    async def _run(self, operation: str, payload: str) -> dict[str, Any]:
        self._check_loop()
        try:
            encoded = await self._native.run_async(operation, payload)
        except RuntimeError:
            raise DefectError("implementation_defect", "Native operation failed.") from None
        return _decode(encoded)

    async def aclose(self) -> None:
        """Cancel and drain active calls; cancellation still leaves the client closed."""
        self._check_loop()
        try:
            await self._native.close_async()
        except RuntimeError:
            raise DefectError("implementation_defect", "Native cleanup failed.") from None

    async def __aenter__(self) -> Self:
        self._check_loop()
        return self

    async def __aexit__(self, exc_type: type[BaseException] | None, exc: BaseException | None,
                        traceback: TracebackType | None) -> None:
        await self.aclose()
