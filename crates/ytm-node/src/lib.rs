#![cfg_attr(test, allow(dead_code))]

#[cfg(all(feature = "judge-fixtures", not(debug_assertions)))]
compile_error!("the judge-fixtures transport cannot be compiled into a release artifact");

use std::{
    panic::AssertUnwindSafe,
    sync::{Arc, OnceLock},
};

use futures_util::FutureExt;
use napi::{
    bindgen_prelude::{AbortSignal, AsyncBlock, AsyncBlockBuilder},
    Env,
};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{json, Value};
use ytm_core::{
    BaseDate, CancellationToken, HistoryInput, HistoryRequest, HttpTransport, KindSelector,
    KindsInput, LookbackDays, MatrixInput, RetrievalOptions, RetrievalProgress, Transport,
    YtmError, YtmService, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS,
};

/// Native storage for a bounded metadata snapshot; no JavaScript references cross runtimes.
#[napi]
pub struct NativeProgress {
    inner: RetrievalProgress,
}

#[napi]
impl NativeProgress {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: RetrievalProgress::new(),
        }
    }
    #[napi]
    pub fn snapshot(&self) -> napi::Result<String> {
        serde_json::to_string(&self.inner.snapshot())
            .map_err(|_| napi::Error::from_reason("progress serialization failed"))
    }
}

impl Default for NativeProgress {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatrixInputDto {
    base_date: Value,
    kind: Value,
    fallback: Option<String>,
    lookback_days: Option<Value>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KindsInputDto {
    base_date: Option<String>,
}

enum Operation {
    History(HistoryRequest),
    Matrix(Box<MatrixInputDto>),
    Kinds(KindsInputDto),
}

#[napi(js_name = "history")]
fn history(
    env: Env,
    input_json: String,
    signal: Option<AbortSignal>,
    pre_aborted: Option<bool>,
    operation_timeout_ms: Option<f64>,
    request_policy_json: Option<String>,
    progress: Option<&NativeProgress>,
) -> napi::Result<AsyncBlock<String>> {
    let input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid history input JSON: {e}")))?;
    task(
        &env,
        Operation::History(input),
        signal,
        pre_aborted.unwrap_or(false),
        operation_timeout_ms,
        request_policy_json,
        progress.map(|progress| progress.inner.clone()),
    )
}

#[napi(js_name = "matrix")]
fn matrix(
    env: Env,
    input_json: String,
    signal: Option<AbortSignal>,
    pre_aborted: Option<bool>,
    operation_timeout_ms: Option<f64>,
    request_policy_json: Option<String>,
    progress: Option<&NativeProgress>,
) -> napi::Result<AsyncBlock<String>> {
    let input: MatrixInputDto = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid matrix input JSON: {error}")))?;
    task(
        &env,
        Operation::Matrix(Box::new(input)),
        signal,
        pre_aborted.unwrap_or(false),
        operation_timeout_ms,
        request_policy_json,
        progress.map(|progress| progress.inner.clone()),
    )
}

#[napi(js_name = "kinds")]
fn kinds(
    env: Env,
    input_json: String,
    signal: Option<AbortSignal>,
    pre_aborted: Option<bool>,
    operation_timeout_ms: Option<f64>,
    request_policy_json: Option<String>,
    progress: Option<&NativeProgress>,
) -> napi::Result<AsyncBlock<String>> {
    let input: KindsInputDto = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid kinds input JSON: {error}")))?;
    task(
        &env,
        Operation::Kinds(input),
        signal,
        pre_aborted.unwrap_or(false),
        operation_timeout_ms,
        request_policy_json,
        progress.map(|progress| progress.inner.clone()),
    )
}

#[napi]
fn describe() -> String {
    match std::panic::catch_unwind(|| {
        let mut value = serde_json::to_value(YtmService::capabilities())?;
        value
            .as_object_mut()
            .expect("capabilities serialize as an object")
            .insert("minimumNodeMajor".into(), json!(minimum_node_major()));
        serde_json::to_string(&value)
    }) {
        Ok(Ok(value)) => value,
        _ => serde_json::to_string(&error_envelope(YtmError::defect()))
            .expect("defect envelope serializes"),
    }
}

fn task(
    env: &Env,
    operation: Operation,
    signal: Option<AbortSignal>,
    pre_aborted: bool,
    operation_timeout_ms: Option<f64>,
    request_policy_json: Option<String>,
    progress: Option<RetrievalProgress>,
) -> napi::Result<AsyncBlock<String>> {
    let cancellation = CancellationToken::new();
    if pre_aborted {
        cancellation.cancel();
    }
    if let Some(signal) = signal {
        let token = cancellation.clone();
        signal.on_abort(move || token.cancel());
    }

    let future = async move {
        let result = AssertUnwindSafe(execute(
            operation,
            cancellation,
            operation_timeout_ms,
            request_policy_json,
            progress,
        ))
        .catch_unwind()
        .await;
        let envelope = match result {
            Ok(Ok(value)) => json!({ "ok": true, "value": value }),
            Ok(Err(error)) => error_envelope(error),
            Err(_) => error_envelope(YtmError::defect()),
        };
        serde_json::to_string(&envelope)
            .map_err(|_| napi::Error::from_reason("native result serialization failed"))
    };
    AsyncBlockBuilder::new(future).build(env)
}

async fn execute(
    operation: Operation,
    cancellation: CancellationToken,
    operation_timeout_ms: Option<f64>,
    request_policy_json: Option<String>,
    progress: Option<RetrievalProgress>,
) -> Result<Value, YtmError> {
    let mut options = retrieval_options("retrieval", operation_timeout_ms)?;
    if let Some(encoded) = request_policy_json {
        let (retries, base, maximum, interval): (u8, u64, u64, u64) =
            serde_json::from_str(&encoded).map_err(|_| {
                YtmError::invalid_parameter(
                    "retrieval",
                    "requestPolicy",
                    "Expected bounded integer retry and millisecond settings.",
                    Value::Null,
                )
            })?;
        options = options.with_request_policy(
            retries,
            std::time::Duration::from_millis(base),
            std::time::Duration::from_millis(maximum),
            std::time::Duration::from_millis(interval),
        )?;
    }
    if let Some(progress) = progress {
        options = options.with_progress(progress);
    }
    let transport = transport()?;
    let service = YtmService::with_shared_transport(transport);
    match operation {
        Operation::History(input) => service
            .history_with_options_and_cancellation(
                HistoryInput::try_from(input)?,
                options,
                cancellation,
            )
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|_| YtmError::defect())),
        Operation::Matrix(input) => service
            .matrix_with_options_and_cancellation(matrix_input(*input)?, options, cancellation)
            .await
            .map(|value| serde_json::to_value(value).expect("matrix result serializes")),
        Operation::Kinds(input) => service
            .kinds_with_options_and_cancellation(kinds_input(input)?, options, cancellation)
            .await
            .map(|value| serde_json::to_value(value).expect("kinds result serializes")),
    }
}

