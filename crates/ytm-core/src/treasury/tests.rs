use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::{io::AsyncWriteExt, net::TcpListener};

use super::*;

const HEADER: &str = "Date,\"3 Mo\",\"6 Mo\",\"1 Yr\",\"10 Yr\"";

/// Deterministic Treasury transport keyed by year; records requested years.
#[derive(Default)]
struct Years {
    bodies: Vec<(u16, Result<String, YtmError>)>,
    requested: Mutex<Vec<TreasuryRequest>>,
}

impl Years {
    fn new(bodies: Vec<(u16, Result<String, YtmError>)>) -> Arc<Self> {
        Arc::new(Self {
            bodies,
            requested: Mutex::default(),
        })
    }

    fn years(&self) -> Vec<u16> {
        self.requested
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.year)
            .collect()
    }
}

#[async_trait]
impl TreasuryTransport for Years {
    async fn get(
        &self,
        request: TreasuryRequest,
        _cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        self.requested.lock().unwrap().push(request.clone());
        match self.bodies.iter().find(|(year, _)| *year == request.year) {
            Some((_, Ok(body))) => Ok(body.clone().into_bytes()),
            Some((_, Err(error))) => Err(error.clone()),
            None => Ok(Vec::new()),
        }
    }
}

fn date(text: &str) -> BaseDate {
    text.parse().unwrap()
}

fn dates(values: &[&str]) -> DateSelection {
    DateSelection::dates(values.iter().map(|value| date(value)).collect()).unwrap()
}

fn year_2025() -> String {
    format!(
        "{HEADER}\n09/30/2025,4.02,3.83,3.68,4.16\n09/29/2025,4.03,3.85,3.69,4.14\n09/26/2025,4.04,3.86,3.70,4.18\n01/02/2025,4.33,4.27,4.17,4.57\n"
    )
}

fn year_2024() -> String {
    format!("{HEADER}\n12/31/2024,4.37,4.24,4.16,4.58\n")
}

fn curve(entry: &TreasuryCurveEntry) -> &TreasuryCurve {
    match entry {
        TreasuryCurveEntry::Available { curve } => curve,
        TreasuryCurveEntry::Unavailable { .. } => panic!("expected an available curve"),
    }
}

