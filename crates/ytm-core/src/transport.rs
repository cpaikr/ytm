use std::{
    error::Error,
    io,
    sync::Arc,
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{header, redirect::Policy, Client};
use tokio::time::{sleep_until, Instant};
use tokio_util::sync::CancellationToken;

use crate::{
    RetrievalContext, RetrievalOptions, RetryDetails, RetryStopReason, YtmError,
    MAX_RESPONSE_BODY_BYTES, REQUEST_DEADLINE_SECONDS,
};

#[derive(Debug, Clone)]
pub struct PreparedRequest {
    pub operation: &'static str,
    pub path: &'static str,
    pub url: String,
    pub body: String,
}

#[async_trait]
pub trait Transport: Send + Sync {
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError>;

    /// Preserve the invocation deadline through decorators. Existing custom
    /// transports keep their own retry policy and need only implement `post`.
    async fn post_with_context(
        &self,
        request: PreparedRequest,
        context: RetrievalContext,
    ) -> Result<Vec<u8>, YtmError> {
        context.unknown_attempts()?;
        self.post(request, context.cancellation()).await
    }
}

#[derive(Clone)]
pub struct HttpTransport {
    client: Client,
    jitter: fn(u64) -> u64,
    #[cfg(any(test, feature = "judge-fixtures"))]
    origin: Option<String>,
}

struct AttemptFailure {
    error: YtmError,
    transient: bool,
    retry_after: Option<Duration>,
}

impl AttemptFailure {
    fn terminal(error: YtmError) -> Self {
        Self {
            error,
            transient: false,
            retry_after: None,
        }
    }

    fn dependency(error: reqwest::Error, reason: &str) -> Self {
        // Classify typed dependency evidence before projecting a sanitized error.
        let transient = transient_dependency_error(&error);
        Self {
            error: YtmError::transport(reason, None, Some(error_name(&error))),
            transient,
            retry_after: None,
        }
    }
}

impl HttpTransport {
    pub fn new() -> Result<Self, YtmError> {
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(REQUEST_DEADLINE_SECONDS))
            .user_agent(format!("ytm/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| {
                YtmError::transport(
                    "The KIS-NET HTTP client could not be initialized.",
                    None,
                    Some(error_name(&error)),
                )
            })?;
        Ok(Self {
            client,
            jitter: |cap| fastrand::u64(0..=cap),
            #[cfg(any(test, feature = "judge-fixtures"))]
            origin: None,
        })
    }

    #[cfg(feature = "judge-fixtures")]
    pub(crate) fn with_loopback_origin(origin: &str) -> Result<Self, YtmError> {
        let url = reqwest::Url::parse(origin)
            .map_err(|_| YtmError::defect_with_reason("Judge HTTP origin is invalid."))?;
        let loopback = url
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|address| address.is_loopback());
        if url.scheme() != "http"
            || !loopback
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(YtmError::defect_with_reason(
                "Judge HTTP origin must be a plain numeric loopback HTTP origin.",
            ));
        }
        let mut transport = Self::new()?;
        transport.origin = Some(url.as_str().trim_end_matches('/').to_owned());
        Ok(transport)
    }

    pub fn shared() -> Result<Arc<dyn Transport>, YtmError> {
        Ok(Arc::new(Self::new()?))
    }

    async fn retrieve(
        &self,
        request: PreparedRequest,
        context: RetrievalContext,
    ) -> Result<Vec<u8>, YtmError> {
        let operation = request.operation;
        context.clear_lookup()?;
        context.check(operation)?;
        let can_retry = replayable(&request);
        let max_attempts = if can_retry {
            context.options().max_retries() + 1
        } else {
            1
        };
        // Test routing occurs after replay eligibility: an arbitrary caller URL
        // never becomes a supported lookup merely by matching its operation name.
        #[cfg(any(test, feature = "judge-fixtures"))]
        let request = if let Some(origin) = &self.origin {
            PreparedRequest {
                url: format!("{origin}{}", request.path),
                ..request
            }
        } else {
            request
        };
        let cancellation = context.cancellation();
        let mut last_failure = None;
        let mut retry_ready = None;
        for attempt in 1..=max_attempts {
            if let Err(error) = context.check(operation) {
                let stop = if error.details.cause.as_deref() == Some("AbortError") {
                    RetryStopReason::Cancellation
                } else {
                    RetryStopReason::OperationDeadline
                };
                return Err(attach_retry(
                    last_failure.unwrap_or(error),
                    attempt - 1,
                    max_attempts,
                    operation,
                    stop,
                ));
            }
            let wake = context.pacing_wake()?.into_iter().chain(retry_ready).max();
            if let Some(wake) = wake.filter(|wake| *wake > Instant::now()) {
                let _waiting = context.progress().wait();
                if let Err(stop) = wait_for_retry(&context, wake).await {
                    let error = if stop == RetryStopReason::Cancellation {
                        YtmError::cancelled(operation)
                    } else {
                        last_failure.unwrap_or_else(|| YtmError::operation_deadline(operation))
                    };
                    return Err(attach_retry(
                        error,
                        attempt - 1,
                        max_attempts,
                        operation,
                        stop,
                    ));
                }
            }
            context.check(operation)?;
            context.record_attempt(operation, attempt, max_attempts)?;
            let attempt_deadline = context
                .deadline()
                .min(Instant::now() + Duration::from_secs(REQUEST_DEADLINE_SECONDS));
            let result = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(attach_retry(YtmError::cancelled(operation), attempt, max_attempts, operation, RetryStopReason::Cancellation)),
                () = sleep_until(attempt_deadline) => Err(AttemptFailure {
                    error: YtmError::transport("KIS-NET request exceeded its attempt deadline.", None, Some("TimeoutError")),
                    transient: true, retry_after: None,
                }),
                result = self.attempt(&request, attempt_deadline.saturating_duration_since(Instant::now())) => result,
            };
            let failure = match result {
                Ok(body) => return context.finish(Ok(body), operation),
                Err(failure) => failure,
            };
            if Instant::now() >= context.deadline() {
                return Err(attach_retry(
                    last_failure.unwrap_or(failure.error),
                    attempt,
                    max_attempts,
                    operation,
                    RetryStopReason::OperationDeadline,
                ));
            }
            if !failure.transient || attempt == max_attempts {
                return Err(attach_retry(
                    failure.error,
                    attempt,
                    max_attempts,
                    operation,
                    if failure.transient && can_retry {
                        RetryStopReason::AttemptExhaustion
                    } else {
                        RetryStopReason::TerminalFailure
                    },
                ));
            }
            let wait = full_jitter(context.options(), attempt, self.jitter)
                .max(failure.retry_after.unwrap_or(Duration::ZERO));
            let now = Instant::now();
            let Some(wake) = retry_wake(now, wait, context.deadline()) else {
                return Err(attach_retry(
                    failure.error,
                    attempt,
                    max_attempts,
                    operation,
                    RetryStopReason::OperationDeadline,
                ));
            };
            last_failure = Some(failure.error);
            retry_ready = Some(wake);
        }
        unreachable!("positive attempt limit always returns from its final attempt")
    }

    async fn attempt(
        &self,
        request: &PreparedRequest,
        timeout: Duration,
    ) -> Result<Vec<u8>, AttemptFailure> {
        let response = self
            .client
            .post(&request.url)
            .header(header::CONTENT_TYPE, "text/xml; charset=UTF-8")
            .header(header::ACCEPT, "text/xml, */*")
            .body(request.body.clone())
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| {
                AttemptFailure::dependency(
                    error,
                    "KIS-NET request failed before a response was received.",
                )
            })?;
        let status = response.status().as_u16();
        if status != 200 {
            let retry_after = response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| retry_after(value, SystemTime::now()));
            return Err(AttemptFailure {
                error: YtmError::transport(
                    format!("KIS-NET returned HTTP {status}."),
                    Some(status),
                    None,
                ),
                transient: matches!(status, 408 | 429 | 500 | 502 | 503 | 504),
                retry_after,
            });
        }
        if let Some(content_type) = response.headers().get(header::CONTENT_TYPE) {
            if !content_type.to_str().is_ok_and(is_nexacro_content_type) {
                return Err(AttemptFailure::terminal(YtmError::format("KIS-NET HTTP 200 response Content-Type must use text/xml; charset=UTF-8 when present.")));
            }
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                AttemptFailure::dependency(error, "KIS-NET response body could not be read.")
            })?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
                return Err(AttemptFailure::terminal(YtmError::format(format!("KIS-NET response exceeds the maximum body size of {MAX_RESPONSE_BODY_BYTES} bytes."))));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        self.post_with_context(
            request,
            RetrievalContext::new(RetrievalOptions::default(), cancellation)?,
        )
        .await
    }

    async fn post_with_context(
        &self,
        request: PreparedRequest,
        context: RetrievalContext,
    ) -> Result<Vec<u8>, YtmError> {
        let operation = request.operation;
        let result = self.retrieve(request, context.clone()).await;
        context.finish(result, operation)
    }
}