fn retrieval_options(
    operation: &str,
    milliseconds: Option<f64>,
) -> Result<RetrievalOptions, YtmError> {
    let Some(milliseconds) = milliseconds else {
        return Ok(RetrievalOptions::default());
    };
    let invalid = || {
        YtmError::invalid_parameter(operation, "operationTimeoutMs",
        "operationTimeoutMs must be a positive safe integer representable by the monotonic clock.", json!(milliseconds))
    };
    if !milliseconds.is_finite()
        || milliseconds <= 0.0
        || milliseconds.fract() != 0.0
        || milliseconds > 9_007_199_254_740_991.0
    {
        return Err(invalid());
    }
    RetrievalOptions::new(std::time::Duration::from_millis(milliseconds as u64))
        .map_err(|_| invalid())
}

fn matrix_input(input: MatrixInputDto) -> Result<MatrixInput, YtmError> {
    let base_date = base_date(&input.base_date, "matrix")?;
    let lookback_days = lookback_days(input.lookback_days.as_ref())?;
    let kind_text = match input.kind {
        Value::String(value) => value.trim().to_owned(),
        Value::Number(value) => value.to_string(),
        actual => {
            return Err(YtmError::invalid_parameter(
                "matrix",
                "kind",
                "kind must be a 종류 label or source code.",
                actual,
            ))
        }
    };
    let kind = KindSelector::new(&kind_text).map_err(|_| {
        YtmError::invalid_parameter("matrix", "kind", "kind must be nonempty.", json!(kind_text))
    })?;
    match input.fallback.as_deref() {
        None | Some("exact") if lookback_days.is_none() => Ok(MatrixInput::new(base_date, kind)),
        None | Some("exact") => Err(YtmError::invalid_parameter(
            "matrix",
            "lookbackDays",
            "lookbackDays only applies when fallback is previous-available.",
            input.lookback_days.expect("lookback value is present"),
        )),
        Some("previous-available") => {
            let raw = lookback_days.unwrap_or(DEFAULT_LOOKBACK_DAYS);
            let lookback = LookbackDays::new(raw).map_err(|_| {
                YtmError::invalid_parameter(
                    "matrix",
                    "lookbackDays",
                    format!("lookbackDays must be an integer from 1 to {MAX_LOOKBACK_DAYS}."),
                    json!(raw),
                )
            })?;
            Ok(MatrixInput::previous_available(base_date, kind, lookback))
        }
        Some(fallback) => Err(YtmError::invalid_parameter(
            "matrix",
            "fallback",
            "fallback must be exact or previous-available.",
            json!(fallback),
        )),
    }
}

fn lookback_days(value: Option<&Value>) -> Result<Option<u8>, YtmError> {
    let Some(value) = value else {
        return Ok(None);
    };
    value
        .as_u64()
        .and_then(|raw| u8::try_from(raw).ok())
        .map(Some)
        .ok_or_else(|| {
            YtmError::invalid_parameter(
                "matrix",
                "lookbackDays",
                format!("lookbackDays must be an integer from 1 to {MAX_LOOKBACK_DAYS}."),
                value.clone(),
            )
        })
}

