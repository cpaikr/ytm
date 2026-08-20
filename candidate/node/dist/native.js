import binding from "./native.cjs";

export function describeNative() {
  const value = JSON.parse(binding.describe());
  if (value?.ok === false) throw nativeFailure(value.error);
  return value;
}

export async function invokeNative(operation, input, signal) {
  const call = binding[operation];
  if (typeof call !== "function") throw new TypeError(`Native ytm operation is unavailable: ${operation}`);
  const encoded = await call(JSON.stringify(input), signal);
  return JSON.parse(encoded);
}

function nativeFailure(details) {
  const error = new Error(details?.reason || "The native ytm core failed during initialization.");
  error.details = details;
  return error;
}