fn replayable(request: &PreparedRequest) -> bool {
    use crate::request::{INIT_PATH, MATRIX_PATH, SOURCE_ORIGIN};
    matches!(
        (request.operation, request.path),
        ("initializeYtmMatrix", INIT_PATH) | ("listYtmMatrix", MATRIX_PATH)
    ) && request.url == format!("{SOURCE_ORIGIN}{}", request.path)
}

fn attach_retry(
    mut error: YtmError,
    attempt_count: u8,
    max_attempts: u8,
    operation: &str,
    stop_reason: RetryStopReason,
) -> YtmError {
    error.details.operation_name = Some(operation.to_owned());
    if attempt_count > 0 {
        error.details.retry = Some(RetryDetails {
            attempt_count,
            max_attempts,
            source_operation: operation.to_owned(),
            stop_reason,
        });
    }
    error
}

fn retry_wake(now: Instant, wait: Duration, deadline: Instant) -> Option<Instant> {
    now.checked_add(wait).filter(|wake| *wake < deadline)
}

async fn wait_for_retry(context: &RetrievalContext, wake: Instant) -> Result<(), RetryStopReason> {
    let cancellation = context.cancellation();
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(RetryStopReason::Cancellation),
        () = sleep_until(context.deadline()) => Err(RetryStopReason::OperationDeadline),
        () = sleep_until(wake) => Ok(()),
    }
}

