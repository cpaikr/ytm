use super::*;
use crate::{DateSelection, HistoryInput, YtmService};
use std::sync::Mutex;
use tokio::{io::AsyncWriteExt, net::TcpListener};

fn xml(rows: &str) -> Vec<u8> {
    format!(r#"<Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters><Dataset id="output1"><Rows>{rows}</Rows></Dataset></Root>"#).into_bytes()
}

fn fixture(request: &str) -> Vec<u8> {
    if request.starts_with("POST /rateInfo/ytmMatrixMobileInitList.do ") {
        return xml(r#"<Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row>"#);
    }
    let mut row = String::from(
        r#"<Row><Col id="pricingGroupCode">001</Col><Col id="pricingGroupName">synthetic</Col>"#,
    );
    for (key, _) in crate::model::TENORS {
        row.push_str(&format!(r#"<Col id="{key}">-0.500</Col>"#));
    }
    row.push_str("</Row>");
    xml(&row)
}

async fn history_sequence(
    fail_at: Option<usize>,
    interrupted_body: bool,
) -> (Result<crate::HistoryResult, YtmError>, Vec<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let captures = Arc::new(Mutex::new(Vec::new()));
    let server_captures = captures.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = super::tests::read_request(&mut socket).await;
            let index = {
                let mut captures = server_captures.lock().unwrap();
                let index = captures.len();
                captures.push(request.clone());
                index
            };
            let response = if Some(index) == fail_at {
                if interrupted_body {
                    b"HTTP/1.1 200 OK\r\nContent-Length: 9999\r\nConnection: close\r\n\r\n<Root>partial".to_vec()
                } else {
                    super::tests::response(503, &[], b"")
                }
            } else {
                super::tests::response(200, &[], &fixture(&request))
            };
            socket.write_all(&response).await.unwrap();
        }
    });
    let mut transport = HttpTransport::new().unwrap();
    transport.origin = Some(origin);
    transport.jitter = |_| 0;
    let result = YtmService::with_transport(transport)
        .history(HistoryInput::new(
            DateSelection::dates(vec![
                "2026-06-08".parse().unwrap(),
                "2026-06-09".parse().unwrap(),
            ])
            .unwrap(),
        ))
        .await;
    server.abort();
    let requests = captures.lock().unwrap().clone();
    (result, requests)
}

#[tokio::test]
async fn real_http_history_recovers_only_the_failed_lookup() {
    let (expected, baseline) = history_sequence(None, false).await;
    let mut expected = expected.unwrap();
    let statistics = expected.statistics.take().unwrap();
    assert_eq!(statistics.physical_attempt_count, Some(18));
    assert_eq!(statistics.retry_count, Some(0));
    assert!(statistics.finished);
    let expected = serde_json::to_value(expected).unwrap();
    assert_eq!(baseline.len(), 18);
    for (fail_at, interrupted) in [(16, false), (0, false), (16, true)] {
        let (actual, requests) = history_sequence(Some(fail_at), interrupted).await;
        if let Err(error) = &actual {
            eprintln!(
                "reproduction failure: {}",
                serde_json::to_string(&error.details).unwrap()
            );
            eprintln!(
                "physical lookups observed: {} (failed index {fail_at})",
                requests.len()
            );
        }
        let mut actual = actual.unwrap();
        let statistics = actual.statistics.take().unwrap();
        assert_eq!(statistics.physical_attempt_count, Some(19));
        assert_eq!(statistics.retry_count, Some(1));
        assert_eq!(statistics.scanned_date_count, 2);
        assert_eq!(statistics.discovery_count, 2);
        assert_eq!(statistics.matrix_lookup_count, 16);
        assert!(statistics.finished);
        assert_eq!(serde_json::to_value(actual).unwrap(), expected);
        assert_eq!(requests.len(), baseline.len() + 1);
        assert_eq!(
            requests[fail_at],
            requests[fail_at + 1],
            "retry must be byte-identical"
        );
        // Host differs between independently bound servers; compare source path and XML body.
        let identities = |items: Vec<String>| {
            items
                .into_iter()
                .map(|item| {
                    (
                        item.lines().next().unwrap().to_owned(),
                        item.split_once("\r\n\r\n").unwrap().1.to_owned(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut deduplicated = requests;
        deduplicated.remove(fail_at);
        assert_eq!(identities(deduplicated), identities(baseline.clone()));
    }
}

struct Scenario {
    transport: HttpTransport,
    requests: Arc<Mutex<Vec<String>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Scenario {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Scenario {
    async fn new(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = super::tests::read_request(&mut socket).await;
                let index = {
                    let mut captures = captured.lock().unwrap();
                    let index = captures.len();
                    captures.push(request);
                    index
                };
                let response = &responses[index.min(responses.len() - 1)];
                let _ = socket.write_all(response).await;
            }
        });
        let mut transport = HttpTransport::new().unwrap();
        transport.origin = Some(origin);
        transport.jitter = |_| 0;
        Self {
            transport,
            requests,
            server,
        }
    }

    async fn lookup(&self, timeout: Duration) -> Result<Vec<u8>, YtmError> {
        self.transport
            .post_with_context(
                crate::request::matrix("20260609", "70"),
                RetrievalContext::new(
                    RetrievalOptions::new(timeout).unwrap(),
                    CancellationToken::new(),
                )
                .unwrap(),
            )
            .await
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn http(status: u16, body: &[u8]) -> Vec<u8> {
    super::tests::response(status, &[], body)
}

#[tokio::test]
async fn retries_exactly_the_status_allowlist_and_stops_at_three_attempts() {
    for status in [408, 429, 500, 502, 503, 504] {
        let scenario = Scenario::new(vec![http(status, b""), http(200, b"ok")]).await;
        assert_eq!(
            scenario.lookup(Duration::from_secs(5)).await.unwrap(),
            b"ok"
        );
        assert_eq!(scenario.count(), 2, "status {status}");
        {
            let requests = scenario.requests.lock().unwrap();
            assert_eq!(requests[0], requests[1]);
        }
        let exhausted = Scenario::new(vec![http(status, b"")]).await;
        let error = exhausted.lookup(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(exhausted.count(), 3);
        assert_eq!(error.details.actual, Some(serde_json::json!(status)));
        assert_eq!(
            error.details.retry.unwrap(),
            RetryDetails {
                attempt_count: 3,
                max_attempts: 3,
                source_operation: "listYtmMatrix".into(),
                stop_reason: RetryStopReason::AttemptExhaustion
            }
        );
    }
    for status in [204, 301, 302, 400, 401, 403, 404, 409, 501, 505] {
        let scenario = Scenario::new(vec![http(status, b""), http(200, b"ok")]).await;
        let error = scenario.lookup(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(scenario.count(), 1, "status {status}");
        assert_eq!(
            error.details.retry.unwrap().stop_reason,
            RetryStopReason::TerminalFailure
        );
    }
}

#[tokio::test]
async fn body_network_faults_recover_but_complete_corrupt_compression_is_terminal() {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(b"body").unwrap();
    let compressed = encoder.finish().unwrap();
    let mut network_truncated =
        super::tests::response(200, &[("Content-Encoding", "gzip")], &compressed);
    network_truncated.truncate(network_truncated.len() - 4);
    for truncated in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 30\r\nConnection: close\r\n\r\npartial".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10\r\npartial"
            .to_vec(),
        network_truncated,
    ] {
        let scenario = Scenario::new(vec![truncated, http(200, b"complete")]).await;
        assert_eq!(
            scenario.lookup(Duration::from_secs(5)).await.unwrap(),
            b"complete"
        );
        assert_eq!(scenario.count(), 2);
    }
    for corrupt in [
        b"not gzip".to_vec(),
        compressed[..compressed.len() - 4].to_vec(),
    ] {
        let scenario = Scenario::new(vec![
            super::tests::response(200, &[("Content-Encoding", "gzip")], &corrupt),
            http(200, b"ok"),
        ])
        .await;
        let error = scenario.lookup(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(scenario.count(), 1);
        assert_eq!(
            error.details.retry.unwrap().stop_reason,
            RetryStopReason::TerminalFailure
        );
    }
}

#[tokio::test]
async fn response_validation_and_protocol_failures_are_not_replayed() {
    for (body, expected) in [
        (b"malformed".to_vec(), "source_format_error"),
        (
            xml("<Row><Col id=\"bad\">data</Col></Row>"),
            "source_format_error",
        ),
        (xml(""), "source_data_unavailable"),
        (
            String::from_utf8(xml(""))
                .unwrap()
                .replace(">0</Parameter>", ">17</Parameter>")
                .into_bytes(),
            "source_protocol_error",
        ),
    ] {
        let scenario = Scenario::new(vec![
            http(200, &body),
            http(200, &fixture("POST /rateInfo/ytmMatrixMobileInitList.do ")),
        ])
        .await;
        let service = YtmService::with_transport(scenario.transport.clone());
        let error = service
            .kinds(crate::KindsInput::for_date("2026-06-09".parse().unwrap()))
            .await
            .unwrap_err();
        assert_eq!(error.details.code, expected);
        assert_eq!(scenario.count(), 1);
        if expected == "source_data_unavailable" {
            assert!(error.details.retry.is_none());
        } else {
            assert_eq!(error.details.retry.unwrap().attempt_count, 1);
        }
    }
    for response in [
        super::tests::response(200, &[("Content-Type", "text/html")], b"no"),
        http(200, &vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1]),
    ] {
        let scenario = Scenario::new(vec![response, http(200, b"ok")]).await;
        assert_eq!(
            scenario
                .lookup(Duration::from_secs(5))
                .await
                .unwrap_err()
                .details
                .code,
            "source_format_error"
        );
        assert_eq!(scenario.count(), 1);
    }
}

#[tokio::test]
async fn provider_wait_beyond_budget_preserves_failure_without_sleep_or_replay() {
    for value in [
        "60",
        "184467440737095516160",
        "Fri, 31 Dec 9999 23:59:59 GMT",
    ] {
        let scenario = Scenario::new(vec![super::tests::response(
            503,
            &[("Retry-After", value)],
            b"",
        )])
        .await;
        let started = Instant::now();
        let error = scenario.lookup(Duration::from_secs(5)).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(scenario.count(), 1);
        assert_eq!(error.details.actual, Some(serde_json::json!(503)));
        assert_eq!(
            error.details.retry.unwrap().stop_reason,
            RetryStopReason::OperationDeadline
        );
    }
}

#[test]
fn provider_guidance_and_schedule_are_bounded_without_wall_clock_waits() {
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(784111777);
    assert_eq!(retry_after("2", now), Some(Duration::from_secs(2)));
    assert_eq!(
        retry_after("Sun, 06 Nov 1994 08:49:39 GMT", now),
        Some(Duration::from_secs(2))
    );
    for value in ["-1", "1.5", "bogus", "Sun, 06 Nov 1994 08:49:36 GMT", ""] {
        assert_eq!(retry_after(value, now), None);
    }
    assert_eq!(
        retry_after("18446744073709551616", now),
        Some(Duration::MAX)
    );
    assert_eq!(
        [
            jitter_cap_ms(&RetrievalOptions::default(), 1),
            jitter_cap_ms(&RetrievalOptions::default(), 2)
        ],
        [500, 1000]
    );
    assert_eq!(
        full_jitter(&RetrievalOptions::default(), 1, |_| 0),
        Duration::ZERO
    );
    assert_eq!(
        full_jitter(&RetrievalOptions::default(), 1, |cap| cap),
        Duration::from_millis(500)
    );
    assert_eq!(
        full_jitter(&RetrievalOptions::default(), 2, |cap| cap),
        Duration::from_millis(1000)
    );
    let start = Instant::now();
    let deadline = start + Duration::from_secs(1);
    assert_eq!(
        retry_wake(start, Duration::from_millis(999), deadline),
        Some(start + Duration::from_millis(999))
    );
    assert_eq!(retry_wake(start, Duration::from_secs(1), deadline), None);
    assert_eq!(retry_wake(start, Duration::MAX, deadline), None);
}

#[tokio::test(start_paused = true)]
async fn retry_wait_obeys_guidance_deadline_and_cancellation_in_virtual_time() {
    let context = RetrievalContext::new(
        RetrievalOptions::new(Duration::from_secs(10)).unwrap(),
        CancellationToken::new(),
    )
    .unwrap();
    let start = Instant::now();
    let wake = start + Duration::from_secs(2).max(Duration::from_millis(500));
    wait_for_retry(&context, wake).await.unwrap();
    assert_eq!(Instant::now() - start, Duration::from_secs(2));
    assert_eq!(
        wait_for_retry(&context, context.deadline()).await,
        Err(RetryStopReason::OperationDeadline)
    );
    let token = CancellationToken::new();
    let context = RetrievalContext::new(RetrievalOptions::default(), token.clone()).unwrap();
    token.cancel();
    assert_eq!(
        wait_for_retry(&context, context.deadline()).await,
        Err(RetryStopReason::Cancellation)
    );
}

#[tokio::test]
async fn refused_connections_retry_but_arbitrary_urls_and_builder_errors_do_not() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let mut transport = HttpTransport::new().unwrap();
    transport.origin = Some(origin.clone());
    transport.jitter = |_| 0;
    let error = transport
        .post(crate::request::init("20260609"), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.details.cause.as_deref(), Some("ConnectError"));
    assert_eq!(error.details.retry.unwrap().attempt_count, 3);
    transport.origin = None;
    let mut request = crate::request::init("20260609");
    request.url = origin;
    let error = transport
        .post(request.clone(), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.details.retry.unwrap().attempt_count, 1);
    request.url = ":invalid:".into();
    let error = transport
        .post(request, CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(
        error.details.retry.unwrap().stop_reason,
        RetryStopReason::TerminalFailure
    );
}

#[tokio::test]
async fn overall_deadline_stops_send_and_body_and_retains_prior_source_failure() {
    for (prior_failure, partial_body) in
        [(false, false), (false, true), (true, false), (true, true)]
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let captures = count.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                super::tests::read_request(&mut socket).await;
                let index = captures.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if prior_failure && index == 0 {
                    socket.write_all(&http(503, b"")).await.unwrap();
                    continue;
                }
                if partial_body {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
                        .await
                        .unwrap();
                }
                std::future::pending::<()>().await;
            }
        });
        let mut transport = HttpTransport::new().unwrap();
        transport.origin = Some(origin);
        transport.jitter = |_| 0;
        let caller = CancellationToken::new();
        let context = RetrievalContext::new(
            RetrievalOptions::new(Duration::from_millis(250)).unwrap(),
            caller.clone(),
        )
        .unwrap();
        let child = context.cancellation();
        let error = transport
            .post_with_context(crate::request::init("20260609"), context)
            .await
            .unwrap_err();
        assert!(!caller.is_cancelled());
        assert!(child.is_cancelled());
        assert_eq!(
            count.load(std::sync::atomic::Ordering::SeqCst),
            if prior_failure { 2 } else { 1 }
        );
        let retry = error.details.retry.unwrap();
        assert_eq!(retry.stop_reason, RetryStopReason::OperationDeadline);
        assert_eq!(retry.attempt_count, if prior_failure { 2 } else { 1 });
        if prior_failure {
            assert_eq!(error.details.actual, Some(serde_json::json!(503)));
        } else {
            assert_eq!(error.details.cause.as_deref(), Some("TimeoutError"));
        }
        server.abort();
    }
}

#[tokio::test]
async fn caller_cancellation_during_send_body_or_wait_never_retries() {
    for stage in ["send", "body", "wait"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (ready, observed) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            super::tests::read_request(&mut socket).await;
            if stage == "body" {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
                    .await
                    .unwrap();
            } else if stage == "wait" {
                socket
                    .write_all(&super::tests::response(503, &[("Retry-After", "10")], b""))
                    .await
                    .unwrap();
            }
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let mut transport = HttpTransport::new().unwrap();
        transport.origin = Some(origin);
        let caller = CancellationToken::new();
        let cancellation = caller.clone();
        let client = tokio::spawn(async move {
            transport
                .post(crate::request::init("20260609"), cancellation)
                .await
        });
        observed.await.unwrap();
        if stage == "wait" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        caller.cancel();
        let error = client.await.unwrap().unwrap_err();
        assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
        assert!(!error.details.retryable);
        assert_eq!(
            error.details.retry.unwrap().stop_reason,
            RetryStopReason::Cancellation
        );
        server.abort();
    }
}

#[tokio::test]
async fn attempt_timeout_retries_without_resetting_the_invocation_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (ready, received) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let request = super::tests::read_request(&mut first).await;
        ready.send(()).unwrap();
        let (mut second, _) = listener.accept().await.unwrap();
        assert_eq!(super::tests::read_request(&mut second).await, request);
        second.write_all(&http(200, b"recovered")).await.unwrap();
    });
    let mut transport = HttpTransport::new().unwrap();
    transport.origin = Some(origin);
    transport.jitter = |_| 0;
    let client = tokio::spawn(async move {
        transport
            .post(crate::request::init("20260609"), CancellationToken::new())
            .await
    });
    received.await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(REQUEST_DEADLINE_SECONDS)).await;
    tokio::time::resume();
    assert_eq!(client.await.unwrap().unwrap(), b"recovered");
    server.await.unwrap();
}

