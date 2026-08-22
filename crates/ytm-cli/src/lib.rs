use std::ffi::OsString;

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::Serialize;
use serde_json::{json, Map, Number, Value};
use ytm_core::{
    BaseDate, KindSelector, KindsInput, LookbackDays, MatrixInput, YtmError, YtmService,
    DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS,
};

const FORMATS: [&str; 3] = ["json", "csv", "tsv"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const VALUE_OPTIONS: [(&str, &str, &str, &str); 8] = [
    (
        "--input-json",
        "inputJson",
        "JSON object string",
        "--input-json requires a JSON object string.",
    ),
    (
        "--base-date",
        "baseDate",
        "date",
        "--base-date requires a 기준일 value.",
    ),
    (
        "--baseDate",
        "baseDate",
        "date",
        "--baseDate requires a 기준일 value.",
    ),
    (
        "--kind",
        "kind",
        "종류 label or code",
        "--kind requires a 종류 value.",
    ),
    (
        "--fallback",
        "fallback",
        "previous-available",
        "--fallback requires a policy value.",
    ),
    (
        "--lookback-days",
        "lookbackDays",
        "integer day count",
        "--lookback-days requires a day count.",
    ),
    (
        "--lookbackDays",
        "lookbackDays",
        "integer day count",
        "--lookbackDays requires a day count.",
    ),
    (
        "--format",
        "format",
        "format",
        "--format requires a format value.",
    ),
];

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

    match execute(input).await {
        Ok(result) => success_output(
            invocation.operation,
            result,
            invocation.format,
            invocation.pretty,
        ),
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
    let help_requested = if Operation::parse(first).is_some() {
        help_requested(&tail[1..])
    } else {
        tail[1..]
            .iter()
            .any(|argument| matches!(argument.as_str(), "--help" | "-h"))
    };
    if matches!(first, "--help" | "-h") || help_requested {
        return ParseOutcome::Immediate(help_output(first));
    }
    if first == "help" {
        return ParseOutcome::Immediate(match tail.get(1) {
            Some(command) => command_help_output(command),
            None => stdout_output(0, root_help()),
        });
    }
    let Some(operation) = Operation::parse(first) else {
        return ParseOutcome::Immediate(unknown_command_output(first));
    };
    if let Some(error) = legacy_syntax_error(operation, &tail[1..]) {
        return ParseOutcome::Invalid(InvocationError {
            operation,
            error: Box::new(error),
        });
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
        .arg(repeated_value("input_json", "input-json", None))
        .arg(repeated_value("base_date", "base-date", Some("baseDate")))
        .arg(repeated_value("format", "format", None))
        .arg(Arg::new("pretty").long("pretty").action(ArgAction::Count))
        .arg(repeated_value("kind", "kind", None))
        .arg(repeated_value("fallback", "fallback", None))
        .arg(repeated_value(
            "lookback_days",
            "lookback-days",
            Some("lookbackDays"),
        ))
}

fn repeated_value(id: &'static str, long: &'static str, alias: Option<&'static str>) -> Arg {
    let argument = Arg::new(id)
        .long(long)
        .action(ArgAction::Append)
        .allow_hyphen_values(true)
        .num_args(1);
    alias.map_or(argument.clone(), |value| argument.alias(value))
}

fn invocation_from_matches(
    operation: Operation,
    matches: &ArgMatches,
) -> Result<ParsedInvocation, Box<CliError>> {
    let mut events = Vec::new();
    let ids = &[
        "input_json",
        "base_date",
        "kind",
        "fallback",
        "lookback_days",
        "format",
    ];
    for &id in ids {
        let Some(indices) = matches.indices_of(id) else {
            continue;
        };
        let values = matches
            .get_many::<String>(id)
            .expect("Clap indices and values are paired");
        events.extend(
            indices
                .zip(values)
                .map(|(index, value)| (index, id, value.clone())),
        );
    }
    events.sort_by_key(|(index, _, _)| *index);

    let mut input = Map::new();
    let mut format = OutputFormat::Json;
    for (_, id, value) in events {
        match id {
            "input_json" => {
                let parsed = serde_json::from_str::<Value>(&value).map_err(|error| {
                    Box::new(cli_error(
                        operation,
                        "invalid_parameter",
                        "inputJson",
                        format!("Invalid JSON: {error}"),
                        json!("JSON object string"),
                        Some(Value::String(value.clone())),
                    ))
                })?;
                assign_json(&mut input, parsed);
            }
            "base_date" => {
                input.insert("baseDate".into(), Value::String(value));
            }
            "kind" => {
                input.insert("kind".into(), Value::String(value));
            }
            "fallback" => {
                input.insert("fallback".into(), Value::String(value));
            }
            "lookback_days" => {
                let parsed = if value.bytes().all(|byte| byte.is_ascii_digit()) {
                    value
                        .parse::<u64>()
                        .ok()
                        .map(Number::from)
                        .map(Value::Number)
                        .unwrap_or_else(|| Value::String(value))
                } else {
                    Value::String(value)
                };
                input.insert("lookbackDays".into(), parsed);
            }
            "format" => {
                format = OutputFormat::parse(&value).ok_or_else(|| {
                    Box::new(cli_error(
                        operation,
                        "invalid_parameter",
                        "format",
                        "Unsupported format.",
                        json!(FORMATS),
                        Some(Value::String(value)),
                    ))
                })?;
            }
            _ => unreachable!("all event IDs are enumerated"),
        }
    }

    Ok(ParsedInvocation {
        operation,
        input,
        format,
        pretty: matches.get_count("pretty") > 0,
    })
}

fn assign_json(target: &mut Map<String, Value>, source: Value) {
    match source {
        Value::Object(values) => {
            for (key, value) in values {
                target.insert(key, value);
            }
        }
        Value::Array(values) => {
            for (index, value) in values.into_iter().enumerate() {
                target.insert(index.to_string(), value);
            }
        }
        Value::String(value) => {
            for (index, character) in value.chars().enumerate() {
                target.insert(index.to_string(), Value::String(character.to_string()));
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn help_requested(args: &[String]) -> bool {
    let mut index = 0;
    while index < args.len() {
        if matches!(args[index].as_str(), "--help" | "-h") {
            return true;
        }
        if args[index] == "--pretty" {
            index += 1;
        } else if VALUE_OPTIONS
            .iter()
            .any(|(flag, _, _, _)| *flag == args[index])
        {
            index += 2;
        } else {
            index += 1;
        }
    }
    false
}

fn legacy_syntax_error(operation: Operation, args: &[String]) -> Option<CliError> {
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--pretty" {
            index += 1;
            continue;
        }
        if let Some((_, parameter, expected, reason)) = VALUE_OPTIONS
            .iter()
            .find(|(flag, _, _, _)| *flag == args[index])
        {
            let raw = args.get(index + 1);
            if args[index] == "--format" {
                if raw.is_none_or(|value| !FORMATS.contains(&value.as_str())) {
                    return Some(cli_error(
                        operation,
                        "invalid_parameter",
                        "format",
                        "Unsupported format.",
                        json!(FORMATS),
                        raw.cloned().map(Value::String),
                    ));
                }
                index += 2;
                continue;
            }
            if raw.is_none_or(String::is_empty) {
                return Some(cli_error(
                    operation,
                    "missing_parameter",
                    parameter,
                    *reason,
                    json!(expected),
                    None,
                ));
            }
            index += 2;
            continue;
        }
        let argument = args[index].clone();
        return Some(cli_error(
            operation,
            "unknown_parameter",
            &argument,
            format!("Unknown option: {argument}."),
            json!("supported CLI options"),
            Some(Value::String(argument.clone())),
        ));
    }
    None
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

async fn execute(input: ValidatedInput) -> Result<Value, YtmError> {
    let service = service()?;
    match input {
        ValidatedInput::Matrix(input) => service.matrix(input).await.and_then(serialize_result),
        ValidatedInput::Kinds(input) => service.kinds(input).await.and_then(serialize_result),
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
    operation: Operation,
    result: Value,
    format: OutputFormat,
    pretty: bool,
) -> ProcessOutput {
    let stdout = match format {
        OutputFormat::Json => encode_json(
            &json!({ "ok": true, "operation": operation.name(), "result": normalize_numbers(result) }),
            pretty,
        ),
        OutputFormat::Csv | OutputFormat::Tsv => {
            let delimiter = if format == OutputFormat::Tsv {
                '\t'
            } else {
                ','
            };
            match operation {
                Operation::Matrix => render_matrix_table(result, delimiter),
                Operation::Kinds => render_kinds_table(result, delimiter),
            }
        }
    };
    ProcessOutput {
        code: 0,
        stdout,
        stderr: String::new(),
    }
}

fn render_matrix_table(result: Value, delimiter: char) -> String {
    let result = result
        .as_object()
        .expect("core matrix results serialize as an object");
    let tenors = result["tenors"]
        .as_array()
        .expect("matrix tenors serialize as an array")
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("matrix tenor labels serialize as strings")
                .to_owned()
        })
        .collect::<Vec<_>>();
    let mut columns = vec![
        "requestedBaseDate".to_owned(),
        "baseDate".to_owned(),
        "usedFallback".to_owned(),
        "kindCode".to_owned(),
        "kindName".to_owned(),
        "pricingGroupCode".to_owned(),
        "pricingGroupName".to_owned(),
    ];
    columns.extend(tenors.iter().cloned());
    let rows = result["rows"]
        .as_array()
        .expect("matrix rows serialize as an array")
        .iter()
        .map(|row| {
            let mut cells = vec![
                Cell::Text(json_string(result, "requestedBaseDate")),
                Cell::Text(json_string(result, "baseDate")),
                Cell::Boolean(
                    result["dateResolution"]["usedFallback"]
                        .as_bool()
                        .expect("usedFallback serializes as a boolean"),
                ),
                Cell::Text(json_string(
                    result["kind"]
                        .as_object()
                        .expect("kind serializes as an object"),
                    "code",
                )),
                Cell::Text(json_string(
                    result["kind"]
                        .as_object()
                        .expect("kind serializes as an object"),
                    "name",
                )),
                Cell::Text(
                    row["pricingGroupCode"]
                        .as_str()
                        .expect("pricingGroupCode serializes as a string")
                        .to_owned(),
                ),
                Cell::Text(
                    row["pricingGroupName"]
                        .as_str()
                        .expect("pricingGroupName serializes as a string")
                        .to_owned(),
                ),
            ];
            cells.extend(tenors.iter().map(|tenor| {
                match &row["yields"][tenor] {
                    Value::Number(value) => Cell::Number(
                        value
                            .as_f64()
                            .expect("yield numbers serialize as finite f64 values"),
                    ),
                    Value::Null => Cell::Empty,
                    _ => panic!("matrix yields serialize as numbers or null"),
                }
            }));
            cells
        });
    table(columns, rows, delimiter)
}

fn render_kinds_table(result: Value, delimiter: char) -> String {
    let rows = result["kinds"]
        .as_array()
        .expect("core kinds serialize as an array")
        .iter()
        .map(|kind| {
            vec![
                Cell::Text(
                    kind["code"]
                        .as_str()
                        .expect("kind code serializes as a string")
                        .to_owned(),
                ),
                Cell::Text(
                    kind["name"]
                        .as_str()
                        .expect("kind name serializes as a string")
                        .to_owned(),
                ),
            ]
        });
    table(["code".to_owned(), "name".to_owned()], rows, delimiter)
}

fn json_string(object: &Map<String, Value>, key: &str) -> String {
    object[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} serializes as a string"))
        .to_owned()
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

fn help_output(first: &str) -> ProcessOutput {
    match first {
        "--help" | "-h" | "help" => stdout_output(0, root_help()),
        command => command_help_output(command),
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
        "{}\n\nCLI usage:\n  ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv] [--pretty]\n  ytm kinds [--base-date <기준일>] [--format json|csv|tsv] [--pretty]\n  ytm help <command>\n\nOutput:\n  json is the default and prints one JSON object. csv and tsv print tabular success rows. Failures always print one JSON object to stdout and exit non-zero. Help diagnostics for invalid invocations are written to stderr.\n",
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
            "matrix\n  Input JSON: {{ \"baseDate\": \"2026-06-08\", \"kind\": \"국채\" }}\n  Optional fallback: {{ \"fallback\": \"previous-available\", \"lookbackDays\": {DEFAULT_LOOKBACK_DAYS} }}\n  baseDate maps to 기준일 and accepts YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.\n  kind maps to 종류 and accepts one of these Korean labels or source codes:\n{}\n  fallback=previous-available tries the requested date once, then walks backward until rows are found.\n  lookbackDays defaults to {DEFAULT_LOOKBACK_DAYS} and may not exceed {MAX_LOOKBACK_DAYS}.\n  Run kinds to print this list as JSON, CSV, or TSV.\n  Result rows include 적용대상채권, tenors 3M through 50Y, and dateResolution metadata.",
            formatted_kinds("    ")
        ),
        Operation::Kinds => "kinds\n  Input JSON: {} or { \"baseDate\": \"2026-06-08\" }\n  Returns accepted 종류 source codes and Korean labels.".into(),
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

    #[tokio::test]
    async fn root_and_command_help_keep_stdout_clean() {
        let root = run(vec!["ytm".into(), "--help".into()]).await;
        assert_eq!(root.code, 0);
        assert!(root.stdout.contains("CLI usage:"));
        assert_eq!(root.stderr, "");

        let command = run(vec!["ytm".into(), "matrix".into(), "--help".into()]).await;
        assert_eq!(command.code, 0);
        assert!(command.stdout.contains("CLI example:"));
        assert_eq!(command.stderr, "");

        let unknown = run(vec!["ytm".into(), "not-a-command".into(), "--help".into()]).await;
        assert_eq!(unknown.code, 2);
        assert!(unknown.stdout.starts_with("Unknown command: not-a-command"));
        assert_eq!(unknown.stderr, "");

        let help = run(vec!["ytm".into(), "help".into(), "--help".into()]).await;
        assert_eq!(help.code, 0);
        assert!(help.stdout.contains("CLI usage:"));
        assert_eq!(help.stderr, "");

        for (flag, help_value) in [("--kind", "-h"), ("--base-date", "--help")] {
            let args = ["ytm", "matrix", flag, help_value]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>();
            let tail = args[1..]
                .iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert!(matches!(
                parse_invocation(&args, &tail),
                ParseOutcome::Execute(_)
            ));
        }

        let args = ["ytm", "matrix", "--format", "--help"]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>();
        let tail = args[1..]
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(matches!(
            parse_invocation(&args, &tail),
            ParseOutcome::Invalid(_)
        ));
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
    async fn invalid_invocations_preserve_the_removed_cli_contract() {
        let unknown = run(vec!["ytm".into(), "not-a-command".into()]).await;
        assert_eq!(unknown.code, 2);
        assert_eq!(
            serde_json::from_str::<Value>(&unknown.stdout).unwrap(),
            json!({
                "ok": false,
                "error": {
                    "code": "invalid_request",
                    "reason": "Unknown command: not-a-command.",
                    "expected": ["matrix", "kinds"],
                    "actual": "not-a-command",
                    "recoveryHint": "Run ytm --help and retry with a listed command.",
                    "recoveryAction": "inspect_tool_help",
                    "recoverable": true,
                    "retryable": false
                }
            })
        );

        let cross_command = run(vec![
            "ytm".into(),
            "kinds".into(),
            "--kind".into(),
            "10".into(),
        ])
        .await;
        let envelope: Value = serde_json::from_str(&cross_command.stdout).unwrap();
        assert_eq!(envelope["error"]["code"], "unknown_parameter");
        assert_eq!(envelope["error"]["parameter"], "kind");
        assert_eq!(envelope["error"]["exampleInput"], json!({}));

        for args in [
            vec!["ytm", "matrix", "--format"],
            vec!["ytm", "matrix", "--format", ""],
        ] {
            let has_empty_value = args.last() == Some(&"");
            let output = run(args.into_iter().map(OsString::from).collect()).await;
            let envelope: Value = serde_json::from_str(&output.stdout).unwrap();
            assert_eq!(envelope["error"]["code"], "invalid_parameter");
            assert_eq!(envelope["error"]["parameter"], "format");
            if has_empty_value {
                assert_eq!(envelope["error"]["actual"], "");
            } else {
                assert!(envelope["error"].get("actual").is_none());
            }
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
        assert_eq!(
            envelope["error"]["reason"],
            "--base-date requires a 기준일 value."
        );

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
    fn input_json_and_flags_replay_in_argv_order() {
        let args = [
            "ytm",
            "matrix",
            "--kind",
            "10",
            "--input-json",
            r#"{"kind":"20","baseDate":"20260608"}"#,
            "--kind",
            "80",
        ]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
        let ParseOutcome::Execute(invocation) = parse_invocation(
            &args,
            &args[1..]
                .iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
        ) else {
            panic!("invocation should parse");
        };
        assert_eq!(invocation.input["baseDate"], "20260608");
        assert_eq!(invocation.input["kind"], "80");
    }

    #[test]
    fn input_json_preserves_required_field_and_numeric_kind_semantics() {
        for base_date in [Value::Null, Value::String(String::new())] {
            let input =
                Map::from_iter([("baseDate".into(), base_date), ("kind".into(), json!(10))]);
            let error = validate_input(Operation::Matrix, &input).unwrap_err();
            assert_eq!(error.code, "missing_parameter");
            assert_eq!(error.parameter.as_deref(), Some("baseDate"));
        }

        for kind in [Value::Null, Value::String(String::new())] {
            let input = Map::from_iter([
                ("baseDate".into(), json!("2026-06-08")),
                ("kind".into(), kind),
            ]);
            let error = validate_input(Operation::Matrix, &input).unwrap_err();
            assert_eq!(error.code, "missing_parameter");
            assert_eq!(error.parameter.as_deref(), Some("kind"));
        }

        for kind in [json!(10.0), json!(1e1)] {
            let input = Map::from_iter([
                ("baseDate".into(), json!("2026-06-08")),
                ("kind".into(), kind),
            ]);
            let ValidatedInput::Matrix(input) = validate_input(Operation::Matrix, &input).unwrap()
            else {
                panic!("matrix input should remain a matrix input");
            };
            assert_eq!(input.kind.as_str(), "10");
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
