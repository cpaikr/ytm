"""Stable error types with immutable, project-owned diagnostic metadata."""
from types import MappingProxyType
from typing import Mapping


def _freeze(value: object) -> object:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


class YtmError(Exception):
    """Base for source, input, lifecycle, and contained native failures."""
    def __init__(self, code: str, reason: str, details: Mapping[str, object] | None = None):
        super().__init__(reason)
        self.code = code
        self.details: Mapping[str, object] = MappingProxyType(
            {key: _freeze(value) for key, value in (details or {}).items()}
        )


class InvalidParameterError(YtmError):
    """The supplied call shape or domain value is invalid."""


class SourceTransportError(YtmError):
    """The bounded source request could not complete."""


class SourceProtocolError(YtmError):
    """The source reported an operation failure."""


class SourceFormatError(YtmError):
    """The response violated the source format contract."""


class SourceDataUnavailableError(YtmError):
    """No data exists within the requested bounded date search."""


class RequestCancelledError(YtmError):
    """Client cleanup cancelled an operation."""


class ClientStateError(YtmError):
    """A closed client or a different event loop was used."""


class DefectError(YtmError):
    """An unexpected implementation failure was contained."""
