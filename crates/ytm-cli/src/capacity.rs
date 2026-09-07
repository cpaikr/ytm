//! Opt-in synthetic capacity measurement through the public core and CLI writer.
use crate::{xlsx, OperationResult};
use async_trait::async_trait;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use ytm_core::{
    CancellationToken, DateSelection, FallbackPolicy, HistoryInput, LookbackDays, PreparedRequest,
    Transport, YtmError, YtmService,
};

struct Synthetic {
    count: Arc<AtomicUsize>,
    rows: Vec<u8>,
    sparse: bool,
    delay: Duration,
}
fn xml(rows: &str) -> Vec<u8> {
    format!(r#"<Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters><Dataset id="output1"><Rows>{rows}</Rows></Dataset></Root>"#).into_bytes()
}
#[async_trait]
impl Transport for Synthetic {
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        self.count.fetch_add(1, Ordering::Relaxed);
        if !self.delay.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(self.delay) => {},
                _ = cancellation.cancelled() => return Err(YtmError::transport("cancelled synthetic delay",None,Some("AbortError"))),
            }
        }
        if request.operation == "initializeYtmMatrix" {
            return Ok(xml(
                r#"<Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row>"#,
            ));
        }
        // Only dates ending in 01 have rows: this forces maximum overlapping
        // 31-day lookback paths without retaining captured request payloads.
        if self.sparse {
            let date = request
                .body
                .split("<Col id=\"calBaseDt\">")
                .nth(1)
                .unwrap()
                .split("</Col>")
                .next()
                .unwrap();
            if !date.ends_with("01") {
                return Ok(xml(""));
            }
        }
        Ok(self.rows.clone())
    }
}
fn synthetic(rows: usize, sparse: bool, delay: Duration) -> Synthetic {
    let mut body = String::new();
    for index in 0..rows {
        body.push_str(&format!(r#"<Row><Col id="pricingGroupCode">{index:04}</Col><Col id="pricingGroupName">합성 채권 {index}</Col>"#));
        for key in [
            "m3", "m6", "m9", "y1", "y15a", "y2", "y25", "y3", "y5", "y7", "y10", "y15", "y20",
            "y30", "y50",
        ] {
            body.push_str(&format!(r#"<Col id="{key}">2.500</Col>"#));
        }
        body.push_str("</Row>");
    }
    Synthetic {
        count: Arc::new(AtomicUsize::new(0)),
        rows: xml(&body),
        sparse,
        delay,
    }
}
#[tokio::test]
#[ignore = "capacity measurement; run explicitly with YTM_CAPACITY_END and YTM_CAPACITY_SPARSE"]
async fn measure() {
    let end = std::env::var("YTM_CAPACITY_END").unwrap_or_else(|_| "2022-12-31".into());
    let sparse = std::env::var_os("YTM_CAPACITY_SPARSE").is_some();
    let transport = synthetic(10, sparse, Duration::ZERO);
    let count = transport.count.clone();
    let client = YtmService::with_transport(transport);
    let mut input = HistoryInput::new(
        DateSelection::range("2020-01-01".parse().unwrap(), end.parse().unwrap()).unwrap(),
    );
    if sparse {
        input.fallback = FallbackPolicy::PreviousAvailable(LookbackDays::new(31).unwrap());
    }
    let dates = input.selection.as_dates().len();
    let started = Instant::now();
    let result = client.history(input).await.unwrap();
    let retrieval_ms = started.elapsed().as_millis();
    assert_eq!(result.entries.len(), dates * 8);
    assert_eq!(result.available_count, dates * 8);
    assert_eq!(count.load(Ordering::Relaxed), dates * 9);
    let pairs = result.entries.len();
    let rows = result.data_row_count;
    if std::env::var_os("YTM_CAPACITY_CLI_JSON").is_some() {
        let started = Instant::now();
        let output = crate::success_output(
            OperationResult::History(result),
            crate::OutputFormat::Json,
            false,
        )
        .unwrap();
        println!(
            "CAPACITY_CLI_JSON {}",
            serde_json::json!({"dates":dates,"pairs":pairs,"dataRows":rows,"physicalRequests":count.load(Ordering::Relaxed),"retrievalMs":retrieval_ms,"serializationMs":started.elapsed().as_millis(),"jsonBytes":output.stdout.len()})
        );
        return;
    }
    let started = Instant::now();
    let json = serde_json::to_vec(&result).unwrap();
    let json_bytes = json.len();
    let serialization_ms = started.elapsed().as_millis();
    drop(json);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("capacity.xlsx");
    let started = Instant::now();
    assert_eq!(
        xlsx::export(
            &OperationResult::History(result),
            path.to_str().unwrap(),
            false
        )
        .unwrap(),
        rows
    );
    println!(
        "CAPACITY {}",
        serde_json::json!({"dates":dates,"pairs":pairs,"dataRows":rows,"physicalRequests":count.load(Ordering::Relaxed),"sparse":sparse,"retrievalMs":retrieval_ms,"serializationMs":serialization_ms,"jsonBytes":json_bytes,"workbookMs":started.elapsed().as_millis(),"workbookBytes":std::fs::metadata(path).unwrap().len()})
    );
}
#[tokio::test]
async fn delayed_history_cancellation_latency() {
    let transport = synthetic(10, false, Duration::from_millis(200));
    let count = transport.count.clone();
    let client = YtmService::with_transport(transport);
    let token = CancellationToken::new();
    let request = client.history_with_cancellation(
        HistoryInput::new(DateSelection::dates(vec!["2020-01-01".parse().unwrap()]).unwrap()),
        token.clone(),
    );
    let cancel = async {
        while count.load(Ordering::Relaxed) == 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        let now = Instant::now();
        token.cancel();
        now
    };
    let (result, cancelled) = tokio::join!(request, cancel);
    assert!(result.is_err());
    assert_eq!(count.load(Ordering::Relaxed), 1);
    assert!(cancelled.elapsed() < Duration::from_millis(100));
    println!(
        "CANCELLATION latency_us={}",
        cancelled.elapsed().as_micros()
    );
}
