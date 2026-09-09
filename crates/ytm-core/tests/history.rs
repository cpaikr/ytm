use async_trait::async_trait;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use ytm_core::{
    BaseDate, CancellationToken, DateSelection, FallbackPolicy, HistoryEntry, HistoryInput,
    HistoryRequest, LookbackDays, PreparedRequest, Transport, YtmClient, YtmError,
};

fn xml(rows: &str) -> Vec<u8> {
    format!(r#"<Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters><Dataset id="output1"><Rows>{rows}</Rows></Dataset></Root>"#).into_bytes()
}
fn matrix() -> Vec<u8> {
    let mut row = String::from(
        r#"<Row><Col id="pricingGroupCode">001</Col><Col id="pricingGroupName">=한글</Col>"#,
    );
    for (index, key) in [
        "m3", "m6", "m9", "y1", "y15a", "y2", "y25", "y3", "y5", "y7", "y10", "y15", "y20", "y30",
        "y50",
    ]
    .iter()
    .enumerate()
    {
        row.push_str(&format!(
            r#"<Col id="{key}">{}</Col>"#,
            if index == 0 {
                "-0.500"
            } else if index == 1 {
                "0"
            } else {
                "-"
            }
        ));
    }
    row.push_str("</Row>");
    xml(&row)
}
fn cell(body: &str, key: &str) -> String {
    body.split(&format!("<Col id=\"{key}\"> ").replace("> ", ">"))
        .nth(1)
        .unwrap()
        .split("</Col>")
        .next()
        .unwrap()
        .to_owned()
}
#[derive(Clone, Default)]
struct Synthetic {
    requests: Arc<Mutex<Vec<(String, String, String)>>>,
    empty_discovery: bool,
    fallback: bool,
    fatal: bool,
    wait: bool,
}
#[async_trait]
impl Transport for Synthetic {
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        let date = cell(&request.body, "calBaseDt");
        let kind = cell(&request.body, "cboYtmSort");
        self.requests
            .lock()
            .unwrap()
            .push((request.operation.into(), date.clone(), kind.clone()));
        if self.wait {
            cancellation.cancelled().await;
            return Err(YtmError::transport("cancelled", None, Some("AbortError")));
        }
        if request.operation == "initializeYtmMatrix" {
            if self.empty_discovery {
                return Ok(xml(""));
            }
            let label = if date == "20260608" {
                "이전"
            } else {
                "이후"
            };
            // Deliberately omit seven canonical categories, including 80.
            return Ok(xml(&format!(
                r#"<Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row><Row><Col id="divCode">90</Col><Col id="divName">{label}</Col></Row>"#
            )));
        }
        if self.fatal && kind == "20" {
            return Err(YtmError::protocol(
                "17".into(),
                Some("synthetic failure".into()),
            ));
        }
        if self.fallback && date != "20260608" {
            return Ok(xml(""));
        }
        Ok(matrix())
    }
}
fn input(dates: &[&str], fallback: bool) -> HistoryInput {
    let mut input = HistoryInput::new(
        DateSelection::dates(dates.iter().map(|d| d.parse().unwrap()).collect()).unwrap(),
    );
    if fallback {
        input.fallback = FallbackPolicy::PreviousAvailable(LookbackDays::new(2).unwrap());
    }
    input
}
#[test]
fn date_selection_contract() {
    let selection = DateSelection::dates(vec![
        "20260609".parse().unwrap(),
        "2026.06.08".parse().unwrap(),
        "2026-06-08".parse().unwrap(),
    ])
    .unwrap();
    assert_eq!(
        selection
            .as_dates()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["2026-06-08", "2026-06-09"]
    );
    assert_eq!(
        DateSelection::range("2024-02-28".parse().unwrap(), "2024-03-01".parse().unwrap())
            .unwrap()
            .as_dates()
            .len(),
        3
    );
    assert!(
        DateSelection::range("2024-03-01".parse().unwrap(), "2024-02-28".parse().unwrap()).is_err()
    );
    assert!(DateSelection::dates(vec![]).is_err());
    assert!(DateSelection::dates(vec!["2026-06-08".parse().unwrap(); 2001]).is_err());
    for value in [
        serde_json::json!({}),
        serde_json::json!({"baseDates":[],"startDate":"2024-01-01","endDate":"2024-01-01"}),
        serde_json::json!({"startDate":"2020-01-01","endDate":"2026-01-01"}),
        serde_json::json!({"baseDates":["2026-02-30"]}),
    ] {
        let request: HistoryRequest = serde_json::from_value(value).unwrap();
        assert!(HistoryInput::try_from(request).is_err());
    }
}
#[tokio::test]
async fn all_categories_reuse_and_observation_labels() {
    let transport = Synthetic {
        fallback: true,
        ..Default::default()
    };
    let client = YtmClient::with_transport(transport.clone());
    let result = client
        .history(input(&["20260609", "20260608", "2026.06.09"], true))
        .await
        .unwrap();
    assert_eq!(
        (
            result.available_count,
            result.unavailable_count,
            result.data_row_count
        ),
        (18, 0, 18)
    );
    assert_eq!(result.entries.len(), 18);
    let requests = transport.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 20); // Two catalogs + nine matrices per date.
    assert_eq!(
        requests.iter().collect::<HashSet<_>>().len(),
        requests.len()
    );
    for (index, entry) in result.entries.iter().enumerate() {
        let HistoryEntry::Available { matrix } = entry else {
            panic!("available")
        };
        assert_eq!(matrix.base_date.to_string(), "2026-06-08");
        assert_eq!(
            matrix.date_resolution.attempted_dates.len(),
            if index < 9 { 1 } else { 2 }
        );
        assert_eq!(matrix.rows[0].pricing_group_code, "001");
        assert_eq!(matrix.rows[0].yields["3M"], Some(-0.5));
        assert_eq!(matrix.rows[0].yields["6M"], Some(0.0));
        assert_eq!(matrix.rows[0].yields["9M"], None);
        assert_eq!(matrix.rows[0].group_name, matrix.kind.name);
        if matrix.kind.code == "90" {
            assert_eq!(matrix.kind.name, "이전");
        }
    }
    let alone = client.history(input(&["20260609"], true)).await.unwrap();
    assert_eq!(
        serde_json::to_value(&alone.entries).unwrap(),
        serde_json::to_value(&result.entries[9..]).unwrap()
    );
}
#[tokio::test]
async fn unavailable_discovery_is_not_a_matrix_request() {
    let transport = Synthetic {
        empty_discovery: true,
        ..Default::default()
    };
    let result = YtmClient::with_transport(transport.clone())
        .history(input(&["20260608", "20260609"], true))
        .await
        .unwrap();
    assert_eq!(
        (
            result.available_count,
            result.unavailable_count,
            result.data_row_count
        ),
        (0, 16, 0)
    );
    assert!(result.discovery.iter().all(|d| !d.available));
    assert_eq!(transport.requests.lock().unwrap().len(), 4);
    for entry in result.entries {
        let HistoryEntry::Unavailable {
            attempted_dates,
            stage,
            ..
        } = entry
        else {
            panic!("unavailable")
        };
        assert_eq!(attempted_dates.len(), 3);
        assert_eq!(serde_json::to_value(stage).unwrap(), "discovery");
    }
}
#[tokio::test]
async fn fatal_failure_stops_the_batch_with_context() {
    let transport = Synthetic {
        fatal: true,
        ..Default::default()
    };
    let error = YtmClient::with_transport(transport.clone())
        .history(input(&["20260608", "20260609"], false))
        .await
        .unwrap_err();
    assert_eq!(error.details.code, "source_protocol_error");
    assert_eq!(error.details.actual.as_ref().unwrap()["kind"]["code"], "20");
    assert_eq!(transport.requests.lock().unwrap().len(), 3);
    let client = YtmClient::with_transport(Synthetic {
        empty_discovery: true,
        ..Default::default()
    });
    let error = client
        .history(input(&["0000-01-01"], true))
        .await
        .unwrap_err();
    assert_eq!(error.details.code, "invalid_parameter");
}
#[tokio::test]
async fn cancellation_stops_inflight_history_and_next_call_is_independent() {
    let transport = Synthetic {
        wait: true,
        ..Default::default()
    };
    let client = YtmClient::with_transport(transport.clone());
    let token = CancellationToken::new();
    let request = client.history_with_cancellation(input(&["20260608"], false), token.clone());
    let cancel = async {
        while transport.requests.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        token.cancel();
    };
    let (result, ()) = tokio::join!(request, cancel);
    assert_eq!(
        result.unwrap_err().details.cause.as_deref(),
        Some("AbortError")
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
    let token = CancellationToken::new();
    token.cancel();
    assert!(client
        .history_with_cancellation(input(&["20260608"], false), token)
        .await
        .is_err());
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}

#[test]
fn full_date_limit_is_constructible() {
    let dates = DateSelection::range(
        BaseDate::new(2020, 1, 1).unwrap(),
        BaseDate::new(2025, 6, 22).unwrap(),
    )
    .unwrap();
    assert_eq!(dates.as_dates().len(), 2000);
}

fn count_input(count: usize, end: &str, start: Option<&str>) -> HistoryInput {
    HistoryInput::new(
        ytm_core::CountSelection::new(
            count,
            end.parse().unwrap(),
            start.map(|d| d.parse().unwrap()),
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn count_180_stops_at_target_and_orders_whole_dates() {
    let transport = Synthetic::default();
    let requests = transport.requests.clone();
    let result = YtmClient::with_transport(transport)
        .history(count_input(180, "2026-06-29", None))
        .await
        .unwrap();
    assert_eq!(result.requested_dates.len(), 180);
    assert_eq!(result.requested_dates[0].to_string(), "2026-01-01");
    assert_eq!(result.requested_dates[179].to_string(), "2026-06-29");
    assert!(result.requested_dates.windows(2).all(|d| d[0] < d[1]));
    assert_eq!(requests.lock().unwrap().len(), 180 * 10);
    assert_eq!(result.available_count, 180 * 9);
    for day in result.entries.chunks(9) {
        assert_eq!(
            day.iter()
                .map(|e| match e {
                    HistoryEntry::Available { matrix } => {
                        assert!(!matrix.date_resolution.used_fallback);
                        assert_eq!(matrix.base_date, matrix.requested_base_date);
                        matrix.kind.code.as_str()
                    }
                    _ => panic!("numeric fixture"),
                })
                .collect::<Vec<_>>(),
            ["10", "20", "30", "40", "50", "60", "70", "80", "90"]
        );
    }
    assert_eq!(result.count_selection.unwrap().scanned_date_count, 180);
}

#[tokio::test]
async fn count_shortfalls_report_boundaries_and_preserve_fatal_errors() {
    for (end, start, scanned, stop) in [
        ("2024-03-01", Some("2024-02-28"), 3, "start_boundary"),
        ("2026-06-08", None, 2000, "search_limit"),
        ("0000-01-02", None, 2, "date_floor"),
    ] {
        let transport = Synthetic {
            empty_discovery: true,
            ..Default::default()
        };
        let requests = transport.requests.clone();
        let error = YtmClient::with_transport(transport)
            .history(count_input(1, end, start))
            .await
            .unwrap_err();
        assert_eq!(error.details.code, "insufficient_history");
        let actual = error.details.actual.unwrap();
        assert_eq!(actual["foundCount"], 0);
        assert_eq!(actual["scannedDateCount"], scanned);
        assert_eq!(actual["stopReason"], stop);
        assert_eq!(requests.lock().unwrap().len(), scanned as usize);
    }
    let error = YtmClient::with_transport(Synthetic {
        fatal: true,
        ..Default::default()
    })
    .history(count_input(1, "2026-06-08", None))
    .await
    .unwrap_err();
    assert_eq!(error.details.code, "source_protocol_error");
    assert_eq!(error.details.actual.unwrap()["kind"]["code"], "20");
}

#[test]
fn count_validation_is_exact_and_bounded() {
    for value in [
        serde_json::json!({"count":1}),
        serde_json::json!({"count":0,"endDate":"20260608"}),
        serde_json::json!({"count":2001,"endDate":"20260608"}),
        serde_json::json!({"count":1,"endDate":"20260608","baseDates":["20260608"]}),
        serde_json::json!({"count":1,"endDate":"20260608","fallback":"previous-available"}),
        serde_json::json!({"count":1,"endDate":"20260608","lookbackDays":1}),
        serde_json::json!({"count":1,"endDate":"20260608","startDate":"20260609"}),
        serde_json::json!({"count":1,"endDate":"20260608","startDate":"20200101"}),
    ] {
        assert!(
            HistoryInput::try_from(serde_json::from_value::<HistoryRequest>(value).unwrap())
                .is_err()
        );
    }
    for count in [
        serde_json::json!(true),
        serde_json::json!(1.5),
        serde_json::json!(-1),
        serde_json::json!("1"),
        serde_json::json!(1e40),
    ] {
        assert!(serde_json::from_value::<HistoryRequest>(
            serde_json::json!({"count":count,"endDate":"20260608"})
        )
        .is_err());
    }
}

#[tokio::test]
async fn count_accepts_the_last_candidate_and_rejects_rust_fallback_before_io() {
    let transport = Synthetic {
        fallback: true,
        ..Default::default()
    };
    let requests = transport.requests.clone();
    let client = YtmClient::with_transport(transport);
    let mut invalid = count_input(1, "2026-06-08", None);
    invalid.fallback = FallbackPolicy::PreviousAvailable(LookbackDays::default());
    assert_eq!(
        client.history(invalid).await.unwrap_err().details.code,
        "invalid_parameter"
    );
    assert!(requests.lock().unwrap().is_empty());
    let result = client
        .history(count_input(1, "2031-11-28", None))
        .await
        .unwrap();
    assert_eq!(result.requested_dates, ["2026-06-08".parse().unwrap()]);
    assert_eq!(result.count_selection.unwrap().scanned_date_count, 2000);
    assert_eq!(requests.lock().unwrap().len(), 2000 * 10);
}
