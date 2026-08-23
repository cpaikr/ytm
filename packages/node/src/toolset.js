import { describeNative, invokeNative } from "./native.js";

const FALLBACK_PREVIOUS_AVAILABLE = "previous-available";
const DEFAULT_LOOKBACK_DAYS = 10;
const MAX_LOOKBACK_DAYS = 31;

const TOOLSET_ID = "ytm";
const TOOLSET_LABEL = "KIS-NET YTM Matrix";
const TOOLSET_DESCRIPTION =
  "Deterministic lookup of KIS-NET YTM Matrix data with source and resolution metadata.";

const operationSpecs = [
  {
    name: "matrix",
    label: "Lookup KIS-NET YTM Matrix",
    description:
      "Fetch YTM Matrix rows from KIS-NET for a 기준일 and 종류. The source-native 종류 may be a Korean label such as 국채 or a source code such as 10.",
    requiredInputKeys: ["baseDate", "kind"],
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["baseDate", "kind"],
      properties: {
        baseDate: {
          type: "string",
          description:
            "기준일. Accepted forms: YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD."
        },
        kind: {
          type: ["string", "number"],
          description:
            "종류. Use a Korean source label such as 국채 or a source code such as 10."
        },
        fallback: {
          type: "string",
          enum: [FALLBACK_PREVIOUS_AVAILABLE],
          description:
            "Optional unavailable-date policy. Use previous-available to try the requested 기준일 once, then walk backward until KIS-NET returns matrix rows."
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
      required: [
        "baseDate",
        "kind",
        "tenors",
        "rows",
        "source",
        "requestedBaseDate",
        "dateResolution"
      ],
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
      { baseDate: "2026-06-08", kind: "국채" },
      { baseDate: "20260608", kind: "10" },
      {
        baseDate: "2026-06-07",
        kind: "국채",
        fallback: FALLBACK_PREVIOUS_AVAILABLE,
        lookbackDays: 10
      }
    ],
    limitations: [
      "KIS-NET decides available 기준일 data and may return an empty matrix for non-business days, holidays, or unavailable dates.",
      `With fallback=${FALLBACK_PREVIOUS_AVAILABLE}, the requested 기준일 is still tried first; previous dates are probed only after KIS-NET returns no rows.`,
      "Exact '-' yield cells are returned as null; leading ASCII-space padding on numeric yields is parsed without changing yieldText or raw."
    ],
    resultSummary:
      "Returns the resolved 종류, tenor labels, one row per 적용대상채권, numeric yield values, raw source cells, source request metadata, and date-resolution metadata."
  },
  {
    name: "kinds",
    label: "List KIS-NET YTM 종류 values",
    description:
      "List source 종류 codes and Korean labels for the KIS-NET YTM Matrix. When baseDate is supplied, values are refreshed from KIS-NET's init endpoint; otherwise the inspected source list is returned without a network request.",
    requiredInputKeys: [],
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseDate: {
          type: "string",
          description:
            "Optional 기준일 used to refresh 종류 values from KIS-NET. Accepted forms: YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD."
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
    examples: [{}, { baseDate: "2026-06-08" }],
    limitations: [
      "Without baseDate this command returns the source list observed during tool inspection instead of performing a live request."
    ],
    resultSummary: "Returns accepted 종류 codes and labels."
  }
];

const ERROR_NAMES = {
  invalid_request: "ValidationError",
  missing_parameter: "ValidationError",
  invalid_parameter: "ValidationError",
  unknown_parameter: "ValidationError",
  source_data_unavailable: "SourceDataUnavailableError",
  source_transport_error: "SourceTransportError",
  source_protocol_error: "SourceProtocolError",
  source_format_error: "SourceFormatError",
  unsupported_platform: "UnsupportedPlatformError",
  native_package_unavailable: "NativePackageUnavailableError",
  native_package_corrupt: "NativePackageCorruptError",
  internal_error: "InternalError"
};

export class KisnetYtmError extends Error {
  constructor(details) {
    const serialized = normalizeSerializedError(details);
    super(serialized.message);
    this.name = serialized.name;
    this.details = serialized;
  }
}

export function createKisnetYtmToolset() {
  return {
    id: TOOLSET_ID,
    label: TOOLSET_LABEL,
    description: TOOLSET_DESCRIPTION,
    help() {
      return buildHelp();
    },
    listOperations() {
      return clone(operationSpecs);
    },
    getOperation(name) {
      const spec = operationSpecs.find((candidate) => candidate.name === name);
      return spec ? clone(spec) : undefined;
    },
    getCommandHelp(name) {
      const spec = operationSpecs.find((candidate) => candidate.name === name);
      return spec ? clone(spec) : undefined;
    },
    validateInput(operationName, input) {
      return validateInput(operationName, input);
    },
    async execute(operationName, input, context = {}) {
      const effectiveInput =
        operationName === "kinds" && input === undefined ? {} : input;
      const validation = validateInput(operationName, effectiveInput);
      if (!validation.ok) throw new KisnetYtmError(validation.error);

      // A pre-aborted request is a caller cancellation, not a transient source
      // failure. Keep the historical source_transport_error code while making
      // the retry policy explicit and non-retryable.
      if (context.signal?.aborted) {
        throw new KisnetYtmError({
          ok: false,
          name: "AbortError",
          code: "source_transport_error",
          operationName,
          reason: "The KIS-NET request was cancelled before it started.",
          expected: "A non-aborted request signal",
          recoveryHint: "Create a new request with a non-aborted AbortSignal.",
          recoveryAction: { kind: "start_new_request" },
          recoverable: false,
          retryable: false,
          cause: "AbortError"
        });
      }

      if (operationName !== "matrix" && operationName !== "kinds") {
        throw new KisnetYtmError(unknownOperationError(operationName));
      }

      const envelope = await invokeNative(
        operationName,
        validation.input,
        context.signal
      );
      if (!envelope || envelope.ok !== true) {
        throw new KisnetYtmError(envelope?.error ?? nativeEnvelopeError());
      }
      return envelope.value;
    },
    serializeError(error) {
      return serializeError(error);
    }
  };
}

export function validateInput(operationName, input) {
  const spec = operationSpecs.find((candidate) => candidate.name === operationName);
  if (!spec) return { ok: false, error: unknownOperationError(operationName) };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: validationError({
        operationName,
        code: "invalid_request",
        reason: "Input must be a JSON object.",
        expected: "object",
        actual: safeActual(input),
        exampleInput: spec.examples[0],
        recoveryHint: "Pass a JSON object matching the command input schema.",
        recoveryAction: {
          kind: "inspect_command_help",
          operationName
        }
      })
    };
  }

  const allowed = Object.keys(spec.inputJsonSchema.properties || {});
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        error: validationError({
          operationName,
          code: "unknown_parameter",
          parameter: key,
          reason: `Unknown parameter: ${key}.`,
          expected: allowed,
          actual: key,
          exampleInput: spec.examples[0],
          recoveryHint: `Remove ${key} or inspect command help for supported parameters.`
        })
      };
    }
  }

  for (const key of spec.requiredInputKeys) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      return {
        ok: false,
        error: validationError({
          operationName,
          code: "missing_parameter",
          parameter: key,
          reason: `Missing required parameter: ${key}.`,
          expected: spec.inputJsonSchema.properties[key],
          actual: safeActual(input[key]),
          exampleInput: spec.examples[0],
          recoveryHint: `Provide ${key}.`
        })
      };
    }
  }

  const normalized = { ...input };
  if (input.baseDate !== undefined) {
    const date = normalizeBaseDate(input.baseDate);
    if (!date) {
      return {
        ok: false,
        error: validationError({
          operationName,
          code: "invalid_parameter",
          parameter: "baseDate",
          reason:
            "baseDate must be a valid 기준일 in YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD form.",
          expected: "YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD",
          actual: safeActual(input.baseDate),
          exampleInput: spec.examples[0],
          recoveryHint:
            "Use the official 기준일 date shown by KIS-NET, for example 2026-06-08."
        })
      };
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
      return {
        ok: false,
        error: validationError({
          operationName,
          code: "invalid_parameter",
          parameter: "kind",
          reason: "kind must be a 종류 label or source code.",
          expected: "string or number",
          actual: safeActual(input.kind),
          exampleInput: spec.examples[0],
          recoveryHint:
            "Use kinds to inspect accepted 종류 values, then retry with a code like 10 or label like 국채."
        })
      };
    }
    if (typeof input.kind === "number" && !Number.isFinite(input.kind)) {
      return {
        ok: false,
        error: validationError({
          operationName,
          code: "invalid_parameter",
          parameter: "kind",
          reason:
            "kind must be a finite number or nonempty 종류 label or source code.",
          expected: "finite number or nonempty string",
          actual: String(input.kind),
          exampleInput: spec.examples[0],
          recoveryHint:
            "Use kinds to inspect accepted 종류 values, then retry with a code like 10 or label like 국채."
        })
      };
    }
    const normalizedKind = String(input.kind).trim();
    if (normalizedKind === "") {
      return {
        ok: false,
        error: validationError({
          operationName,
          code: "missing_parameter",
          parameter: "kind",
          reason: "Missing required parameter: kind.",
          expected: spec.inputJsonSchema.properties.kind,
          actual: normalizedKind,
          exampleInput: spec.examples[0],
          recoveryHint: "Provide kind."
        })
      };
    }
    normalized.kind = normalizedKind;

    if (input.fallback !== undefined) {
      if (input.fallback !== FALLBACK_PREVIOUS_AVAILABLE) {
        return {
          ok: false,
          error: validationError({
            operationName,
            code: "invalid_parameter",
            parameter: "fallback",
            reason: `fallback must be ${FALLBACK_PREVIOUS_AVAILABLE}.`,
            expected: [FALLBACK_PREVIOUS_AVAILABLE],
            actual: safeActual(input.fallback),
            exampleInput: spec.examples[2],
            recoveryHint: `Use fallback=${FALLBACK_PREVIOUS_AVAILABLE}, or omit fallback for exact-date behavior.`
          })
        };
      }
      normalized.fallback = FALLBACK_PREVIOUS_AVAILABLE;
    }

    if (input.lookbackDays !== undefined) {
      if (input.fallback !== FALLBACK_PREVIOUS_AVAILABLE) {
        return {
          ok: false,
          error: validationError({
            operationName,
            code: "invalid_parameter",
            parameter: "lookbackDays",
            reason: `lookbackDays only applies when fallback is ${FALLBACK_PREVIOUS_AVAILABLE}.`,
            expected: {
              fallback: FALLBACK_PREVIOUS_AVAILABLE,
              lookbackDays: `integer 1-${MAX_LOOKBACK_DAYS}`
            },
            actual: safeActual(input.lookbackDays),
            exampleInput: spec.examples[2],
            recoveryHint: `Add fallback=${FALLBACK_PREVIOUS_AVAILABLE}, or remove lookbackDays for exact-date behavior.`
          })
        };
      }
      const lookbackDays = normalizeLookbackDays(input.lookbackDays);
      if (lookbackDays === null) {
        return {
          ok: false,
          error: validationError({
            operationName,
            code: "invalid_parameter",
            parameter: "lookbackDays",
            reason: `lookbackDays must be an integer from 1 to ${MAX_LOOKBACK_DAYS}.`,
            expected: `integer 1-${MAX_LOOKBACK_DAYS}`,
            actual: safeActual(input.lookbackDays),
            exampleInput: spec.examples[2],
            recoveryHint: `Use a small calendar-day lookback window such as ${DEFAULT_LOOKBACK_DAYS}.`
          })
        };
      }
      normalized.lookbackDays = lookbackDays;
    } else if (input.fallback === FALLBACK_PREVIOUS_AVAILABLE) {
      normalized.lookbackDays = DEFAULT_LOOKBACK_DAYS;
    }
  }

  return { ok: true, input: normalized };
}

