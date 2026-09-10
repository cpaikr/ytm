use async_trait::async_trait;
use ytm_core::{
    BaseDate, CancellationToken, KindSelector, KindsInput, KindsResult, LookbackDays, MatrixInput,
    MatrixResult, PreparedRequest, Transport, YtmClient, YtmError,
};

struct ConsumerTransport;

#[async_trait]
impl Transport for ConsumerTransport {
    async fn post_with_context(
        &self,
        request: PreparedRequest,
        context: ytm_core::RetrievalContext,
    ) -> Result<Vec<u8>, YtmError> {
        // Context-aware custom transports must not fabricate zero physical work.
        assert_eq!(context.statistics().physical_attempt_count, None);
        assert_eq!(context.statistics().retry_count, None);
        self.post(request, context.cancellation()).await
    }

    async fn post(
        &self,
        _request: PreparedRequest,
        _cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        // Independently authored empty discovery is a completed history outcome.
        Ok(br#"<Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters><Dataset id="output1"><Rows/></Dataset></Root>"#.to_vec())
    }
}

#[tokio::main]
async fn main() -> Result<(), YtmError> {
    let _client = YtmClient::new()?;
    let client = construct_injected_client();
    let result = history_consumer(&client).await?;
    assert_eq!(result.requested_dates.iter().map(ToString::to_string).collect::<Vec<_>>(), ["2024-02-28", "2024-02-29", "2024-03-01"]);
    assert_eq!(result.entries.len(), 24);
    assert_eq!(result.available_count, 0);
    assert_eq!(result.unavailable_count, 24);
    assert_eq!(result.data_row_count, 0);
    assert!(result.discovery.iter().all(|d| !d.available));
    let selection = ytm_core::CountSelection::new(1, "2024-02-29".parse().unwrap(), Some("2024-02-29".parse().unwrap())).unwrap();
    let error = client.history(ytm_core::HistoryInput::new(selection)).await.unwrap_err();
    assert_eq!(error.details.code, "insufficient_history");
    assert_eq!(error.details.actual.unwrap()["scannedDateCount"], 1);
    Ok(())
}

#[allow(dead_code)]
async fn call_public_sdk(client: &YtmClient) -> Result<(KindsResult, MatrixResult), YtmError> {
    let kinds = client
        .kinds_with_cancellation(KindsInput::default(), CancellationToken::new())
        .await?;
    let date = "2026-06-08".parse::<BaseDate>().expect("valid example date");
    let kind = KindSelector::new("국채").expect("nonempty kind");
    let input = MatrixInput::previous_available(
        date,
        kind,
        LookbackDays::new(10).expect("valid lookback"),
    );
    let matrix = client.matrix(input).await?;
    Ok((kinds, matrix))
}

#[allow(dead_code)]
fn construct_injected_client() -> YtmClient {
    YtmClient::with_transport(ConsumerTransport)
}

#[allow(dead_code)]
async fn history_consumer(client: &YtmClient) -> Result<ytm_core::HistoryResult, YtmError> {
    let dates = ytm_core::DateSelection::range("2024-02-28".parse().unwrap(), "2024-03-01".parse().unwrap()).unwrap();
    let progress = ytm_core::RetrievalProgress::new();
    let options = ytm_core::RetrievalOptions::default().with_request_policy(4, std::time::Duration::ZERO, std::time::Duration::ZERO, std::time::Duration::from_millis(1))?.with_progress(progress.clone());
    let result = client.history_with_options_and_cancellation(ytm_core::HistoryInput::new(dates), options, CancellationToken::new()).await?;
    let statistics = result.statistics.as_ref().expect("successful calls expose final statistics");
    assert_eq!(statistics.scanned_date_count, 3);
    assert_eq!(statistics.physical_attempt_count, None);
    assert_eq!(statistics.retry_count, None);
    assert!(statistics.finished);
    assert_eq!(progress.snapshot().as_ref(), Some(statistics));
    for entry in &result.entries {
        match entry {
            ytm_core::HistoryEntry::Available { matrix } => { let _: &MatrixResult = matrix; }
            ytm_core::HistoryEntry::Unavailable { requested_base_date, kind, .. } => { let _: (&BaseDate, &str) = (requested_base_date, &kind.code); }
        }
    }
    Ok(result)
}

// ErrorDetails is exhaustive: callers using literals must initialize the new
// optional retry and statistics fields, while constructor-based code remains unchanged.
#[allow(dead_code)]
fn error_literal_migration() -> ytm_core::ErrorDetails {
    let old_constructor = YtmError::cancelled("history");
    assert!(old_constructor.details.retry.is_none());
    ytm_core::ErrorDetails {
        ok: false, code: "custom_error", operation_name: None, parameter: None,
        reason: "consumer-defined failure".into(), expected: None, actual: None,
        example_input: None, recovery_hint: "inspect consumer".into(), recovery_action: "inspect_tool_help",
        recoverable: false, retryable: false, source_error_code: None, source_error_message: None,
        attempted_dates: None, lookback_days: None, cause: None, retry: None, statistics: None,
    }
}

#[allow(dead_code)]
async fn bounded_consumer(client: &YtmClient) -> Result<KindsResult, YtmError> {
    let options = ytm_core::RetrievalOptions::new(std::time::Duration::from_secs(60))?;
    client.kinds_with_options(KindsInput::default(), options).await
}
