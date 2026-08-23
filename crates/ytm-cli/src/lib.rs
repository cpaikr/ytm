use std::ffi::OsString;

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::Serialize;
use serde_json::{json, Map, Number, Value};
use ytm_core::{
    BaseDate, KindSelector, KindsInput, KindsResult, LookbackDays, MatrixInput, MatrixResult,
    YtmError, YtmService, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS,
};

const FORMATS: [&str; 3] = ["json", "csv", "tsv"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, PartialEq, Eq)]
pub struct ProcessOutput {
    pub code: u8,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Operation {
    Matrix,
    Kinds,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Matrix => "matrix",
            Self::Kinds => "kinds",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
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

#[derive(Debug)]
struct ParsedInvocation {
    operation: Operation,
    input: Map<String, Value>,
    format: OutputFormat,
    pretty: bool,
}

#[derive(Debug)]
enum ValidatedInput {
    Matrix(MatrixInput),
    Kinds(KindsInput),
}

#[derive(Debug)]
enum OperationResult {
    Matrix(MatrixResult),
    Kinds(KindsResult),
}

impl OperationResult {
    fn operation(&self) -> Operation {
        match self {
            Self::Matrix(_) => Operation::Matrix,
            Self::Kinds(_) => Operation::Kinds,
        }
    }

    fn into_json(self) -> Result<Value, YtmError> {
        match self {
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
    Immediate(ProcessOutput),
    Invalid(InvocationError),
}

pub async fn run(args: Vec<OsString>) -> ProcessOutput {
    let tail = args
        .get(1..)
        .unwrap_or_default()
        .iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    let invocation = match parse_invocation(&args, &tail) {
        ParseOutcome::Execute(invocation) => invocation,
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

    match execute(input)
        .await
        .and_then(|result| success_output(result, invocation.format, invocation.pretty))
    {
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
    let Some(operation) = Operation::parse(first) else {
        return ParseOutcome::Immediate(unknown_command_output(first));
    };
    if help_requested(&tail[1..]) {
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
        .subcommand(operation_command("matrix"))
        .subcommand(operation_command("kinds"))
}

fn operation_command(name: &'static str) -> Command {
    Command::new(name)
        .disable_help_flag(true)
        .arg(value_arg("base_date", "base-date"))
        .arg(value_arg("format", "format"))
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

fn invocation_from_matches(
    operation: Operation,
    matches: &ArgMatches,
) -> Result<ParsedInvocation, Box<CliError>> {
    let mut input = Map::new();
    if let Some(value) = matches.get_one::<String>("base_date") {
        input.insert("baseDate".into(), Value::String(value.clone()));
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
    let format = matches
        .get_one::<String>("format")
        .map(|value| {
            OutputFormat::parse(value).ok_or_else(|| {
                Box::new(cli_error(
                    operation,
                    "invalid_parameter",
                    "format",
                    "Unsupported format.",
                    json!(FORMATS),
                    Some(Value::String(value.clone())),
                ))
            })
        })
        .transpose()?
        .unwrap_or(OutputFormat::Json);

    Ok(ParsedInvocation {
        operation,
        input,
        format,
        pretty: matches.get_count("pretty") > 0,
    })
}

fn help_requested(args: &[String]) -> bool {
    let mut index = 0;
    let mut requested = false;
    let mut seen = std::collections::HashSet::new();
    while index < args.len() {
        if matches!(args[index].as_str(), "--help" | "-h") {
            requested = true;
            index += 1;
        } else if args[index] == "--pretty" {
            if !seen.insert("--pretty") {
                return false;
            }
            index += 1;
        } else if matches!(
            args[index].as_str(),
            "--base-date" | "--kind" | "--fallback" | "--lookback-days" | "--format"
        ) {
            if !seen.insert(args[index].as_str()) {
                return false;
            }
            let Some(value) = args.get(index + 1) else {
                return false;
            };
            if value.starts_with("--") || value == "-h" {
                return false;
            }
            index += 2;
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
    let mut invocation = invocation_from_matches(operation, subcommand)?;
    if operation == Operation::Matrix {
        invocation
            .input
            .entry("baseDate")
            .or_insert_with(|| json!("2000-01-01"));
        invocation
            .input
            .entry("kind")
            .or_insert_with(|| json!("10"));
    }
    validate_input(operation, &invocation.input).map(|_| ())
}

fn validate_input(
    operation: Operation,
    input: &Map<String, Value>,
) -> Result<ValidatedInput, Box<CliError>> {
    let allowed = match operation {
        Operation::Matrix => &["baseDate", "kind", "fallback", "lookbackDays"][..],
        Operation::Kinds => &["baseDate"][..],
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
    }
}

fn validation_example_input(operation: Operation, parameter: Option<&str>) -> Value {
    match (operation, parameter) {
        (Operation::Kinds, _) => json!({}),
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

async fn execute(input: ValidatedInput) -> Result<OperationResult, YtmError> {
    let service = service()?;
    match input {
        ValidatedInput::Matrix(input) => service.matrix(input).await.map(OperationResult::Matrix),
        ValidatedInput::Kinds(input) => service.kinds(input).await.map(OperationResult::Kinds),
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
                OperationResult::Matrix(result) => render_matrix_table(&result, delimiter),
                OperationResult::Kinds(result) => render_kinds_table(&result, delimiter),
            }
        }
    };
    Ok(ProcessOutput {
        code: 0,
        stdout,
        stderr: String::new(),
    })
}

fn render_matrix_table(result: &MatrixResult, delimiter: char) -> String {
    let mut columns = vec![
        "requestedBaseDate".to_owned(),
        "baseDate".to_owned(),
        "usedFallback".to_owned(),
        "kindCode".to_owned(),
        "kindName".to_owned(),
        "pricingGroupCode".to_owned(),
        "pricingGroupName".to_owned(),
    ];
    columns.extend(result.tenors.iter().cloned());
    let rows = result.rows.iter().map(|row| {
        let mut cells = vec![
            Cell::Text(result.requested_base_date.to_string()),
            Cell::Text(result.base_date.to_string()),
            Cell::Boolean(result.date_resolution.used_fallback),
            Cell::Text(result.kind.code.clone()),
            Cell::Text(result.kind.name.clone()),
            Cell::Text(row.pricing_group_code.clone()),
            Cell::Text(row.pricing_group_name.clone()),
        ];
        cells.extend(result.tenors.iter().map(|tenor| {
            row.yields
                .get(tenor)
                .copied()
                .flatten()
                .map(Cell::Number)
                .unwrap_or(Cell::Empty)
        }));
        cells
    });
    table(columns, rows, delimiter)
}

fn render_kinds_table(result: &KindsResult, delimiter: char) -> String {
    let rows = result
        .kinds
        .iter()
        .map(|kind| vec![Cell::Text(kind.code.clone()), Cell::Text(kind.name.clone())]);
    table(["code".to_owned(), "name".to_owned()], rows, delimiter)
}

#[derive(Debug)]
enum Cell {
    Empty,
    Text(String),
    Number(f64),
    Boolean(bool),
}

fn table(
    columns: impl IntoIterator<Item = String>,
    rows: impl IntoIterator<Item = Vec<Cell>>,
    delimiter: char,
) -> String {
    let mut rendered = Vec::new();
    rendered.push(
        columns
            .into_iter()
            .map(|cell| format_cell(&Cell::Text(cell), delimiter))
            .collect::<Vec<_>>()
            .join(&delimiter.to_string()),
    );
    rendered.extend(rows.into_iter().map(|row| {
        row.iter()
            .map(|cell| format_cell(cell, delimiter))
            .collect::<Vec<_>>()
            .join(&delimiter.to_string())
    }));
    format!("{}\n", rendered.join("\n"))
}

fn format_cell(value: &Cell, delimiter: char) -> String {
    let (mut text, source_string) = match value {
        Cell::Empty => (String::new(), false),
        Cell::Text(value) => (value.clone(), true),
        Cell::Number(value) => (value.to_string(), false),
        Cell::Boolean(value) => (value.to_string(), false),
    };
    if source_string
        && text
            .chars()
            .next()
            .is_some_and(|value| matches!(value, '=' | '+' | '-' | '@' | '\t' | '\r'))
    {
        text.insert(0, '\'');
    }
    if delimiter == '\t' {
        return text.replace(['\t', '\r', '\n'], " ");
    }
    if text.contains(['"', ',', '\r', '\n']) {
        return format!("\"{}\"", text.replace('"', "\"\""));
    }
    text
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
        "expected": ["matrix", "kinds"],
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
        "{}\n\nCLI usage:\n  ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv] [--pretty]\n  ytm kinds [--base-date <기준일>] [--format json|csv|tsv] [--pretty]\n  ytm help <command>\n\nOutput:\n  json is the default and prints one JSON object. csv and tsv print tabular success rows. Command failures print one JSON object to stdout and exit non-zero. Unknown command names given to ytm help print a plain-text message and exit non-zero. Help diagnostics for invalid invocations are written to stderr.\n",
        tool_help()
    )
}

fn tool_help() -> String {
    format!(
        "KIS-NET YTM Matrix CLI\n\nOperations:\n  matrix: fetch YTM Matrix rows for a 기준일 and 종류.\n  kinds: list accepted 종류 codes and Korean labels.\n\nAccepted 종류 values:\n{}\n\nSource terms are preserved where official: 기준일, 종류, and 적용대상채권.\nRun ytm help <command> for command-specific input and output guidance.",
        formatted_kinds("  ")
    )
}

fn command_help(operation: Operation) -> String {
    let body = match operation {
        Operation::Matrix => format!(
            "matrix\n  Required: --base-date <기준일> --kind <종류>\n  Optional: --fallback previous-available --lookback-days <days>\n  Output: --format json|csv|tsv [--pretty]\n  base-date accepts YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.\n  kind maps to 종류 and accepts one of these Korean labels or source codes:\n{}\n  fallback=previous-available tries the requested date once, then walks backward until rows are found.\n  lookback-days defaults to {DEFAULT_LOOKBACK_DAYS} and may not exceed {MAX_LOOKBACK_DAYS}.\n  Run ytm kinds to print accepted kinds as JSON, CSV, or TSV.\n  Result rows include 적용대상채권, tenors 3M through 50Y, and dateResolution metadata.",
            formatted_kinds("    ")
        ),
        Operation::Kinds => "kinds\n  Optional: --base-date <기준일>\n  Output: --format json|csv|tsv [--pretty]\n  base-date accepts YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.\n  Returns accepted 종류 source codes and Korean labels.".into(),
    };
    let example = match operation {
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
        assert_eq!(invocation.format, OutputFormat::Json);
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
