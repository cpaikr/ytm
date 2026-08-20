#![cfg_attr(test, allow(dead_code))]

use std::{panic::AssertUnwindSafe, sync::OnceLock};

use napi::{
    bindgen_prelude::{AbortSignal, AsyncTask},
    Env, Task,
};
use napi_derive::napi;
use serde_json::{json, Value};
use tokio::runtime::Runtime;
use tokio_util::sync::CancellationToken;
use ytm_core::{HttpTransport, KindsInput, MatrixInput, Transport, YtmError, YtmService};

enum Operation {
    Matrix(MatrixInput),
    Kinds(KindsInput),
}

struct CoreTask {
    operation: Option<Operation>,
    cancellation: CancellationToken,
}

#[napi]
impl Task for CoreTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let operation = self
            .operation
            .take()
            .ok_or_else(|| napi::Error::from_reason("native task was already consumed"))?;
        let cancellation = self.cancellation.clone();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            runtime().block_on(async move {
                let transport = transport()?;
                let service = YtmService::new(transport);
                match operation {
                    Operation::Matrix(input) => {
                        service.matrix(input, cancellation).await.map(|value| {
                            serde_json::to_value(value).expect("matrix result serializes")
                        })
                    }
                    Operation::Kinds(input) => service
                        .kinds(input, cancellation)
                        .await
                        .map(|value| serde_json::to_value(value).expect("kinds result serializes")),
                }
            })
        }));
        let envelope = match result {
            Ok(Ok(value)) => json!({ "ok": true, "value": value }),
            Ok(Err(error)) => error_envelope(error),
            Err(_) => error_envelope(YtmError::defect()),
        };
        serde_json::to_string(&envelope)
            .map_err(|_| napi::Error::from_reason("native result serialization failed"))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "matrix")]
fn matrix(input_json: String, signal: Option<AbortSignal>) -> napi::Result<AsyncTask<CoreTask>> {
    let input: MatrixInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid matrix input JSON: {error}")))?;
    Ok(task(Operation::Matrix(input), signal))
}

#[napi(js_name = "kinds")]
fn kinds(input_json: String, signal: Option<AbortSignal>) -> napi::Result<AsyncTask<CoreTask>> {
    let input: KindsInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid kinds input JSON: {error}")))?;
    Ok(task(Operation::Kinds(input), signal))
}

#[napi]
fn describe() -> String {
    match std::panic::catch_unwind(|| serde_json::to_string(&YtmService::capabilities())) {
        Ok(Ok(value)) => value,
        _ => serde_json::to_string(&error_envelope(YtmError::defect()))
            .expect("defect envelope serializes"),
    }
}

fn task(operation: Operation, signal: Option<AbortSignal>) -> AsyncTask<CoreTask> {
    let cancellation = CancellationToken::new();
    if let Some(signal) = signal {
        let token = cancellation.clone();
        signal.on_abort(move || token.cancel());
    }
    AsyncTask::new(CoreTask {
        operation: Some(operation),
        cancellation,
    })
}

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| Runtime::new().expect("Tokio runtime initialization must succeed"))
}

fn transport() -> Result<std::sync::Arc<dyn Transport>, YtmError> {
    #[cfg(feature = "judge-fixtures")]
    if let Some(transport) = ytm_core::judge::FixtureTransport::from_env()? {
        return Ok(transport);
    }
    HttpTransport::shared()
}

fn error_envelope(error: YtmError) -> Value {
    json!({ "ok": false, "error": error.details })
}
