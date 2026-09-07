use async_trait::async_trait;
use ytm_core::{
    BaseDate, CancellationToken, KindSelector, KindsInput, KindsResult, LookbackDays, MatrixInput,
    MatrixResult, PreparedRequest, Transport, YtmClient, YtmError,
};

struct ConsumerTransport;

#[async_trait]
impl Transport for ConsumerTransport {
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
    let result = client.history_with_cancellation(ytm_core::HistoryInput::new(dates), CancellationToken::new()).await?;
    for entry in &result.entries {
        match entry {
            ytm_core::HistoryEntry::Available { matrix } => { let _: &MatrixResult = matrix; }
            ytm_core::HistoryEntry::Unavailable { requested_base_date, kind, .. } => { let _: (&BaseDate, &str) = (requested_base_date, &kind.code); }
        }
    }
    Ok(result)
}
