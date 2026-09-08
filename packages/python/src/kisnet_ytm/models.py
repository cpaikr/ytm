"""Immutable Python projections of the Rust core's result information."""
from dataclasses import dataclass
from typing import Literal, Mapping

Fallback = Literal["exact", "previous-available"]

@dataclass(frozen=True)
class Kind:
    code: str
    name: str

@dataclass(frozen=True)
class SourceParameters:
    cal_base_dt: str
    cbo_ytm_sort: str

@dataclass(frozen=True)
class SourceRequest:
    format: str
    in_datasets: str
    out_datasets: str
    parameters: SourceParameters

@dataclass(frozen=True)
class SourceMetadata:
    page_url: str
    endpoint: str | None
    method: str | None
    request: SourceRequest | None = None
    inspected_workflow: str | None = None
    note: str | None = None

@dataclass(frozen=True)
class MatrixRow:
    group_name: str
    pricing_group_code: str
    pricing_group_name: str
    yields: Mapping[str, float | None]
    yield_text: Mapping[str, str]
    raw: Mapping[str, str]

@dataclass(frozen=True)
class DateResolution:
    mode: Fallback
    requested_base_date: str
    resolved_base_date: str
    used_fallback: bool
    attempted_dates: tuple[str, ...]
    lookback_days: int

@dataclass(frozen=True)
class KindsResult:
    base_date: str | None
    kinds: tuple[Kind, ...]
    source: SourceMetadata

@dataclass(frozen=True)
class MatrixResult:
    base_date: str
    kind: Kind
    tenors: tuple[str, ...]
    rows: tuple[MatrixRow, ...]
    source: SourceMetadata
    requested_base_date: str
    date_resolution: DateResolution


@dataclass(frozen=True)
class HistoryDiscovery:
    requested_base_date: str
    available: bool

@dataclass(frozen=True)
class AvailableHistoryEntry:
    matrix: MatrixResult
    availability: Literal["available"] = "available"

@dataclass(frozen=True)
class UnavailableHistoryEntry:
    requested_base_date: str
    kind: Kind
    attempted_dates: tuple[str, ...]
    mode: Fallback
    lookback_days: int
    reason: str
    stage: Literal["discovery", "matrix"]
    availability: Literal["unavailable"] = "unavailable"

HistoryEntry = AvailableHistoryEntry | UnavailableHistoryEntry

@dataclass(frozen=True)
class CountSelectionMetadata:
    count: int
    end_date: str
    start_date: str | None
    scanned_start_date: str
    scanned_date_count: int


@dataclass(frozen=True)
class HistoryResult:
    requested_dates: tuple[str, ...]
    discovery: tuple[HistoryDiscovery, ...]
    entries: tuple[HistoryEntry, ...]
    available_count: int
    unavailable_count: int
    data_row_count: int
    mode: Fallback
    lookback_days: int
    count_selection: CountSelectionMetadata | None = None