#[cfg(feature = "judge-fixtures")]
#[test]
fn judge_routing_accepts_only_numeric_loopback_origins() {
    for origin in ["http://127.0.0.1:1234", "http://[::1]:1234/"] {
        assert!(HttpTransport::with_loopback_origin(origin).is_ok());
    }
    for origin in [
        "https://127.0.0.1",
        "http://localhost:1234",
        "http://192.0.2.1",
        "http://user@127.0.0.1",
        "http://127.0.0.1/path",
        "http://127.0.0.1?x=1",
        "http://127.0.0.1#fragment",
    ] {
        assert!(
            HttpTransport::with_loopback_origin(origin).is_err(),
            "{origin}"
        );
    }
}

#[test]
fn configurable_jitter_preserves_defaults_and_caps_overflow() {
    let policy = |retries, base, maximum| {
        RetrievalOptions::default()
            .with_request_policy(
                retries,
                Duration::from_millis(base),
                Duration::from_millis(maximum),
                Duration::ZERO,
            )
            .unwrap()
    };
    let options = policy(10, 3, 20);
    assert_eq!(
        (1..=10)
            .map(|attempt| jitter_cap_ms(&options, attempt))
            .collect::<Vec<_>>(),
        [3, 6, 12, 20, 20, 20, 20, 20, 20, 20]
    );
    assert_eq!(full_jitter(&options, 3, |_| 0), Duration::ZERO);
    assert_eq!(
        full_jitter(&options, 3, |cap| cap),
        Duration::from_millis(12)
    );
    assert_eq!(full_jitter(&policy(0, 0, 0), 1, |cap| cap), Duration::ZERO);
    // Platforms may reject this duration at the monotonic-clock boundary.
    if let Ok(largest) = RetrievalOptions::default().with_request_policy(
        10,
        Duration::from_millis(u64::MAX),
        Duration::from_millis(u64::MAX),
        Duration::ZERO,
    ) {
        assert_eq!(jitter_cap_ms(&largest, 10), u64::MAX);
        assert_eq!(jitter_cap_ms(&largest, u8::MAX), u64::MAX);
    }
}