fn full_jitter(options: &RetrievalOptions, failed_attempt: u8, sample: fn(u64) -> u64) -> Duration {
    Duration::from_millis(sample(jitter_cap_ms(options, failed_attempt)))
}

fn jitter_cap_ms(options: &RetrievalOptions, failed_attempt: u8) -> u64 {
    // Accepted policies fit u64 milliseconds; calculate before narrowing so even
    // the largest accepted duration cannot overflow during exponential growth.
    options
        .base_backoff()
        .as_millis()
        .saturating_mul(
            1u128
                .checked_shl(u32::from(failed_attempt.saturating_sub(1)))
                .unwrap_or(u128::MAX),
        )
        .min(options.max_backoff().as_millis()) as u64
}

fn retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        // Overflowing but syntactically valid guidance must never cause an early retry.
        return Some(
            value
                .parse::<u64>()
                .map(Duration::from_secs)
                .unwrap_or(Duration::MAX),
        );
    }
    httpdate::parse_http_date(value)
        .ok()?
        .duration_since(now)
        .ok()
}

// Reqwest 0.13.4 wraps body-frame failures as Decode. Hyper 1.11.0 preserves
// framing I/O beneath its typed error, whereas tower-http returns decompressor
// I/O directly. Keep the pinned-source assumption covered by loopback tests.
fn transient_dependency_error(error: &reqwest::Error) -> bool {
    if error.is_timeout() {
        return true;
    }
    let mut source = error.source();
    let mut in_hyper = false;
    while let Some(error) = source {
        if let Some(error) = error.downcast_ref::<hyper::Error>() {
            if error.is_incomplete_message() {
                return true;
            }
            in_hyper = true;
        }
        if let Some(error) = error.downcast_ref::<io::Error>() {
            match error.kind() {
                io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionRefused
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::BrokenPipe
                | io::ErrorKind::Interrupted
                | io::ErrorKind::TimedOut => return true,
                // A decompressor can also emit UnexpectedEof; only the HTTP
                // transport's underlying I/O establishes a truncated response.
                io::ErrorKind::UnexpectedEof if in_hyper => return true,
                _ => {}
            }
        }
        source = error.source();
    }
    false
}

fn is_nexacro_content_type(value: &str) -> bool {
    let mut parts = value.split(';');
    if !parts
        .next()
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("text/xml"))
    {
        return false;
    }
    let Some(charset) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let Some((name, value)) = charset.split_once('=') else {
        return false;
    };
    name.trim().eq_ignore_ascii_case("charset") && value.trim().eq_ignore_ascii_case("UTF-8")
}

