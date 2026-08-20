#!/usr/bin/env node
import { createKisnetYtmToolset } from "./toolset.js";

const toolset = createKisnetYtmToolset();
const FORMATS = new Set(["json", "csv", "tsv"]);

main(process.argv.slice(2)).catch((error) => {
  writeJsonFailure(toolset.serializeError(error));
  process.exitCode = 1;
});

async function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    if (argv[0] && !["--help", "-h", "help"].includes(argv[0])) {
      printCommandHelp(argv[0]);
    } else {
      printHelp();
    }
    return;
  }

  const command = argv[0];
  if (command === "help") {
    if (argv[1]) printCommandHelp(argv[1]);
    else printHelp();
    return;
  }

  if (!toolset.getOperation(command)) {
    writeRootHelpDiagnostic();
    writeJsonFailure(toolset.serializeError(new Error(`Unknown command: ${command}`)), {
      code: "invalid_request",
      reason: `Unknown command: ${command}.`,
      expected: toolset.listOperations().map((operation) => operation.name),
      actual: command,
      recoveryHint: "Run ytm --help and retry with a listed command.",
      recoveryAction: "inspect_tool_help",
      recoverable: true,
      retryable: false
    });
    process.exitCode = 2;
    return;
  }

  const parsed = parseArgs(command, argv.slice(1));
  if (!parsed.ok) {
    writeCommandHelpDiagnostic(command);
    writeJsonFailure(parsed.error);
    process.exitCode = 2;
    return;
  }

  const validation = toolset.validateInput(command, parsed.input);
  if (!validation.valid) {
    writeCommandHelpDiagnostic(command);
    writeJsonFailure(validation.error);
    process.exitCode = 2;
    return;
  }

  const result = await toolset.execute(command, parsed.input);
  renderSuccess(command, result, parsed.format, parsed.pretty);
}

function printHelp() {
  process.stdout.write(formatRootHelp());
}

function printCommandHelp(command) {
  const help = formatCommandHelp(command);
  if (!help) {
    process.stdout.write(`Unknown command: ${command}\nRun ytm --help for available commands.\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(help);
}

function writeRootHelpDiagnostic() {
  process.stderr.write(`\n${formatRootHelp()}`);
}

function writeCommandHelpDiagnostic(command) {
  const help = formatCommandHelp(command);
  if (help) process.stderr.write(`\n${help}`);
}

function formatRootHelp() {
  return `${toolset.help()}\n\nCLI usage:\n  ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv] [--pretty]\n  ytm kinds [--base-date <기준일>] [--format json|csv|tsv] [--pretty]\n  ytm help <command>\n\nOutput:\n  json is the default and prints one JSON object. csv and tsv print tabular success rows. Failures always print one JSON object to stdout and exit non-zero. Help diagnostics for invalid invocations are written to stderr.\n`;
}

function formatCommandHelp(command) {
  const help = toolset.getCommandHelp(command);
  if (!help) return undefined;
  const cli = command === "matrix"
    ? "ytm matrix --base-date 2026-06-08 --kind 국채 --format json"
    : "ytm kinds --base-date 2026-06-08 --format json";
  return `${help}\n\nCLI example:\n  ${cli}\n`;
}

function parseArgs(command, args) {
  const input = {};
  let format = "json";
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--input-json") {
      const raw = args[++index];
      if (!raw) return { ok: false, error: cliError(command, "missing_parameter", "inputJson", "--input-json requires a JSON object string.", "JSON object string", undefined) };
      try {
        Object.assign(input, JSON.parse(raw));
      } catch (error) {
        return { ok: false, error: cliError(command, "invalid_parameter", "inputJson", `Invalid JSON: ${error.message}`, "JSON object string", raw) };
      }
      continue;
    }
    if (arg === "--base-date" || arg === "--baseDate") {
      input.baseDate = args[++index];
      if (!input.baseDate) return { ok: false, error: cliError(command, "missing_parameter", "baseDate", `${arg} requires a 기준일 value.`, "date", undefined) };
      continue;
    }
    if (arg === "--kind") {
      input.kind = args[++index];
      if (!input.kind) return { ok: false, error: cliError(command, "missing_parameter", "kind", "--kind requires a 종류 value.", "종류 label or code", undefined) };
      continue;
    }
    if (arg === "--fallback") {
      input.fallback = args[++index];
      if (!input.fallback) return { ok: false, error: cliError(command, "missing_parameter", "fallback", "--fallback requires a policy value.", "previous-available", undefined) };
      continue;
    }
    if (arg === "--lookback-days" || arg === "--lookbackDays") {
      const rawLookbackDays = args[++index];
      if (!rawLookbackDays) return { ok: false, error: cliError(command, "missing_parameter", "lookbackDays", `${arg} requires a day count.`, "integer day count", undefined) };
      input.lookbackDays = /^\d+$/.test(rawLookbackDays) ? Number(rawLookbackDays) : rawLookbackDays;
      continue;
    }
    if (arg === "--format") {
      format = args[++index];
      if (!FORMATS.has(format)) return { ok: false, error: cliError(command, "invalid_parameter", "format", "Unsupported format.", [...FORMATS], format) };
      continue;
    }
    return { ok: false, error: cliError(command, "unknown_parameter", arg, `Unknown option: ${arg}.`, "supported CLI options", arg) };
  }

  return { ok: true, input, format, pretty };
}

function cliError(operationName, code, parameter, reason, expected, actual) {
  return {
    ok: false,
    code,
    operationName,
    parameter,
    reason,
    expected,
    actual,
    exampleInput: operationName === "matrix" ? { baseDate: "2026-06-08", kind: "국채" } : { baseDate: "2026-06-08" },
    recoveryHint: `Run ytm help ${operationName} and retry with supported options.`,
    recoveryAction: "inspect_command_help",
    recoverable: true,
    retryable: false
  };
}

function renderSuccess(operation, result, format, pretty) {
  if (format === "json") {
    const envelope = { ok: true, operation, result };
    process.stdout.write(`${JSON.stringify(envelope, null, pretty ? 2 : 0)}\n`);
    return;
  }
  if (operation === "matrix") {
    process.stdout.write(renderMatrixTable(result, format));
    return;
  }
  process.stdout.write(renderKindsTable(result, format));
}

function renderMatrixTable(result, format) {
  const delimiter = format === "tsv" ? "\t" : ",";
  const columns = ["requestedBaseDate", "baseDate", "usedFallback", "kindCode", "kindName", "pricingGroupCode", "pricingGroupName", ...result.tenors];
  const rows = result.rows.map((row) => [
    result.requestedBaseDate,
    result.baseDate,
    result.dateResolution?.usedFallback ?? false,
    result.kind.code,
    result.kind.name,
    row.pricingGroupCode,
    row.pricingGroupName,
    ...result.tenors.map((tenor) => row.yields[tenor] ?? "")
  ]);
  return table(columns, rows, delimiter);
}

function renderKindsTable(result, format) {
  const delimiter = format === "tsv" ? "\t" : ",";
  return table(["code", "name"], result.kinds.map((kind) => [kind.code, kind.name]), delimiter);
}

function table(columns, rows, delimiter) {
  return [columns, ...rows].map((row) => row.map((cell) => formatCell(cell, delimiter)).join(delimiter)).join("\n") + "\n";
}

function formatCell(value, delimiter) {
  const text = value === null || value === undefined ? "" : String(value);
  if (delimiter === "\t") return text.replace(/[\t\r\n]/g, " ");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeJsonFailure(error, override) {
  const payload = { ok: false, error: override || error };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
