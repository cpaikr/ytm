use serde::Serialize;
use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetails {
    pub ok: bool,
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter: Option<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_input: Option<Value>,
    pub recovery_hint: String,
    pub recovery_action: &'static str,
    pub recoverable: bool,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_dates: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lookback_days: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

#[derive(Debug, Clone)]
pub struct YtmError {
    pub details: Box<ErrorDetails>,
}

impl fmt::Display for YtmError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.details.code, self.details.reason)
    }
}

impl std::error::Error for YtmError {}

impl YtmError {
    pub fn invalid_parameter(
        operation: &str,
        parameter: &str,
        reason: impl Into<String>,
        actual: Value,
    ) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "invalid_parameter",
            operation_name: Some(operation.to_owned()),
            parameter: Some(parameter.to_owned()),
            reason: reason.into(),
            expected: None,
            actual: Some(actual),
            example_input: None,
            recovery_hint: "Inspect command help and retry with a supported value.".into(),
            recovery_action: "inspect_command_help",
            recoverable: true,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
        })
    }

    pub fn unsupported_kind(actual: &str, expected: Value, example_input: Value) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "invalid_parameter",
            operation_name: Some("matrix".into()),
            parameter: Some("kind".into()),
            reason: format!("Unknown 종류: {actual}."),
            expected: Some(expected),
            actual: Some(Value::String(actual.to_owned())),
            example_input: Some(example_input),
            recovery_hint:
                "Use kinds to inspect accepted 종류 values, then retry with a listed code or label."
                    .into(),
            recovery_action: "inspect_command_help",
            recoverable: true,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
        })
    }

    pub fn transport(reason: impl Into<String>, status: Option<u16>, cause: Option<&str>) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "source_transport_error",
            operation_name: None,
            parameter: None,
            reason: reason.into(),
            expected: Some(Value::String(
                "A successful HTTP response from KIS-NET".into(),
            )),
            actual: status.map(|value| Value::from(u64::from(value))),
            example_input: None,
            recovery_hint: "Retry later or inspect whether KIS-NET is available.".into(),
            recovery_action: "inspect_tool_help",
            recoverable: true,
            retryable: true,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: cause.map(str::to_owned),
        })
    }

    pub fn format(reason: impl Into<String>) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "source_format_error",
            operation_name: None,
            parameter: None,
            reason: reason.into(),
            expected: Some(Value::String(
                "A valid KIS-NET Nexacro response matching the documented YTM Matrix schema".into(),
            )),
            actual: None,
            example_input: None,
            recovery_hint:
                "The KIS-NET source format may have changed; update the package before retrying."
                    .into(),
            recovery_action: "inspect_tool_help",
            recoverable: false,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
        })
    }

    pub fn protocol(code: String, message: Option<String>) -> Self {
        let suffix = message
            .as_ref()
            .map(|value| format!(" ({value})"))
            .unwrap_or_default();
        Self::new(ErrorDetails {
            ok: false,
            code: "source_protocol_error",
            operation_name: None,
            parameter: None,
            reason: format!("KIS-NET returned nonzero Nexacro ErrorCode {code}{suffix}."),
            expected: Some(Value::String("Nexacro ErrorCode 0".into())),
            actual: Some(Value::String(code.clone())),
            example_input: None,
            recovery_hint: "Inspect the preserved KIS-NET status before deciding whether the request can be retried.".into(),
            recovery_action: "inspect_tool_help",
            recoverable: false,
            retryable: false,
            source_error_code: Some(code),
            source_error_message: message,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
        })
    }

    pub fn unavailable(
        operation: &str,
        base_date: &str,
        kind: Option<&str>,
        attempted_dates: Vec<String>,
        lookback_days: u8,
        exhausted: bool,
    ) -> Self {
        let reason = if exhausted {
            format!("KIS-NET returned no YTM Matrix rows for {base_date} or the prior {lookback_days} calendar day(s).")
        } else if operation == "kinds" {
            format!("KIS-NET returned no 종류 values for {base_date}. It may be a weekend, holiday, or unavailable source date.")
        } else {
            format!("KIS-NET returned no YTM Matrix rows for {base_date}. It may be a weekend, holiday, or unavailable source date.")
        };
        let nearby_date = chrono::NaiveDate::parse_from_str(base_date, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.checked_sub_days(chrono::Days::new(1)))
            .map(|date| date.format("%Y-%m-%d").to_string());
        let example_input = if operation == "matrix" && exhausted {
            nearby_date
                .map(|date| serde_json::json!({ "baseDate": date, "kind": kind.unwrap_or("국채") }))
                .unwrap_or_else(|| serde_json::json!({ "kind": kind.unwrap_or("국채") }))
        } else if operation == "matrix" {
            serde_json::json!({
                "baseDate": base_date,
                "kind": kind.unwrap_or("국채"),
                "fallback": "previous-available",
                "lookbackDays": 10
            })
        } else {
            nearby_date
                .map(|date| serde_json::json!({ "baseDate": date }))
                .unwrap_or_else(|| serde_json::json!({}))
        };
        Self::new(ErrorDetails {
            ok: false,
            code: "source_data_unavailable",
            operation_name: Some(operation.to_owned()),
            parameter: Some("baseDate".into()),
            reason,
            expected: Some(Value::String(
                "KIS-NET data for an available business 기준일".into(),
            )),
            actual: Some(Value::String(base_date.to_owned())),
            example_input: Some(example_input),
            recovery_hint: if exhausted {
                "No data was found in the fallback window. Try a known business day, or increase lookbackDays up to 31."
            } else if operation == "kinds" {
                "Try a nearby business day."
            } else {
                "Try a nearby business day, or rerun matrix with fallback=previous-available."
            }
            .into(),
            recovery_action: if operation == "matrix" && !exhausted {
                "use_previous_available_fallback"
            } else {
                "try_nearby_business_day"
            },
            recoverable: true,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: Some(attempted_dates),
            lookback_days: Some(lookback_days),
            cause: None,
        })
    }

    pub fn defect() -> Self {
        Self::defect_with_reason("The native ytm core encountered an internal defect.")
    }

    pub fn defect_with_reason(reason: impl Into<String>) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "internal_error",
            operation_name: None,
            parameter: None,
            reason: reason.into(),
            expected: None,
            actual: None,
            example_input: None,
            recovery_hint:
                "Update the package or report the failure without including source response bodies."
                    .into(),
            recovery_action: "update_package",
            recoverable: false,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
        })
    }

    fn new(details: ErrorDetails) -> Self {
        Self {
            details: Box::new(details),
        }
    }
}
