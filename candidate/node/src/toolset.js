import { describeNative, invokeNative } from "./native.js";

const FALLBACK_PREVIOUS_AVAILABLE = "previous-available";
const DEFAULT_LOOKBACK_DAYS = 10;
const MAX_LOOKBACK_DAYS = 31;

const operationSpecs = [
  {
    name: "matrix",
    label: "Lookup KIS-NET YTM Matrix",
    description: "Fetch YTM Matrix rows from KIS-NET for a 기준일 and 종류. The source-native 종류 may be a Korean label such as 국채 or a source code such as 10.",
    requiredInputKeys: ["baseDate", "kind"],
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["baseDate", "kind"],
      properties: {
        baseDate: {
          type: "string",
          description: "기준일. Accepted forms: YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD."
        },
        kind: {
          type: ["string", "number"],
          description: "종류. Use a Korean source label such as 국채 or a source code such as 10."
        },
        fallback: {
          type: "string",
          enum: [FALLBACK_PREVIOUS_AVAILABLE],
          description: "Optional unavailable-date policy. Use previous-available to try the requested 기준일 once, then walk backward until KIS-NET returns matrix rows."
        },
        lookbackDays: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LOOKBACK_DAYS,
          description: `Maximum prior calendar days to try when fallback is ${FALLBACK_PREVIOUS_AVAILABLE}. Defaults to ${DEFAULT_LOOKBACK_DAYS}.`
        }
      }
    },
    resultJsonSchema: {
      type: "object",
      required: ["baseDate", "kind", "tenors", "rows", "source", "requestedBaseDate", "dateResolution"],
      properties: {
        baseDate: { type: "string" },
        requestedBaseDate: { type: "string" },
        dateResolution: { type: "object" },
        kind: { type: "object" },
        tenors: { type: "array", items: { type: "string" } },
        rows: { type: "array" },
        source: { type: "object" }
      }
    },
    examples: [
      { input: { baseDate: "2026-06-08", kind: "국채" } },
      { input: { baseDate: "20260608", kind: "10" } },
      { input: { baseDate: "2026-06-07", kind: "국채", fallback: FALLBACK_PREVIOUS_AVAILABLE, lookbackDays: 10 } }
    ],
    limitations: [
      "KIS-NET decides available 기준일 data and may return an empty matrix for non-business days, holidays, or unavailable dates.",
      `With fallback=${FALLBACK_PREVIOUS_AVAILABLE}, the requested 기준일 is still tried first; previous dates are probed only after KIS-NET returns no rows.`,
      "Yield cells containing '-' are returned as null while preserving the raw cell text."
    ],
    resultSummary: "Returns the resolved 종류, tenor labels, one row per 적용대상채권, numeric yield values, raw source cells, source request metadata, and date-resolution metadata."
  },
  {
    name: "kinds",
    label: "List KIS-NET YTM 종류 values",
    description: "List source 종류 codes and Korean labels for the KIS-NET YTM Matrix. When baseDate is supplied, values are refreshed from KIS-NET's init endpoint; otherwise the inspected source list is returned without a network request.",
    requiredInputKeys: [],
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseDate: {
          type: "string",
          description: "Optional 기준일 used to refresh 종류 values from KIS-NET. Accepted forms: YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD."
        }
      }
    },
    resultJsonSchema: {
      type: "object",
      required: ["kinds", "source"],
      properties: {
        baseDate: { type: ["string", "null"] },
        kinds: { type: "array" },
        source: { type: "object" }
      }
    },
    examples: [
      { input: {} },
      { input: { baseDate: "2026-06-08" } }
    ],
    limitations: [
      "Without baseDate this command returns the source list observed during tool inspection instead of performing a live request."
    ],
    resultSummary: "Returns accepted 종류 codes and labels."
  }
];

export class KisnetYtmError extends Error {
  constructor(details) {
    super(details.message || details.reason || details.code);
    this.name = "KisnetYtmError";
    this.details = details;
  }
}