function buildHelp() {
  return clone({
    id: TOOLSET_ID,
    label: TOOLSET_LABEL,
    description: TOOLSET_DESCRIPTION,
    operations: operationSpecs,
    availableKinds: formatKindsForHelp(),
    guidance: [
      "Call getCommandHelp(operationName) for the complete input and result contract.",
      "Validate a direct input object before execute; validation returns normalized input or structured recovery metadata.",
      "Results preserve source metadata, references where available, and date-resolution warnings in the operation payload."
    ],
    sourceTerms: ["기준일", "종류", "적용대상채권"]
  });
}

function normalizeLookbackDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LOOKBACK_DAYS) {
    return null;
  }
  return value;
}

function normalizeBaseDate(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match =
    /^(?:(\d{4})(\d{2})(\d{2})|(\d{4})-(\d{2})-(\d{2})|(\d{4})\.(\d{2})\.(\d{2}))$/.exec(
      trimmed
    );
  if (!match) return null;
  const [
    ,
    compactYear,
    compactMonth,
    compactDay,
    dashedYear,
    dashedMonth,
    dashedDay,
    dottedYear,
    dottedMonth,
    dottedDay
  ] = match;
  const yyyy = compactYear || dashedYear || dottedYear;
  const mm = compactMonth || dashedMonth || dottedMonth;
  const dd = compactDay || dashedDay || dottedDay;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    return null;
  }
  return { display: `${yyyy}-${mm}-${dd}`, compact: `${yyyy}${mm}${dd}` };
}