fn base_date(value: &Value, operation: &str) -> Result<BaseDate, YtmError> {
    let text = value.as_str().ok_or_else(|| {
        YtmError::invalid_parameter(
            operation,
            "baseDate",
            "baseDate must use YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD and be a valid calendar date.",
            value.clone(),
        )
    })?;
    parse_base_date(text, operation)
}

fn minimum_node_major() -> u8 {
    env!("YTM_MINIMUM_NODE_MAJOR")
        .parse()
        .expect("build script exports a valid minimum Node major")
}

fn kinds_input(input: KindsInputDto) -> Result<KindsInput, YtmError> {
    match input.base_date.as_deref() {
        Some(value) => parse_base_date(value, "kinds").map(KindsInput::for_date),
        None => Ok(KindsInput::default()),
    }
}

fn parse_base_date(value: &str, operation: &str) -> Result<BaseDate, YtmError> {
    value.parse().map_err(|_| {
        YtmError::invalid_parameter(
            operation,
            "baseDate",
            "baseDate must use YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD and be a valid calendar date.",
            json!(value),
        )
    })
}

fn transport() -> Result<Arc<dyn Transport>, YtmError> {
    #[cfg(feature = "judge-fixtures")]
    if let Some(transport) = ytm_core::judge::FixtureTransport::from_env()? {
        return Ok(transport);
    }
    static SHARED: OnceLock<Arc<dyn Transport>> = OnceLock::new();
    if let Some(transport) = SHARED.get() {
        return Ok(transport.clone());
    }
    let transport = HttpTransport::shared()?;
    Ok(SHARED.get_or_init(|| transport).clone())
}

fn error_envelope(error: YtmError) -> Value {
    json!({ "ok": false, "error": error.details })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_dto_preserves_numeric_kind_and_previous_available() {
        let input = MatrixInputDto {
            base_date: json!("20260608"),
            kind: json!(10),
            fallback: Some("previous-available".into()),
            lookback_days: Some(json!(7)),
        };
        let input = matrix_input(input).unwrap();
        assert_eq!(input.base_date.to_string(), "2026-06-08");
        assert_eq!(input.kind.as_str(), "10");
        assert!(matches!(
            input.fallback,
            ytm_core::FallbackPolicy::PreviousAvailable(days) if days.get() == 7
        ));
    }

    #[test]
    fn node_capabilities_keep_node_runtime_projection_outside_core() {
        let capabilities: Value = serde_json::from_str(&describe()).unwrap();
        assert_eq!(
            capabilities["minimumNodeMajor"],
            json!(minimum_node_major())
        );
        assert_eq!(capabilities["fallback"], json!("previous-available"));
    }

    #[test]
    fn matrix_input_rejects_lookback_days_for_exact_fallback() {
        let error =
            matrix_input(dto(Some("exact"), Some(json!(5)), json!("20260608"))).unwrap_err();
        assert_eq!(error.details.parameter.as_deref(), Some("lookbackDays"));
    }

    #[test]
    fn matrix_input_rejects_unknown_fallback() {
        let error = matrix_input(dto(Some("nearest"), None, json!("20260608"))).unwrap_err();
        assert_eq!(error.details.parameter.as_deref(), Some("fallback"));
    }

    #[test]
    fn matrix_input_rejects_out_of_range_or_mistyped_lookback_days() {
        for value in [json!(0), json!(32), json!(300), json!(-1), json!(1.5)] {
            let error = matrix_input(dto(
                Some("previous-available"),
                Some(value),
                json!("20260608"),
            ))
            .unwrap_err();
            assert_eq!(error.details.parameter.as_deref(), Some("lookbackDays"));
        }
    }

    #[test]
    fn matrix_input_rejects_invalid_or_mistyped_base_date() {
        for value in [json!("2026-02-30"), json!(20260608)] {
            let error = matrix_input(dto(None, None, value)).unwrap_err();
            assert_eq!(error.details.parameter.as_deref(), Some("baseDate"));
        }
    }

    fn dto(
        fallback: Option<&str>,
        lookback_days: Option<Value>,
        base_date: Value,
    ) -> MatrixInputDto {
        MatrixInputDto {
            base_date,
            kind: json!("국채"),
            fallback: fallback.map(str::to_owned),
            lookback_days,
        }
    }
}

#[cfg(test)]
mod retrieval_option_tests {
    use super::*;
    #[test]
    fn defaults_and_numeric_boundaries_match_core() {
        assert_eq!(
            retrieval_options("history", None)
                .unwrap()
                .operation_timeout(),
            RetrievalOptions::default().operation_timeout()
        );
        assert_eq!(
            retrieval_options("history", Some(1.0))
                .unwrap()
                .operation_timeout(),
            std::time::Duration::from_millis(1)
        );
        for value in [
            0.0,
            -1.0,
            0.5,
            f64::NAN,
            f64::INFINITY,
            9_007_199_254_740_992.0,
        ] {
            assert_eq!(
                retrieval_options("history", Some(value))
                    .unwrap_err()
                    .details
                    .parameter
                    .as_deref(),
                Some("operationTimeoutMs")
            );
        }
    }
}