export function createKisnetYtmToolset() {
  return {
    id: "ytm",
    label: "KIS-NET YTM Matrix",
    description: "Deterministic lookup tool for KIS-NET YTM Matrix data using 기준일 and 종류.",
    help() {
      return [
        "KIS-NET YTM Matrix toolset",
        "",
        "Operations:",
        "  matrix: fetch YTM Matrix rows for a 기준일 and 종류.",
        "  kinds: list accepted 종류 codes and Korean labels.",
        "",
        "Accepted 종류 values:",
        ...formatKindsForHelp().map((line) => `  ${line}`),
        "",
        "Source terms are preserved where official: 기준일, 종류, and 적용대상채권.",
        "Use validateInput(operationName, input) before execute when integrating in-process."
      ].join("\n");
    },
    listOperations() {
      return structuredClone(operationSpecs);
    },
    getOperation(name) {
      const spec = operationSpecs.find((spec) => spec.name === name);
      return spec && structuredClone(spec);
    },
    getCommandHelp(name) {
      if (name === "matrix") {
        return [
          "matrix",
          "  Input JSON: { \"baseDate\": \"2026-06-08\", \"kind\": \"국채\" }",
          `  Optional fallback: { "fallback": "${FALLBACK_PREVIOUS_AVAILABLE}", "lookbackDays": ${DEFAULT_LOOKBACK_DAYS} }`,
          "  baseDate maps to 기준일 and accepts YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.",
          "  kind maps to 종류 and accepts one of these Korean labels or source codes:",
          ...formatKindsForHelp().map((line) => `    ${line}`),
          `  fallback=${FALLBACK_PREVIOUS_AVAILABLE} tries the requested date once, then walks backward until rows are found.`,
          `  lookbackDays defaults to ${DEFAULT_LOOKBACK_DAYS} and may not exceed ${MAX_LOOKBACK_DAYS}.`,
          "  Run kinds to print this list as JSON, CSV, or TSV.",
          "  Result rows include 적용대상채권, tenors 3M through 50Y, and dateResolution metadata."
        ].join("\n");
      }
      if (name === "kinds") {
        return [
          "kinds",
          "  Input JSON: {} or { \"baseDate\": \"2026-06-08\" }",
          "  Returns accepted 종류 source codes and Korean labels."
        ].join("\n");
      }
      return undefined;
    },
    validateInput(operationName, input) {
      return validateInput(operationName, input);
    },
    async execute(operationName, input, context = {}) {
      const validation = validateInput(operationName, input);
      if (!validation.valid) throw new KisnetYtmError(validation.error);
      if (context.signal?.aborted) {
        throw new KisnetYtmError({
          ok: false,
          code: "source_transport_error",
          reason: "KIS-NET request was cancelled.",
          expected: "A successful HTTP response from KIS-NET",
          recoveryHint: "Retry later or inspect whether KIS-NET is available.",
          recoveryAction: "inspect_tool_help",
          recoverable: true,
          retryable: true,
          cause: "AbortError"
        });
      }
      const safeInput = validation.normalizedInput;
      if (operationName === "matrix" || operationName === "kinds") {
        const envelope = await invokeNative(operationName, safeInput, context.signal);
        if (!envelope.ok) throw new KisnetYtmError(envelope.error);
        return envelope.value;
      }
      throw new KisnetYtmError(unknownOperationError(operationName));
    },
    serializeError(error) {
      return serializeError(error);
    }
  };
}

export function validateInput(operationName, input) {
  const spec = operationSpecs.find((candidate) => candidate.name === operationName);
  if (!spec) return { valid: false, error: unknownOperationError(operationName) };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: validationError({ operationName, code: "invalid_request", reason: "Input must be a JSON object.", expected: "object", actual: safeActual(input), exampleInput: spec.examples[0].input, recoveryHint: "Pass a JSON object matching the command input schema." }) };
  }

  const allowed = Object.keys(spec.inputJsonSchema.properties || {});
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return { valid: false, error: validationError({ operationName, code: "unknown_parameter", parameter: key, reason: `Unknown parameter: ${key}.`, expected: allowed, actual: key, exampleInput: spec.examples[0].input, recoveryHint: `Remove ${key} or inspect command help for supported parameters.` }) };
    }
  }

  for (const key of spec.requiredInputKeys) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      return { valid: false, error: validationError({ operationName, code: "missing_parameter", parameter: key, reason: `Missing required parameter: ${key}.`, expected: spec.inputJsonSchema.properties[key], actual: safeActual(input[key]), exampleInput: spec.examples[0].input, recoveryHint: `Provide ${key}.` }) };
    }
  }

  const normalized = { ...input };
  if (input.baseDate !== undefined) {
    const date = normalizeBaseDate(input.baseDate);
    if (!date) {
      return { valid: false, error: validationError({ operationName, code: "invalid_parameter", parameter: "baseDate", reason: "baseDate must be a valid 기준일 in YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD form.", expected: "YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD", actual: safeActual(input.baseDate), exampleInput: spec.examples[0].input, recoveryHint: "Use the official 기준일 date shown by KIS-NET, for example 2026-06-08." }) };
    }
    normalized.baseDate = date.display;
    Object.defineProperty(normalized, "baseDateCompact", {
      value: date.compact,
      enumerable: false,
      configurable: true
    });
  }
  if (operationName === "matrix") {
    if (!["string", "number"].includes(typeof input.kind)) {
      return { valid: false, error: validationError({ operationName, code: "invalid_parameter", parameter: "kind", reason: "kind must be a 종류 label or source code.", expected: "string or number", actual: safeActual(input.kind), exampleInput: spec.examples[0].input, recoveryHint: "Use kinds to inspect accepted 종류 values, then retry with a code like 10 or label like 국채." }) };
    }
    normalized.kind = String(input.kind).trim();

    if (input.fallback !== undefined) {
      if (input.fallback !== FALLBACK_PREVIOUS_AVAILABLE) {
        return { valid: false, error: validationError({ operationName, code: "invalid_parameter", parameter: "fallback", reason: `fallback must be ${FALLBACK_PREVIOUS_AVAILABLE}.`, expected: [FALLBACK_PREVIOUS_AVAILABLE], actual: safeActual(input.fallback), exampleInput: spec.examples[2].input, recoveryHint: `Use fallback=${FALLBACK_PREVIOUS_AVAILABLE}, or omit fallback for exact-date behavior.` }) };
      }
      normalized.fallback = FALLBACK_PREVIOUS_AVAILABLE;
    }

    if (input.lookbackDays !== undefined) {
      if (input.fallback !== FALLBACK_PREVIOUS_AVAILABLE) {
        return { valid: false, error: validationError({ operationName, code: "invalid_parameter", parameter: "lookbackDays", reason: `lookbackDays only applies when fallback is ${FALLBACK_PREVIOUS_AVAILABLE}.`, expected: { fallback: FALLBACK_PREVIOUS_AVAILABLE, lookbackDays: `integer 1-${MAX_LOOKBACK_DAYS}` }, actual: safeActual(input.lookbackDays), exampleInput: spec.examples[2].input, recoveryHint: `Add fallback=${FALLBACK_PREVIOUS_AVAILABLE}, or remove lookbackDays for exact-date behavior.` }) };
      }
      const lookbackDays = normalizeLookbackDays(input.lookbackDays);
      if (lookbackDays === null) {
        return { valid: false, error: validationError({ operationName, code: "invalid_parameter", parameter: "lookbackDays", reason: `lookbackDays must be an integer from 1 to ${MAX_LOOKBACK_DAYS}.`, expected: `integer 1-${MAX_LOOKBACK_DAYS}`, actual: safeActual(input.lookbackDays), exampleInput: spec.examples[2].input, recoveryHint: `Use a small calendar-day lookback window such as ${DEFAULT_LOOKBACK_DAYS}.` }) };
      }
      normalized.lookbackDays = lookbackDays;
    } else if (input.fallback === FALLBACK_PREVIOUS_AVAILABLE) {
      normalized.lookbackDays = DEFAULT_LOOKBACK_DAYS;
    }
  }

  return { valid: true, normalizedInput: normalized };
}

function normalizeLookbackDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LOOKBACK_DAYS) return null;
  return value;
}

function normalizeBaseDate(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(?:(\d{4})(\d{2})(\d{2})|(\d{4})-(\d{2})-(\d{2})|(\d{4})\.(\d{2})\.(\d{2}))$/.exec(trimmed);
  if (!match) return null;
  const [, compactYear, compactMonth, compactDay, dashedYear, dashedMonth, dashedDay, dottedYear, dottedMonth, dottedDay] = match;
  const yyyy = compactYear || dashedYear || dottedYear;
  const mm = compactMonth || dashedMonth || dottedMonth;
  const dd = compactDay || dashedDay || dottedDay;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(Number(yyyy), month - 1, day));
  if (date.getUTCFullYear() !== Number(yyyy) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { display: `${yyyy}-${mm}-${dd}`, compact: `${yyyy}${mm}${dd}` };
}

function validationError(details) {
  return {
    ok: false,
    code: details.code,
    operationName: details.operationName,
    parameter: details.parameter,
    reason: details.reason,
    expected: details.expected,
    actual: details.actual,
    exampleInput: details.exampleInput,
    recoveryHint: details.recoveryHint,
    recoveryAction: details.parameter ? "inspect_command_help" : "inspect_tool_help",
    recoverable: true,
    retryable: false
  };
}

function unknownOperationError(operationName) {
  return validationError({
    operationName,
    code: "invalid_request",
    reason: `Unknown operation: ${operationName}.`,
    expected: operationSpecs.map((spec) => spec.name),
    actual: safeActual(operationName),
    exampleInput: { operationName: "matrix", input: { baseDate: "2026-06-08", kind: "국채" } },
    recoveryHint: "Inspect tool help and retry with a listed operation name."
  });
}

function serializeError(error) {
  if (error instanceof KisnetYtmError) return error.details;
  if (error && typeof error === "object" && error.details) return error.details;
  return {
    ok: false,
    code: "internal_error",
    reason: "The Node adapter encountered an internal error.",
    recoveryHint: "Reinstall or update the package for this platform, then report the failure if it persists.",
    recoveryAction: "update_package",
    recoverable: false,
    retryable: false,
    cause: error instanceof Error ? error.name : "Error"
  };
}

function safeActual(value) {
  if (value === undefined) return "[missing]";
  if (value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return `[array:${value.length}]`;
  return "[object]";
}


function formatKindsForHelp() {
  try {
    return describeNative().kinds.map((kind) => `${kind.code} = ${kind.name}`);
  } catch {
    return ["Native capabilities unavailable; reinstall @sjunepark/ytm for this platform."];
  }
}
