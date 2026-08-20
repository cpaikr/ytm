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
  const encoded = await call(JSON.stringify(input), signal, signal?.aborted === true);
  return JSON.parse(encoded);
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