function validationError(details) {
  const reason = details.reason || "The input is invalid.";
  return normalizeSerializedError({
    ok: false,
    name: "ValidationError",
    message: details.message || reason,
    code: details.code,
    operationName: details.operationName,
    parameter: details.parameter,
    reason,
    expected: details.expected,
    actual: details.actual,
    exampleInput: details.exampleInput,
    recoveryHint: details.recoveryHint,
    recoveryAction:
      details.recoveryAction ||
      (details.parameter
        ? { kind: "inspect_command_help", operationName: details.operationName }
        : { kind: "inspect_tool_help" }),
    recoverable: true,
    retryable: false
  });
}

function unknownOperationError(operationName) {
  return validationError({
    operationName,
    code: "invalid_request",
    reason: `Unknown operation: ${operationName}.`,
    expected: operationSpecs.map((spec) => spec.name),
    actual: safeActual(operationName),
    exampleInput: {
      operationName: "matrix",
      input: { baseDate: "2026-06-08", kind: "국채" }
    },
    recoveryHint: "Inspect tool help and retry with a listed operation name.",
    recoveryAction: { kind: "inspect_tool_help" }
  });
}

function nativeEnvelopeError() {
  return {
    ok: false,
    code: "internal_error",
    reason: "The native ytm adapter returned an invalid result envelope.",
    recoveryHint:
      "Update the package for this platform, then report the failure if it persists.",
    recoveryAction: { kind: "update_package" },
    recoverable: false,
    retryable: false,
    cause: "InvalidNativeEnvelope"
  };
}

