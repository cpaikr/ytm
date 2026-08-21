import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let binding;

export function describeNative() {
  const value = JSON.parse(loadBinding().describe());
  if (value?.ok === false) throw nativeFailure(value.error);
  return value;
}

export async function invokeNative(operation, input, signal) {
  const binding = loadBinding();
  const call = binding[operation];
  if (typeof call !== "function") throw new TypeError(`Native ytm operation is unavailable: ${operation}`);
  const bridge = bridgeAbortSignal(signal);
  try {
    const encoded = await call(JSON.stringify(input), bridge.signal, bridge.signal?.aborted === true);
    return JSON.parse(encoded);
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
  binding ??= require("./native.cjs");
  return binding;
}

function nativeFailure(details) {
  const error = new Error(details?.reason || "The native ytm core failed during initialization.");
  error.details = details;
  return error;
}
