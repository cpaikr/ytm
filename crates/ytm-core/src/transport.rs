use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{header, redirect::Policy, Client};
use tokio_util::sync::CancellationToken;

use crate::{YtmError, MAX_RESPONSE_BODY_BYTES, REQUEST_DEADLINE_SECONDS};

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
}

#[derive(Clone)]
pub struct HttpTransport {
    client: Client,
}

impl HttpTransport {
    pub fn new() -> Result<Self, YtmError> {
        let client = Client::builder()
            .redirect(Policy::none())
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
        Ok(Self { client })
    }

    pub fn shared() -> Result<Arc<dyn Transport>, YtmError> {
        Ok(Arc::new(Self::new()?))
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        if cancellation.is_cancelled() {
            return Err(YtmError::transport(
                "KIS-NET request was cancelled.",
                None,
                Some("AbortError"),
            ));
        }
        let send = self
            .client
            .post(&request.url)
            .header(header::CONTENT_TYPE, "text/xml; charset=UTF-8")
            .header(header::ACCEPT, "text/xml, */*")
            .body(request.body)
            .send();
        let response = tokio::select! {
            () = cancellation.cancelled() => return Err(YtmError::transport("KIS-NET request was cancelled.", None, Some("AbortError"))),
            result = send => result.map_err(|error| YtmError::transport("KIS-NET request failed before a response was received.", None, Some(error_name(&error))))?,
        };
        let status = response.status();
        if status.as_u16() != 200 {
            return Err(YtmError::transport(
                format!("KIS-NET returned HTTP {}.", status.as_u16()),
                Some(status.as_u16()),
                None,
            ));
        }
        if let Some(content_type) = response.headers().get(header::CONTENT_TYPE) {
            let valid = content_type.to_str().is_ok_and(is_nexacro_content_type);
            if !valid {
                return Err(YtmError::format(
                    "KIS-NET HTTP 200 response Content-Type must use text/xml; charset=UTF-8 when present.",
                ));
            }
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        loop {
            let next = tokio::select! {
                () = cancellation.cancelled() => return Err(YtmError::transport("KIS-NET response body read was cancelled.", None, Some("AbortError"))),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|error| {
                YtmError::transport(
                    "KIS-NET response body could not be read.",
                    None,
                    Some(error_name(&error)),
                )
            })?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
                return Err(YtmError::format(format!("KIS-NET response exceeds the maximum body size of {MAX_RESPONSE_BODY_BYTES} bytes.")));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
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
        assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
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

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
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

    fn response(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
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