function serializeError(error) {
  if (isRecord(error?.details)) return normalizeSerializedError(error.details);
  if (
    isRecord(error) &&
    (typeof error.code === "string" ||
      typeof error.reason === "string" ||
      error.ok === false)
  ) {
    if (error instanceof Error) {
      return normalizeSerializedError({
        ...error,
        ok: false,
        name: error.name,
        message: error.message
      });
    }
    return normalizeSerializedError(error);
  }
  return normalizeSerializedError({
    ok: false,
    code: "internal_error",
    reason: "The Node adapter encountered an internal error.",
    recoveryHint:
      "Update the package for this platform, then report the failure if it persists.",
    recoveryAction: { kind: "update_package" },
    recoverable: false,
    retryable: false,
    cause: error instanceof Error ? error.name : "Error"
  });
}

function normalizeSerializedError(details) {
  if (!isRecord(details)) {
    return normalizeSerializedError({
      ok: false,
      code: "internal_error",
      reason: "The Node adapter encountered an internal error.",
      recoveryHint:
        "Update the package for this platform, then report the failure if it persists.",
      recoveryAction: { kind: "update_package" },
      recoverable: false,
      retryable: false,
      cause: "InvalidErrorDetails"
    });
  }

  const code = typeof details.code === "string" ? details.code : "internal_error";
  const reason =
    typeof details.reason === "string"
      ? details.reason
      : typeof details.message === "string"
        ? details.message
        : "The operation failed.";
  const message = typeof details.message === "string" ? details.message : reason;
  const operationName =
    typeof details.operationName === "string" ? details.operationName : undefined;
  const normalized = {
    ...clone(details),
    ok: details.ok === false ? false : details.ok === true ? true : false,
    name:
      typeof details.name === "string" && details.name.length > 0
        ? details.name
        : details.cause === "AbortError"
          ? "AbortError"
        : ERROR_NAMES[code] || "KisnetYtmError",
    message,
    code,
    reason,
    recoveryAction: normalizeRecoveryAction(details.recoveryAction, operationName),
    recoverable:
      typeof details.recoverable === "boolean" ? details.recoverable : false,
    retryable: typeof details.retryable === "boolean" ? details.retryable : false
  };
  if (normalized.recoveryHint === undefined) {
    normalized.recoveryHint =
      code === "internal_error"
        ? "Update the package for this platform, then report the failure if it persists."
        : "Inspect tool help and retry with the documented recovery action.";
  }
  return clone(normalized);
}

function normalizeRecoveryAction(action, operationName) {
  if (isRecord(action) && typeof action.kind === "string") {
    return clone(action);
  }
  if (typeof action === "string") {
    if (action === "inspect_command_help") {
      return {
        kind: action,
        ...(operationName ? { operationName } : {})
      };
    }
    return { kind: action };
  }
  return operationName
    ? { kind: "inspect_command_help", operationName }
    : { kind: "inspect_tool_help" };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeActual(value) {
  if (value === undefined) return "[missing]";
  if (value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return `[array:${value.length}]`;
  return "[object]";
}

function clone(value) {
  return structuredClone(value);
}

function formatKindsForHelp() {
  try {
    return describeNative().kinds.map((kind) => `${kind.code} = ${kind.name}`);
  } catch {
    return [
      "Native capabilities unavailable; install the platform package before executing source-backed operations."
    ];
  }
}