#[test]
fn requests_match_the_contract_authority() {
    let contract: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(include_str!("../../../../contracts/treasury/openapi.yaml"))
            .unwrap();
    assert_eq!(
        contract["servers"][0]["url"].as_str(),
        Some(TREASURY_ORIGIN)
    );
    let profile = &contract["x-ytm-treasury-profile"];
    assert_eq!(
        profile["transport"]["requestDeadlineMilliseconds"].as_u64(),
        Some(TREASURY_REQUEST_DEADLINE_SECONDS * 1000)
    );
    assert_eq!(
        profile["response"]["maxDecompressedBodyBytes"].as_u64(),
        Some(crate::MAX_RESPONSE_BODY_BYTES as u64)
    );
    let labels = profile["tenors"]
        .as_sequence()
        .unwrap()
        .iter()
        .map(|tenor| {
            (
                tenor["label"].as_str().unwrap().to_owned(),
                tenor["tenor"].as_str().unwrap().to_owned(),
                tenor["months"].as_f64().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        labels,
        TREASURY_TENORS
            .iter()
            .map(|(label, tenor, months)| ((*label).to_owned(), (*tenor).to_owned(), *months))
            .collect::<Vec<_>>()
    );
    let request = year_request(2025);
    let example = profile["request"]["example"].as_str().unwrap();
    assert_eq!(request.url, example);
    assert_eq!(request.url, format!("{TREASURY_ORIGIN}{}", request.path));
    assert!(
        contract["paths"][profile["request"]["pathTemplate"].as_str().unwrap()]["get"].is_mapping()
    );
    assert!(is_supported_request(&request));
    assert!(!is_supported_request(&TreasuryRequest {
        url: "https://example.invalid/".into(),
        ..request.clone()
    }));
    assert!(!is_supported_request(&TreasuryRequest {
        operation: "other",
        ..request
    }));
}

#[tokio::test]
async fn exact_dates_resolve_from_one_request_per_year() {
    let transport = Years::new(vec![(2025, Ok(year_2025())), (2024, Ok(year_2024()))]);
    let service = TreasuryService::with_shared_transport(transport.clone());
    let result = service
        .curve(TreasuryCurveInput::new(dates(&[
            "2025-09-30",
            "2025-01-02",
            "2024-12-31",
            "2025-09-28",
        ])))
        .await
        .unwrap();
    assert_eq!(transport.years(), [2024, 2025]);
    assert_eq!(result.available_count, 3);
    assert_eq!(result.unavailable_count, 1);
    assert_eq!(result.latest_observation_date, Some(date("2025-09-30")));
    assert_eq!(
        result.requested_dates,
        ["2024-12-31", "2025-01-02", "2025-09-28", "2025-09-30"].map(date)
    );
    let last = curve(&result.entries[3]);
    assert_eq!(last.base_date, date("2025-09-30"));
    assert_eq!(
        last.tenors.iter().map(|t| t.tenor).collect::<Vec<_>>(),
        ["3M", "6M", "1Y", "10Y"]
    );
    assert_eq!(last.tenors[0].value, Some(4.02));
    assert!(matches!(
        &result.entries[2],
        TreasuryCurveEntry::Unavailable { attempted_dates, .. } if attempted_dates == &[date("2025-09-28")]
    ));
    assert_eq!(result.source.files.len(), 2);
    assert_eq!(result.source.files[1].observation_count, 4);
    let statistics = result.statistics.unwrap();
    assert_eq!(statistics.scanned_date_count, 4);
    assert_eq!(statistics.matrix_lookup_count, 0);
    assert_eq!(statistics.discovery_count, 0);
}

#[tokio::test]
async fn previous_available_crosses_into_the_prior_year() {
    let transport = Years::new(vec![(2025, Ok(year_2025())), (2024, Ok(year_2024()))]);
    let service = TreasuryService::with_shared_transport(transport.clone());
    let result = service
        .curve(TreasuryCurveInput::previous_available(
            dates(&["2025-01-01", "2025-09-28"]),
            LookbackDays::new(3).unwrap(),
        ))
        .await
        .unwrap();
    let new_year = curve(&result.entries[0]);
    assert_eq!(new_year.base_date, date("2024-12-31"));
    assert!(new_year.date_resolution.used_fallback);
    assert_eq!(
        new_year.date_resolution.attempted_dates,
        [date("2025-01-01"), date("2024-12-31")]
    );
    let weekend = curve(&result.entries[1]);
    assert_eq!(weekend.base_date, date("2025-09-26"));
    assert_eq!(transport.years(), [2025, 2024]);
    assert_eq!(result.mode, FallbackMode::PreviousAvailable);
}

#[tokio::test]
async fn exhausted_lookback_and_empty_years_are_unavailable_entries() {
    let transport = Years::new(vec![(2025, Ok(year_2025()))]);
    let service = TreasuryService::with_shared_transport(transport.clone());
    let result = service
        .curve(TreasuryCurveInput::previous_available(
            dates(&["2025-06-01", "2027-03-01"]),
            LookbackDays::new(2).unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(result.available_count, 0);
    for entry in &result.entries {
        let TreasuryCurveEntry::Unavailable {
            attempted_dates,
            reason,
            ..
        } = entry
        else {
            panic!("expected unavailable");
        };
        assert_eq!(attempted_dates.len(), 3);
        assert!(reason.starts_with("source_data_unavailable"));
    }
    assert_eq!(result.latest_observation_date, Some(date("2025-09-30")));
    assert_eq!(transport.years(), [2025, 2027]);
    let serialized = serde_json::to_value(&result).unwrap();
    assert_eq!(serialized["entries"][0]["availability"], "unavailable");
    assert_eq!(serialized["source"]["files"][1]["observationCount"], 0);
}

#[tokio::test]
async fn format_and_transport_errors_abort_with_treasury_context() {
    let transport = Years::new(vec![(2025, Ok("Date,\"9 Mo\"\n01/02/2025,1\n".into()))]);
    let error = TreasuryService::with_shared_transport(transport)
        .curve(TreasuryCurveInput::new(dates(&["2025-01-02"])))
        .await
        .unwrap_err();
    assert_eq!(error.details.code, "source_format_error");
    assert_eq!(error.details.operation_name.as_deref(), Some("treasury"));
    assert_eq!(
        error.details.attempted_dates.as_deref(),
        Some(&["2025-01-02".to_owned()][..])
    );
    assert!(error.details.recovery_hint.contains("Treasury"));
    assert!(error.details.statistics.is_some());

    let transport = Years::new(vec![(
        2025,
        Err(YtmError::transport(
            "Treasury returned HTTP 503.",
            Some(503),
            None,
        )),
    )]);
    let error = TreasuryService::with_shared_transport(transport)
        .curve(TreasuryCurveInput::new(dates(&["2025-01-02"])))
        .await
        .unwrap_err();
    assert_eq!(error.details.code, "source_transport_error");
    assert_eq!(
        error.details.expected,
        Some(json!("A successful HTTP response from Treasury"))
    );
    assert_eq!(error.details.actual.as_ref().unwrap()["sourceActual"], 503);
}

#[tokio::test]
async fn cancellation_before_retrieval_reports_treasury() {
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = TreasuryService::with_shared_transport(Years::new(Vec::new()))
        .curve_with_cancellation(
            TreasuryCurveInput::new(dates(&["2025-01-02"])),
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
    assert_eq!(error.details.reason, "Treasury request was cancelled.");
    assert!(!error.details.retryable);
}

#[test]
fn wire_request_validates_dates_and_fallback() {
    let parse = |value: serde_json::Value| {
        serde_json::from_value::<TreasuryCurveRequest>(value)
            .map_err(|error| error.to_string())
            .and_then(|request| {
                TreasuryCurveInput::try_from(request).map_err(|error| error.details.reason.clone())
            })
    };
    let input = parse(json!({ "baseDates": ["2025-09-30", "20250930", "2025.09.29"] })).unwrap();
    assert_eq!(
        input.selection.as_dates(),
        ["2025-09-29", "2025-09-30"].map(date)
    );
    assert_eq!(input.fallback, FallbackPolicy::Exact);
    let input = parse(json!({
        "startDate": "2025-09-01", "endDate": "2025-09-30", "fallback": "previous-available"
    }))
    .unwrap();
    assert_eq!(input.selection.as_dates().len(), 30);
    assert_eq!(
        input.fallback,
        FallbackPolicy::PreviousAvailable(LookbackDays::default())
    );
    for invalid in [
        json!({}),
        json!({ "baseDates": [] }),
        json!({ "startDate": "2025-09-30", "endDate": "2025-09-01" }),
        json!({ "baseDates": ["2025-02-30"] }),
        json!({ "baseDates": ["2025-09-30"], "lookbackDays": 3 }),
        json!({ "baseDates": ["2025-09-30"], "fallback": "nearest" }),
        json!({ "baseDates": ["2025-09-30"], "fallback": "previous-available", "lookbackDays": 32 }),
        json!({ "baseDates": ["2025-09-30"], "kind": "10" }),
        json!({ "count": 3, "endDate": "2025-09-30" }),
    ] {
        assert!(parse(invalid.clone()).is_err(), "{invalid}");
    }
}

#[tokio::test]
async fn http_transport_gets_the_csv_with_treasury_headers_and_limits() {
    let body = year_2025();
    let (origin, captured) = serve(vec![http_response(
        200,
        "text/csv; charset=UTF-8",
        body.as_bytes(),
    )])
    .await;
    let transport = HttpTransport::new().unwrap().with_test_origin(&origin);
    let result = TreasuryService::with_transport(transport)
        .curve(TreasuryCurveInput::new(dates(&["2025-09-30"])))
        .await
        .unwrap();
    assert_eq!(result.available_count, 1);
    let request = captured.lock().unwrap()[0].to_ascii_lowercase();
    assert!(request.starts_with(&format!(
        "get {} http/1.1\r\n",
        year_request(2025).path.to_ascii_lowercase()
    )));
    assert!(request.contains("\r\naccept: text/csv, */*\r\n"));
    let statistics = result.statistics.unwrap();
    assert_eq!(statistics.physical_attempt_count, Some(1));
}

#[tokio::test]
async fn http_transport_retries_transient_status_and_rejects_wrong_media() {
    let body = year_2025();
    let (origin, captured) = serve(vec![
        http_response(503, "text/plain", b"busy"),
        http_response(200, "text/csv", body.as_bytes()),
    ])
    .await;
    let options = RetrievalOptions::default()
        .with_request_policy(
            2,
            std::time::Duration::ZERO,
            std::time::Duration::ZERO,
            std::time::Duration::ZERO,
        )
        .unwrap();
    let result =
        TreasuryService::with_transport(HttpTransport::new().unwrap().with_test_origin(&origin))
            .curve_with_options(TreasuryCurveInput::new(dates(&["2025-09-30"])), options)
            .await
            .unwrap();
    assert_eq!(captured.lock().unwrap().len(), 2);
    assert_eq!(result.statistics.unwrap().retry_count, Some(1));

    let (origin, _) = serve(vec![http_response(
        200,
        "text/html; charset=UTF-8",
        b"<html/>",
    )])
    .await;
    let error =
        TreasuryService::with_transport(HttpTransport::new().unwrap().with_test_origin(&origin))
            .curve(TreasuryCurveInput::new(dates(&["2025-09-30"])))
            .await
            .unwrap_err();
    assert_eq!(error.details.code, "source_format_error");
    assert!(error.details.reason.starts_with("Treasury HTTP 200"));
    assert_eq!(
        error
            .details
            .retry
            .as_ref()
            .map(|retry| retry.source_operation.as_str()),
        Some("treasuryYieldCurve")
    );
}

#[tokio::test]
async fn http_transport_does_not_replay_unsupported_requests() {
    let (origin, captured) = serve(vec![
        http_response(503, "text/plain", b"busy"),
        http_response(503, "text/plain", b"busy"),
    ])
    .await;
    let transport = HttpTransport::new().unwrap().with_test_origin(&origin);
    let mut request = year_request(2025);
    request.url = format!("{origin}/elsewhere");
    let error = transport
        .get(request, CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.details.actual, Some(json!(503)));
    assert_eq!(captured.lock().unwrap().len(), 1);
}

#[test]
fn content_type_accepts_csv_with_optional_utf8_charset() {
    use crate::transport::tests_support::is_treasury_content_type;
    for accepted in [
        "text/csv",
        "TEXT/CSV ; charset = utf-8",
        "text/csv; charset=UTF-8",
    ] {
        assert!(is_treasury_content_type(accepted), "{accepted}");
    }
    for rejected in [
        "text/plain",
        "text/csv; charset=ISO-8859-1",
        "text/csv; charset=UTF-8; header=present",
        "text/csv; header=present",
    ] {
        assert!(!is_treasury_content_type(rejected), "{rejected}");
    }
}

type Captured = Arc<Mutex<Vec<String>>>;

async fn serve(responses: Vec<Vec<u8>>) -> (String, Captured) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let captured = Captured::default();
    let sink = captured.clone();
    tokio::spawn(async move {
        for response in responses {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let request = crate::transport::tests_support::read_request(&mut socket).await;
            sink.lock().unwrap().push(request);
            let _ = socket.write_all(&response).await;
        }
    });
    (origin, captured)
}

fn http_response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    crate::transport::tests_support::response(status, &[("Content-Type", content_type)], body)
}

/// Manual conformance check against downloaded source files, which are not
/// committed: set YTM_TREASURY_SURVEY_DIR to a directory of `<year>.csv` files.
#[test]
#[ignore = "requires locally downloaded Treasury yearly CSV files"]
fn parses_downloaded_source_years() {
    let directory = std::env::var("YTM_TREASURY_SURVEY_DIR").expect("survey directory");
    let mut parsed = 0;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let year: u16 = path.file_stem().unwrap().to_str().unwrap().parse().unwrap();
        let body = std::fs::read(&path).unwrap();
        let file = parse::parse_year(&body, year).unwrap_or_else(|error| panic!("{year}: {error}"));
        assert!(body.is_empty() || !file.observations.is_empty(), "{year}");
        parsed += 1;
    }
    assert!(parsed > 0);
}

#[test]
fn evidence_corpus_cases_hold() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/treasury");
    let cases: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join("cases.json")).unwrap())
            .unwrap();
    let cases = cases["parseCases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let body = std::fs::read(directory.join(case["fixture"].as_str().unwrap())).unwrap();
        let year = case["year"].as_u64().unwrap() as u16;
        let parsed = parse::parse_year(&body, year);
        if case["outcome"] == "source_format_error" {
            assert_eq!(
                parsed.unwrap_err().details.code,
                "source_format_error",
                "{name}"
            );
            continue;
        }
        let file = parsed.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            file.observations.len() as u64,
            case["observationCount"].as_u64().unwrap(),
            "{name}"
        );
        let expected = case["tenors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tenor| tenor.as_str().unwrap())
            .collect::<Vec<_>>();
        for tenors in file.observations.values() {
            assert_eq!(
                tenors.iter().map(|t| t.tenor).collect::<Vec<_>>(),
                expected,
                "{name}"
            );
        }
        if let Some(sample) = case.get("sample") {
            let tenors = &file.observations[&date(sample["date"].as_str().unwrap())];
            let tenor = tenors
                .iter()
                .find(|t| t.tenor == sample["tenor"].as_str().unwrap())
                .unwrap();
            assert_eq!(tenor.value, sample["yield"].as_f64(), "{name}");
            assert_eq!(
                tenor.yield_text,
                sample["yieldText"].as_str().unwrap(),
                "{name}"
            );
        }
    }
}
