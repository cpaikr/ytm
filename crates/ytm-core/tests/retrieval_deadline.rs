use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use ytm_core::{
    CancellationToken, CountSelection, DateSelection, FallbackPolicy, HistoryInput, KindsInput,
    LookbackDays, MatrixInput, PreparedRequest, RetrievalOptions, Transport, YtmClient, YtmError,
};

#[derive(Clone, Default)]
struct SlowCustomTransport {
    calls: Arc<Mutex<Vec<CancellationToken>>>,
    available: bool,
}

#[async_trait]
impl Transport for SlowCustomTransport {
    // Intentionally implement only the old required method: the compatible hook
    // must apply one outer deadline without introducing service-owned retries.
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        self.calls.lock().unwrap().push(cancellation);
        tokio::time::sleep(Duration::from_secs(1)).await;
        let rows = if self.available && request.operation == "initializeYtmMatrix" {
            "<Row><Col id=\"divCode\">10</Col><Col id=\"divName\">국채</Col></Row>".to_owned()
        } else if self.available {
            let mut row = "<Row><Col id=\"pricingGroupCode\">001</Col><Col id=\"pricingGroupName\">synthetic</Col>".to_owned();
            for key in [
                "m3", "m6", "m9", "y1", "y15a", "y2", "y25", "y3", "y5", "y7", "y10", "y15", "y20",
                "y30", "y50",
            ] {
                row.push_str(&format!("<Col id=\"{key}\">1.000</Col>"));
            }
            row.push_str("</Row>");
            row
        } else {
            String::new()
        };
        Ok(format!("<Root xmlns=\"http://www.nexacroplatform.com/platform/dataset\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows>{rows}</Rows></Dataset></Root>").into_bytes())
    }
}

fn options(milliseconds: u64) -> RetrievalOptions {
    RetrievalOptions::new(Duration::from_millis(milliseconds)).unwrap()
}

#[tokio::test(start_paused = true)]
async fn shared_budget_spans_successful_categories_and_preserves_reusable_caller() {
    let transport = SlowCustomTransport {
        available: true,
        ..Default::default()
    };
    let calls = transport.calls.clone();
    let client = YtmClient::with_transport(transport);
    let caller = CancellationToken::new();
    let input =
        HistoryInput::new(DateSelection::dates(vec!["2026-06-09".parse().unwrap()]).unwrap());
    let start = tokio::time::Instant::now();
    let error = client
        .history_with_options_and_cancellation(input, options(2500), caller.clone())
        .await
        .unwrap_err();
    assert_eq!(
        tokio::time::Instant::now() - start,
        Duration::from_millis(2500)
    );
    assert_eq!(calls.lock().unwrap().len(), 3);
    assert_eq!(error.details.cause.as_deref(), Some("TimeoutError"));
    assert_eq!(error.details.operation_name.as_deref(), Some("history"));
    assert_eq!(error.details.actual.as_ref().unwrap()["kind"]["code"], "20");
    assert!(
        error.details.retry.is_none(),
        "custom transports own physical attempts"
    );
    assert!(calls.lock().unwrap().last().unwrap().is_cancelled());
    assert!(!caller.is_cancelled());
    assert!(client
        .kinds_with_options_and_cancellation(
            KindsInput::for_date("2026-06-09".parse().unwrap()),
            options(1500),
            caller
        )
        .await
        .is_ok());
    assert_eq!(calls.lock().unwrap().len(), 4);
}

#[tokio::test(start_paused = true)]
async fn budget_spans_dates_count_search_and_previous_available_fallback() {
    for count in [false, true] {
        let transport = SlowCustomTransport::default();
        let calls = transport.calls.clone();
        let client = YtmClient::with_transport(transport);
        let input = if count {
            HistoryInput::new(CountSelection::new(1, "2026-06-09".parse().unwrap(), None).unwrap())
        } else {
            HistoryInput::new(
                DateSelection::dates(vec![
                    "2026-06-08".parse().unwrap(),
                    "2026-06-09".parse().unwrap(),
                ])
                .unwrap(),
            )
        };
        let error = client
            .history_with_options(input, options(1500))
            .await
            .unwrap_err();
        assert_eq!(error.details.code, "source_transport_error");
        assert_eq!(error.details.cause.as_deref(), Some("TimeoutError"));
        assert_eq!(calls.lock().unwrap().len(), 2);
    }
    let transport = SlowCustomTransport::default();
    let calls = transport.calls.clone();
    let client = YtmClient::with_transport(transport);
    let mut input = MatrixInput::new("2026-06-09".parse().unwrap(), "10".parse().unwrap());
    input.fallback = FallbackPolicy::PreviousAvailable(LookbackDays::new(2).unwrap());
    let error = client
        .matrix_with_options(input, options(1500))
        .await
        .unwrap_err();
    assert_eq!(error.details.cause.as_deref(), Some("TimeoutError"));
    assert_eq!(
        error.details.attempted_dates.unwrap(),
        ["2026-06-09", "2026-06-08"]
    );
    assert_eq!(calls.lock().unwrap().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn cancellation_wins_at_deadline_and_pre_cancelled_calls_make_no_requests() {
    let transport = SlowCustomTransport::default();
    let calls = transport.calls.clone();
    let client = YtmClient::with_transport(transport);
    let caller = CancellationToken::new();
    caller.cancel();
    let error = client
        .kinds_with_options_and_cancellation(
            KindsInput::for_date("2026-06-09".parse().unwrap()),
            options(1),
            caller,
        )
        .await
        .unwrap_err();
    assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
    assert!(calls.lock().unwrap().is_empty());
}
