import { invokeNative } from "./native.js";

const FALLBACK_PREVIOUS_AVAILABLE = "previous-available";
const DEFAULT_LOOKBACK_DAYS = 10;
const MAX_LOOKBACK_DAYS = 31;

const methodSpecs = {
  history: {
    requiredInputKeys: [],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {
      baseDates: { type: "array", minItems: 1, maxItems: 2000, items: { type: "string" } },
      startDate: { type: "string" }, endDate: { type: "string" },
      fallback: { type: "string", enum: ["exact", "previous-available"] },
      lookbackDays: { type: "integer", minimum: 1, maximum: 31 }
    } },
    examples: [{ baseDates: ["2026-06-08"] }]
  },
  matrix: {
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
    examples: [
      { baseDate: "2026-06-08", kind: "국채" },
      { baseDate: "20260608", kind: "10" },
      {
        baseDate: "2026-06-07",
        kind: "국채",
        fallback: FALLBACK_PREVIOUS_AVAILABLE,
        lookbackDays: 10
      }
    ]
  },
  kinds: {
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
    examples: [{}, { baseDate: "2026-06-08" }]
  }
};

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

export class YtmError extends Error {
  constructor(details) {
    const serialized = normalizeSerializedError(details);
    super(serialized.message);
    this.name = serialized.name;
    this.details = serialized;
  }
}

export class YtmClient {
  history(input, options = {}) {
    return executeOperation("history", input, options);
  }

  matrix(input, options = {}) {
    return executeOperation("matrix", input, options);
  }

  kinds(input = {}, options = {}) {
    return executeOperation("kinds", input, options);
  }
}

export function validateHistoryInput(input) {
  return validateInput("history", input);
}

export function validateMatrixInput(input) {
  return validateInput("matrix", input);
}

export function validateKindsInput(input = {}) {
  return validateInput("kinds", input);
}

export function serializeYtmError(error) {
  return serializeError(error);
}

