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
    BaseDate, CancellationToken, HttpTransport, KindSelector, KindsInput, LookbackDays,
    MatrixInput, Transport, YtmError, YtmService,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatrixInputDto {
    base_date: String,
    kind: Value,
    fallback: Option<String>,
    lookback_days: Option<u8>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KindsInputDto {
    base_date: Option<String>,
}

enum Operation {
    Matrix(MatrixInputDto),
    Kinds(KindsInputDto),
}

#[napi(js_name = "matrix")]
fn matrix(
    env: Env,
    input_json: String,
    signal: Option<AbortSignal>,
    pre_aborted: Option<bool>,
) -> napi::Result<AsyncBlock<String>> {
    let input: MatrixInputDto = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid matrix input JSON: {error}")))?;
    task(
        &env,
        Operation::Matrix(input),
        signal,
        pre_aborted.unwrap_or(false),
    )
}

#[napi(js_name = "kinds")]
fn kinds(
    env: Env,
    input_json: String,
    signal: Option<AbortSignal>,
    pre_aborted: Option<bool>,
) -> napi::Result<AsyncBlock<String>> {
    let input: KindsInputDto = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid kinds input JSON: {error}")))?;
    task(
        &env,
        Operation::Kinds(input),
        signal,
        pre_aborted.unwrap_or(false),
    )
}

#[napi]
fn describe() -> String {
    match std::panic::catch_unwind(|| {
        let mut value = serde_json::to_value(YtmService::capabilities())?;
        value
            .as_object_mut()
            .expect("capabilities serialize as an object")
            .insert("minimumNodeMajor".into(), json!(22));
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
        let result = AssertUnwindSafe(execute(operation, cancellation))
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

async fn execute(operation: Operation, cancellation: CancellationToken) -> Result<Value, YtmError> {
    let transport = transport()?;
    let service = YtmService::with_shared_transport(transport);
    match operation {
        Operation::Matrix(input) => service
            .matrix_with_cancellation(matrix_input(input)?, cancellation)
            .await
            .map(|value| serde_json::to_value(value).expect("matrix result serializes")),
        Operation::Kinds(input) => service
            .kinds_with_cancellation(kinds_input(input)?, cancellation)
            .await
            .map(|value| serde_json::to_value(value).expect("kinds result serializes")),
    }
}

fn matrix_input(input: MatrixInputDto) -> Result<MatrixInput, YtmError> {
    let base_date = parse_base_date(&input.base_date, "matrix")?;
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
        None | Some("exact") if input.lookback_days.is_none() => {
            Ok(MatrixInput::new(base_date, kind))
        }
        None | Some("exact") => Err(YtmError::invalid_parameter(
            "matrix",
            "lookbackDays",
            "lookbackDays only applies when fallback is previous-available.",
            json!(input.lookback_days),
        )),
        Some("previous-available") => {
            let raw = input.lookback_days.unwrap_or(10);
            let lookback = LookbackDays::new(raw).map_err(|_| {
                YtmError::invalid_parameter(
                    "matrix",
                    "lookbackDays",
                    "lookbackDays must be an integer from 1 to 31.",
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

fn kinds_input(input: KindsInputDto) -> Result<KindsInput, YtmError> {
    input
        .base_date
        .as_deref()
        .map(|value| parse_base_date(value, "kinds"))
        .transpose()
        .map(|base_date| KindsInput { base_date })
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
            base_date: "20260608".into(),
            kind: json!(10),
            fallback: Some("previous-available".into()),
            lookback_days: Some(7),
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
        assert_eq!(capabilities["minimumNodeMajor"], json!(22));
        assert_eq!(capabilities["fallback"], json!("previous-available"));
    }
}
