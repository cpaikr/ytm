use std::ffi::OsString;

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::Serialize;
use serde_json::{json, Map, Number, Value};
use ytm_core::{
    BaseDate, HistoryInput, HistoryRequest, HistoryResult, KindSelector, KindsInput, KindsResult,
    LookbackDays, MatrixInput, MatrixResult, YtmError, YtmService, DEFAULT_LOOKBACK_DAYS,
    MAX_LOOKBACK_DAYS,
};

#[cfg(test)]
mod capacity;
mod progress;
mod release_management;
mod table;
mod xlsx;

#[cfg(test)]
use table::{format_cell, Cell};

use release_management::UpgradeMode;

const FORMATS: [&str; 4] = ["json", "csv", "tsv", "xlsx"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, PartialEq, Eq)]
pub struct ProcessOutput {
    pub code: u8,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Operation {
    History,
    Matrix,
    Kinds,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::History => "history",
            Self::Matrix => "matrix",
            Self::Kinds => "kinds",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "history" => Some(Self::History),
            "matrix" => Some(Self::Matrix),
            "kinds" => Some(Self::Kinds),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Json,
    Csv,
    Tsv,
}

impl OutputFormat {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "json" => Some(Self::Json),
            "csv" => Some(Self::Csv),
            "tsv" => Some(Self::Tsv),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum OutputSelection {
    Text(OutputFormat),
    Xlsx { path: String, overwrite: bool },
}

#[derive(Debug)]
struct ParsedInvocation {
    operation: Operation,
    input: Map<String, Value>,
    output: OutputSelection,
    pretty: bool,
}

#[derive(Debug)]
enum ValidatedInput {
    History(HistoryInput),
    Matrix(MatrixInput),
    Kinds(KindsInput),
}

#[derive(Debug)]
enum OperationResult {
    History(HistoryResult),
    Matrix(MatrixResult),
    Kinds(KindsResult),
}

impl OperationResult {
    fn operation(&self) -> Operation {
        match self {
            Self::History(_) => Operation::History,
            Self::Matrix(_) => Operation::Matrix,
            Self::Kinds(_) => Operation::Kinds,
        }
    }