#[tokio::test(start_paused = true)]
async fn pacing_and_retry_waits_overlap_and_partial_waits_are_counted_once() {
    let progress = crate::RetrievalProgress::new();
    let caller = CancellationToken::new();
    let options = RetrievalOptions::new(Duration::from_secs(10))
        .unwrap()
        .with_request_policy(
            2,
            Duration::from_millis(500),
            Duration::from_secs(1),
            Duration::from_secs(2),
        )
        .unwrap()
        .with_progress(progress.clone());
    let context = RetrievalContext::new(options, caller.clone()).unwrap();
    assert!(
        context.pacing_wake().unwrap().is_none(),
        "first attempt has no pacing wait"
    );
    context.record_attempt("initializeYtmMatrix", 1, 3).unwrap();
    tokio::time::advance(Duration::from_millis(100)).await;
    let retry_ready = Instant::now() + Duration::from_millis(500);
    let wake = context.pacing_wake().unwrap().unwrap().max(retry_ready);
    {
        let _waiting = context.progress().wait();
        wait_for_retry(&context, wake).await.unwrap();
    }
    assert_eq!(progress.snapshot().unwrap().waiting_ms, 1900);
    assert_eq!(progress.snapshot().unwrap().elapsed_ms, 2000);
    context.record_attempt("initializeYtmMatrix", 2, 3).unwrap();
    // A different logical lookup shares the same physical-start pacing clock.
    context.clear_lookup().unwrap();
    let wake = context.pacing_wake().unwrap().unwrap();
    {
        let _waiting = context.progress().wait();
        tokio::time::advance(Duration::from_millis(400)).await;
        assert_eq!(progress.snapshot().unwrap().waiting_ms, 2300);
        caller.cancel();
        assert_eq!(
            wait_for_retry(&context, wake).await,
            Err(RetryStopReason::Cancellation)
        );
    }
    let error = context
        .complete::<()>(Err(YtmError::cancelled("history")), "history")
        .unwrap_err();
    let final_stats = error.details.statistics.unwrap();
    assert_eq!(final_stats.waiting_ms, 2300);
    assert_eq!(final_stats.physical_attempt_count, Some(2));
    assert_eq!(final_stats.retry_count, Some(1));
    assert!(final_stats.finished);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(progress.snapshot().unwrap(), final_stats);
}

