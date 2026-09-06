#[cfg(all(feature = "judge-fixtures", not(debug_assertions)))]
compile_error!("the judge-fixtures transport cannot be compiled into a release artifact");

mod panic_boundary;
use pyo3::{exceptions::PyRuntimeError, prelude::*};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    panic::AssertUnwindSafe,
    sync::{Arc, Condvar, Mutex, MutexGuard},
};
use tokio::sync::Notify;
use ytm_core::{
    BaseDate, CancellationToken, KindSelector, KindsInput, LookbackDays, MatrixInput, YtmError,
    YtmService,
};

#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
    service: Option<Arc<YtmService>>,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    drained: Condvar,
    changed: Notify,
    serial: tokio::sync::Mutex<()>,
    cancellation: CancellationToken,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        // No user code runs under this lock. After a caught initialization panic,
        // recover the state so close can still cancel and release resources.
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn close(&self) {
        self.cancellation.cancel();
        let mut state = self.state();
        state.closed = true;
        if state.active == 0 {
            state.service = None;
        }
    }

    fn begin(self: &Arc<Self>) -> Result<Call, Value> {
        let mut state = self.state();
        if state.closed {
            return Err(local_error("client_closed", "Client is closed."));
        }
        if state.service.is_none() {
            state.service = Some(Arc::new(service().map_err(|e| json!(e.details))?));
        }
        let service = state.service.as_ref().expect("service initialized").clone();
        state.active += 1;
        Ok(Call {
            service,
            cancellation: self.cancellation.child_token(),
            _registration: Registration(self.clone()),
        })
    }
}

struct Call {
    service: Arc<YtmService>,
    cancellation: CancellationToken,
    // Dropped last: cleanup waiters observe the service reference released.
    _registration: Registration,
}

impl Drop for Call {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

struct Registration(Arc<Inner>);

impl Drop for Registration {
    fn drop(&mut self) {
        let mut state = self.0.state();
        state.active -= 1;
        if state.active == 0 {
            if state.closed {
                state.service = None;
            }
            self.0.drained.notify_all();
            self.0.changed.notify_waiters();
        }
    }
}

#[pyclass]
struct NativeClient {
    inner: Arc<Inner>,
}

impl Drop for NativeClient {
    fn drop(&mut self) {
        self.inner.close();
    }
}

#[pymethods]
impl NativeClient {
    #[new]
    fn new() -> Self {
        Self {
            inner: Arc::new(Inner::default()),
        }
    }

    fn run_sync(&self, py: Python<'_>, operation: String, input: String) -> String {
        let inner = self.inner.clone();
        py.detach(move || {
            match panic_boundary::catch(AssertUnwindSafe(|| {
                pyo3_async_runtimes::tokio::get_runtime().block_on(run(inner, operation, input))
            })) {
                Ok(value) => value,
                Err(_) => defect(),
            }
        })
    }

    fn run_async<'py>(
        &self,
        py: Python<'py>,
        operation: String,
        input: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let inner = self.inner.clone();
        panic_boundary::catch(AssertUnwindSafe(|| {
            pyo3_async_runtimes::tokio::future_into_py(py, async move {
                Ok(
                    match panic_boundary::catch_future(run(inner, operation, input)).await {
                        Ok(value) => value,
                        Err(_) => defect(),
                    },
                )
            })
        }))
        .unwrap_or_else(|_| Err(PyRuntimeError::new_err("Native operation failed.")))
    }

    fn close_sync(&self, py: Python<'_>) -> PyResult<()> {
        let inner = self.inner.clone();
        py.detach(move || {
            panic_boundary::catch(AssertUnwindSafe(|| {
                inner.close();
                let mut state = inner.state();
                while state.active != 0 {
                    state = inner.drained.wait(state).unwrap_or_else(|e| e.into_inner());
                }
            }))
            .map_err(|_| PyRuntimeError::new_err("Native cleanup failed."))
        })
    }

    fn close_async<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let inner = self.inner.clone();
        // Closure takes effect even if the caller cancels the cleanup awaitable.
        panic_boundary::catch(AssertUnwindSafe(|| {
            inner.close();
            pyo3_async_runtimes::tokio::future_into_py(py, async move {
                panic_boundary::catch_future(async move {
                    loop {
                        let notified = inner.changed.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if inner.state().active == 0 {
                            break;
                        }
                        notified.await;
                    }
                })
                .await
                .map_err(|_| PyRuntimeError::new_err("Native cleanup failed."))
            })
        }))
        .unwrap_or_else(|_| Err(PyRuntimeError::new_err("Native cleanup failed.")))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    base_date: Option<String>,
    kind: Option<Value>,
    fallback: Option<String>,
    lookback_days: Option<Value>,
}