async function executeOperation(operationName, input, options) {
  const validation = validateInput(operationName, input);
  if (!validation.ok) throw new YtmError(validation.error);

  // A pre-aborted request is a caller cancellation, not a transient source
  // failure. Keep the historical source_transport_error code while making
  // the retry policy explicit and non-retryable.
  if (options.signal?.aborted) {
    throw new YtmError({
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

  let envelope;
  try {
    envelope = await invokeNative(
      operationName,
      validation.input,
      options.signal
    );
  } catch (cause) {
    throw cause instanceof YtmError ? cause : new YtmError(serializeError(cause));
  }
  if (!envelope || envelope.ok !== true) {
    throw new YtmError(envelope?.error ?? nativeEnvelopeError(operationName));
  }
  if (!isOperationResult(operationName, envelope.value)) {
    throw new YtmError(nativeEnvelopeError(operationName));
  }
  return envelope.value;
}

function validateInput(operationName, input) {
  const spec = methodSpecs[operationName];
  if (!spec) throw new Error(`Unsupported client method: ${operationName}`);

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
        recoveryHint: "Pass a JSON object matching the method input schema.",
        recoveryAction: {
          kind: "review_method_input",
          method: operationName
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
          recoveryHint: `Remove ${key} or review the documented ${operationName} input.`
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

  if (operationName === "history") {
    const fail = (parameter, reason) => ({ ok: false, error: validationError({
      operationName, code: "invalid_parameter", parameter, reason,
      recoveryHint: "Select a date list or inclusive range of at most 2000 dates."
    }) });
    const list = input.baseDates !== undefined;
    if (list) {
      if (input.startDate !== undefined || input.endDate !== undefined || !Array.isArray(input.baseDates) ||
          input.baseDates.length < 1 || input.baseDates.length > 2000 || Array.from(input.baseDates).some(date => typeof date !== "string")) {
        return fail("baseDates", "Select 1..=2000 date strings without range bounds.");
      }
    } else if (typeof input.startDate !== "string" || typeof input.endDate !== "string") {
      return fail("dates", "Supply baseDates or both startDate and endDate.");
    }
    if (input.fallback !== undefined && !["exact", "previous-available"].includes(input.fallback)) {
      return fail("fallback", "fallback must be exact or previous-available.");
    }
    if (input.lookbackDays !== undefined && (input.fallback !== "previous-available" || normalizeLookbackDays(input.lookbackDays) === null)) {
      return fail("lookbackDays", "lookbackDays requires previous-available and an integer from 1 to 31.");
    }
    // Shape checks here; Rust owns calendar validation, expansion and ordering.
    return { ok: true, input: { ...input } };
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
        ? { kind: "review_method_input", method: details.operationName }
        : { kind: "review_client_usage" }),
    recoverable: true,
    retryable: false
  });
}

function nativeEnvelopeError(operationName) {
  return {
    ok: false,
    code: "internal_error",
    operationName,
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
  try {
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
  } catch {
    return internalSerializedError("InvalidErrorDetails");
  }
  return internalSerializedError(error instanceof Error ? error.name : "Error");
}

function internalSerializedError(cause) {
  return normalizeSerializedError({
    ok: false,
    code: "internal_error",
    reason: "The Node adapter encountered an internal error.",
    recoveryHint:
      "Update the package for this platform, then report the failure if it persists.",
    recoveryAction: { kind: "update_package" },
    recoverable: false,
    retryable: false,
    cause
  });
}

function normalizeSerializedError(details) {
  if (!isRecord(details)) {
    return internalSerializedError("InvalidErrorDetails");
  }

  let sanitized;
  try {
    sanitized = jsonSafeClone(details);
  } catch {
    return internalSerializedError("InvalidErrorDetails");
  }
  if (!isRecord(sanitized)) return internalSerializedError("InvalidErrorDetails");
  const code = typeof sanitized.code === "string" ? sanitized.code : "internal_error";
  const reason =
    typeof sanitized.reason === "string"
      ? sanitized.reason
      : typeof sanitized.message === "string"
        ? sanitized.message
        : "The operation failed.";
  const message = typeof sanitized.message === "string" ? sanitized.message : reason;
  const operationName =
    typeof sanitized.operationName === "string" ? sanitized.operationName : undefined;
  const normalized = {
    ...sanitized,
    ok: false,
    name:
      typeof sanitized.name === "string" && sanitized.name.length > 0
        ? sanitized.name
        : sanitized.cause === "AbortError"
          ? "AbortError"
          : Object.hasOwn(ERROR_NAMES, code)
            ? ERROR_NAMES[code]
            : "YtmError",
    message,
    code,
    reason,
    recoveryAction: normalizeRecoveryAction(sanitized.recoveryAction, operationName),
    recoverable:
      typeof sanitized.recoverable === "boolean" ? sanitized.recoverable : false,
    retryable: typeof sanitized.retryable === "boolean" ? sanitized.retryable : false
  };
  if (normalized.recoveryHint === undefined) {
    normalized.recoveryHint =
      code === "internal_error"
        ? "Update the package for this platform, then report the failure if it persists."
        : "Review the client method documentation and retry with the documented recovery action.";
  }
  return normalized;
}

function normalizeRecoveryAction(action, operationName) {
  const fallback = isMethodName(operationName)
    ? { kind: "review_method_input", method: operationName }
    : { kind: "review_client_usage" };
  const kind = isRecord(action) ? action.kind : action;

  if (kind === "inspect_command_help") return fallback;
  if (kind === "inspect_tool_help" || kind === "review_client_usage") {
    return { kind: "review_client_usage" };
  }
  if (kind === "review_method_input") {
    return isRecord(action) && isMethodName(action.method)
      ? { kind: "review_method_input", method: action.method }
      : fallback;
  }
  if ([
    "use_previous_available_fallback",
    "try_nearby_business_day",
    "start_new_request",
    "update_package"
  ].includes(kind)) {
    return { kind };
  }
  return fallback;
}

function isOperationResult(operationName, value) {
  if (operationName === "history") {
    return isRecord(value) && Array.isArray(value.requestedDates) && Array.isArray(value.discovery) &&
      Array.isArray(value.entries) && value.entries.every(entry => isRecord(entry) &&
        (entry.availability === "available" ? isOperationResult("matrix", entry.matrix) :
          entry.availability === "unavailable" && typeof entry.requestedBaseDate === "string" &&
          isRecord(entry.kind) && Array.isArray(entry.attemptedDates) && typeof entry.reason === "string")) &&
      Number.isInteger(value.availableCount) && Number.isInteger(value.unavailableCount) && Number.isInteger(value.dataRowCount);
  }
  if (!isRecord(value) || !isRecord(value.source)) return false;
  if (operationName === "kinds") {
    return (
      (value.baseDate === null || typeof value.baseDate === "string") &&
      Array.isArray(value.kinds) &&
      value.kinds.every(isYtmKind)
    );
  }
  if (operationName !== "matrix") return false;
  return (
    typeof value.baseDate === "string" &&
    typeof value.requestedBaseDate === "string" &&
    isDateResolution(value.dateResolution) &&
    isYtmKind(value.kind) &&
    Array.isArray(value.tenors) &&
    value.tenors.every((tenor) => typeof tenor === "string") &&
    Array.isArray(value.rows) &&
    value.rows.every(isYtmMatrixRow)
  );
}

function isDateResolution(value) {
  return (
    isRecord(value) &&
    ["exact", "previous-available"].includes(value.mode) &&
    typeof value.requestedBaseDate === "string" &&
    typeof value.resolvedBaseDate === "string" &&
    typeof value.usedFallback === "boolean" &&
    Array.isArray(value.attemptedDates) &&
    value.attemptedDates.every((date) => typeof date === "string") &&
    Number.isInteger(value.lookbackDays)
  );
}

function isYtmKind(value) {
  return isRecord(value) && typeof value.code === "string" && typeof value.name === "string";
}

function isYtmMatrixRow(value) {
  return (
    isRecord(value) &&
    typeof value.groupName === "string" &&
    typeof value.pricingGroupCode === "string" &&
    typeof value.pricingGroupName === "string" &&
    isRecord(value.yields) &&
    Object.values(value.yields).every((yieldValue) => yieldValue === null || typeof yieldValue === "number") &&
    isStringRecord(value.yieldText) &&
    isStringRecord(value.raw)
  );
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isMethodName(value) {
  return value === "matrix" || value === "kinds" || value === "history";
}

function isRecord(value) {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function safeActual(value) {
  if (value === undefined) return "[missing]";
  if (value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return `[array:${value.length}]`;
  return "[object]";
}

function jsonSafeClone(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((entry) => jsonSafeClone(entry, seen) ?? null);
    seen.delete(value);
    return output;
  }

  const output = Object.create(null);
  for (const key of Object.keys(value)) {
    let entry;
    try {
      entry = value[key];
    } catch {
      continue;
    }
    const cloned = jsonSafeClone(entry, seen);
    if (cloned !== undefined) output[key] = cloned;
  }
  seen.delete(value);
  return output;
}
