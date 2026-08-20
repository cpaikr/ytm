from __future__ import annotations

import json
import pickle
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from curl_cffi import CurlError
from curl_cffi.const import CurlECode
from curl_cffi.requests import RequestsError
from pydantic import ValidationError

from kisnet_ytm import (
    DataUnavailableError,
    DateResolution,
    InvalidInputError,
    SourceFormatError,
    SourceProtocolError,
    SourceTransportError,
    list_kinds,
)
from kisnet_ytm._nexacro import (
    MAX_ELEMENT_DEPTH,
    MAX_RESPONSE_BODY_BYTES,
    build_request_xml,
    parse_kinds_response,
    parse_matrix_response,
)
from kisnet_ytm._retrieval import fetch_matrix_from_source
from kisnet_ytm._source import CurlCffiSource
from kisnet_ytm.models import Kind


def resolve_contract_directory() -> Path:
    test_file = Path(__file__).resolve()
    candidates = (
        test_file.parents[1] / "contracts" / "kisnet",
        test_file.parents[3] / "contracts" / "kisnet",
    )
    for candidate in candidates:
        if (candidate / "cases.json").is_file():
            return candidate
    raise RuntimeError("KIS-NET contract fixtures are missing from the source tree")


CONTRACT_DIRECTORY = resolve_contract_directory()
CONTRACT = json.loads((CONTRACT_DIRECTORY / "cases.json").read_text(encoding="utf-8"))
FIXTURES = {
    name: (CONTRACT_DIRECTORY / filename).read_text(encoding="utf-8")
    for name, filename in CONTRACT["fixtures"].items()
}
REQUESTED_DATE = date.fromisoformat(CONTRACT["requestExample"]["baseDate"])


class FixtureResponseRequestError(RequestsError):
    def __init__(self, message: str, code: CurlECode, status_code: int) -> None:
        super().__init__(message, code, response=SimpleNamespace(status_code=status_code))


class CallbackSession:
    def __init__(
        self,
        chunks: tuple[bytes, ...],
        *,
        status_code: int = 200,
        error: CurlError | None = None,
    ) -> None:
        self.chunks = chunks
        self.status_code = status_code
        self.error = error
        self.closed = False
        self.callback_results: list[int] = []

    def post(
        self, url: str, *, data: bytes, content_callback: Callable[[bytes], int]
    ) -> SimpleNamespace:
        assert url.startswith("https://kis-net.kr/")
        assert data.startswith(b'<?xml version="1.0" encoding="UTF-8"?>')
        if self.error is not None:
            raise self.error
        for chunk in self.chunks:
            wrote = content_callback(chunk)
            self.callback_results.append(wrote)
            if wrote != len(chunk):
                raise FixtureResponseRequestError(
                    "fixture callback aborted the transfer", CurlECode.WRITE_ERROR, self.status_code
                )
        return SimpleNamespace(status_code=self.status_code)

    def close(self) -> None:
        self.closed = True


@dataclass
class FixtureSource:
    matrix_by_date: dict[date, str]
    empty_kind_dates: set[date] = field(default_factory=set)
    calls: list[tuple[str, date]] = field(default_factory=list)

    def list_kinds(self, base_date: date) -> tuple[Kind, ...]:
        self.calls.append(("kinds", base_date))
        if base_date in self.empty_kind_dates:
            return ()
        return parse_kinds_response(FIXTURES["init"])

    def fetch_rows(self, base_date: date, kind_code: str) -> tuple[dict[str, str], ...]:
        self.calls.append((f"matrix:{kind_code}", base_date))
        return parse_matrix_response(self.matrix_by_date[base_date])


@pytest.mark.parametrize("fixture_name", ["initMalformedMixed", "initMalformedAll"])
def test_malformed_kind_rows_are_source_format_errors(fixture_name: str) -> None:
    with pytest.raises(SourceFormatError):
        parse_kinds_response(FIXTURES[fixture_name])