enum Operation {
    Matrix(MatrixInput),
    Kinds(KindsInput),
}

fn parse(operation: &str, input: &str) -> Result<Operation, YtmError> {
    let input: Input = serde_json::from_str(input)
        .map_err(|_| invalid(operation, "input", "Invalid input shape."))?;
    let date: Option<BaseDate> = input
        .base_date
        .map(|date| {
            date.parse()
                .map_err(|_| invalid(operation, "base_date", "Invalid calendar date."))
        })
        .transpose()?;
    match operation {
        "kinds"
            if input.kind.is_none()
                && input.fallback.is_none()
                && input.lookback_days.is_none() =>
        {
            Ok(Operation::Kinds(
                date.map(KindsInput::for_date).unwrap_or_default(),
            ))
        }
        "matrix" => {
            let date =
                date.ok_or_else(|| invalid(operation, "base_date", "A base date is required."))?;
            let kind = match input.kind {
                Some(Value::String(value)) => value,
                Some(Value::Number(value)) if value.is_i64() || value.is_u64() => value.to_string(),
                _ => {
                    return Err(invalid(
                        operation,
                        "kind",
                        "Kind must be a string or integer code.",
                    ))
                }
            };
            let kind = KindSelector::new(kind)
                .map_err(|_| invalid(operation, "kind", "Kind must be nonempty."))?;
            let result = match input.fallback.as_deref().unwrap_or("exact") {
                "exact" if input.lookback_days.is_none() => MatrixInput::new(date, kind),
                "previous-available" => {
                    let days = match input.lookback_days {
                        None => LookbackDays::default(),
                        Some(value) => value
                            .as_u64()
                            .and_then(|v| u8::try_from(v).ok())
                            .and_then(|v| LookbackDays::new(v).ok())
                            .ok_or_else(|| {
                                invalid(
                                    operation,
                                    "lookback_days",
                                    "Lookback days must be an integer from 1 to 31.",
                                )
                            })?,
                    };
                    MatrixInput::previous_available(date, kind, days)
                }
                "exact" => {
                    return Err(invalid(
                        operation,
                        "lookback_days",
                        "Lookback days requires previous-available fallback.",
                    ))
                }
                _ => {
                    return Err(invalid(
                        operation,
                        "fallback",
                        "Fallback must be exact or previous-available.",
                    ))
                }
            };
            Ok(Operation::Matrix(result))
        }
        _ => Err(invalid(operation, "operation", "Unsupported operation.")),
    }
}

async fn run(inner: Arc<Inner>, operation: String, input: String) -> String {
    let result = async {
        if inner.state().closed { return Err(local_error("client_closed", "Client is closed.")); }
        let operation = parse(&operation, &input).map_err(|e| json!(e.details))?;
        let call = inner.begin()?;
        let _serial = tokio::select! {
            biased;
            _ = call.cancellation.cancelled() => return Err(local_error("request_cancelled", "Request was cancelled.")),
            guard = inner.serial.lock() => guard,
        };
        #[cfg(feature = "judge-fixtures")]
        if std::env::var_os("YTM_PYTHON_JUDGE_PANIC").is_some() { panic!("injected binding defect"); }
        let result = match operation {
            Operation::Matrix(input) => call.service.matrix_with_cancellation(input, call.cancellation.clone()).await
                .and_then(|v| serde_json::to_value(v).map_err(|_| YtmError::defect())),
            Operation::Kinds(input) => call.service.kinds_with_cancellation(input, call.cancellation.clone()).await
                .and_then(|v| serde_json::to_value(v).map_err(|_| YtmError::defect())),
        };
        if call.cancellation.is_cancelled() { return Err(local_error("request_cancelled", "Request was cancelled.")); }
        result.map_err(|e| json!(e.details))
    }.await;
    match result {
        Ok(value) => json!({"ok": true, "value": value}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    }
}

fn invalid(operation: &str, parameter: &str, reason: &str) -> YtmError {
    YtmError::invalid_parameter(operation, parameter, reason, Value::Null)
}
fn local_error(code: &str, reason: &str) -> Value {
    json!({"code":code,"reason":reason,"retryable":false,"recoverable":false})
}
fn defect() -> String {
    json!({"ok":false,"error":YtmError::defect().details}).to_string()
}
fn service() -> Result<YtmService, YtmError> {
    #[cfg(feature = "judge-fixtures")]
    if let Some(transport) = ytm_core::judge::FixtureTransport::from_env()? {
        return Ok(YtmService::with_shared_transport(transport));
    }
    YtmService::new()
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    panic_boundary::install();
    module.add_class::<NativeClient>()?;
    module.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
