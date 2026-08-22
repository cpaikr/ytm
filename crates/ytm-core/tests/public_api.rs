use ytm_core::{
    BaseDate, FallbackPolicy, KindSelector, KindsInput, KindsResult, LookbackDays, MatrixInput,
    MatrixResult, YtmClient, YtmError,
};

#[test]
fn default_client_and_typed_inputs_are_available_from_the_crate_root() {
    let _client = YtmClient::new().expect("default HTTP client builds");
    let date = "2026-06-08".parse::<BaseDate>().unwrap();
    let kind = KindSelector::new("국채").unwrap();
    let exact = MatrixInput::new(date, kind.clone());
    let fallback = MatrixInput::previous_available(date, kind, LookbackDays::new(10).unwrap());

    assert_eq!(exact.base_date, date);
    assert_eq!(fallback.base_date, date);
    assert_eq!(exact.fallback, FallbackPolicy::Exact);
    assert_eq!(
        fallback.fallback,
        FallbackPolicy::PreviousAvailable(LookbackDays::new(10).unwrap())
    );
}

#[allow(dead_code)]
async fn public_result_and_error_types_are_nameable(
    client: &YtmClient,
    matrix: MatrixInput,
) -> Result<(KindsResult, MatrixResult), YtmError> {
    let kinds = client.kinds(KindsInput::default()).await?;
    let matrix = client.matrix(matrix).await?;
    Ok((kinds, matrix))
}