#[tokio::test(start_paused = true)]
async fn combined_wait_deadline_and_dropped_future_freeze_actual_wait() {
    let progress = crate::RetrievalProgress::new();
    let context = RetrievalContext::new(
        RetrievalOptions::new(Duration::from_secs(2))
            .unwrap()
            .with_progress(progress.clone()),
        CancellationToken::new(),
    )
    .unwrap();
    {
        let _waiting = context.progress().wait();
        assert_eq!(
            wait_for_retry(&context, Instant::now() + Duration::from_secs(3)).await,
            Err(RetryStopReason::OperationDeadline)
        );
    }
    let error = context
        .complete::<()>(Err(YtmError::operation_deadline("history")), "history")
        .unwrap_err();
    assert_eq!(error.details.statistics.unwrap().waiting_ms, 2000);

    let dropped = crate::RetrievalProgress::new();
    let context = RetrievalContext::new(
        RetrievalOptions::default().with_progress(dropped.clone()),
        CancellationToken::new(),
    )
    .unwrap();
    let waiting = context.progress().wait();
    tokio::time::advance(Duration::from_millis(75)).await;
    drop(waiting);
    drop(context);
    let frozen = dropped.snapshot().unwrap();
    assert!(frozen.finished);
    assert_eq!(frozen.waiting_ms, 75);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(dropped.snapshot().unwrap(), frozen);
}

