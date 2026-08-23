import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let binding;

export function describeNative() {
  let loaded;
  try {
    loaded = loadBinding();
  } catch (error) {
    throw error;
  }
  if (typeof loaded?.describe !== "function") {
    throw nativeLoaderFailure(
      "native_package_corrupt",
      "The installed native ytm package does not expose its capability descriptor.",
      new TypeError("describe is not a function")
    );
  }

  let encoded;
  try {
    encoded = loaded.describe();
  } catch (cause) {
    throw classifyNativeFailure(cause);
  }

  let value;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw nativeLoaderFailure(
      "native_package_corrupt",
      "The installed native ytm package returned invalid capability metadata.",
      cause
    );
  }
  if (value?.ok === false) throw nativeFailure(value.error);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw nativeLoaderFailure(
      "native_package_corrupt",
      "The installed native ytm package returned an invalid capability descriptor.",
      new TypeError("capability descriptor is not an object")
    );
  }
  return value;
}

export async function invokeNative(operation, input, signal) {
  const loaded = loadBinding();
  const call = loaded?.[operation];
  if (typeof call !== "function") {
    throw nativeLoaderFailure(
      "native_package_corrupt",
      `The installed native ytm package does not expose the ${operation} operation.`,
      new TypeError(`${operation} is not a function`)
    );
  }

  const bridge = bridgeAbortSignal(signal);
  try {
    const encoded = await call(
      JSON.stringify(input),
      bridge.signal,
      bridge.signal?.aborted === true
    );
    try {
      return JSON.parse(encoded);
    } catch (cause) {
      throw nativeLoaderFailure(
        "native_package_corrupt",
        `The native ytm package returned invalid JSON for ${operation}.`,
        cause
      );
    }
  } catch (cause) {
    if (cause?.details) throw cause;
    throw classifyNativeFailure(cause, operation);
  } finally {
    bridge.cleanup();
  }
}

function bridgeAbortSignal(signal) {
  if (!signal) return { signal: undefined, cleanup() {} };

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    forwardAbort();
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      signal.removeEventListener("abort", forwardAbort);
    }
  };
}

function loadBinding() {
  if (binding) return binding;
  try {
    binding = require("./native.cjs");
    return binding;
  } catch (cause) {
    throw classifyLoaderFailure(cause);
  }
}

function nativeFailure(details) {
  const error = new Error(
    details?.message || details?.reason || "The native ytm core failed during initialization."
  );
  error.name = errorName(details?.code || "internal_error");
  error.details = details;
  return error;
}

function classifyLoaderFailure(cause) {
  if (cause?.details) return cause;
  const key = runtimeKey();
  const chain = errorChain(cause);
  const message = chain
    .map((error) => (typeof error?.message === "string" ? error.message : ""))
    .filter(Boolean)
    .join(" ");

  if (/does not support|unsupported platform|unsupported runtime/i.test(message)) {
    return nativeLoaderFailure(
      "unsupported_platform",
      `@sjunepark/ytm does not support the current platform (${key}).`,
      cause,
      key
    );
  }

  const missingPackage = chain.some(
    (error) => error?.code === "YTM_NATIVE_PACKAGE_UNAVAILABLE"
  );
  if (missingPackage) {
    return nativeLoaderFailure(
      "native_package_unavailable",
      `The native ytm package for ${key} is not installed.`,
      cause,
      key
    );
  }

  return nativeLoaderFailure(
    "native_package_corrupt",
    `The native ytm package for ${key} could not be loaded.`,
    cause,
    key
  );
}

function classifyNativeFailure(cause, operationName) {
  if (cause?.details) return cause;
  if (isAbortError(cause)) {
    const error = new Error(`The KIS-NET request was cancelled during ${operationName} execution.`);
    error.name = "AbortError";
    error.details = {
      ok: false,
      name: "AbortError",
      code: "source_transport_error",
      operationName,
      reason: `The KIS-NET request was cancelled during ${operationName} execution.`,
      expected: "A request that remains active until completion",
      recoveryHint: "Create a new request with a non-aborted AbortSignal.",
      recoveryAction: { kind: "start_new_request" },
      recoverable: false,
      retryable: false,
      cause: "AbortError"
    };
    return error;
  }
  return nativeLoaderFailure(
    "native_package_corrupt",
    `The native ytm package failed during ${operationName ?? "capability discovery"}.`,
    cause,
    runtimeKey()
  );
}

function nativeLoaderFailure(code, reason, cause, key = runtimeKey()) {
  const error = new Error(reason);
  error.name = errorName(code);
  error.details = {
    ok: false,
    name: error.name,
    message: reason,
    code,
    reason,
    expected:
      code === "unsupported_platform"
        ? "A supported Node.js platform and architecture"
        : "A loadable @sjunepark/ytm native package for the current platform",
    actual: key,
    recoveryHint:
      code === "unsupported_platform"
        ? "Run @sjunepark/ytm on a supported platform, or use the standalone Rust ytm executable."
        : code === "native_package_unavailable"
          ? "Install @sjunepark/ytm with its platform-specific optional dependency, then retry."
          : "Reinstall @sjunepark/ytm for this platform, then retry; report the failure if it persists.",
    recoveryAction: { kind: "update_package" },
    recoverable: code !== "unsupported_platform",
    retryable: false,
    cause: causeName(cause)
  };
  return error;
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function causeName(error) {
  for (const candidate of errorChain(error)) {
    if (typeof candidate?.code === "string") return candidate.code;
  }
  if (typeof error?.name === "string") return error.name;
  return "Error";
}

function errorName(code) {
  return {
    unsupported_platform: "UnsupportedPlatformError",
    native_package_unavailable: "NativePackageUnavailableError",
    native_package_corrupt: "NativePackageCorruptError",
    source_transport_error: "SourceTransportError",
    internal_error: "InternalError"
  }[code] || "KisnetYtmError";
}

function runtimeKey() {
  const libc = process.platform === "linux" ? linuxLibc() : null;
  return [process.platform, process.arch, libc].filter(Boolean).join("-");
}

function linuxLibc() {
  try {
    const runtimeVersion = process.report?.getReport()?.header?.glibcVersionRuntime;
    return typeof runtimeVersion === "string" && runtimeVersion.length > 0
      ? "gnu"
      : "unknown-libc";
  } catch {
    return "unknown-libc";
  }
}