def test_request_mapping_and_canonical_tenors() -> None:
    request = build_request_xml(
        REQUESTED_DATE, CONTRACT["requestExample"]["kind"]["code"], initial=False
    )

    assert f'<Col id="calBaseDt">{CONTRACT["requestExample"]["baseDateCompact"]}</Col>' in request
    assert f'<Col id="cboYtmSort">{CONTRACT["requestExample"]["kind"]["code"]}</Col>' in request

    result = fetch_matrix_from_source(
        FixtureSource({REQUESTED_DATE: FIXTURES["matrix"]}),
        REQUESTED_DATE,
        CONTRACT["requestExample"]["kind"]["name"],
    )
    assert result.tenors == tuple(item["label"] for item in CONTRACT["expectedTenors"])
    assert result.base_date == REQUESTED_DATE
    assert result.requested_date == REQUESTED_DATE
    assert result.date_resolution.attempted_dates == (REQUESTED_DATE,)
    assert not result.date_resolution.used_previous_available
    assert (
        result.rows[0].pricing_group_code == CONTRACT["expectations"]["matrix"]["pricingGroupCode"]
    )
    assert result.rows[0].yields["3M"] == Decimal(CONTRACT["expectations"]["matrix"]["threeMonth"])
    assert result.rows[0].yields["10Y"] == Decimal(CONTRACT["expectations"]["matrix"]["tenYear"])


def test_request_date_is_zero_padded_independently_of_platform_strftime() -> None:
    request = build_request_xml(date.min, "10", initial=False)

    assert '<Col id="calBaseDt">00010101</Col>' in request


