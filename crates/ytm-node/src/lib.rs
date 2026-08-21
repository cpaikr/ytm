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
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use ytm_core::{HttpTransport, KindsInput, MatrixInput, Transport, YtmError, YtmService};

enum Operation {
    Matrix(MatrixInput),
    Kinds(KindsInput),
}

#[napi(js_name = "matrix")]
fn matrix(
    env: Env,
    input_json: String,
    signal: Option<AbortSignal>,
    pre_aborted: Option<bool>,
) -> napi::Result<AsyncBlock<String>> {
    let input: MatrixInput = serde_json::from_str(&input_json)
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
    let input: KindsInput = serde_json::from_str(&input_json)
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
    match std::panic::catch_unwind(|| serde_json::to_string(&YtmService::capabilities())) {
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
    let service = YtmService::new(transport);
    match operation {
        Operation::Matrix(input) => service
            .matrix(input, cancellation)
            .await
            .map(|value| serde_json::to_value(value).expect("matrix result serializes")),
        Operation::Kinds(input) => service
            .kinds(input, cancellation)
            .await
            .map(|value| serde_json::to_value(value).expect("kinds result serializes")),
    }
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