#[tokio::test]
async fn retry_limits_and_success_failure_summaries_match_final_progress() {
    for retries in [0, 1, 4, 10] {
        let scenario = Scenario::new(vec![http(503, b"")]).await;
        let progress = crate::RetrievalProgress::new();
        let options = RetrievalOptions::default()
            .with_request_policy(retries, Duration::ZERO, Duration::ZERO, Duration::ZERO)
            .unwrap()
            .with_progress(progress.clone());
        let error = YtmService::with_transport(scenario.transport.clone())
            .kinds_with_options(
                crate::KindsInput::for_date("2026-06-09".parse().unwrap()),
                options,
            )
            .await
            .unwrap_err();
        assert_eq!(scenario.count(), usize::from(retries) + 1);
        assert_eq!(error.details.actual, Some(serde_json::json!(503)));
        let retry = error.details.retry.unwrap();
        assert_eq!(retry.max_attempts, retries + 1);
        assert_eq!(retry.stop_reason, RetryStopReason::AttemptExhaustion);
        let statistics = error.details.statistics.unwrap();
        assert_eq!(
            statistics.physical_attempt_count,
            Some(u64::from(retries) + 1)
        );
        assert_eq!(statistics.retry_count, Some(u64::from(retries)));
        assert_eq!(statistics.waiting_ms, 0);
        assert_eq!(statistics, progress.snapshot().unwrap());
    }
    let scenario = Scenario::new(vec![
        http(503, b""),
        http(200, &fixture("POST /rateInfo/ytmMatrixMobileInitList.do ")),
    ])
    .await;
    let progress = crate::RetrievalProgress::new();
    let result = YtmService::with_transport(scenario.transport.clone())
        .kinds_with_options(
            crate::KindsInput::for_date("2026-06-09".parse().unwrap()),
            RetrievalOptions::default().with_progress(progress.clone()),
        )
        .await
        .unwrap();
    let statistics = result.statistics.unwrap();
    assert_eq!(statistics.physical_attempt_count, Some(2));
    assert_eq!(statistics.retry_count, Some(1));
    assert_eq!(statistics.waiting_ms, 0);
    assert_eq!(statistics, progress.snapshot().unwrap());
}