def test_source_preserves_xml_encoding_when_http_charset_disagrees(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = CallbackSession((FIXTURES["init"].encode("utf-8"),))
    monkeypatch.setattr("kisnet_ytm._source.requests.Session", lambda **_: session)

    with CurlCffiSource() as source:
        kinds = source.list_kinds(REQUESTED_DATE)

    assert kinds[0].name == "국채"
    assert session.closed


@pytest.mark.parametrize("xml_case", CONTRACT["xmlCases"]["valid"])
def test_shared_valid_xml_cases(xml_case: dict[str, str]) -> None:
    fixture = FIXTURES[xml_case["fixture"]]
    if xml_case["operation"] == "matrix":
        row = parse_matrix_response(fixture)[0]
        assert row[xml_case["expectedRawColumn"]] == xml_case["expectedRawValue"]
        if extra_column := xml_case.get("expectedExtraRawColumn"):
            assert row[extra_column] == xml_case["expectedExtraRawValue"]
        return

    kind = parse_kinds_response(fixture)[0]
    assert kind.code == xml_case["expectedKindCode"]
    assert kind.name == xml_case["expectedKindName"]


@pytest.mark.parametrize("fixture_name", CONTRACT["xmlCases"]["invalid"])
def test_shared_invalid_xml_cases(fixture_name: str) -> None:
    with pytest.raises(SourceFormatError):
        parse_kinds_response(FIXTURES[fixture_name])


def test_xml_depth_limit_accepts_boundary_and_rejects_excess() -> None:
    response = _nested_xml_response(MAX_ELEMENT_DEPTH - 1)
    assert parse_kinds_response(response)[0].code == "10"

    with pytest.raises(SourceFormatError, match="depth"):
        parse_kinds_response(_nested_xml_response(MAX_ELEMENT_DEPTH))


def test_response_byte_limit_accepts_boundary_and_rejects_excess() -> None:
    exact = _xml_at_byte_length(FIXTURES["init"], MAX_RESPONSE_BODY_BYTES).encode()
    assert parse_kinds_response(exact)[0].code == "10"

    oversized = _xml_at_byte_length(FIXTURES["init"], MAX_RESPONSE_BODY_BYTES + 1).encode()
    with pytest.raises(SourceFormatError, match="body size"):
        parse_kinds_response(oversized)


def test_transport_aborts_before_buffering_past_response_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    oversized = _xml_at_byte_length(FIXTURES["init"], MAX_RESPONSE_BODY_BYTES + 1).encode()
    session = CallbackSession((oversized[:MAX_RESPONSE_BODY_BYTES], oversized[-1:]))
    monkeypatch.setattr("kisnet_ytm._source.requests.Session", lambda **_: session)

    with CurlCffiSource() as source, pytest.raises(SourceFormatError, match="body size"):
        source.list_kinds(REQUESTED_DATE)

    assert session.callback_results[0] == MAX_RESPONSE_BODY_BYTES
    assert session.callback_results[1] != 1
    assert session.closed


def test_transport_accepts_response_at_exact_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    exact = _xml_at_byte_length(FIXTURES["init"], MAX_RESPONSE_BODY_BYTES).encode()
    session = CallbackSession((exact[:500_000], exact[500_000:]))
    monkeypatch.setattr("kisnet_ytm._source.requests.Session", lambda **_: session)

    with CurlCffiSource() as source:
        kinds = source.list_kinds(REQUESTED_DATE)

    assert kinds[0].code == "10"
    assert session.callback_results == [500_000, MAX_RESPONSE_BODY_BYTES - 500_000]


def test_transport_keeps_curl_failures_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    session = CallbackSession((), error=CurlError("fixture transport failure", 7))
    monkeypatch.setattr("kisnet_ytm._source.requests.Session", lambda **_: session)

    with CurlCffiSource() as source, pytest.raises(SourceTransportError):
        source.list_kinds(REQUESTED_DATE)


def test_transport_does_not_report_synthetic_http_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    class ResponseCurlError(CurlError):
        def __init__(self) -> None:
            super().__init__("fixture DNS failure", 6)
            self.response = SimpleNamespace(status_code=0)

    error = ResponseCurlError()
    session = CallbackSession((), error=error)
    monkeypatch.setattr("kisnet_ytm._source.requests.Session", lambda **_: session)

    with (
        CurlCffiSource() as source,
        pytest.raises(SourceTransportError, match="failed before a response"),
    ):
        source.list_kinds(REQUESTED_DATE)


def test_transport_keeps_http_failures_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    session = CallbackSession((FIXTURES["init"].encode(),), status_code=503)
    monkeypatch.setattr("kisnet_ytm._source.requests.Session", lambda **_: session)

    with CurlCffiSource() as source, pytest.raises(SourceTransportError, match="HTTP 503"):
        source.list_kinds(REQUESTED_DATE)


def test_utf8_bom_and_replacement_character_are_valid() -> None:
    response = FIXTURES["init"].replace("국채", "국\ufffd채").encode()

    assert parse_kinds_response(b"\xef\xbb\xbf" + response)[0].name == "국\ufffd채"
    assert (
        parse_kinds_response(response.replace("국\ufffd채".encode(), b"&#xFFFD;"))[0].name
        == "\ufffd"
    )


def test_duplicate_bom_is_rejected() -> None:
    response = FIXTURES["init"].encode()

    with pytest.raises(SourceFormatError, match="at most one"):
        parse_kinds_response(b"\xef\xbb\xbf\xef\xbb\xbf" + response)


def test_invalid_utf8_is_rejected() -> None:
    with pytest.raises(SourceFormatError, match="UTF-8"):
        parse_kinds_response(FIXTURES["init"].encode() + b"\xff")


@pytest.mark.parametrize("version", ["1.1", "1.2"])
def test_unsupported_xml_versions_are_rejected(version: str) -> None:
    response = FIXTURES["init"].replace('version="1.0"', f'version="{version}"')

    with pytest.raises(SourceFormatError, match=r"XML 1\.0"):
        parse_kinds_response(response)


@pytest.mark.parametrize("encoding", ["UTF8", "ISO-8859-1", "UTF-16", "UTF-32"])
def test_unsupported_xml_encoding_declarations_are_rejected(encoding: str) -> None:
    response = FIXTURES["init"].replace('encoding="UTF-8"', f'encoding="{encoding}"')

    with pytest.raises(SourceFormatError, match="UTF-8"):
        parse_kinds_response(response)


@pytest.mark.parametrize("encoding", ["UTF-8", "utf-8"])
def test_supported_xml_encoding_declarations_are_accepted(encoding: str) -> None:
    response = FIXTURES["init"].replace('encoding="UTF-8"', f'encoding="{encoding}"')

    assert parse_kinds_response(response)[0].code == "10"


@pytest.mark.parametrize("encoding", ["unknown", "UTF-32"])
def test_unsupported_xml_encoding_is_a_source_format_error(encoding: str) -> None:
    response = f'<?xml version="1.0" encoding="{encoding}"?><Root/>'.encode()

    with pytest.raises(SourceFormatError):
        parse_matrix_response(response)


@pytest.mark.parametrize("fixture_name", ["protocolError", "protocolWarning"])
def test_nonzero_protocol_statuses_fail_closed(fixture_name: str) -> None:
    expected = CONTRACT["expectations"]["protocolStatuses"][fixture_name]

    with pytest.raises(SourceProtocolError) as caught:
        parse_matrix_response(FIXTURES[fixture_name])

    assert caught.value.error_code == expected["errorCode"]
    assert caught.value.error_message == expected["errorMessage"]
    assert expected["errorCode"] in str(caught.value)
    assert expected["errorMessage"] in str(caught.value)


@pytest.mark.parametrize("fixture_name", ["protocolError", "protocolWarning"])
def test_nonzero_protocol_statuses_fail_closed_for_kind_responses(
    fixture_name: str,
) -> None:
    expected = CONTRACT["expectations"]["protocolStatuses"][fixture_name]

    with pytest.raises(SourceProtocolError) as caught:
        parse_kinds_response(FIXTURES[fixture_name])

    assert caught.value.error_code == expected["errorCode"]
    assert caught.value.error_message == expected["errorMessage"]


@pytest.mark.parametrize("error_code", ["00", "+0", "-0"])
def test_signed_and_padded_zero_protocol_statuses_succeed(error_code: str) -> None:
    response = FIXTURES["matrix"].replace(
        '<Parameter id="ErrorCode">0</Parameter>',
        f'<Parameter id="ErrorCode">{error_code}</Parameter>',
        1,
    )

    assert parse_matrix_response(response)[0]["pricingGroupCode"] == "100"


def test_malformed_protocol_status_is_a_source_format_error() -> None:
    with pytest.raises(SourceFormatError, match="invalid ErrorCode"):
        parse_matrix_response(FIXTURES["invalidErrorCode"])


def test_missing_yield_values_preserve_source_text() -> None:
    result = fetch_matrix_from_source(
        FixtureSource({REQUESTED_DATE: FIXTURES["missingValues"]}),
        REQUESTED_DATE,
        "10",
    )

    for tenor in CONTRACT["expectations"]["missingValues"]["nullTenors"]:
        assert result.rows[0].yields[tenor] is None
        assert (
            result.rows[0].yield_text[tenor]
            == CONTRACT["expectations"]["missingValues"]["rawValues"][tenor]
        )


@pytest.mark.parametrize("raw", ["2_500", "2e3"])
def test_noncanonical_numeric_text_is_a_source_format_error(raw: str) -> None:
    response = FIXTURES["matrix"].replace(
        '<Col id="m3">2.500</Col>',
        f'<Col id="m3">{raw}</Col>',
        1,
    )

    with pytest.raises(SourceFormatError):
        fetch_matrix_from_source(
            FixtureSource({REQUESTED_DATE: response}),
            REQUESTED_DATE,
            "국채",
        )


def test_exact_unavailable_records_only_requested_date() -> None:
    with pytest.raises(DataUnavailableError) as caught:
        fetch_matrix_from_source(
            FixtureSource({REQUESTED_DATE: FIXTURES["unavailable"]}),
            REQUESTED_DATE,
            "국채",
        )

    assert caught.value.requested_date == REQUESTED_DATE
    assert caught.value.attempted_dates == (REQUESTED_DATE,)


def test_data_unavailable_error_round_trips_through_pickle() -> None:
    error = DataUnavailableError(
        "fixture unavailable",
        requested_date=REQUESTED_DATE,
        attempted_dates=(REQUESTED_DATE,),
    )

    restored = pickle.loads(pickle.dumps(error))

    assert type(restored) is DataUnavailableError
    assert str(restored) == str(error)
    assert restored.requested_date == error.requested_date
    assert restored.attempted_dates == error.attempted_dates


def test_source_protocol_error_round_trips_through_pickle() -> None:
    error = SourceProtocolError(
        "fixture protocol failure",
        error_code="-1",
        error_message="Request rejected",
    )

    restored = pickle.loads(pickle.dumps(error))

    assert type(restored) is SourceProtocolError
    assert str(restored) == str(error)
    assert restored.error_code == error.error_code
    assert restored.error_message == error.error_message


def test_previous_available_probes_calendar_dates_in_order() -> None:
    previous_one = date(2026, 6, 7)
    previous_two = date(2026, 6, 6)
    resolved = date(2026, 6, 5)
    source = FixtureSource(
        {
            previous_two: FIXTURES["unavailable"],
            resolved: FIXTURES["matrix"],
        },
        empty_kind_dates={previous_one},
    )

    result = fetch_matrix_from_source(
        source,
        previous_one,
        "국채",
        previous_available_days=2,
    )

    assert result.base_date == resolved
    assert result.date_resolution.attempted_dates == (previous_one, previous_two, resolved)
    assert result.date_resolution.used_previous_available
    assert source.calls == [
        ("kinds", previous_one),
        ("kinds", previous_two),
        ("matrix:10", previous_two),
        ("kinds", resolved),
        ("matrix:10", resolved),
    ]


@pytest.mark.parametrize("fixture_name", ["malformed", "invalidNumeric", "missingColumn"])
def test_source_format_failures_stop_fallback(fixture_name: str) -> None:
    source = FixtureSource({REQUESTED_DATE: FIXTURES[fixture_name]})

    with pytest.raises(SourceFormatError):
        fetch_matrix_from_source(
            source,
            REQUESTED_DATE,
            "국채",
            previous_available_days=10,
        )

    assert source.calls == [("kinds", REQUESTED_DATE), ("matrix:10", REQUESTED_DATE)]


@pytest.mark.parametrize("fixture_name", ["protocolError", "protocolWarning"])
def test_source_protocol_failures_stop_fallback(fixture_name: str) -> None:
    source = FixtureSource({REQUESTED_DATE: FIXTURES[fixture_name]})

    with pytest.raises(SourceProtocolError):
        fetch_matrix_from_source(
            source,
            REQUESTED_DATE,
            "국채",
            previous_available_days=10,
        )

    assert source.calls == [("kinds", REQUESTED_DATE), ("matrix:10", REQUESTED_DATE)]


def test_transport_failure_stops_fallback() -> None:
    class FailedSource:
        def list_kinds(self, base_date: date) -> tuple[Kind, ...]:
            raise SourceTransportError("fixture transport failure")

        def fetch_rows(self, base_date: date, kind_code: str) -> tuple[dict[str, str], ...]:
            raise AssertionError("matrix must not be called")

    with pytest.raises(SourceTransportError):
        fetch_matrix_from_source(
            FailedSource(),
            REQUESTED_DATE,
            "국채",
            previous_available_days=10,
        )


@pytest.mark.parametrize(
    ("base_date", "kind", "previous_available_days"),
    [
        ("2026-06-08", "국채", None),
        (REQUESTED_DATE, "", None),
        (REQUESTED_DATE, "국채", -1),
        (REQUESTED_DATE, "국채", 32),
        (REQUESTED_DATE, "국채", 1_000_000_000),
        (REQUESTED_DATE, "국채", True),
        (date.min, "국채", 1),
    ],
)
def test_invalid_inputs_are_explicit(
    base_date: object,
    kind: str,
    previous_available_days: int | None,
) -> None:
    with pytest.raises(InvalidInputError):
        fetch_matrix_from_source(
            FixtureSource({}),
            cast(date, base_date),
            kind,
            previous_available_days=previous_available_days,
        )


@pytest.mark.parametrize("previous_available_days", [0, 31])
def test_previous_available_days_accepts_documented_boundaries(
    previous_available_days: int,
) -> None:
    source = FixtureSource({REQUESTED_DATE: FIXTURES["matrix"]})

    result = fetch_matrix_from_source(
        source,
        REQUESTED_DATE,
        "국채",
        previous_available_days=previous_available_days,
    )

    assert result.base_date == REQUESTED_DATE
    assert result.date_resolution.previous_available_days == previous_available_days


def test_date_resolution_rejects_lookback_above_public_limit() -> None:
    with pytest.raises(ValidationError):
        DateResolution(
            requested_date=REQUESTED_DATE,
            resolved_date=REQUESTED_DATE,
            attempted_dates=(REQUESTED_DATE,),
            previous_available_days=32,
            used_previous_available=False,
        )


@pytest.mark.parametrize("previous_available_days", [True, 1.0, "1"])
def test_date_resolution_rejects_coerced_lookback_values(
    previous_available_days: object,
) -> None:
    with pytest.raises(ValidationError):
        DateResolution(
            requested_date=REQUESTED_DATE,
            resolved_date=REQUESTED_DATE,
            attempted_dates=(REQUESTED_DATE,),
            previous_available_days=cast(int | None, previous_available_days),
            used_previous_available=False,
        )


@pytest.mark.parametrize(
    "resolution",
    [
        {
            "requested_date": date(2026, 6, 8),
            "resolved_date": date(2026, 6, 6),
            "attempted_dates": (date(2026, 6, 8), date(2026, 6, 6)),
            "previous_available_days": 2,
            "used_previous_available": True,
        },
        {
            "requested_date": date(2026, 6, 8),
            "resolved_date": date(2026, 6, 9),
            "attempted_dates": (date(2026, 6, 8), date(2026, 6, 9)),
            "previous_available_days": 1,
            "used_previous_available": True,
        },
        {
            "requested_date": date(2026, 6, 8),
            "resolved_date": date(2026, 6, 6),
            "attempted_dates": (
                date(2026, 6, 8),
                date(2026, 6, 7),
                date(2026, 6, 6),
            ),
            "previous_available_days": 1,
            "used_previous_available": True,
        },
        {
            "requested_date": date(2026, 6, 8),
            "resolved_date": date(2026, 6, 7),
            "attempted_dates": (date(2026, 6, 8), date(2026, 6, 7)),
            "previous_available_days": None,
            "used_previous_available": True,
        },
    ],
)
def test_date_resolution_rejects_impossible_attempt_history(
    resolution: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        DateResolution.model_validate(resolution)


def test_list_kinds_without_a_date_is_network_free() -> None:
    assert list_kinds()[0] == Kind(code="10", name="국채")


def _xml_at_byte_length(xml: str, target_bytes: int) -> str:
    prefix = f"{xml}<!--"
    suffix = "-->"
    padding_bytes = target_bytes - len(f"{prefix}{suffix}".encode())
    if padding_bytes < 0:
        raise ValueError(f"target XML byte length {target_bytes} is too small")
    return f"{prefix}{'x' * padding_bytes}{suffix}"


def _nested_xml_response(nested_elements: int) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Root xmlns="http://www.nexacroplatform.com/platform/dataset">'
        '<Parameters><Parameter id="ErrorCode">0</Parameter></Parameters>'
        + "<Extra>" * nested_elements
        + "</Extra>" * nested_elements
        + '<Dataset id="output1"><Rows><Row><Col id="divCode">10</Col>'
        '<Col id="divName">국채</Col></Row></Rows></Dataset></Root>'
    )
