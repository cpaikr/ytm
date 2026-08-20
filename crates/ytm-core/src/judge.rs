//! Compile-time-only deterministic transport used by the repository parity judge.
//!
//! This module is absent from release builds. It exercises the same prepared
//! requests, response parser, and service code as the real HTTP transport.

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{PreparedRequest, Transport, YtmError};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    fixture_directory: PathBuf,
    #[serde(default)]
    steps: Vec<Step>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    path: Option<String>,
    fixture: Option<PathBuf>,
    body: Option<String>,
    status: Option<u16>,
    transport_error: Option<String>,
    replace: Option<Vec<(String, String)>>,
    pad_to_bytes: Option<usize>,
    bom: Option<usize>,
    invalid_utf8: Option<bool>,
    depth: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    url: String,
    method: &'static str,
    headers: CaptureHeaders,
    body: String,
    signal_present: bool,
    signal_aborted: bool,
}

#[derive(Debug, Serialize)]
struct CaptureHeaders {
    accept: &'static str,
    #[serde(rename = "content-type")]
    content_type: &'static str,
}

struct State {
    config: Config,
    next_step: usize,
    captures: Vec<Capture>,
    capture_path: Option<PathBuf>,
}

pub struct FixtureTransport {
    state: Mutex<State>,
}

impl FixtureTransport {
    pub fn from_env() -> Result<Option<Arc<dyn Transport>>, YtmError> {
        let Ok(encoded) = env::var("YTM_JUDGE_FIXTURE") else {
            return Ok(None);
        };
        let config = serde_json::from_str(&encoded).map_err(|error| {
            YtmError::defect_with_reason(format!(
                "Judge fixture configuration is invalid: {error}."
            ))
        })?;
        let capture_path = env::var_os("YTM_JUDGE_CAPTURE_PATH").map(PathBuf::from);
        let transport = Self {
            state: Mutex::new(State {
                config,
                next_step: 0,
                captures: Vec::new(),
                capture_path,
            }),
        };
        Ok(Some(Arc::new(transport)))
    }
}

#[async_trait]
impl Transport for FixtureTransport {
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        let mut state = self.state.lock().map_err(|_| YtmError::defect())?;
        let signal_aborted = cancellation.is_cancelled();
        state.captures.push(Capture {
            url: request.url.clone(),
            method: "POST",
            headers: CaptureHeaders {
                accept: "text/xml, */*",
                content_type: "text/xml; charset=UTF-8",
            },
            body: request.body,
            signal_present: true,
            signal_aborted,
        });
        persist_captures(&state)?;

        let step_index = state.next_step;
        state.next_step += 1;
        let step = state.config.steps.get(step_index).ok_or_else(|| {
            YtmError::defect_with_reason(format!(
                "Judge fixture received unexpected request {}.",
                request.url
            ))
        })?;
        if let Some(expected) = &step.path {
            if !request.url.ends_with(expected) {
                return Err(YtmError::defect_with_reason(format!(
                    "Judge fixture expected {expected}, received {}.",
                    request.url
                )));
            }
        }
        if step.transport_error.is_some() {
            return Err(YtmError::transport(
                "KIS-NET request failed before a response was received.",
                None,
                Some("TypeError"),
            ));
        }
        if signal_aborted {
            return Err(YtmError::transport(
                "KIS-NET request was cancelled.",
                None,
                Some("AbortError"),
            ));
        }
        let status = step.status.unwrap_or(200);
        if status != 200 {
            return Err(YtmError::transport(
                format!("KIS-NET returned HTTP {status}."),
                Some(status),
                None,
            ));
        }
        response_bytes(step, &state.config.fixture_directory)
    }
}

fn persist_captures(state: &State) -> Result<(), YtmError> {
    let Some(path) = &state.capture_path else {
        return Ok(());
    };
    let encoded = serde_json::to_vec(&state.captures).map_err(|_| YtmError::defect())?;
    fs::write(path, encoded).map_err(|error| {
        YtmError::defect_with_reason(format!(
            "Judge request capture could not be written: {error}."
        ))
    })
}

fn response_bytes(step: &Step, fixture_directory: &Path) -> Result<Vec<u8>, YtmError> {
    if let Some(depth) = step.depth {
        let extra_depth = depth.saturating_sub(2);
        let nesting = "<Extra>".repeat(extra_depth);
        let closing = "</Extra>".repeat(extra_depth);
        return Ok(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Root xmlns=\"http://www.nexacroplatform.com/platform/dataset\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"unrelated\">{nesting}{closing}</Dataset><Dataset id=\"output1\"><Rows><Row><Col id=\"divCode\">10</Col><Col id=\"divName\">국채</Col></Row></Rows></Dataset></Root>"
        )
        .into_bytes());
    }
    let mut bytes = if let Some(fixture) = &step.fixture {
        fs::read(fixture_directory.join(fixture)).map_err(|error| {
            YtmError::defect_with_reason(format!(
                "Judge fixture {} could not be read: {error}.",
                fixture.display()
            ))
        })?
    } else {
        step.body.clone().unwrap_or_default().into_bytes()
    };
    if let Some(replacements) = &step.replace {
        let mut text = String::from_utf8(bytes)
            .map_err(|_| YtmError::defect_with_reason("Judge replacement fixture is not UTF-8."))?;
        for (from, to) in replacements {
            text = text.replacen(from, to, 1);
        }
        bytes = text.into_bytes();
    }
    if let Some(target) = step.pad_to_bytes {
        let prefix = b"<!--";
        let suffix = b"-->";
        let padding = target
            .checked_sub(bytes.len() + prefix.len() + suffix.len())
            .ok_or_else(|| {
                YtmError::defect_with_reason(format!(
                    "Judge fixture cannot be padded down to {target} bytes."
                ))
            })?;
        bytes.extend_from_slice(prefix);
        bytes.extend(std::iter::repeat_n(b'x', padding));
        bytes.extend_from_slice(suffix);
    }
    if let Some(count) = step.bom {
        let mut prefixed = Vec::with_capacity(count.saturating_mul(3) + bytes.len());
        for _ in 0..count {
            prefixed.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        prefixed.extend_from_slice(&bytes);
        bytes = prefixed;
    }
    if step.invalid_utf8.unwrap_or(false) {
        bytes.push(0xff);
    }
    Ok(bytes)
}