#[tokio::test]
async fn real_http_pacing_can_be_cancelled_between_successful_lookups() {
    let scenario = Scenario::new(vec![http(
        200,
        &fixture("POST /rateInfo/ytmMatrixMobileInitList.do "),
    )])
    .await;
    let progress = crate::RetrievalProgress::new();
    let caller = CancellationToken::new();
    let options = RetrievalOptions::default()
        .with_request_policy(2, Duration::ZERO, Duration::ZERO, Duration::from_secs(5))
        .unwrap()
        .with_progress(progress.clone());
    let service = YtmService::with_transport(scenario.transport.clone());
    let token = caller.clone();
    let task = tokio::spawn(async move {
        service
            .matrix_with_options_and_cancellation(
                crate::MatrixInput::new("2026-06-09".parse().unwrap(), "10".parse().unwrap()),
                options,
                token,
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if progress
                .snapshot()
                .is_some_and(|stats| stats.matrix_lookup_count == 1 && stats.waiting_ms > 0)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    caller.cancel();
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
    let statistics = error.details.statistics.unwrap();
    assert_eq!(statistics.physical_attempt_count, Some(1));
    assert_eq!(statistics.retry_count, Some(0));
    assert!(statistics.waiting_ms > 0);
    assert_eq!(statistics, progress.snapshot().unwrap());
    assert_eq!(scenario.count(), 1);
}

const BULK_BASELINE_ATTEMPTS: u64 = 250 + 180 * 8;
const BULK_INJECTED_RETRIES: u64 = 14;

async fn synthetic_bulk(
    inject_failures: bool,
) -> (
    crate::HistoryResult,
    Vec<String>,
    Vec<crate::RetrievalStatistics>,
) {
    use std::collections::{HashMap, HashSet};
    let end: crate::BaseDate = "2026-06-09".parse().unwrap();
    let dates: Vec<_> = (0..250)
        .map(|offset| end.checked_sub_days(offset).unwrap())
        .collect();
    let offsets: HashMap<_, _> = dates
        .iter()
        .enumerate()
        .map(|(index, date)| (date.compact(), index))
        .collect();
    let progress = crate::RetrievalProgress::new();
    let observed = progress.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut server = tokio::spawn(async move {
        let mut requests = Vec::new();
        let mut snapshots = Vec::new();
        let mut failed = HashSet::new();
        let total = BULK_BASELINE_ATTEMPTS
            + if inject_failures {
                BULK_INJECTED_RETRIES
            } else {
                0
            };
        for _ in 0..total {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = super::tests::read_request(&mut socket).await;
            let column = |name| {
                let prefix = format!("<Col id=\"{name}\">");
                request
                    .split_once(&prefix)
                    .unwrap()
                    .1
                    .split_once("</Col>")
                    .unwrap()
                    .0
                    .to_owned()
            };
            let date = column("calBaseDt");
            let kind = column("cboYtmSort");
            let offset = offsets[&date];
            let discovery = request.starts_with("POST /rateInfo/ytmMatrixMobileInitList.do ");
            let key = (discovery, date.clone(), kind.clone());
            let statistics = observed.snapshot().unwrap();
            let completed_before_date = (offset / 7) * 5 + (offset % 7).min(5);
            assert_eq!(
                statistics.completed_qualifying_date_count, completed_before_date,
                "the current date must not complete before its last category response"
            );
            assert!(!statistics.finished);
            snapshots.push(statistics);
            let fail = inject_failures
                && ((discovery && offset % 37 == 0)
                    || (!discovery && kind == "10" && offset % 29 == 0))
                && failed.insert(key);
            let response = if fail {
                http(503, b"")
            } else if (discovery && offset % 7 >= 5)
                || (!discovery && kind == "80" && offset % 11 == 0)
            {
                http(200, &xml(""))
            } else if discovery {
                http(200, &fixture(&request))
            } else {
                let value = if kind == "70" {
                    "-".to_owned()
                } else {
                    format!("{}.{}", offset, kind)
                };
                let mut row = String::from(
                    r#"<Row><Col id="pricingGroupCode">001</Col><Col id="pricingGroupName">synthetic</Col>"#,
                );
                for (tenor, _) in crate::model::TENORS {
                    row.push_str(&format!(r#"<Col id="{tenor}">{value}</Col>"#));
                }
                row.push_str("</Row>");
                http(200, &xml(&row))
            };
            requests.push(request);
            socket.write_all(&response).await.unwrap();
        }
        (requests, snapshots)
    });
    let mut transport = HttpTransport::new().unwrap();
    transport.origin = Some(origin);
    transport.jitter = |_| 0;
    let options = RetrievalOptions::new(Duration::from_secs(120))
        .unwrap()
        .with_request_policy(
            2,
            Duration::ZERO,
            Duration::ZERO,
            if inject_failures {
                Duration::from_millis(1)
            } else {
                Duration::ZERO
            },
        )
        .unwrap()
        .with_progress(progress.clone());
    let selection = crate::CountSelection::new(180, end, None).unwrap();
    let result = YtmService::with_transport(transport)
        .history_with_options(HistoryInput::new(selection), options)
        .await
        .unwrap();
    let joined = tokio::time::timeout(Duration::from_secs(5), &mut server).await;
    if joined.is_err() {
        server.abort();
        let _ = server.await;
        panic!("synthetic server did not observe the expected request count");
    }
    let (requests, mut snapshots) = joined.unwrap().unwrap();
    let final_stats = progress.snapshot().unwrap();
    assert_eq!(result.statistics.as_ref(), Some(&final_stats));
    snapshots.push(final_stats);
    (result, requests, snapshots)
}

#[tokio::test]
async fn deterministic_180_date_http_acceptance_preserves_selection_and_day_boundaries() {
    let (mut baseline, baseline_requests, _) = synthetic_bulk(false).await;
    let baseline_stats = baseline.statistics.take().unwrap();
    let (mut actual, requests, snapshots) = synthetic_bulk(true).await;
    let statistics = actual.statistics.take().unwrap();
    assert_eq!(statistics.scanned_date_count, 250);
    assert_eq!(statistics.completed_qualifying_date_count, 180);
    assert_eq!(statistics.discovery_count, 250);
    assert_eq!(statistics.matrix_lookup_count, 1440);
    assert_eq!(
        statistics.physical_attempt_count,
        Some(BULK_BASELINE_ATTEMPTS + BULK_INJECTED_RETRIES)
    );
    assert_eq!(statistics.retry_count, Some(BULK_INJECTED_RETRIES));
    // Slow loopback I/O may itself satisfy the configured interval.
    assert!(statistics.waiting_ms <= statistics.elapsed_ms);
    assert!(
        statistics.elapsed_ms < 120_000,
        "the accepted workload fits its retrieval deadline"
    );
    assert!(statistics.finished);
    assert_eq!(
        baseline_stats.physical_attempt_count,
        Some(BULK_BASELINE_ATTEMPTS)
    );
    assert_eq!(baseline_stats.retry_count, Some(0));
    assert_eq!(baseline_stats.waiting_ms, 0);
    assert_eq!(actual.requested_dates.len(), 180);
    assert!(actual
        .requested_dates
        .windows(2)
        .all(|pair| pair[0] < pair[1]));
    assert_eq!(actual.entries.len(), 180 * 8);
    assert!(actual.unavailable_count > 0);
    for entry in &actual.entries {
        if let crate::HistoryEntry::Available { matrix } = entry {
            if matrix.kind.code == "70" {
                assert!(matrix.rows[0].yields.values().all(Option::is_none));
            }
        }
    }
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(baseline).unwrap()
    );
    for pair in snapshots.windows(2) {
        assert!(pair[0].scanned_date_count <= pair[1].scanned_date_count);
        assert!(pair[0].completed_qualifying_date_count <= pair[1].completed_qualifying_date_count);
        assert!(pair[0].physical_attempt_count <= pair[1].physical_attempt_count);
        assert!(pair[0].retry_count <= pair[1].retry_count);
        assert!(pair[0].waiting_ms <= pair[1].waiting_ms);
        assert!(pair[0].elapsed_ms <= pair[1].elapsed_ms);
    }
    // Remove only byte-identical replays. Every other wire request must match
    // the unpaced baseline, including each complete date's category order.
    let identities = |requests: Vec<String>| {
        requests
            .into_iter()
            .map(|request| {
                (
                    request.lines().next().unwrap().to_owned(),
                    request.split_once("\r\n\r\n").unwrap().1.to_owned(),
                )
            })
            .collect::<Vec<_>>()
    };
    let mut deduplicated = identities(requests);
    deduplicated.dedup();
    assert_eq!(deduplicated, identities(baseline_requests));
}

#[tokio::test]
async fn terminal_history_failure_retains_only_completed_day_counters() {
    let catalog = http(200, &fixture("POST /rateInfo/ytmMatrixMobileInitList.do "));
    let matrix = http(200, &fixture("matrix"));
    let mut responses = vec![catalog.clone()];
    responses.extend(std::iter::repeat_n(matrix.clone(), 8));
    responses.extend([catalog, matrix, http(400, b"")]);
    let scenario = Scenario::new(responses).await;
    let progress = crate::RetrievalProgress::new();
    let selection = crate::CountSelection::new(2, "2026-06-09".parse().unwrap(), None).unwrap();
    let result = YtmService::with_transport(scenario.transport.clone())
        .history_with_options(
            HistoryInput::new(selection),
            RetrievalOptions::default().with_progress(progress.clone()),
        )
        .await;
    let error = result.unwrap_err();
    assert_eq!(error.details.code, "source_transport_error");
    assert_eq!(
        error.details.retry.unwrap().stop_reason,
        RetryStopReason::TerminalFailure
    );
    let stats = error.details.statistics.unwrap();
    assert_eq!(stats.scanned_date_count, 2);
    assert_eq!(stats.completed_qualifying_date_count, 1);
    assert_eq!(stats.matrix_lookup_count, 10);
    assert_eq!(stats.physical_attempt_count, Some(12));
    assert_eq!(stats.retry_count, Some(0));
    assert_eq!(scenario.count(), 12);
    assert!(stats.finished);
    assert_eq!(stats, progress.snapshot().unwrap());
}

#[tokio::test(start_paused = true)]
async fn real_http_combines_provider_guidance_and_pacing_without_adding_waits() {
    // Keep virtual time under explicit test control while loopback I/O is pending.
    let keep_awake = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    let mut scenario = Scenario::new(vec![
        super::tests::response(503, &[("Retry-After", "2")], b""),
        http(200, &fixture("POST /rateInfo/ytmMatrixMobileInitList.do ")),
        http(200, &fixture("matrix")),
    ])
    .await;
    scenario.transport.jitter = |cap| cap;
    let service = YtmService::with_transport(scenario.transport.clone());
    let progress = crate::RetrievalProgress::new();
    let options = RetrievalOptions::default()
        .with_request_policy(
            2,
            Duration::from_millis(500),
            Duration::from_millis(500),
            Duration::from_secs(1),
        )
        .unwrap()
        .with_progress(progress.clone());
    let task = tokio::spawn(async move {
        service
            .matrix_with_options(
                crate::MatrixInput::new("2026-06-09".parse().unwrap(), "10".parse().unwrap()),
                options,
            )
            .await
    });
    settle(|| progress.is_waiting()).await;
    assert_eq!(progress.snapshot().unwrap().physical_attempt_count, Some(1));
    tokio::time::advance(Duration::from_millis(1999)).await;
    assert_eq!(progress.snapshot().unwrap().physical_attempt_count, Some(1));
    tokio::time::advance(Duration::from_millis(1)).await;
    settle(|| {
        progress
            .snapshot()
            .is_some_and(|stats| stats.matrix_lookup_count == 1)
            && progress.is_waiting()
    })
    .await;
    assert_eq!(progress.snapshot().unwrap().physical_attempt_count, Some(2));
    tokio::time::advance(Duration::from_millis(999)).await;
    assert_eq!(progress.snapshot().unwrap().physical_attempt_count, Some(2));
    tokio::time::advance(Duration::from_millis(1)).await;
    settle(|| task.is_finished()).await;
    let statistics = task.await.unwrap().unwrap().statistics.unwrap();
    keep_awake.abort();
    assert_eq!(statistics.physical_attempt_count, Some(3));
    assert_eq!(statistics.retry_count, Some(1));
    assert_eq!(statistics.elapsed_ms, 3000);
    assert_eq!(statistics.waiting_ms, 3000);
    assert_eq!(scenario.count(), 3);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        progress.snapshot().unwrap(),
        statistics,
        "no timer survives final completion"
    );
}

async fn settle(condition: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "loopback test did not reach its synchronization point"
        );
        tokio::task::yield_now().await;
    }
}
