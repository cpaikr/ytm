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
        Ok(Vec::new())
    }
}

fn main() -> Result<(), YtmError> {
    let _client = YtmClient::new()?;
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