fn error_name(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "TimeoutError"
    } else if error.is_connect() {
        "ConnectError"
    } else {
        "RequestError"
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::{write::GzEncoder, Compression};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
        time::{sleep, Duration},
    };

    use super::*;

    #[tokio::test]
    async fn posts_required_headers_and_accepts_exact_http_200() {
        let (url, request) = server(response(
            200,
            &[("Content-Type", "text/xml; charset=UTF-8")],
            b"ok",
        ))
        .await;
        let body = HttpTransport::new()
            .unwrap()
            .post(prepared(url), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(body, b"ok");

        let request = request.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /probe http/1.1\r\n"));
        assert!(request.contains("\r\ncontent-type: text/xml; charset=utf-8\r\n"));
        assert!(request.contains("\r\naccept: text/xml, */*\r\n"));
        assert!(request.contains(&format!(
            "\r\nuser-agent: ytm/{}\r\n",
            env!("CARGO_PKG_VERSION")
        )));
        assert!(request.ends_with("<probe/>"));
    }

    #[tokio::test]
    async fn rejects_non_200_and_does_not_follow_redirects() {
        for (status, headers) in [
            (204, Vec::new()),
            (302, vec![("Location", "https://example.invalid/")]),
        ] {
            let (url, _) = server(response(status, &headers, b"")).await;
            let error = HttpTransport::new()
                .unwrap()
                .post(prepared(url), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.details.code, "source_transport_error");
            assert_eq!(error.details.actual, Some(serde_json::json!(status)));
        }
    }

    #[tokio::test]
    async fn accepts_missing_success_content_type_and_rejects_invalid_values() {
        let (url, _) = server(response(200, &[], b"ok")).await;
        let body = HttpTransport::new()
            .unwrap()
            .post(prepared(url), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(body, b"ok");

        for headers in [
            vec![("Content-Type", "text/html; charset=UTF-8")],
            vec![("Content-Type", "text/xml; charset=EUC-KR")],
            vec![("Content-Type", "text/xml")],
        ] {
            let (url, _) = server(response(200, &headers, b"ok")).await;
            let error = HttpTransport::new()
                .unwrap()
                .post(prepared(url), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.details.code, "source_format_error");
        }
        assert!(is_nexacro_content_type("TEXT/XML ; CHARSET = utf-8"));
    }

    #[tokio::test]
    async fn caps_the_decompressed_response_body() {
        for (size, succeeds) in [
            (MAX_RESPONSE_BODY_BYTES, true),
            (MAX_RESPONSE_BODY_BYTES + 1, false),
        ] {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(&vec![b'x'; size]).unwrap();
            let compressed = encoder.finish().unwrap();
            let (url, _) = server(response(
                200,
                &[
                    ("Content-Encoding", "gzip"),
                    ("Content-Type", "text/xml; charset=UTF-8"),
                ],
                &compressed,
            ))
            .await;
            let result = HttpTransport::new()
                .unwrap()
                .post(prepared(url), CancellationToken::new())
                .await;
            if succeeds {
                assert_eq!(result.unwrap().len(), size);
            } else {
                assert_eq!(result.unwrap_err().details.code, "source_format_error");
            }
        }
    }

    #[tokio::test]
    async fn cancels_an_in_flight_body_read() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/probe", listener.local_addr().unwrap());
        let (headers_sent, headers_received) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/xml; charset=UTF-8\r\nContent-Length: 10\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            headers_sent.send(()).unwrap();
            sleep(Duration::from_secs(2)).await;
        });

        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let client = tokio::spawn(async move {
            HttpTransport::new()
                .unwrap()
                .post(prepared(url), task_cancellation)
                .await
        });
        headers_received.await.unwrap();
        cancellation.cancel();
        let error = client.await.unwrap().unwrap_err();
        assert_eq!(error.details.code, "source_transport_error");
        assert_eq!(error.details.operation_name.as_deref(), Some("probe"));
        assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
        assert!(!error.details.recoverable);
        assert!(!error.details.retryable);
        server.abort();
    }

    fn prepared(url: String) -> PreparedRequest {
        PreparedRequest {
            operation: "probe",
            path: "/probe",
            url,
            body: "<probe/>".into(),
        }
    }

    async fn server(response: Vec<u8>) -> (String, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/probe", listener.local_addr().unwrap());
        let (request_sent, request_received) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            let _ = request_sent.send(request);
            socket.write_all(&response).await.unwrap();
        });
        (url, request_received)
    }

    pub(super) async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0; 1024];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0, "client closed before completing its request");
            bytes.extend_from_slice(&buffer[..count]);
            let Some(headers_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers_end = headers_end + 4;
            let headers = String::from_utf8_lossy(&bytes[..headers_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if bytes.len() >= headers_end + content_length {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }

    pub(super) fn response(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let reason = match status {
            200 => "OK",
            204 => "No Content",
            302 => "Found",
            _ => "Test",
        };
        let mut response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        )
        .into_bytes();
        for (name, value) in headers {
            response.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        response.extend_from_slice(b"\r\n");
        response.extend_from_slice(body);
        response
    }
}

#[cfg(test)]
mod recovery_tests;