    fn into_json(self) -> Result<Value, YtmError> {
        match self {
            Self::History(result) => serialize_result(result),
            Self::Matrix(result) => serialize_result(result),
            Self::Kinds(result) => serialize_result(result),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliError {
    ok: bool,
    code: &'static str,
    operation_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameter: Option<String>,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actual: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    example_input: Option<Value>,
    recovery_hint: String,
    recovery_action: &'static str,
    recoverable: bool,
    retryable: bool,
}

#[derive(Debug)]
struct InvocationError {
    operation: Operation,
    error: Box<CliError>,
}

#[derive(Debug)]
enum ParseOutcome {
    Execute(ParsedInvocation),
    Management(UpgradeMode),
    Immediate(ProcessOutput),
    Invalid(InvocationError),
}

pub async fn run(args: Vec<OsString>) -> ProcessOutput {
    run_with_cancellation(args, ytm_core::CancellationToken::new()).await
}

pub async fn run_with_cancellation(
    args: Vec<OsString>,
    cancellation: ytm_core::CancellationToken,
) -> ProcessOutput {
    let tail = args
        .get(1..)
        .unwrap_or_default()
        .iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    let invocation = match parse_invocation(&args, &tail) {
        ParseOutcome::Execute(invocation) => invocation,
        ParseOutcome::Management(mode) => return release_management::run(mode).await,
        ParseOutcome::Immediate(output) => return output,
        ParseOutcome::Invalid(failure) => return invalid_output(failure),
    };
    let input = match validate_input(invocation.operation, &invocation.input) {
        Ok(input) => input,
        Err(error) => {
            return invalid_output(InvocationError {
                operation: invocation.operation,
                error,
            });
        }
    };

    if let OutputSelection::Xlsx { path, overwrite } = &invocation.output {
        if let Err(error) = xlsx::preflight(path, *overwrite) {
            return error.output(invocation.operation);
        }
    }
    let result = match execute(input, cancellation.clone()).await {
        Ok(result) => result,
        Err(error) => {
            return ProcessOutput {
                code: 1,
                stdout: encode_json(&json!({ "ok": false, "error": error.details }), false),
                stderr: String::new(),
            }
        }
    };
    if let OutputSelection::Xlsx { path, overwrite } = &invocation.output {
        let mut receipt = json!({ "format": "xlsx", "path": path });
        if let OperationResult::History(history) = &result {
            receipt["availableCount"] = json!(history.available_count);
            receipt["unavailableCount"] = json!(history.unavailable_count);
            receipt["dataRowCount"] = json!(history.data_row_count);
        }
        return match xlsx::export_with_cancellation(&result, path, *overwrite, &cancellation) {
            Ok(row_count) => stdout_output(
                0,
                encode_json(
                    &json!({
                        "ok": true, "operation": invocation.operation.name(),
                        "result": ({ receipt["rowCount"] = json!(row_count); receipt })
                    }),
                    invocation.pretty,
                ),
            ),
            Err(error) => error.output(invocation.operation),
        };
    }
    let OutputSelection::Text(format) = invocation.output else {
        unreachable!()
    };
    let output = success_output(result, format, invocation.pretty).and_then(|output| {
        if cancellation.is_cancelled() {
            Err(YtmError::cancelled(invocation.operation.name()))
        } else {
            Ok(output)
        }
    });
    match output {
        Ok(output) => output,
        Err(error) => ProcessOutput {
            code: 1,
            stdout: encode_json(&json!({ "ok": false, "error": error.details }), false),
            stderr: String::new(),
        },
    }
}

fn parse_invocation(args: &[OsString], tail: &[String]) -> ParseOutcome {
    if tail.is_empty() {
        return ParseOutcome::Immediate(stdout_output(0, root_help()));
    }

    let first = tail[0].as_str();
    if matches!(first, "--version" | "-V") && tail.len() == 1 {
        return ParseOutcome::Immediate(stdout_output(
            0,
            format!("ytm {}\n", env!("CARGO_PKG_VERSION")),
        ));
    }
    if first == "help" {
        return ParseOutcome::Immediate(help_invocation_output(tail));
    }
    if matches!(first, "--help" | "-h") {
        return ParseOutcome::Immediate(if tail.len() == 1 {
            stdout_output(0, root_help())
        } else {
            invalid_help_invocation_output(&tail[1..])
        });
    }
    if first == "upgrade" {
        return match tail {
            [_] => ParseOutcome::Management(UpgradeMode::Install),
            [_, flag] if flag == "--check" => ParseOutcome::Management(UpgradeMode::Check),
            [_, flag] if matches!(flag.as_str(), "--help" | "-h") => {
                ParseOutcome::Immediate(stdout_output(0, upgrade_help()))
            }
            _ => ParseOutcome::Immediate(invalid_upgrade_invocation_output(&tail[1..])),
        };
    }
    let Some(operation) = Operation::parse(first) else {
        return ParseOutcome::Immediate(unknown_command_output(first));
    };
    if help_requested(operation, &tail[1..]) {
        return match validate_operation_help(args, operation) {
            Ok(()) => ParseOutcome::Immediate(command_help_output(operation.name())),
            Err(error) => ParseOutcome::Invalid(InvocationError { operation, error }),
        };
    }

    let matches = match command().try_get_matches_from(args.iter().cloned()) {
        Ok(matches) => matches,
        Err(_) => {
            return ParseOutcome::Invalid(InvocationError {
                operation,
                error: Box::new(cli_error(
                    operation,
                    "invalid_request",
                    "input",
                    "Invalid command invocation.",
                    json!("supported CLI options"),
                    None,
                )),
            });
        }
    };
    let (_, subcommand) = matches
        .subcommand()
        .expect("known operation parsed as a Clap subcommand");
    match invocation_from_matches(operation, subcommand) {
        Ok(invocation) => ParseOutcome::Execute(invocation),
        Err(error) => ParseOutcome::Invalid(InvocationError { operation, error }),
    }
}

fn command() -> Command {
    Command::new("ytm")
        .disable_help_flag(true)
        .disable_version_flag(true)
        .subcommand(operation_command("history"))
        .subcommand(operation_command("matrix"))
        .subcommand(operation_command("kinds"))
}

fn operation_command(name: &'static str) -> Command {
    Command::new(name)
        .disable_help_flag(true)
        .arg(
            value_arg("base_date", "base-date").action(if name == "history" {
                ArgAction::Append
            } else {
                ArgAction::Set
            }),
        )
        .arg(value_arg("start_date", "start-date"))
        .arg(value_arg("end_date", "end-date"))
        .arg(value_arg("format", "format"))
        .arg(value_arg("output", "output"))
        .arg(
            Arg::new("overwrite")
                .long("overwrite")
                .action(ArgAction::SetTrue),
        )
        .arg(Arg::new("pretty").long("pretty").action(ArgAction::Count))
        .arg(value_arg("kind", "kind"))
        .arg(value_arg("fallback", "fallback"))
        .arg(value_arg("lookback_days", "lookback-days"))
}

fn value_arg(id: &'static str, long: &'static str) -> Arg {
    Arg::new(id)
        .long(long)
        .action(ArgAction::Set)
        .allow_hyphen_values(true)
        .num_args(1)
}

fn input_from_matches(matches: &ArgMatches, operation: Operation) -> Map<String, Value> {
    let mut input = Map::new();
    if operation == Operation::History {
        if let Some(values) = matches.get_many::<String>("base_date") {
            input.insert("baseDates".into(), json!(values.collect::<Vec<_>>()));
        }
    } else if let Some(value) = matches.get_one::<String>("base_date") {
        input.insert("baseDate".into(), Value::String(value.clone()));
    }
    for (flag, field) in [("start_date", "startDate"), ("end_date", "endDate")] {
        if let Some(value) = matches.get_one::<String>(flag) {
            input.insert(field.into(), json!(value));
        }
    }
    if let Some(value) = matches.get_one::<String>("kind") {
        input.insert("kind".into(), Value::String(value.clone()));
    }
    if let Some(value) = matches.get_one::<String>("fallback") {
        input.insert("fallback".into(), Value::String(value.clone()));
    }
    if let Some(value) = matches.get_one::<String>("lookback_days") {
        let parsed = if value.bytes().all(|byte| byte.is_ascii_digit()) {
            value
                .parse::<u64>()
                .ok()
                .map(Number::from)
                .map(Value::Number)
                .unwrap_or_else(|| Value::String(value.clone()))
        } else {
            Value::String(value.clone())
        };
        input.insert("lookbackDays".into(), parsed);
    }
    input
}

fn invocation_from_matches(
    operation: Operation,
    matches: &ArgMatches,
) -> Result<ParsedInvocation, Box<CliError>> {
    let output = parse_output(operation, matches, false)?
        .expect("execution parsing requires an output selection");
    Ok(ParsedInvocation {
        operation,
        input: input_from_matches(matches, operation),
        output,
        pretty: matches.get_count("pretty") > 0,
    })
}

fn parse_output(
    operation: Operation,
    matches: &ArgMatches,
    help: bool,
) -> Result<Option<OutputSelection>, Box<CliError>> {
    let format = matches
        .get_one::<String>("format")
        .map(String::as_str)
        .unwrap_or("json");
    let path = matches.get_one::<String>("output");
    let overwrite = matches.get_flag("overwrite");
    let invalid = |parameter, reason, actual| {
        Box::new(cli_error(
            operation,
            "invalid_parameter",
            parameter,
            reason,
            json!("--format xlsx --output <file.xlsx> [--overwrite]"),
            actual,
        ))
    };
    if !FORMATS.contains(&format) {
        return Err(Box::new(cli_error(
            operation,
            "invalid_parameter",
            "format",
            "Unsupported format.",
            json!(FORMATS),
            Some(json!(format)),
        )));
    }
    if format != "xlsx" {
        if path.is_some() || overwrite {
            return Err(invalid(
                if path.is_some() {
                    "output"
                } else {
                    "overwrite"
                },
                "File output options require --format xlsx.",
                None,
            ));
        }
        return Ok(Some(OutputSelection::Text(
            OutputFormat::parse(format).expect("validated text format"),
        )));
    }
    let Some(path) = path else {
        if help {
            return Ok(None);
        }
        return Err(invalid(
            "output",
            "XLSX requires --output <file.xlsx>.",
            None,
        ));
    };
    let file = std::path::Path::new(path);
    if path.ends_with(['/', '\\'])
        || file.file_stem().is_none_or(|stem| stem.is_empty())
        || !file
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
        || path.contains('\0')
    {
        return Err(invalid(
            "output",
            "Output must name a file ending in .xlsx.",
            Some(json!(path)),
        ));
    }
    Ok(Some(OutputSelection::Xlsx {
        path: path.clone(),
        overwrite,
    }))
}

fn help_requested(operation: Operation, args: &[String]) -> bool {
    let recognized = operation_command(operation.name())
        .get_arguments()
        .filter_map(|argument| {
            argument.get_long().map(|long| {
                (
                    format!("--{long}"),
                    argument
                        .get_num_args()
                        .is_some_and(|range| range.takes_values()),
                )
            })
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut index = 0;
    let mut requested = false;
    while index < args.len() {
        let (option, inline_value) = args[index]
            .split_once('=')
            .map_or((args[index].as_str(), None), |(option, value)| {
                (option, Some(value))
            });
        if matches!(args[index].as_str(), "--help" | "-h") {
            requested = true;
            index += 1;
        } else if let Some(takes_value) = recognized.get(option) {
            if *takes_value {
                if inline_value.is_some() {
                    index += 1;
                    continue;
                }
                let Some(value) = args.get(index + 1) else {
                    return false;
                };
                if value.starts_with("--") || value == "-h" {
                    return false;
                }
                index += 2;
            } else {
                if inline_value.is_some() {
                    return false;
                }
                index += 1;
            }
        } else {
            return false;
        }
    }
    requested
}

fn validate_operation_help(args: &[OsString], operation: Operation) -> Result<(), Box<CliError>> {
    let filtered = args
        .iter()
        .filter(|argument| !matches!(argument.to_str(), Some("--help" | "-h")))
        .cloned()
        .collect::<Vec<_>>();
    let matches = command().try_get_matches_from(filtered).map_err(|_| {
        Box::new(cli_error(
            operation,
            "invalid_request",
            "input",
            "Invalid command invocation.",
            json!("supported CLI options"),
            None,
        ))
    })?;
    let (_, subcommand) = matches
        .subcommand()
        .expect("known operation parsed as a Clap subcommand");
    parse_output(operation, subcommand, true)?;
    let mut input = input_from_matches(subcommand, operation);
    if operation == Operation::Matrix {
        input
            .entry("baseDate")
            .or_insert_with(|| json!("2000-01-01"));
        input.entry("kind").or_insert_with(|| json!("10"));
    }
    if operation == Operation::History
        && !input.contains_key("baseDates")
        && !input.contains_key("startDate")
        && !input.contains_key("endDate")
    {
        input.insert("baseDates".into(), json!(["2000-01-01"]));
    }
    validate_input(operation, &input).map(|_| ())
}

fn validate_input(
    operation: Operation,
    input: &Map<String, Value>,
) -> Result<ValidatedInput, Box<CliError>> {
    if operation == Operation::History {
        let parsed = serde_json::from_value::<HistoryRequest>(Value::Object(input.clone()))
            .map_err(|e| {
                YtmError::invalid_parameter(
                    "history",
                    "input",
                    format!("Invalid history input: {e}"),
                    Value::Null,
                )
            })
            .and_then(HistoryInput::try_from);
        return parsed.map(ValidatedInput::History).map_err(|e| {
            Box::new(validation_error(
                operation,
                "invalid_parameter",
                e.details.parameter.as_deref(),
                e.details.reason,
                e.details.expected,
                e.details.actual,
                e.details.recovery_hint,
            ))
        });
    }
    let allowed = match operation {
        Operation::Matrix => &["baseDate", "kind", "fallback", "lookbackDays"][..],
        Operation::Kinds => &["baseDate"][..],
        Operation::History => unreachable!(),
    };
    for key in input.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(Box::new(validation_error(
                operation,
                "unknown_parameter",
                Some(key),
                format!("Unknown parameter: {key}."),
                Some(json!(allowed)),
                Some(Value::String(key.clone())),
                format!("Remove {key} or inspect command help for supported parameters."),
            )));
        }
    }

    let missing_base_date = |actual| {
        Box::new(validation_error(
            operation,
            "missing_parameter",
            Some("baseDate"),
            "Missing required parameter: baseDate.",
            Some(json!({
                "type": "string",
                "description": "기준일. Accepted forms: YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD."
            })),
            actual,
            "Provide baseDate.",
        ))
    };
    let base_date = match input.get("baseDate") {
        Some(value) if operation == Operation::Matrix && required_value_is_missing(value) => {
            return Err(missing_base_date(Some(safe_actual(value))));
        }
        Some(value) => Some(parse_base_date(operation, value)?),
        None if operation == Operation::Matrix => {
            return Err(missing_base_date(Some(Value::String("[missing]".into()))));
        }
        None => None,
    };

    if operation == Operation::Kinds {
        return Ok(ValidatedInput::Kinds(match base_date {
            Some(base_date) => KindsInput::for_date(base_date),
            None => KindsInput::default(),
        }));
    }

    let missing_kind = |actual| {
        Box::new(validation_error(
            operation,
            "missing_parameter",
            Some("kind"),
            "Missing required parameter: kind.",
            Some(json!({
                "type": ["string", "number"],
                "description": "종류. Use a Korean source label such as 국채 or a source code such as 10."
            })),
            actual,
            "Provide kind.",
        ))
    };
    let kind_value = match input.get("kind") {
        Some(value) if required_value_is_missing(value) => {
            return Err(missing_kind(Some(safe_actual(value))));
        }
        Some(value) => value,
        None => return Err(missing_kind(Some(Value::String("[missing]".into())))),
    };
    let kind_text = match kind_value {
        Value::String(value) => value.trim().to_owned(),
        Value::Number(value) => stringify_kind_number(value),
        actual => {
            return Err(Box::new(validation_error(
                operation,
                "invalid_parameter",
                Some("kind"),
                "kind must be a 종류 label or source code.",
                Some(json!("string or number")),
                Some(safe_actual(actual)),
                "Use kinds to inspect accepted 종류 values, then retry with a code like 10 or label like 국채.",
            )));
        }
    };
    let kind = KindSelector::new(kind_text).map_err(|_| {
        Box::new(validation_error(
            operation,
            "missing_parameter",
            Some("kind"),
            "Missing required parameter: kind.",
            Some(json!({
                "type": ["string", "number"],
                "description": "종류. Use a Korean source label such as 국채 or a source code such as 10."
            })),
            Some(Value::String("".into())),
            "Provide kind.",
        ))
    })?;

    let fallback = input.get("fallback");
    if let Some(actual) = fallback.filter(|value| value.as_str() != Some("previous-available")) {
        return Err(Box::new(validation_error(
            operation,
            "invalid_parameter",
            Some("fallback"),
            "fallback must be previous-available.",
            Some(json!(["previous-available"])),
            Some(safe_actual(actual)),
            "Use fallback=previous-available, or omit fallback for exact-date behavior.",
        )));
    }

    let lookback = match input.get("lookbackDays") {
        Some(actual) if fallback.is_none() => {
            return Err(Box::new(validation_error(
                operation,
                "invalid_parameter",
                Some("lookbackDays"),
                "lookbackDays only applies when fallback is previous-available.",
                Some(json!({
                    "fallback": "previous-available",
                    "lookbackDays": format!("integer 1-{MAX_LOOKBACK_DAYS}")
                })),
                Some(safe_actual(actual)),
                "Add fallback=previous-available, or remove lookbackDays for exact-date behavior.",
            )));
        }
        Some(actual) => Some(parse_lookback(operation, actual)?),
        None if fallback.is_some() => {
            Some(LookbackDays::new(DEFAULT_LOOKBACK_DAYS).expect("default lookback is valid"))
        }
        None => None,
    };

    let base_date = base_date.expect("matrix baseDate was required above");
    Ok(ValidatedInput::Matrix(match lookback {
        Some(days) => MatrixInput::previous_available(base_date, kind, days),
        None => MatrixInput::new(base_date, kind),
    }))
}

fn stringify_kind_number(number: &Number) -> String {
    number
        .as_i64()
        .map(|value| value.to_string())
        .or_else(|| number.as_u64().map(|value| value.to_string()))
        .or_else(|| {
            number
                .as_f64()
                .filter(|value| value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER)
                .map(|value| (value as i64).to_string())
        })
        .unwrap_or_else(|| number.to_string())
}

fn required_value_is_missing(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

fn parse_base_date(operation: Operation, value: &Value) -> Result<BaseDate, Box<CliError>> {
    let parsed = value.as_str().and_then(|text| text.parse().ok());
    parsed.ok_or_else(|| {
        Box::new(validation_error(
            operation,
            "invalid_parameter",
            Some("baseDate"),
            "baseDate must be a valid 기준일 in YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD form.",
            Some(json!("YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD")),
            Some(safe_actual(value)),
            "Use the official 기준일 date shown by KIS-NET, for example 2026-06-08.",
        ))
    })
}

fn parse_lookback(operation: Operation, value: &Value) -> Result<LookbackDays, Box<CliError>> {
    let parsed = value
        .as_u64()
        .and_then(|value| u8::try_from(value).ok())
        .and_then(|value| LookbackDays::new(value).ok());
    parsed.ok_or_else(|| {
        Box::new(validation_error(
            operation,
            "invalid_parameter",
            Some("lookbackDays"),
            format!("lookbackDays must be an integer from 1 to {MAX_LOOKBACK_DAYS}."),
            Some(json!(format!("integer 1-{MAX_LOOKBACK_DAYS}"))),
            Some(safe_actual(value)),
            format!("Use a small calendar-day lookback window such as {DEFAULT_LOOKBACK_DAYS}."),
        ))
    })
}

fn validation_error(
    operation: Operation,
    code: &'static str,
    parameter: Option<&str>,
    reason: impl Into<String>,
    expected: Option<Value>,
    actual: Option<Value>,
    recovery_hint: impl Into<String>,
) -> CliError {
    let example_input = validation_example_input(operation, parameter);
    CliError {
        ok: false,
        code,
        operation_name: operation.name().into(),
        parameter: parameter.map(str::to_owned),
        reason: reason.into(),
        expected,
        actual,
        example_input: Some(example_input),
        recovery_hint: recovery_hint.into(),
        recovery_action: if parameter.is_some() {
            "inspect_command_help"
        } else {
            "inspect_tool_help"
        },
        recoverable: true,
        retryable: false,
    }
}

fn cli_error(
    operation: Operation,
    code: &'static str,
    parameter: &str,
    reason: impl Into<String>,
    expected: Value,
    actual: Option<Value>,
) -> CliError {
    CliError {
        ok: false,
        code,
        operation_name: operation.name().into(),
        parameter: Some(parameter.into()),
        reason: reason.into(),
        expected: Some(expected),
        actual,
        example_input: Some(example_input(operation)),
        recovery_hint: format!(
            "Run ytm help {} and retry with supported options.",
            operation.name()
        ),
        recovery_action: "inspect_command_help",
        recoverable: true,
        retryable: false,
    }
}

fn example_input(operation: Operation) -> Value {
    match operation {
        Operation::Matrix => json!({ "baseDate": "2026-06-08", "kind": "국채" }),
        Operation::Kinds => json!({ "baseDate": "2026-06-08" }),
        Operation::History => json!({ "baseDates": ["2026-06-08"] }),
    }
}

fn validation_example_input(operation: Operation, parameter: Option<&str>) -> Value {
    match (operation, parameter) {
        (Operation::Kinds, _) => json!({}),
        (Operation::History, _) => example_input(Operation::History),
        (Operation::Matrix, Some("fallback" | "lookbackDays")) => json!({
            "baseDate": "2026-06-07",
            "kind": "국채",
            "fallback": "previous-available",
            "lookbackDays": DEFAULT_LOOKBACK_DAYS
        }),
        (Operation::Matrix, _) => example_input(Operation::Matrix),
    }
}

fn safe_actual(value: &Value) -> Value {
    match value {
        Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(values) => Value::String(format!("[array:{}]", values.len())),
        Value::Object(_) => Value::String("[object]".into()),
    }
}

async fn execute(
    input: ValidatedInput,
    cancellation: ytm_core::CancellationToken,
) -> Result<OperationResult, YtmError> {
    let service = if matches!(input, ValidatedInput::History(_))
        && std::io::IsTerminal::is_terminal(&std::io::stderr())
    {
        progress::service()?
    } else {
        service()?
    };
    match input {
        ValidatedInput::History(input) => service
            .history_with_cancellation(input, cancellation)
            .await
            .map(OperationResult::History),
        ValidatedInput::Matrix(input) => service
            .matrix_with_cancellation(input, cancellation)
            .await
            .map(OperationResult::Matrix),
        ValidatedInput::Kinds(input) => service
            .kinds_with_cancellation(input, cancellation)
            .await
            .map(OperationResult::Kinds),
    }
}

fn serialize_result(result: impl Serialize) -> Result<Value, YtmError> {
    serde_json::to_value(result).map_err(|_| YtmError::defect())
}

fn service() -> Result<YtmService, YtmError> {
    #[cfg(feature = "judge-fixtures")]
    if let Some(transport) = ytm_core::judge::FixtureTransport::from_env()? {
        return Ok(YtmService::with_shared_transport(transport));
    }
    YtmService::new()
}

fn success_output(
    result: OperationResult,
    format: OutputFormat,
    pretty: bool,
) -> Result<ProcessOutput, YtmError> {
    let stdout = match format {
        OutputFormat::Json => {
            let operation = result.operation();
            let result = result.into_json()?;
            encode_json(
                &json!({ "ok": true, "operation": operation.name(), "result": normalize_numbers(result) }),
                pretty,
            )
        }
        OutputFormat::Csv | OutputFormat::Tsv => {
            let delimiter = if format == OutputFormat::Tsv {
                '\t'
            } else {
                ','
            };
            match result {
                OperationResult::History(result) => table::history(&result, true).render(delimiter),
                OperationResult::Matrix(result) => table::matrix(&result).render(delimiter),
                OperationResult::Kinds(result) => table::kinds(&result).render(delimiter),
            }
        }
    };
    Ok(ProcessOutput {
        code: 0,
        stdout,
        stderr: String::new(),
    })
}

fn normalize_numbers(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(normalize_numbers).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, normalize_numbers(value)))
                .collect(),
        ),
        Value::Number(number) => number
            .as_f64()
            .filter(|value| value.fract() == 0.0)
            .filter(|value| value.abs() <= MAX_SAFE_INTEGER)
            .map(|value| Value::Number(Number::from(value as i64)))
            .unwrap_or(Value::Number(number)),
        other => other,
    }
}

fn encode_json(value: &Value, pretty: bool) -> String {
    let encoded = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .expect("CLI envelopes contain serializable JSON");
    format!("{encoded}\n")
}

fn invalid_output(failure: InvocationError) -> ProcessOutput {
    ProcessOutput {
        code: 2,
        stdout: encode_json(&json!({ "ok": false, "error": failure.error }), false),
        stderr: format!("\n{}", command_help(failure.operation)),
    }
}

fn command_help_output(command: &str) -> ProcessOutput {
    if command == "upgrade" {
        return stdout_output(0, upgrade_help());
    }
    match Operation::parse(command) {
        Some(operation) => stdout_output(0, command_help(operation)),
        None => stdout_output(
            2,
            format!("Unknown command: {command}\nRun ytm --help for available commands.\n"),
        ),
    }
}

fn help_invocation_output(tail: &[String]) -> ProcessOutput {
    match tail {
        [_] => stdout_output(0, root_help()),
        [_, flag] if matches!(flag.as_str(), "--help" | "-h") => stdout_output(0, root_help()),
        [_, command] => command_help_output(command),
        [_, command, flag] if matches!(flag.as_str(), "--help" | "-h") => {
            command_help_output(command)
        }
        _ => invalid_help_invocation_output(&tail[1..]),
    }
}

fn invalid_help_invocation_output(actual: &[String]) -> ProcessOutput {
    let error = json!({
        "code": "invalid_request",
        "reason": "Invalid help invocation.",
        "expected": ["help", "help --help", "help <command>", "help <command> --help"],
        "actual": actual,
        "recoveryHint": "Run ytm --help or ytm help <command> without trailing arguments.",
        "recoveryAction": "inspect_tool_help",
        "recoverable": true,
        "retryable": false
    });
    ProcessOutput {
        code: 2,
        stdout: encode_json(&json!({ "ok": false, "error": error }), false),
        stderr: format!("\n{}", root_help()),
    }
}

fn unknown_command_output(command: &str) -> ProcessOutput {
    let error = json!({
        "code": "invalid_request",
        "reason": format!("Unknown command: {command}."),
        "expected": ["matrix", "kinds", "upgrade"],
        "actual": command,
        "recoveryHint": "Run ytm --help and retry with a listed command.",
        "recoveryAction": "inspect_tool_help",
        "recoverable": true,
        "retryable": false
    });
    ProcessOutput {
        code: 2,
        stdout: encode_json(&json!({ "ok": false, "error": error }), false),
        stderr: format!("\n{}", root_help()),
    }
}

fn stdout_output(code: u8, stdout: String) -> ProcessOutput {
    ProcessOutput {
        code,
        stdout,
        stderr: String::new(),
    }
}

fn root_help() -> String {
    format!(
        "{}\n\nCLI usage:\n  ytm --version\n  ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv|xlsx] [--output <file.xlsx>] [--overwrite] [--pretty]\n  ytm kinds [--base-date <기준일>] [--format json|csv|tsv|xlsx] [--output <file.xlsx>] [--overwrite] [--pretty]\n  ytm upgrade [--check]\n  ytm help <command>\n\nOutput:\n  json is the default and prints one JSON object. csv and tsv print tabular success rows. xlsx requires --output <file.xlsx>, writes one workbook, and prints one JSON receipt; it replaces an existing file only with --overwrite. Command failures print one JSON object to stdout and exit non-zero, including upgrade failures. Unknown command names given to ytm help print a plain-text message and exit non-zero. Help diagnostics for invalid invocations are written to stderr.\n",
        tool_help()
    )
}

fn tool_help() -> String {
    format!(
        "KIS-NET YTM Matrix CLI\n\nOperations:\n  history: retrieve all categories for up to 2000 dates; run ytm history --help.\n  matrix: fetch YTM Matrix rows for a 기준일 and 종류.\n  kinds: list accepted 종류 codes and Korean labels.\n  upgrade: check or replace an official managed installation.\n\nAccepted 종류 values:\n{}\n\nSource terms are preserved where official: 기준일, 종류, and 적용대상채권.\nRun ytm help <command> for command-specific input and output guidance.",
        formatted_kinds("  ")
    )
}

fn upgrade_help() -> String {
    "upgrade\n  ytm upgrade --check reads and verifies the adjacent managed-install receipt and installed executable, then checks the latest public stable GitHub Release without changing local files.\n  ytm upgrade verifies release metadata, SHA256SUMS, the generated platform installer, and the target archive digest before replacing the executable and receipt as one recoverable pair.\n  Locally built, renamed, symlinked, receipt-less, or modified executables are not managed.\n  Output: one JSON object. Runtime failures use exit 1; invalid invocations use exit 2.\n"
        .into()
}

fn invalid_upgrade_invocation_output(actual: &[String]) -> ProcessOutput {
    let error = json!({
        "code": "invalid_request",
        "operationName": "upgrade",
        "reason": "Invalid upgrade invocation.",
        "expected": ["upgrade", "upgrade --check", "upgrade --help"],
        "actual": actual,
        "recoveryHint": "Run ytm upgrade --help and retry with one listed form.",
        "recoveryAction": "inspect_command_help",
        "recoverable": true,
        "retryable": false
    });
    ProcessOutput {
        code: 2,
        stdout: encode_json(&json!({ "ok": false, "error": error }), false),
        stderr: format!("\n{}", upgrade_help()),
    }
}

fn command_help(operation: Operation) -> String {
    let body = match operation {
        Operation::History => "history\n  Select repeated --base-date <date> OR --start-date <date> --end-date <date> (inclusive).\n  Maximum 2000 raw list entries or range days; dates normalize, sort and deduplicate.\n  Dates: YYYY-MM-DD, YYYY.MM.DD, YYYYMMDD. All categories and pricing groups are returned.\n  Optional: --fallback previous-available --lookback-days <1..31> (default 10).\n  Output: --format json|csv|tsv|xlsx [--pretty]\n  XLSX: --output <file.xlsx> [--overwrite]\n  Unavailable pairs are reported with exit 0; operational failures are fatal.\n  History, Availability and Metadata sheets preserve requested and actual dates.".into(),
        Operation::Matrix => format!(
            "matrix\n  Required: --base-date <기준일> --kind <종류>\n  Optional: --fallback previous-available --lookback-days <days>\n  Output: --format json|csv|tsv|xlsx [--pretty]\n  XLSX: --output <file.xlsx> [--overwrite]\n  base-date accepts YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.\n  kind maps to 종류 and accepts one of these Korean labels or source codes:\n{}\n  fallback=previous-available tries the requested date once, then walks backward until rows are found.\n  lookback-days defaults to {DEFAULT_LOOKBACK_DAYS} and may not exceed {MAX_LOOKBACK_DAYS}.\n  Run ytm kinds to print accepted kinds as JSON, CSV, TSV, or XLSX.\n  Result rows include 적용대상채권, tenors 3M through 50Y, and dateResolution metadata.",
            formatted_kinds("    ")
        ),
        Operation::Kinds => "kinds\n  Optional: --base-date <기준일>\n  Output: --format json|csv|tsv|xlsx [--pretty]\n  XLSX: --output <file.xlsx> [--overwrite]\n  base-date accepts YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.\n  Returns accepted 종류 source codes and Korean labels.".into(),
    };
    let example = match operation {
        Operation::History => "ytm history --start-date 2026-06-01 --end-date 2026-06-08 --format xlsx --output history.xlsx",
        Operation::Matrix => "ytm matrix --base-date 2026-06-08 --kind 국채 --format json",
        Operation::Kinds => "ytm kinds --base-date 2026-06-08 --format json",
    };
    format!("{body}\n\nCLI example:\n  {example}\n")
}

fn formatted_kinds(prefix: &str) -> String {
    YtmService::capabilities()
        .kinds
        .into_iter()
        .map(|kind| format!("{prefix}{} = {}", kind.code, kind.name))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[tokio::test]
    async fn xlsx_option_contract_and_help_are_side_effect_free() {
        for args in [
            vec!["kinds", "--format", "xlsx"],
            vec!["kinds", "--format=xlsx", "--output="],
            vec!["kinds", "--format=xlsx", "--output=-"],
            vec!["kinds", "--format=xlsx", "--output=foo.csv"],
            vec!["kinds", "--format=xlsx", "--output=.xlsx"],
            vec!["kinds", "--format=xlsx", "--output=foo.xlsx/"],
            vec!["kinds", "--output=foo.xlsx"],
            vec!["kinds", "--format=csv", "--overwrite"],
            vec![
                "kinds",
                "--format=xlsx",
                "--output=a.xlsx",
                "--output=b.xlsx",
            ],
            vec![
                "kinds",
                "--format=xlsx",
                "--output=a.xlsx",
                "--overwrite",
                "--overwrite",
            ],
            vec!["matrix", "--help", "--format=xlsx", "--output=bad"],
            vec!["matrix", "--help", "--format=json", "--overwrite"],
        ] {
            let output = run(std::iter::once("ytm")
                .chain(args)
                .map(OsString::from)
                .collect())
            .await;
            assert_eq!(output.code, 2, "{}", output.stdout);
        }
        for args in [
            vec!["matrix", "--help", "--format=xlsx"],
            vec![
                "matrix",
                "--format",
                "xlsx",
                "--output=absent/한 글.XLSX",
                "--pretty",
                "--pretty",
                "--help",
            ],
            vec!["kinds", "--format=xlsx", "--overwrite", "--help"],
        ] {
            let output = run(std::iter::once("ytm")
                .chain(args)
                .map(OsString::from)
                .collect())
            .await;
            assert_eq!(output.code, 0, "{}", output.stdout);
            assert!(output.stderr.is_empty());
        }
    }

    fn assert_structured_failure(output: &ProcessOutput, operation: Option<&str>) {
        assert_eq!(output.code, 2);
        assert_eq!(output.stdout.lines().count(), 1);
        let envelope: Value = serde_json::from_str(&output.stdout).unwrap();
        assert_eq!(envelope["ok"], false);
        assert!(envelope["error"].is_object());
        if let Some(operation) = operation {
            assert_eq!(envelope["error"]["operationName"], operation);
        }
        assert!(!output.stderr.is_empty());
    }

    #[tokio::test]
    async fn root_and_command_help_keep_stdout_clean() {
        let root = run(vec!["ytm".into(), "--help".into()]).await;
        assert_eq!(root.code, 0);
        assert!(root.stdout.contains("CLI usage:"));
        assert!(root
            .stdout
            .contains("Command failures print one JSON object"));
        assert!(root
            .stdout
            .contains("given to ytm help print a plain-text message"));
        assert_eq!(root.stderr, "");

        let command = run(vec!["ytm".into(), "matrix".into(), "--help".into()]).await;
        assert_eq!(command.code, 0);
        assert!(command.stdout.contains("CLI example:"));
        assert!(!command.stdout.contains("Input JSON"));
        assert_eq!(command.stderr, "");

        let unknown = run(vec!["ytm".into(), "not-a-command".into(), "--help".into()]).await;
        assert_structured_failure(&unknown, None);
        let unknown_envelope: Value = serde_json::from_str(&unknown.stdout).unwrap();
        assert_eq!(unknown_envelope["ok"], false);
        assert_eq!(unknown_envelope["error"]["code"], "invalid_request");
        assert!(unknown.stderr.contains("CLI usage:"));

        let help = run(vec!["ytm".into(), "help".into(), "--help".into()]).await;
        assert_eq!(help.code, 0);
        assert!(help.stdout.contains("CLI usage:"));
        assert_eq!(help.stderr, "");

        let unknown_help = run(vec!["ytm".into(), "help".into(), "not-a-command".into()]).await;
        assert_eq!(unknown_help.code, 2);
        assert!(unknown_help
            .stdout
            .starts_with("Unknown command: not-a-command"));
        assert_eq!(unknown_help.stderr, "");

        let unknown_help_flag = run(vec![
            "ytm".into(),
            "help".into(),
            "not-a-command".into(),
            "--help".into(),
        ])
        .await;
        assert_eq!(unknown_help_flag.code, 2);
        assert!(unknown_help_flag
            .stdout
            .starts_with("Unknown command: not-a-command"));
        assert_eq!(unknown_help_flag.stderr, "");

        let requested_help = run(vec![
            "ytm".into(),
            "help".into(),
            "matrix".into(),
            "--help".into(),
        ])
        .await;
        assert_eq!(requested_help.code, 0);
        assert!(requested_help.stdout.contains("CLI example:"));
        assert_eq!(requested_help.stderr, "");

        for malformed in [
            vec!["ytm", "--help", "--bogus"],
            vec!["ytm", "-h", "extra"],
            vec!["ytm", "help", "matrix", "--bogus"],
            vec!["ytm", "help", "matrix", "extra"],
            vec![
                "ytm",
                "matrix",
                "--help",
                "--base-date",
                "2026-06-08",
                "--base-date",
                "2026-06-09",
            ],
            vec!["ytm", "matrix", "--help", "--base-date", "--unknown"],
            vec!["ytm", "matrix", "--help", "--format", "yaml"],
            vec!["ytm", "matrix", "--help", "--fallback", "nope"],
            vec!["ytm", "matrix", "--help", "--lookback-days", "0"],
        ] {
            let output = run(malformed.into_iter().map(OsString::from).collect()).await;
            assert_structured_failure(&output, None);
        }

        let value_help = run(vec![
            "ytm".into(),
            "matrix".into(),
            "--base-date".into(),
            "2026-06-08".into(),
            "--help".into(),
        ])
        .await;
        assert_eq!(value_help.code, 0);
        assert!(value_help.stdout.contains("CLI example:"));
        assert_eq!(value_help.stderr, "");

        let help_as_value = run(vec![
            "ytm".into(),
            "matrix".into(),
            "--format".into(),
            "--help".into(),
        ])
        .await;
        assert_structured_failure(&help_as_value, Some("matrix"));
    }

    #[tokio::test]
    async fn version_is_exact_and_side_effect_free() {
        for flag in ["--version", "-V"] {
            let output = run(vec!["ytm".into(), flag.into()]).await;
            assert_eq!(output.code, 0);
            assert_eq!(
                output.stdout,
                format!("ytm {}\n", env!("CARGO_PKG_VERSION"))
            );
            assert_eq!(output.stderr, "");
        }
    }

    #[tokio::test]
    async fn upgrade_invocation_is_explicit_and_structured() {
        let help = run(vec!["ytm".into(), "upgrade".into(), "--help".into()]).await;
        assert_eq!(help.code, 0);
        assert!(help.stdout.contains("ytm upgrade --check"));
        assert_eq!(help.stderr, "");

        let delegated_help = run(vec!["ytm".into(), "help".into(), "upgrade".into()]).await;
        assert_eq!(delegated_help, help);

        let invalid = run(vec!["ytm".into(), "upgrade".into(), "--pretty".into()]).await;
        assert_eq!(invalid.code, 2);
        assert_eq!(invalid.stdout.lines().count(), 1);
        let envelope: Value = serde_json::from_str(&invalid.stdout).unwrap();
        assert_eq!(envelope["error"]["operationName"], "upgrade");
        assert_eq!(envelope["error"]["code"], "invalid_request");
        assert!(invalid.stderr.contains("ytm upgrade --check"));

        let args = vec![OsString::from("ytm"), OsString::from("upgrade")];
        let tail = vec!["upgrade".to_string()];
        assert!(matches!(
            parse_invocation(&args, &tail),
            ParseOutcome::Management(UpgradeMode::Install)
        ));
        let args = vec![
            OsString::from("ytm"),
            OsString::from("upgrade"),
            OsString::from("--check"),
        ];
        let tail = vec!["upgrade".to_string(), "--check".to_string()];
        assert!(matches!(
            parse_invocation(&args, &tail),
            ParseOutcome::Management(UpgradeMode::Check)
        ));
    }

    #[test]
    fn operation_help_recognizes_every_declared_long_option() {
        for operation in [Operation::Matrix, Operation::Kinds] {
            for argument in operation_command(operation.name()).get_arguments() {
                let Some(long) = argument.get_long() else {
                    continue;
                };
                let mut args = vec!["--help".to_string(), format!("--{long}")];
                if argument
                    .get_num_args()
                    .is_some_and(|range| range.takes_values())
                {
                    args.push("value".to_string());
                }
                assert!(help_requested(operation, &args), "--{long}");
            }
        }
    }

    #[tokio::test]
    async fn missing_matrix_input_is_structured_and_uses_exit_two() {
        let output = run(vec![
            "ytm".into(),
            "matrix".into(),
            "--kind".into(),
            "국채".into(),
        ])
        .await;
        let envelope: Value = serde_json::from_str(&output.stdout).unwrap();
        assert_eq!(output.code, 2);
        assert_eq!(envelope["error"]["code"], "missing_parameter");
        assert_eq!(envelope["error"]["parameter"], "baseDate");
        assert!(output.stderr.contains("matrix"));
    }

    #[tokio::test]
    async fn invalid_invocations_are_structured_and_use_exit_two() {
        let unknown = run(vec!["ytm".into(), "not-a-command".into()]).await;
        assert_structured_failure(&unknown, None);
        let unknown_envelope: Value = serde_json::from_str(&unknown.stdout).unwrap();
        assert_eq!(
            unknown_envelope["error"]["reason"],
            "Unknown command: not-a-command."
        );

        let cross_command = run(vec![
            "ytm".into(),
            "kinds".into(),
            "--kind".into(),
            "10".into(),
        ])
        .await;
        assert_structured_failure(&cross_command, Some("kinds"));

        for args in [
            vec!["ytm", "matrix", "--format"],
            vec!["ytm", "matrix", "--format", ""],
            vec!["ytm", "matrix", "--unknown-option", "value"],
            vec![
                "ytm",
                "matrix",
                "--base-date",
                "2026-06-08",
                "--base-date",
                "2026-06-09",
                "--kind",
                "10",
            ],
        ] {
            let output = run(args.into_iter().map(OsString::from).collect()).await;
            assert_structured_failure(&output, Some("matrix"));
        }

        let empty_date = run(vec![
            "ytm".into(),
            "matrix".into(),
            "--base-date".into(),
            "".into(),
        ])
        .await;
        let envelope: Value = serde_json::from_str(&empty_date.stdout).unwrap();
        assert_eq!(envelope["error"]["code"], "missing_parameter");
        assert_eq!(envelope["error"]["parameter"], "baseDate");

        let fallback = run(vec![
            "ytm".into(),
            "matrix".into(),
            "--base-date".into(),
            "2026-06-08".into(),
            "--kind".into(),
            "10".into(),
            "--fallback".into(),
            "unsupported".into(),
        ])
        .await;
        let envelope: Value = serde_json::from_str(&fallback.stdout).unwrap();
        assert_eq!(
            envelope["error"]["exampleInput"],
            json!({
                "baseDate": "2026-06-07",
                "kind": "국채",
                "fallback": "previous-available",
                "lookbackDays": 10
            })
        );
    }

    #[test]
    fn documented_flags_are_kebab_case_and_parse_without_merging() {
        let args = [
            "ytm",
            "matrix",
            "--base-date",
            "20260608",
            "--kind",
            "10",
            "--fallback",
            "previous-available",
            "--lookback-days",
            "2",
            "--format",
            "json",
            "--pretty",
        ]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
        let tail = args[1..]
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let ParseOutcome::Execute(invocation) = parse_invocation(&args, &tail) else {
            panic!("documented invocation should parse");
        };
        assert_eq!(invocation.input["baseDate"], "20260608");
        assert_eq!(invocation.input["kind"], "10");
        assert_eq!(invocation.input["fallback"], "previous-available");
        assert_eq!(invocation.input["lookbackDays"], 2);
        assert_eq!(invocation.output, OutputSelection::Text(OutputFormat::Json));
        assert!(invocation.pretty);
    }

    #[tokio::test]
    async fn removed_flags_are_structured_invalid_invocations() {
        for flag in ["--input-json", "--baseDate", "--lookbackDays"] {
            let value = if flag == "--input-json" {
                "{}"
            } else if flag == "--baseDate" {
                "2026-06-08"
            } else {
                "2"
            };
            let args = vec![
                "ytm".into(),
                "matrix".into(),
                "--base-date".into(),
                "2026-06-08".into(),
                "--kind".into(),
                "10".into(),
                flag.into(),
                value.into(),
            ];
            let mut with_help = args.clone();
            with_help.push("--help".into());
            let output = run(args).await;
            assert_structured_failure(&output, Some("matrix"));
            let output_with_help = run(with_help).await;
            assert_structured_failure(&output_with_help, Some("matrix"));
        }
    }

    #[test]
    fn table_cells_neutralize_only_source_strings() {
        assert_eq!(format_cell(&Cell::Text("=1+1".into()), ','), "'=1+1");
        assert_eq!(format_cell(&Cell::Number(-4.455), ','), "-4.455");
        assert_eq!(format_cell(&Cell::Text("a,b".into()), ','), "\"a,b\"");
        assert_eq!(format_cell(&Cell::Text("a\tb".into()), '\t'), "a b");
    }

    #[test]
    fn integral_floats_match_javascript_json_number_rendering() {
        assert_eq!(
            normalize_numbers(json!({ "whole": 3.0, "fraction": 3.1 })),
            json!({ "whole": 3, "fraction": 3.1 })
        );
    }
}
