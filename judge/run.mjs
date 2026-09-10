import { historyScenarios } from "./history.mjs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isNodeCliArtifact } from "../scripts/node-cli-artifact-policy.mjs";
import { nativeRuntimeKey } from "../scripts/native-build-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const productRoot = resolve(options.productRoot || resolve(root, "packages/node"));
const cliBin = resolve(options.cliBin || resolve(root, "target/debug/ytm"));
const selectedScenario = options.scenario;
const selectedSurface = options.surface;
const childTimeoutMilliseconds = 15_000;
if (options.updateGolden && (selectedScenario || selectedSurface)) {
  throw new Error("Golden results can only be updated by a complete, unfiltered judge run");
}
const failures = [];
let scenariosRun = 0;
const goldenPath = resolve(root, "judge/golden-results.json");
const goldenResults = options.updateGolden
  ? {}
  : JSON.parse(await readFile(goldenPath, "utf8"));
const observedGoldenKeys = new Set();
const exercisedFixtureFiles = new Set();

const evidence = JSON.parse(await readFile(resolve(root, "contracts/kisnet/cases.json"), "utf8"));
const wire = parse(await readFile(resolve(root, "contracts/kisnet/openapi.yaml"), "utf8"));
const fixtureDirectory = resolve(root, "contracts/kisnet");
const initPath = wire.paths["/rateInfo/ytmMatrixMobileInitList.do"].post["x-ytm-nexacro-request"].endpoint;
const matrixPath = wire.paths["/rateInfo/ytmMatrixMobileList.do"].post["x-ytm-nexacro-request"].endpoint;
const maxBodyBytes = wire["x-ytm-nexacro-profile"].response.maxDecompressedBodyBytes;
const maxDepth = wire["x-ytm-nexacro-profile"].response.maxElementDepth;
const request = evidence.requestExample;
const authorityRequestExamples = new Map([
  [initPath, wire.paths[initPath].post.requestBody.content["text/xml; charset=UTF-8"].example],
  [matrixPath, wire.paths[matrixPath].post.requestBody.content["text/xml; charset=UTF-8"].example]
]);

function check(condition, message) {
  if (!condition) failures.push(message);
}

function scenarioEnabled(name) {
  return !selectedScenario || selectedScenario === name;
}

function surfaceEnabled(surface) {
  return !selectedSurface || selectedSurface === surface;
}

function assertGolden(name, surface, actual) {
  const key = `${surface}:${name}`;
  if (observedGoldenKeys.has(key)) {
    failures.push(`${name}: ${surface} attempted to reuse approved golden key ${key}`);
    return;
  }
  const normalized = normalizeStatistics(JSON.parse(JSON.stringify(actual)), key);
  observedGoldenKeys.add(key);
  if (options.updateGolden) {
    goldenResults[key] = normalized;
    return;
  }
  check(Object.hasOwn(goldenResults, key), `${name}: ${surface} has no approved golden result`);
  if (Object.hasOwn(goldenResults, key)) {
    check(isDeepStrictEqual(normalized, goldenResults[key]), `${name}: ${surface} public result differs from the approved golden result`);
  }
}

function normalizeStatistics(value, label) {
  if (Array.isArray(value)) return value.map(child => normalizeStatistics(child, label));
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (key === "stdout" && typeof child === "string" && child.trim().startsWith("{")) {
      // CLI stdout is a serialized envelope. Preserve compact versus pretty form.
      let parsed;
      try { parsed = JSON.parse(child); } catch { continue; }
      value[key] = JSON.stringify(normalizeStatistics(parsed, label), null, child.startsWith("{\n") ? 2 : undefined) + (child.endsWith("\n") ? "\n" : "");
    } else if (key === "statistics" && child && typeof child === "object") {
      check(Number.isSafeInteger(child.elapsedMs) && child.elapsedMs >= 0, `${label}: statistics elapsedMs must be a nonnegative safe integer`);
      check(Number.isSafeInteger(child.waitingMs) && child.waitingMs >= 0 && child.waitingMs <= child.elapsedMs, `${label}: statistics waitingMs must be actual non-overlapping time`);
      // Keep every deterministic counter and the finished marker in the goldens.
      child.elapsedMs = 0;
      child.waitingMs = 0;
    } else {
      value[key] = normalizeStatistics(child, label);
    }
  }
  return value;
}

function publicNodeResult(result) {
  return { ok: result.ok, value: result.value, error: result.error };
}

function runNode(name, requestPayload, fixture, assertResult, runnerOptions = {}) {
  if (!surfaceEnabled("node") || !scenarioEnabled(name)) return;
  scenariosRun += 1;
  recordFixtureUse(fixture);
  const product = invokeNode(productRoot, requestPayload, fixture);
  assertGolden(name, "node", publicNodeResult(product));
  assertResult?.(product, `${name}: product`);
  assertRequests(
    product.requests,
    runnerOptions.productSteps ?? fixture?.steps ?? [],
    requestPayload,
    `${name}: product`
  );
}

function runCli(name, args, fixture, assertResult, runnerOptions = {}) {
  if (!surfaceEnabled("cli") || !scenarioEnabled(name)) return;
  scenariosRun += 1;
  recordFixtureUse(fixture);
  const cwd = runnerOptions.isolated ? mkdtempSync(resolve(tmpdir(), "ytm-judge-xlsx-")) : undefined;
  const capturePath = cwd ? resolve(cwd, "requests.json") : undefined;
  try {
    runnerOptions.setup?.(cwd);
    const invocationArgs = typeof args === "function" ? args(cwd) : args;
    const product = invokeCli(cliBin, invocationArgs, fixture, { cwd, capturePath });
    if (product.status === null) {
      failures.push(`${name}: ${product.stderr || "standalone CLI did not start"}`);
      return;
    }
    if (runnerOptions.golden !== false) assertGolden(name, "cli", product);
    assertResult?.(product, `${name}: product`, cwd);
    if (capturePath) {
      const captures = existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, "utf8")) : [];
      assertRequests(captures, runnerOptions.productSteps ?? fixture?.steps ?? [], runnerOptions.requestPayload, name);
      check(!readdirSync(cwd).some((name) => name.startsWith(".ytm-")), `${name} must clean owned staging files`);
    }
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}

historyScenarios({ runNode, runCli, check, fixture, initPath, matrixPath, invokeCli, cliBin, root, spawnSync, resolve, readFileSync, writeFileSync });

runNode("client-surface", { action: "inspect" }, undefined, (result, label) => {
  check(result.ok, `${label} must inspect successfully`);
  check(result.value?.exports?.join(",") === "RetrievalProgress,YtmClient,YtmError,serializeYtmError,validateHistoryInput,validateKindsInput,validateMatrixInput", `${label} must expose only the complete root SDK interface`);
  check(result.value?.methods?.join(",") === "history,matrix,kinds", `${label} must expose only typed domain methods on the client`);
});

for (const validation of [
  { id: "missing-base-date", operation: "matrix", input: { kind: "국채" }, code: "missing_parameter", parameter: "baseDate" },
  { id: "unknown-parameter", operation: "matrix", input: { baseDate: request.baseDate, kind: "국채", extra: true }, code: "unknown_parameter", parameter: "extra" },
  { id: "invalid-date", operation: "matrix", input: { baseDate: "2026-99-99", kind: "국채" }, code: "invalid_parameter", parameter: "baseDate" }
]) {
  runNode(`validation-recovery:${validation.id}`, { action: "validate", operation: validation.operation, input: validation.input }, undefined, (result, label) => {
    const error = result.value?.error;
    check(result.ok && error?.code === validation.code, `${label} must preserve ${validation.code}`);
    check(error?.recoverable === true && error?.retryable === false && error?.recoveryAction?.kind, `${label} must preserve machine recovery metadata`);
    if (validation.parameter) check(error?.parameter === validation.parameter, `${label} must identify ${validation.parameter}`);
  });
}

for (const [dateValue, normalized] of [["2026-06-08", "2026-06-08"], ["2026.06.08", "2026-06-08"], ["20260608", "2026-06-08"]]) {
  runNode(`validation-recovery:date-${dateValue}`, { action: "validate", operation: "matrix", input: { baseDate: dateValue, kind: "10" } }, undefined, (result, label) => {
    check(result.value?.ok === true && result.value?.input?.baseDate === normalized, `${label} must normalize supported dates`);
  });
}

for (const dateValue of ["2026.06-08", "2026-0608", "202606-08", "2026..06.08"]) {
  runNode(`validation-recovery:reject-date-${dateValue}`, { action: "validate", operation: "matrix", input: { baseDate: dateValue, kind: "10" } }, undefined, (result, label) => {
    check(result.value?.ok === false && result.value?.error?.parameter === "baseDate", `${label} must reject an undocumented date shape`);
  });
}

runNode("node-client-regressions", { action: "client-regressions", baseDate: request.baseDate }, undefined, (result, label) => {
  const value = result.value;
  check(result.ok, `${label} must exercise the pure Node client without native transport`);
  check(value?.kindsWithoutInput?.kinds?.some(({ code }) => code === "80"), `${label} kinds execution must accept omitted input`);
  check(value?.nonObject?.error?.code === "invalid_request" && value?.nonObject?.error?.recoveryAction?.kind === "review_method_input", `${label} non-object input must direct recovery to method documentation`);
  check(value?.blankKind?.error?.code === "missing_parameter" && value?.blankKind?.error?.parameter === "kind", `${label} blank kind input must remain missing`);
  check(value?.earlyYearDates?.every(({ ok }) => ok === true), `${label} four-digit years 0000 through 0099 must match the Rust date domain`);
  check(value?.invalidEarlyLeapDay?.ok === false, `${label} early four-digit years must still enforce Gregorian leap days`);
  check(value?.nonFiniteKinds?.length === 3 && value.nonFiniteKinds.every(({ error }) => error?.code === "invalid_parameter" && error?.parameter === "kind"), `${label} non-finite numeric kind input must be rejected`);
  check(value?.nonFiniteKinds?.map(({ error }) => error?.actual).join(",") === "NaN,Infinity,-Infinity", `${label} non-finite numeric diagnostics must preserve each source spelling`);
  check(value?.scalarDetails?.code === "internal_error" && value?.arrayDetails?.code === "internal_error", `${label} malformed error details must not escape as public envelopes`);
  check(value?.objectDetails?.code === "sentinel", `${label} object error details must remain serializable`);
  check(value?.inheritedErrorCodes?.length === 4 && value.inheritedErrorCodes.every(({ code, serialized, name, details, text }) =>
    serialized?.code === code && serialized?.name === "YtmError" && name === "YtmError" && details?.name === "YtmError" && text === "YtmError: The operation failed."
  ), `${label} unknown error codes matching prototype keys must retain a string fallback name in serialization and construction`);
  check(value?.unknownRecoveryAction?.recoveryAction?.kind === "review_method_input" && value?.unknownRecoveryAction?.recoveryAction?.method === "matrix", `${label} unknown recovery actions must normalize to the declared method fallback`);
  check(value?.invalidMethodRecoveryAction?.recoveryAction?.kind === "review_method_input" && value?.invalidMethodRecoveryAction?.recoveryAction?.method === "kinds", `${label} invalid method recovery actions must normalize to the current operation`);
  check(value?.foreignDetails?.ok === false && value?.foreignDetails?.code === "foreign_error", `${label} foreign error details must remain a failure envelope`);
  check(value?.foreignDetails?.retained?.value === 7 && value?.foreignDetails?.large === "42", `${label} JSON-safe foreign fields must be retained`);
  check(value?.foreignDetails?.self === "[Circular]" && value?.foreignDetails?.ignored === undefined, `${label} cyclic and callable foreign fields must be sanitized`);
  check(value?.sharedReferences?.expected?.value === 11 && value?.sharedReferences?.actual?.value === 11, `${label} repeated non-cyclic references must not be mistaken for cycles`);
  check(value?.hostileDetails?.code === "internal_error", `${label} hostile error details must fall back to an internal error envelope`);
  check(value?.hostileConstructor?.code === "internal_error" && value?.hostileConstructor?.threw === undefined, `${label} hostile constructor details must fall back to an internal error envelope`);
});

const successFixture = fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.matrix }
]);
runNode("matrix-success", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name } }, successFixture, (result, label) => {
  check(result.ok, `${label} must succeed`);
  check(result.value?.tenors?.join(",") === evidence.expectedTenors.map(({ label: tenor }) => tenor).join(","), `${label} must preserve tenor order`);
  check(result.value?.rows?.[0]?.pricingGroupCode === evidence.expectations.matrix.pricingGroupCode, `${label} must preserve pricing group code`);
  check(result.value?.rows?.[0]?.yieldText?.["3M"] === evidence.expectations.matrix.threeMonth, `${label} must preserve raw yield text`);
  check(result.requests?.[0]?.body.includes(`<Col id="calBaseDt">${request.baseDateCompact}</Col>`), `${label} must project the compact date`);
  check(result.requests?.[1]?.body.includes(`<Col id="cboYtmSort">${request.kind.code}</Col>`), `${label} must project the resolved kind code`);
});

runNode("missing-values", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.missingValues }
]), (result, label) => {
  for (const tenor of evidence.expectations.missingValues.nullTenors) {
    check(result.value?.rows?.[0]?.yields?.[tenor] === null, `${label} must normalize missing ${tenor} to null`);
    check(result.value?.rows?.[0]?.yieldText?.[tenor] === evidence.expectations.missingValues.rawValues[tenor], `${label} must retain raw ${tenor}`);
  }
});

runNode("unknown-kind-recovery", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: "not-a-kind" } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(!result.ok && result.error?.code === "invalid_parameter" && result.error?.parameter === "kind", `${label} must reject the unknown kind`);
  check(result.error?.expected?.some(({ code }) => code === "80"), `${label} must expose the accepted catalog`);
  check(result.error?.exampleInput?.baseDate === request.baseDate && result.error?.exampleInput?.kind, `${label} must expose a usable example`);
  check(result.error?.recoveryAction?.kind === "review_method_input" && result.error?.recoveryAction?.method === "matrix" && result.error?.retryable === false, `${label} must translate kind-specific recovery metadata to the client interface`);
});

runNode("fallback-order", { action: "execute", operation: "matrix", input: { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available", lookbackDays: 2 } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.matrix }
]), (result, label) => {
  check(result.value?.baseDate === "2026-06-05", `${label} must resolve the first available prior date`);
  check(result.value?.dateResolution?.attemptedDates?.join(",") === "2026-06-07,2026-06-06,2026-06-05", `${label} must preserve attempted-date order`);
});

runNode("cancellation", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name }, abortBeforeExecute: true }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.transportError, `${label} must preserve cancellation as ${evidence.expectations.transportError}`);
  check(result.error?.name === "AbortError" && result.error?.cause === "AbortError", `${label} cancellation must preserve its AbortError identity`);
  check(result.error?.operationName === "matrix" && result.error?.recoveryAction?.kind === "start_new_request", `${label} cancellation must preserve operation-specific recovery metadata`);
  check(result.error?.recoverable === false && result.error?.retryable === false, `${label} cancellation must be terminal and non-retryable`);
  check(result.requests?.length === 0, `${label} must not start HTTP after pre-cancellation`);
}, { productSteps: [] });

for (const failure of [
  { name: "protocol-error", second: { fixture: evidence.fixtures.protocolError }, code: evidence.expectations.protocolError },
  { name: "format-error", second: { fixture: evidence.fixtures.malformed }, code: evidence.expectations.formatError },
  { name: "transport-error", second: { transportError: "deliberate fixture transport failure" }, code: evidence.expectations.transportError },
  { name: "unavailable-data", second: { fixture: evidence.fixtures.unavailable }, code: evidence.expectations.unavailableError }
]) {
  runNode(failure.name, { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name } }, fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, ...failure.second }
  ]), (result, label) => {
    check(!result.ok && result.error?.code === failure.code, `${label} must return ${failure.code}`);
    if (failure.name === "protocol-error") {
      const expected = evidence.expectations.protocolStatuses.protocolError;
      check(result.error?.sourceErrorCode === expected.errorCode && result.error?.sourceErrorMessage === expected.errorMessage, `${label} must preserve the exact source protocol status`);
    }
  });
}

for (const malformedKinds of ["initMalformedMixed", "initMalformedAll"]) {
  runNode(`fixture-behavior:${malformedKinds}`, { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
    { path: initPath, fixture: evidence.fixtures[malformedKinds] }
  ]), (result, label) => {
    check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} malformed kind rows must fail closed`);
    check(result.error?.reason === "KIS-NET kind row is missing divCode or divName.", `${label} must identify the malformed kind fields`);
  });
}

runNode("fixture-behavior:invalid-error-code", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  { path: initPath, fixture: evidence.fixtures.invalidErrorCode }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} non-integer ErrorCode must fail closed`);
  check(result.error?.reason === "KIS-NET ErrorCode is not a textual integer.", `${label} must identify the invalid ErrorCode grammar`);
});

runNode("fixture-behavior:missing-matrix-column", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.missingColumn }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} missing required matrix columns must fail closed`);
  check(result.error?.reason === "KIS-NET matrix row is missing required column y50.", `${label} must identify the missing y50 wire column`);
});

runNode("protocol-status:warning", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  { path: initPath, fixture: evidence.fixtures.protocolWarning }
]), (result, label) => {
  const expected = evidence.expectations.protocolStatuses.protocolWarning;
  check(!result.ok && result.error?.code === evidence.expectations.protocolError, `${label} nonzero positive ErrorCode must be a protocol failure`);
  check(result.error?.sourceErrorCode === expected.errorCode && result.error?.sourceErrorMessage === expected.errorMessage, `${label} must preserve ErrorMessage-only source status`);
});

runNode("protocol-status:error-message-precedence", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  {
    path: initPath,
    fixture: evidence.fixtures.protocolWarning,
    replace: [[
      '<Parameter id="ErrorMessage">Result requires review</Parameter>',
      '<Parameter id="ErrorMsg">higher-priority message</Parameter>\n    <Parameter id="ErrorMessage">Result requires review</Parameter>'
    ]]
  }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.protocolError, `${label} nonzero ErrorCode must remain a protocol failure`);
  check(result.error?.sourceErrorCode === evidence.expectations.protocolStatuses.protocolWarning.errorCode, `${label} must preserve the source ErrorCode`);
  check(result.error?.sourceErrorMessage === "higher-priority message", `${label} ErrorMsg must take precedence over ErrorMessage`);
});

runNode("protocol-status:duplicate-error-message", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  {
    path: initPath,
    fixture: evidence.fixtures.protocolWarning,
    replace: [[
      '<Parameter id="ErrorMessage">Result requires review</Parameter>',
      '<Parameter id="ErrorMessage">Result requires review</Parameter>\n    <Parameter id="ErrorMessage">duplicate</Parameter>'
    ]]
  }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} duplicate ErrorMessage parameters must fail closed`);
});

for (const stop of [
  { id: "format-error", second: { fixture: evidence.fixtures.invalidNumeric }, code: evidence.expectations.formatError },
  { id: "protocol-error", second: { fixture: evidence.fixtures.protocolError }, code: evidence.expectations.protocolError },
  { id: "transport-error", second: { transportError: "deliberate fixture transport failure" }, code: evidence.expectations.transportError }
]) {
  runNode(`fallback-stops-on-${stop.id}`, { action: "execute", operation: "matrix", input: {
    baseDate: request.baseDate,
    kind: request.kind.name,
    fallback: "previous-available",
    lookbackDays: 1
  } }, fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, ...stop.second }
  ]), (result, label) => {
    check(!result.ok && result.error?.code === stop.code, `${label} must preserve ${stop.code}`);
    check(result.requests?.length === 2, `${label} must not advance fallback after ${stop.code}`);
    if (stop.id === "protocol-error") {
      const expected = evidence.expectations.protocolStatuses.protocolError;
      check(result.error?.sourceErrorCode === expected.errorCode && result.error?.sourceErrorMessage === expected.errorMessage, `${label} must preserve the original source protocol status`);
      check(result.error?.reason === "KIS-NET returned nonzero Nexacro ErrorCode -1 (Request rejected).", `${label} must preserve the original protocol reason`);
    }
    if (stop.id === "transport-error") {
      check(result.error?.reason === "KIS-NET request failed before a response was received." && result.error?.cause === "TypeError", `${label} must preserve the original transport reason and cause`);
    }
  });
}

runNode("fallback-stops-on-validation-error", { action: "execute", operation: "matrix", input: {
  baseDate: "not-a-date",
  kind: request.kind.name,
  fallback: "previous-available",
  lookbackDays: 1
} }, fixture([]), (result, label) => {
  check(!result.ok && result.error?.code === "invalid_parameter" && result.error?.parameter === "baseDate", `${label} must preserve validation failure`);
  check(result.requests?.length === 0, `${label} validation must fail before any fallback request`);
});

runNode("fallback-stops-on-kind-resolution-error", { action: "execute", operation: "matrix", input: {
  baseDate: request.baseDate,
  kind: "not-a-kind",
  fallback: "previous-available",
  lookbackDays: 1
} }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(!result.ok && result.error?.code === "invalid_parameter" && result.error?.parameter === "kind", `${label} must preserve kind-resolution failure`);
  check(result.requests?.length === 1, `${label} must not advance fallback after kind resolution fails`);
});

for (const xmlCase of evidence.xmlCases.valid) {
  const operation = xmlCase.operation;
  const effectiveKindCode = xmlCase.expectedKindCode === "10" && xmlCase.expectedKindName !== "국채"
    ? "90"
    : xmlCase.expectedKindCode;
  const replacement = effectiveKindCode !== xmlCase.expectedKindCode
    ? { replace: [[`<Col id="divCode">${xmlCase.expectedKindCode}</Col>`, `<Col id="divCode">${effectiveKindCode}</Col>`]] }
    : {};
  const steps = operation === "matrix"
    ? [{ path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures[xmlCase.fixture] }]
    : [{ path: initPath, fixture: evidence.fixtures[xmlCase.fixture], ...replacement }];
  const input = operation === "matrix" ? { baseDate: request.baseDate, kind: request.kind.name } : { baseDate: request.baseDate };
  runNode(`xml-fixture-corpus:valid-${xmlCase.fixture}`, { action: "execute", operation, input }, fixture(steps), (result, label) => {
    check(result.ok, `${label} must accept the valid XML evidence`);
    const kind = operation === "matrix"
      ? result.value?.kind
      : result.value?.kinds?.find(({ code }) => code === effectiveKindCode);
    check(kind?.code === effectiveKindCode && kind?.name === xmlCase.expectedKindName, `${label} must preserve the fixture kind through any execution-only code remap`);
    const raw = result.value?.rows?.[0]?.raw;
    for (const [columnField, valueField] of [
      ["expectedRawColumn", "expectedRawValue"],
      ["expectedExtraRawColumn", "expectedExtraRawValue"]
    ]) {
      if (xmlCase[columnField] === undefined) continue;
      check(Object.hasOwn(raw || {}, xmlCase[columnField]), `${label} raw row must own ${xmlCase[columnField]}`);
      check(raw?.[xmlCase[columnField]] === xmlCase[valueField], `${label} raw ${xmlCase[columnField]} must preserve its declared value`);
    }
  });
}
for (const fixtureName of evidence.xmlCases.invalid) {
  runNode(`xml-fixture-corpus:invalid-${fixtureName}`, { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
    { path: initPath, fixture: evidence.fixtures[fixtureName] }
  ]), (result, label) => {
    check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} must reject invalid XML evidence`);
  });
}

for (const boundary of [
  { id: "trailing-xml-whitespace", step: { fixture: evidence.fixtures.init, replace: [["</Root>", "</Root> \t\r\n"]] }, succeeds: true },
  { id: "trailing-nonbreaking-space", step: { fixture: evidence.fixtures.init, replace: [["</Root>", "</Root>\u00a0"]] }, succeeds: false },
  { id: "trailing-em-space", step: { fixture: evidence.fixtures.init, replace: [["</Root>", "</Root>\u2003"]] }, succeeds: false },
  { id: "leading-em-space", step: { fixture: evidence.fixtures.init, replace: [["<Root ", "\u2003<Root "]] }, succeeds: false },
  { id: "single-bom", step: { fixture: evidence.fixtures.init, bom: 1 }, succeeds: true },
  { id: "double-bom", step: { fixture: evidence.fixtures.init, bom: 2 }, succeeds: false },
  { id: "invalid-utf8", step: { fixture: evidence.fixtures.init, invalidUtf8: true }, succeeds: false },
  { id: "exact-body-limit", step: { fixture: evidence.fixtures.init, padToBytes: maxBodyBytes }, succeeds: true },
  { id: "body-limit-plus-one", step: { fixture: evidence.fixtures.init, padToBytes: maxBodyBytes + 1 }, succeeds: false },
  { id: "exact-depth-limit", step: { depth: maxDepth }, succeeds: true },
  { id: "depth-limit-plus-one", step: { depth: maxDepth + 1 }, succeeds: false }
]) {
  runNode(`xml-generated-bounds:${boundary.id}`, { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
    { path: initPath, ...boundary.step }
  ]), (result, label) => {
    check(result.ok === boundary.succeeds, `${label} must ${boundary.succeeds ? "accept" : "reject"} the boundary`);
    if (!boundary.succeeds) check(result.error?.code === evidence.expectations.formatError, `${label} must use ${evidence.expectations.formatError}`);
  });
}

runCli("cli-machine-contract:help", ["--help"], undefined, (result, label) => {
  check(result.status === 0 && result.stdout.includes("matrix") && result.stderr === "", `${label} root help must use stdout and exit zero`);
});
runCli("cli-machine-contract:command-help", ["matrix", "--help"], undefined, (result, label) => {
  check(result.status === 0 && result.stdout.includes("CLI example:") && result.stderr === "", `${label} command help must use stdout and exit zero`);
});
for (const [name, args] of [
  ["inline-help-options", ["matrix", "--help", "--base-date=2026-06-08", "--kind=국채", "--format=json", "--fallback=previous-available", "--lookback-days=3"]],
  ["inline-kinds-help", ["kinds", "--base-date=2026-06-08", "--format=csv", "-h"]],
  ["repeated-pretty-help", ["matrix", "--pretty", "--help", "--pretty"]],
]) {
  runCli(`cli-machine-contract:${name}`, args, undefined, (result, label) => {
    check(result.status === 0 && result.stdout.includes("CLI example:") && result.stderr === "", `${label} help must accept the same option syntax as execution without contacting the source`);
  });
}
for (const [name, args, code] of [
  ["inline-invalid-format-help", ["matrix", "--help", "--format=yaml"], "invalid_parameter"],
  ["inline-duplicate-help", ["matrix", "--help", "--format=json", "--format", "csv"], "invalid_request"],
  ["inline-flag-value-help", ["matrix", "--help", "--pretty=true"], "invalid_request"],
  ["inline-help-as-value", ["matrix", "--format=--help"], "invalid_parameter"],
]) {
  runCli(`cli-machine-contract:${name}`, args, undefined, (result, label) => {
    check(result.status === 2 && JSON.parse(result.stdout).error?.code === code, `${label} help must preserve option validation and distinguish values from help flags`);
  });
}
runCli("cli-machine-contract:upgrade-help", ["upgrade", "--help"], undefined, (result, label) => {
  check(result.status === 0 && result.stdout.includes("ytm upgrade --check") && result.stderr === "", `${label} upgrade help must use stdout and exit zero`);
});
runCli("cli-machine-contract:invalid-upgrade", ["upgrade", "--pretty"], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "invalid_request" && error?.operationName === "upgrade", `${label} invalid upgrade invocation must be structured`);
  check(result.stderr.includes("ytm upgrade --check"), `${label} invalid upgrade invocation must show command help on stderr`);
});
runCli("cli-machine-contract:unknown-command-help", ["not-a-command", "--help"], undefined, (result, label) => {
  check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_request" && result.stderr.includes("CLI usage:"), `${label} ordinary unknown commands must remain structured even with --help`);
});
runCli("cli-machine-contract:explicit-unknown-help", ["help", "not-a-command"], undefined, (result, label) => {
  check(result.status === 2 && result.stdout.startsWith("Unknown command: not-a-command") && result.stderr === "", `${label} explicit help for an unknown command is the sole plain-text failure`);
});
runCli("cli-machine-contract:explicit-unknown-help-flag", ["help", "not-a-command", "--help"], undefined, (result, label) => {
  check(result.status === 2 && result.stdout.startsWith("Unknown command: not-a-command") && result.stderr === "", `${label} explicit unknown help remains plain text when followed by --help`);
});
runCli("cli-machine-contract:malformed-help", ["help", "matrix", "--bogus"], undefined, (result, label) => {
  check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_request", `${label} help must reject trailing arguments with structured JSON`);
  check(result.stderr.includes("CLI usage:"), `${label} malformed help must direct recovery on stderr`);
});
runCli("cli-machine-contract:malformed-operation-help", ["matrix", "--help", "--base-date", request.baseDate, "--base-date", "2026-06-09"], undefined, (result, label) => {
  check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_request", `${label} operation help must not bypass duplicate-option validation`);
  check(result.stderr.includes("matrix"), `${label} malformed operation help must show command help on stderr`);
});
runCli("cli-machine-contract:duplicate-value-option", ["matrix", "--base-date", request.baseDate, "--base-date", "2026-06-09", "--kind", "10"], undefined, (result, label) => {
  check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_request", `${label} execution must reject duplicate value options`);
});
runCli("cli-machine-contract:malformed-root-help", ["--help", "--bogus"], undefined, (result, label) => {
  check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_request", `${label} root help must reject trailing arguments with structured JSON`);
  check(result.stderr.includes("CLI usage:"), `${label} malformed root help must direct recovery on stderr`);
});
runCli("cli-machine-contract:semantic-operation-help", ["matrix", "--help", "--format", "yaml"], undefined, (result, label) => {
  check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_parameter", `${label} operation help must validate supplied option values`);
  check(result.stderr.includes("matrix"), `${label} invalid operation help must show command help on stderr`);
});
runCli("cli-machine-contract:help-command-help", ["help", "--help"], undefined, (result, label) => {
  check(result.status === 0 && result.stdout.includes("CLI usage:") && result.stderr === "", `${label} help-command help must show root help on clean stdout`);
});
runCli("cli-machine-contract:validation", ["matrix", "--kind", "국채"], undefined, (result, label) => {
  check(result.status === 2, `${label} validation must exit 2`);
  check(JSON.parse(result.stdout).error?.code === "missing_parameter", `${label} validation stdout must be structured JSON`);
  check(result.stderr.includes("matrix"), `${label} validation diagnostics must include command help`);
});
runCli("cli-machine-contract:json", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name, "--format", "json"], successFixture, (result, label) => {
  check(result.status === 0 && result.stderr === "", `${label} JSON success must exit zero without stderr`);
  check(JSON.parse(result.stdout).ok === true, `${label} JSON success must be one object`);
});
runCli("cli-machine-contract:transport-exit-one", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name], fixture([
  { path: initPath, transportError: "deliberate CLI transport failure" }
]), (result, label) => {
  check(result.status === 1, `${label} execution failure must exit one`);
  check(JSON.parse(result.stdout).error?.code === evidence.expectations.transportError, `${label} execution failure must use structured JSON stdout`);
  check(result.stderr === "", `${label} execution failure must not mix diagnostics into stderr`);
});
runCli("cli-machine-contract:pretty", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name, "--pretty"], successFixture, (result, label) => {
  check(result.status === 0 && result.stdout.includes("\n  \"ok\": true,"), `${label} pretty JSON must be deterministically indented`);
  check(JSON.parse(result.stdout).ok === true, `${label} pretty JSON must remain one object`);
});
for (const [id, flag, value] of [
  ["base-date-alias", "--baseDate", request.baseDate],
  ["lookback-days-alias", "--lookbackDays", "2"],
  ["input-json", "--input-json", JSON.stringify({ baseDate: request.baseDate, kind: request.kind.name })]
]) {
  runCli(`cli-machine-contract:removed-${id}`, ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name, flag, value], undefined, (result, label) => {
    check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_request", `${label} removed compatibility flags must be structured invalid invocations`);
    check(result.stderr.includes("matrix"), `${label} removed compatibility flags must show command help on stderr`);
  });
}
runCli("cli-machine-contract:csv", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name, "--format", "csv"], successFixture, (result, label) => {
  check(result.status === 0 && result.stdout.startsWith("requestedBaseDate,baseDate,usedFallback,kindCode,kindName"), `${label} CSV must preserve its header`);
});
runCli("cli-machine-contract:tsv", ["kinds", "--format", "tsv"], undefined, (result, label) => {
  check(result.status === 0 && result.stdout.startsWith("code\tname"), `${label} TSV must preserve its header`);
});

runCli("cli-machine-contract:formula-safe-csv", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name, "--format", "csv"], fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  {
    path: matrixPath,
    fixture: evidence.fixtures.matrix,
    replace: [
      ["<Col id=\"pricingGroupName\">국고채권</Col>", "<Col id=\"pricingGroupName\">=1+1</Col>"],
      ["<Col id=\"m3\">2.500</Col>", "<Col id=\"m3\">-4.455</Col>"]
    ]
  }
]), (result, label) => {
  check(result.status === 0 && result.stdout.includes(",'=1+1,"), `${label} must neutralize source strings that spreadsheet software can execute`);
  check(result.stdout.includes(",-4.455,"), `${label} must preserve negative numeric yields as numbers`);
});
runCli("cli-machine-contract:fallback", ["matrix", "--base-date", "2026-06-07", "--kind", request.kind.name, "--fallback", "previous-available", "--lookback-days", "2"], fixture([
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.matrix }
]), (result, label) => {
  const parsed = JSON.parse(result.stdout);
  check(result.status === 0 && parsed.result?.baseDate === "2026-06-05", `${label} must resolve the first available prior date`);
  check(parsed.result?.dateResolution?.attemptedDates?.join(",") === "2026-06-07,2026-06-06,2026-06-05", `${label} must preserve fallback attempt order`);
});
runCli("cli-machine-contract:format-error", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name], fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.invalidNumeric }
]), (result, label) => {
  check(result.status === 1 && JSON.parse(result.stdout).error?.code === evidence.expectations.formatError, `${label} malformed source data must exit one with structured JSON`);
  check(result.stderr === "", `${label} execution failure must not write diagnostics to stderr`);
});
runCli("cli-machine-contract:unknown-command", ["not-a-command"], undefined, (result, label) => {
  check(result.status === 2 && JSON.parse(result.stdout).error?.code === "invalid_request", `${label} unknown commands must exit two with structured JSON`);
  check(JSON.parse(result.stdout).error?.ok === undefined && JSON.parse(result.stdout).error?.operationName === undefined, `${label} must preserve the legacy unknown-command payload`);
  check(result.stderr.includes("CLI usage:"), `${label} unknown commands must put root help on stderr`);
});
runCli("cli-machine-contract:cross-command-option", ["kinds", "--kind", "10"], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "unknown_parameter" && error?.parameter === "kind", `${label} syntactically accepted options must be rejected by operation validation`);
});
runCli("cli-machine-contract:missing-format", ["matrix", "--format"], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "invalid_request" && error?.parameter === "input", `${label} missing format values must be structured invalid invocations`);
});
runCli("cli-machine-contract:empty-format", ["matrix", "--format", ""], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "invalid_parameter" && error?.actual === "", `${label} empty format values must preserve the legacy actual value`);
});
runCli("cli-machine-contract:empty-base-date", ["matrix", "--base-date", ""], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "missing_parameter" && error?.reason === "Missing required parameter: baseDate.", `${label} empty option values must use the public validation contract`);
});
runCli("cli-machine-contract:invalid-fallback", ["matrix", "--base-date", request.baseDate, "--kind", "10", "--fallback", "unsupported"], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "invalid_parameter" && error?.exampleInput?.fallback === "previous-available", `${label} fallback failures must preserve the recovery example`);
});

runNativePreabort();
runNode("abort-handler-preservation", {
  action: "abort-handler-preservation",
  input: { baseDate: request.baseDate }
}, fixture([{ path: initPath, waitForCancellation: true }]), (result, label) => {
  check(result.ok, `${label} must complete its cancellation probe`);
  check(result.value?.preservedDuringExecution === true, `${label} must preserve onabort while executing`);
  check(result.value?.preservedAfterAbort === true, `${label} must preserve onabort after cancellation`);
  check(result.value?.handlerCalls === 1, `${label} must call the consumer handler exactly once`);
  check(result.value?.signalAbortedAtEntry === false, `${label} must cancel after transport work begins`);
  check(result.value?.cancellationCode === evidence.expectations.transportError, `${label} must forward cancellation into the native operation`);
  check(result.value?.cancellationIsYtmError === true, `${label} must expose in-flight cancellation as YtmError`);
});
runWithoutNative();

runNode("kind-80:offline-catalog", { action: "execute", operation: "kinds", input: {} }, undefined, (result, label) => {
  check(result.ok, `${label} must return the offline canonical catalog`);
  const privateBond = result.value?.kinds?.find(({ code }) => code === "80");
  check(privateBond?.name === "회사채(사모)", `${label} must include canonical kind 80`);
});

runNode("kind-80:dated-catalog", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(result.ok && result.value?.kinds?.at(-1)?.code === "80", `${label} must retain kind 80 when discovery omits it`);
});

for (const [id, kind] of [["code", "80"], ["number", 80], ["label", "회사채(사모)"], ["normalized-label", "회사채 (사모)"]]) {
  runNode(`kind-80:matrix-${id}`, { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind } }, fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, fixture: evidence.fixtures.privateBondPadded }
  ]), (result, label) => {
    check(result.ok && result.value?.kind?.code === "80" && result.value?.kind?.name === "회사채(사모)", `${label} must resolve canonical kind 80`);
    check(result.value?.rows?.[0]?.groupName === "회사채(사모)", `${label} must preserve the canonical row group`);
    assertPrivateBondPadded(result, label);
    check(result.requests?.[1]?.body.includes('<Col id="cboYtmSort">80</Col>'), `${label} must send only code 80`);
    check(!result.requests?.[1]?.body.includes('<Col id="cboYtmSort">70</Col>'), `${label} must never substitute code 70`);
  });
}

runNode("kind-80:unavailable", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: "80" } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.unavailable }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.unavailableError, `${label} must preserve unavailable semantics`);
  check(result.requests?.[1]?.body.includes('<Col id="cboYtmSort">80</Col>'), `${label} must attempt code 80 directly`);
});

runNode("kind-80:fallback-preserves-kind", { action: "execute", operation: "matrix", input: {
  baseDate: request.baseDate,
  kind: "80",
  fallback: "previous-available",
  lookbackDays: 1
} }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.privateBondPadded }
]), (result, label) => {
  check(result.ok && result.value?.baseDate === "2026-06-07", `${label} must resolve the prior available date`);
  check(result.value?.kind?.code === "80" && result.value?.kind?.name === "회사채(사모)", `${label} must preserve canonical kind 80`);
  check(result.value?.dateResolution?.attemptedDates?.join(",") === "2026-06-08,2026-06-07", `${label} must preserve the kind-80 fallback history`);
  for (const index of [1, 3]) {
    check(result.requests?.[index]?.body.includes('<Col id="cboYtmSort">80</Col>'), `${label} matrix attempt ${index === 1 ? 1 : 2} must send code 80`);
    check(!result.requests?.[index]?.body.includes('<Col id="cboYtmSort">70</Col>'), `${label} matrix attempt ${index === 1 ? 1 : 2} must never substitute code 70`);
  }
});

runNode("kind-80:discovery-conflict", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  {
    path: initPath,
    fixture: evidence.fixtures.init,
    replace: [["<Col id=\"divCode\">70</Col>", "<Col id=\"divCode\">80</Col>"]]
  }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} must reject a live label conflict`);
});

for (const [id, kind] of [["code", "80"], ["label", "회사채(사모)"]]) {
  runCli(`kind-80:cli-${id}`, ["matrix", "--base-date", request.baseDate, "--kind", kind], fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, fixture: evidence.fixtures.privateBondPadded }
  ]), (result, label) => {
    const parsed = JSON.parse(result.stdout);
    check(result.status === 0 && parsed.result?.kind?.code === "80", `${label} must execute kind 80`);
    assertPrivateBondPadded({ value: parsed.result }, label);
  });
}

if (surfaceEnabled("node") && scenarioEnabled("package-surface")) {
  scenariosRun += 1;
  const product = await inspectPackage(productRoot);
  assertGolden("package-surface", "package", product);
  check(product.name === "@sjunepark/ytm", "package-surface: product must preserve package identity");
  check(product.engine === ">=22", "package-surface: product must require Node 22 or newer");
  check(product.exportKeys.join(",") === ".,./package.json", "package-surface: Node SDK must expose only the root client and package metadata");
  check(product.bin === null && product.client === "./dist/client.js", "package-surface: Node SDK must omit a bin and expose the root client interface");
  check(product.cliFiles.length === 0, "package-surface: Node SDK must not retain JavaScript CLI source or distribution files");
  check(product.files.every(({ exists }) => exists), "package-surface: product must ship all required public files");
}

// The executable and the independent OOXML reader jointly verify the file contract.
function xlsxScenario(name, dataArgs, fixtureConfig, input, options = {}) {
  const output = options.path || "수익률 export.XLSX";
  runCli(`cli-xlsx:${name}`, (cwd) => [...dataArgs, "--format=xlsx", `--output=${options.absolute ? resolve(cwd, output) : output}`, ...(options.overwrite ? ["--overwrite"] : []), ...(options.pretty ? ["--pretty", "--pretty"] : [])], fixtureConfig, (result, label, cwd) => {
    check(result.status === 0 && result.stderr === "", `${label} must save a workbook`);
    const receipt = JSON.parse(result.stdout);
    const reference = invokeCli(cliBin, [...dataArgs, "--format=json"], fixtureConfig);
    check(reference.status === 0, `${label} reference JSON must succeed`);
    const expected = JSON.parse(reference.stdout).result;
    const expectedPath = options.absolute ? resolve(cwd, output) : output;
    check(isDeepStrictEqual(normalizeStatistics(receipt, label), normalizeStatistics({ ok: true, operation: dataArgs[0], result: { format: "xlsx", path: expectedPath, statistics: expected.statistics, rowCount: (expected.rows || expected.kinds).length } }, label)), `${label} receipt must identify the published table`);
    const inspected = spawnSync(process.env.PYO3_PYTHON || "python3", [resolve(root, "judge/inspect-xlsx.py"), resolve(cwd, output)], { encoding: "utf8", timeout: childTimeoutMilliseconds, maxBuffer: 4 * 1024 * 1024 });
    check(inspected.status === 0, `${label} independent workbook inspection failed: ${inspected.stderr}`);
    if (inspected.status !== 0) return;
    assertWorkbook(JSON.parse(inspected.stdout), expected, dataArgs[0], label);
    options.assertExpected?.(expected, label);
  }, {
    isolated: true, golden: !options.absolute,
    requestPayload: { operation: dataArgs[0], input },
    setup: options.overwrite ? (cwd) => writeFileSync(resolve(cwd, output), "previous workbook") : undefined
  });
}

function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

function assertWorkbook(workbook, expected, operation, label) {
  const matrix = operation === "matrix";
  check(workbook.sheets.map(({ name }) => name).join(",") === `${matrix ? "Matrix" : "Kinds"},Metadata`, `${label} must contain exactly the two ordered visible worksheets`);
  const [data, metadata] = workbook.sheets;
  if (!data || !metadata) return;
  const columns = matrix ? ["requestedBaseDate", "baseDate", "usedFallback", "kindCode", "kindName", "pricingGroupCode", "pricingGroupName", ...expected.tenors] : ["code", "name"];
  const rows = matrix ? expected.rows.map((row) => [expected.requestedBaseDate, expected.baseDate, expected.dateResolution.usedFallback, expected.kind.code, expected.kind.name, row.pricingGroupCode, row.pricingGroupName, ...expected.tenors.map((tenor) => row.yields[tenor] ?? null)]) : expected.kinds.map(({ code, name }) => [code, name]);
  function cell(sheet, address, value, numericFormat) {
    const actual = sheet.cells[address];
    const type = value === null ? "empty" : typeof value === "string" ? "text" : typeof value;
    check(actual?.type === type && isDeepStrictEqual(actual?.value, value), `${label} ${sheet.name}!${address} must preserve typed ${JSON.stringify(value)}`);
    if (type === "number" && numericFormat) check(actual.format === numericFormat, `${label} ${address} must use ${numericFormat}, without scaling`);
    if (type === "text") check(actual?.wrap, `${label} ${address} must wrap text`);
  }
  columns.forEach((value, index) => {
    const address = `${columnName(index)}1`;
    cell(data, address, value);
    check(data.cells[address]?.bold && data.cells[address]?.fill, `${label} header must be bold and contrasting`);
  });
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => cell(data, `${columnName(columnIndex)}${rowIndex + 2}`, value, "0.000")));
  check(Object.keys(data.cells).length === columns.length * (rows.length + 1), `${label} must preserve the exact table shape`);
  check(data.filter === `A1:${columnName(columns.length - 1)}${rows.length + 1}`, `${label} filter must cover the table`);
  check(data.pane?.state === "frozen" && data.pane.ySplit === "1" && Number(data.pane.xSplit || 0) === (matrix ? 7 : 0), `${label} must freeze header and matrix identities`);
  check(data.columns.length > 0 && data.columns.every((column) => Number(column.width) >= 10), `${label} must set readable widths`);
  cell(metadata, "A1", "field"); cell(metadata, "B1", "value");
  const expectedMetadata = { operation, baseDate: expected.baseDate ?? null };
  if (matrix) {
    Object.assign(expectedMetadata, {
      requestedBaseDate: expected.requestedBaseDate, "kind.code": expected.kind.code, "kind.name": expected.kind.name,
      "dateResolution.mode": expected.dateResolution.mode,
      "dateResolution.resolvedBaseDate": expected.dateResolution.resolvedBaseDate,
      "dateResolution.usedFallback": expected.dateResolution.usedFallback,
      "dateResolution.lookbackDays": expected.dateResolution.lookbackDays
    });
    expected.dateResolution.attemptedDates.forEach((date, index) => { expectedMetadata[`dateResolution.attemptedDates[${index}]`] = date; });
  }
  for (const key of ["pageUrl", "endpoint", "method", "inspectedWorkflow", "note"]) {
    if (expected.source[key] != null) expectedMetadata[`source.${key}`] = expected.source[key];
  }
  if (expected.source.request) {
    for (const key of ["format", "inDatasets", "outDatasets"]) expectedMetadata[`source.request.${key}`] = expected.source.request[key];
    for (const key of ["calBaseDt", "cboYtmSort"]) expectedMetadata[`source.request.parameters.${key}`] = expected.source.request.parameters[key];
  }
  const actualMetadata = {};
  for (let index = 2; metadata.cells[`A${index}`]; index += 1) {
    const key = metadata.cells[`A${index}`].value;
    check(!Object.hasOwn(actualMetadata, key), `${label} duplicate provenance key ${key}`);
    actualMetadata[key] = metadata.cells[`B${index}`]?.value;
    cell(metadata, `B${index}`, expectedMetadata[key]);
  }
  check(isDeepStrictEqual(actualMetadata, expectedMetadata), `${label} must preserve the complete explicit provenance mapping`);
  check(metadata.pane?.ySplit === "1" && metadata.pane.state === "frozen", `${label} metadata must freeze its header`);
}

xlsxScenario("matrix", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name], successFixture, { baseDate: request.baseDate, kind: request.kind.name });
xlsxScenario("date-before-excel-epoch", ["matrix", "--base-date=0000-01-01", "--kind=10"], successFixture, { baseDate: "0000-01-01", kind: "10" });
xlsxScenario("kinds-undated", ["kinds"], fixture([]), {}, { pretty: true });
xlsxScenario("kinds-dated", ["kinds", "--base-date", request.baseDate], fixture([{ path: initPath, fixture: evidence.fixtures.init }]), { baseDate: request.baseDate });
xlsxScenario("overwrite-absolute", ["kinds"], fixture([]), {}, { absolute: true, overwrite: true });
xlsxScenario("overwrite-relative", ["kinds"], fixture([]), {}, { overwrite: true });
xlsxScenario("fallback", ["matrix", "--base-date", "2026-06-07", "--kind", "국채", "--fallback", "previous-available", "--lookback-days", "2"], fixture([
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.matrix }
]), { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available", lookbackDays: 2 });
xlsxScenario("padded-decimals", ["matrix", "--base-date", request.baseDate, "--kind=80"], fixture([
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.privateBondPadded }
]), { baseDate: request.baseDate, kind: "80" });
for (const [index, name] of ["=1+1", "+literal", "-literal", "@literal", "https://example.com"].entries()) {
  xlsxScenario(`literal-${index}`, ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name], fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, fixture: evidence.fixtures.matrix, replace: [
      ['<Col id="pricingGroupName">국고채권</Col>', `<Col id="pricingGroupName">${name}</Col>`],
      ['<Col id="pricingGroupCode">100</Col>', '<Col id="pricingGroupCode">0010</Col>'],
      ['<Col id="m3">2.500</Col>', '<Col id="m3">-4.455</Col>'],
      ['<Col id="m6">2.510</Col>', '<Col id="m6">0.000</Col>']
    ] }
  ]), { baseDate: request.baseDate, kind: request.kind.name }, { assertExpected(expected, label) {
    const row = expected.rows[0];
    check(row.pricingGroupName === name && row.pricingGroupCode === "0010" && row.yields["3M"] === -4.455 && row.yields["6M"] === 0, `${label} fixture must exercise literal text, leading zeros, negative and zero yields`);
  } });
}
xlsxScenario("missing-values", ["matrix", "--base-date", request.baseDate, "--kind=10"], fixture([
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.missingValues }
]), { baseDate: request.baseDate, kind: "10" }, { assertExpected(expected, label) {
  check(expected.rows.some((row) => Object.values(row.yields).includes(null)), `${label} fixture must include blank yields`);
} });
for (const [index, options] of [
  ["--format=xlsx"], ["--format=xlsx", "--output="], ["--format=xlsx", "--output=-"],
  ["--format=xlsx", "--output=out.csv"], ["--output=out.xlsx"], ["--format=tsv", "--overwrite"],
  ["--format=xlsx", "--output=out.xlsx", "--overwrite", "--overwrite"],
  ["--format=xlsx", "--output=out.xlsx", "--output=other.xlsx"],
  ["--help", "--format=xlsx", "--output=bad"], ["--help", "--format=json", "--overwrite"]
].entries()) {
  runCli(`cli-xlsx:invalid-${index}`, ["kinds", ...options], fixture([]), (result, label, cwd) => {
    check(result.status === 2 && JSON.parse(result.stdout).error?.operationName === "kinds", `${label} must return structured invocation failure`);
    check(readdirSync(cwd).length === 0, `${label} must not touch the filesystem`);
  }, { isolated: true });
}
runCli("cli-xlsx:help", ["matrix", "--help", "--format=xlsx"], fixture([]), (result, label, cwd) => {
  check(result.status === 0 && result.stderr === "" && readdirSync(cwd).length === 0, `${label} must not require execution inputs or create files`);
}, { isolated: true });
for (const kind of ["existing", "directory", "missing-parent", ...(process.platform === "win32" ? [] : ["symlink"])]) {
  const path = kind === "missing-parent" ? "absent/out.xlsx" : "out.xlsx";
  runCli(`cli-xlsx:preflight-${kind}`, ["matrix", "--base-date", request.baseDate, "--kind=10", "--format=xlsx", `--output=${path}`, ...(kind === "existing" ? [] : ["--overwrite"])], fixture([]), (result, label, cwd) => {
    const error = JSON.parse(result.stdout).error;
    check(result.status === 1 && result.stderr === "" && error?.parameter === "output" && error.code === (kind === "existing" ? "output_exists" : "output_write_error"), `${label} must identify destination failure`);
    if (kind === "existing" || kind === "symlink") check(readFileSync(resolve(cwd, "out.xlsx"), "utf8") === "old bytes", `${label} must preserve existing bytes`);
  }, { isolated: true, setup(cwd) {
    if (kind === "existing") writeFileSync(resolve(cwd, path), "old bytes");
    if (kind === "directory") mkdirSync(resolve(cwd, path));
    if (kind === "symlink") { writeFileSync(resolve(cwd, "target"), "old bytes"); symlinkSync("target", resolve(cwd, path)); }
  } });
}
runCli("cli-xlsx:source-failure", ["matrix", "--base-date", request.baseDate, "--kind=10", "--format=xlsx", "--output=out.xlsx", "--overwrite"], fixture([
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.invalidNumeric }
]), (result, label, cwd) => {
  check(result.status === 1 && result.stderr === "" && JSON.parse(result.stdout).error?.code === evidence.expectations.formatError, `${label} must preserve source error`);
  check(readFileSync(resolve(cwd, "out.xlsx"), "utf8") === "old bytes", `${label} must preserve old workbook on source failure`);
}, { isolated: true, requestPayload: { operation: "matrix", input: { baseDate: request.baseDate, kind: "10" } }, setup: (cwd) => writeFileSync(resolve(cwd, "out.xlsx"), "old bytes") });

if (!selectedScenario && !selectedSurface) {
  const declaredFixtureFiles = [...new Set(Object.values(evidence.fixtures))];
  const unexercisedFixtures = declaredFixtureFiles.filter((file) => !exercisedFixtureFiles.has(file));
  const undeclaredFixtures = [...exercisedFixtureFiles].filter((file) => !declaredFixtureFiles.includes(file));
  check(unexercisedFixtures.length === 0, `full judge run did not exercise declared fixture(s): ${unexercisedFixtures.join(", ")}`);
  check(undeclaredFixtures.length === 0, `full judge run exercised undeclared fixture(s): ${undeclaredFixtures.join(", ")}`);
}
if (!selectedScenario && !selectedSurface && !options.updateGolden) {
  const unobserved = Object.keys(goldenResults).filter((key) => !observedGoldenKeys.has(key));
  check(unobserved.length === 0, `approved golden results contain stale scenarios: ${unobserved.join(", ")}`);
}

if (selectedScenario && scenariosRun === 0) failures.push(`Unknown or unavailable scenario filter: ${selectedScenario}`);
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
if (options.updateGolden) {
  const sorted = Object.fromEntries(Object.entries(goldenResults).sort(([left], [right]) => left.localeCompare(right)));
  await writeFile(goldenPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`updated ${Object.keys(sorted).length} approved golden result(s)`);
}
console.log(`public-surface judge passed ${scenariosRun} scenario(s)`);

function fixture(steps) {
  return { fixtureDirectory, steps };
}

function recordFixtureUse(fixtureConfig) {
  for (const step of fixtureConfig?.steps || []) {
    if (typeof step.fixture === "string") exercisedFixtureFiles.add(step.fixture);
  }
}

function childEnvironment(additions = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("YTM_JUDGE_"))
  );
  return { ...clean, ...additions };
}

function assertPrivateBondPadded(result, label) {
  const expected = evidence.expectations.privateBondPadded;
  const rows = result.value?.rows;
  const first = rows?.[0];
  check(rows?.length === expected.rowCount, `${label} must normalize all source-shaped private-bond rows`);
  check(first?.pricingGroupCode === expected.pricingGroupCode && first?.pricingGroupName === expected.pricingGroupName, `${label} must retain the private-bond row identity`);
  check(first?.yields?.["3M"] === expected.threeMonthNumeric, `${label} must parse the padded decimal view`);
  check(first?.yieldText?.["3M"] === expected.threeMonthRaw, `${label} must preserve padded yieldText`);
  check(first?.raw?.m3 === expected.threeMonthRaw, `${label} must preserve the exact padded raw cell`);
  for (const tenor of expected.nullTenors) {
    check(first?.yields?.[tenor] === null && first?.yieldText?.[tenor] === "-", `${label} must preserve exact missing ${tenor}`);
  }
}

function runNativePreabort() {
  const name = "native-binding:preaborted-signal";
  if (!surfaceEnabled("node") || !scenarioEnabled(name)) return;
  scenariosRun += 1;
  const captureDirectory = mkdtempSync(resolve(tmpdir(), "ytm-native-judge-"));
  const capturePath = resolve(captureDirectory, "requests.json");
  const nativeUrl = pathToFileURL(resolve(productRoot, "dist/native.js")).href;
  const code = `const {invokeNative}=await import(${JSON.stringify(nativeUrl)});const c=new AbortController();c.abort();const v=await invokeNative('kinds',{baseDate:${JSON.stringify(request.baseDate)}},c.signal);process.stdout.write(JSON.stringify(v));`;
  const fixtureConfig = fixture([{ path: initPath, fixture: evidence.fixtures.init }]);
  recordFixtureUse(fixtureConfig);
  let result;
  let envelope;
  let captures = [];
  try {
    result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: childEnvironment({
        YTM_JUDGE_CAPTURE_PATH: capturePath,
        YTM_JUDGE_FIXTURE: JSON.stringify(fixtureConfig)
      }),
      maxBuffer: 4 * 1024 * 1024,
      timeout: childTimeoutMilliseconds
    });
    envelope = parseSuccessfulJson(result, name);
    captures = existsSync(capturePath) ? parseJson(readFileSync(capturePath, "utf8"), `${name}: request capture`) ?? [] : [];
  } finally {
    rmSync(captureDirectory, { recursive: true, force: true });
  }
  assertGolden(name, "binding", { status: result.status, envelope, stderr: result.stderr === "" ? "empty" : "nonempty" });
  check(result.stderr === "", `${name}: binding must not write to stderr`);
  check(result.status === 0 && envelope?.error?.code === evidence.expectations.transportError, `${name}: binding must preserve a pre-aborted signal`);
  check(captures.length === 0, `${name}: service-level pre-cancellation must prevent transport work`);
}

function runWithoutNative() {
  const name = "node-adapter:missing-native";
  if (!surfaceEnabled("node") || !scenarioEnabled(name)) return;
  scenariosRun += 1;
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "ytm-no-native-"));
  const currentTarget = JSON.parse(readFileSync(resolve(root, "native-targets.json"), "utf8")).targets
    .find((target) => target.npmPlatform === process.platform && target.npmArch === process.arch);
  let result;
  let value;
  let boundaryResult;
  let boundaryValue;
  try {
    cpSync(resolve(productRoot, "src"), resolve(isolatedRoot, "src"), { recursive: true });
    writeFileSync(resolve(isolatedRoot, "package.json"), '{"type":"module"}\n');
    const clientUrl = pathToFileURL(resolve(isolatedRoot, "src/client.js")).href;
    const code = `const m=await import(${JSON.stringify(clientUrl)});const client=new m.YtmClient();const validation=m.validateMatrixInput({baseDate:'20260820',kind:'80'});let failure;try{await client.kinds()}catch(error){failure=m.serializeYtmError(error)}process.stdout.write(JSON.stringify({validation,failure}));`;
    result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: childEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      timeout: childTimeoutMilliseconds
    });
    value = parseSuccessfulJson(result, name);

    rmSync(resolve(isolatedRoot, "src/native.cjs"));
    const missingLoader = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: childEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      timeout: childTimeoutMilliseconds
    });
    const missingLoaderValue = parseSuccessfulJson(missingLoader, `${name}: missing loader`);
    check(missingLoader.status === 0 && missingLoaderValue?.failure?.code === "native_package_corrupt", `${name}: a missing root native loader must be classified as corrupt`);

    cpSync(resolve(productRoot, "src/native.cjs"), resolve(isolatedRoot, "src/native.cjs"));
    if (currentTarget) {
      const packageRoot = resolve(isolatedRoot, "node_modules", ...currentTarget.packageName.split("/"));
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(resolve(packageRoot, "package.json"), '{"main":"index.cjs"}\n');
      writeFileSync(resolve(packageRoot, "index.cjs"), 'module.exports = require("./missing-internal.cjs");\n');
      const corruptPackage = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        env: childEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
        timeout: childTimeoutMilliseconds
      });
      const corruptPackageValue = parseSuccessfulJson(corruptPackage, `${name}: corrupt package`);
      check(corruptPackage.status === 0 && corruptPackageValue?.failure?.code === "native_package_corrupt", `${name}: a missing internal package module must be classified as corrupt`);
    }

    if (process.platform === "linux") {
      const unknownLibcCode = `process.report.getReport=()=>({header:{}});${code}`;
      const unknownLibc = spawnSync(process.execPath, ["--input-type=module", "-e", unknownLibcCode], {
        encoding: "utf8",
        env: childEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
        timeout: childTimeoutMilliseconds
      });
      const unknownLibcValue = parseSuccessfulJson(unknownLibc, `${name}: unknown libc`);
      check(unknownLibc.status === 0 && unknownLibcValue?.failure?.actual?.endsWith("-unknown-libc"), `${name}: inconclusive Linux reports must not be classified as musl`);
    }

    writeFileSync(resolve(isolatedRoot, "src/native.js"), `
export function createProgressNative() { return {snapshot: () => "null"}; }
export async function invokeNative(operation, input) {
  if (input.baseDate === "2026-08-20") return { ok: true };
  if (input.baseDate === "2026-08-21") return { ok: true, value: null };
  const error = new Error("Deliberate native rejection");
  error.details = {
    ok: false,
    code: "native_package_corrupt",
    operationName: operation,
    reason: "Deliberate native rejection",
    recoveryAction: { kind: "update_package" },
    recoverable: true,
    retryable: false
  };
  throw error;
}
`);
    const boundaryCode = `
const m = await import(${JSON.stringify(clientUrl)});
const client = new m.YtmClient();
async function capture(execution) {
  try {
    await execution;
    return { unexpectedSuccess: true };
  } catch (error) {
    return { isYtmError: error instanceof m.YtmError, error: m.serializeYtmError(error) };
  }
}
const missingKindsValue = await capture(client.kinds({ baseDate: "2026-08-20" }));
const nullMatrixValue = await capture(client.matrix({ baseDate: "2026-08-21", kind: "80" }));
const nativeRejection = await capture(client.kinds({ baseDate: "2026-08-22" }));
process.stdout.write(JSON.stringify({ missingKindsValue, nullMatrixValue, nativeRejection }));
`;
    boundaryResult = spawnSync(process.execPath, ["--input-type=module", "-e", boundaryCode], {
      encoding: "utf8",
      env: childEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      timeout: childTimeoutMilliseconds
    });
    boundaryValue = parseSuccessfulJson(boundaryResult, `${name}: client boundaries`);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
  const runtimeKey = value?.failure?.actual;
  const runtimeReason = typeof runtimeKey === "string"
    ? `The native ytm package for ${runtimeKey} is not installed.`
    : undefined;
  check(runtimeKey === (currentTarget ? nativeRuntimeKey(currentTarget) : undefined), `${name}: the unavailable package must identify the exact manifest runtime`);
  check(value?.failure?.reason === runtimeReason && value?.failure?.message === runtimeReason, `${name}: the unavailable package message must identify the current runtime`);
  assertGolden(name, "node", {
    status: result.status,
    value: normalizeMissingNativeGolden(value, runtimeKey),
    boundaryValue,
    stderr: result.stderr === "" ? "empty" : "nonempty",
    boundaryStderr: boundaryResult?.stderr === "" ? "empty" : "nonempty"
  });
  check(result.stderr === "", `${name}: client must not write to stderr`);
  check(value?.validation?.ok === true, `${name}: pure validation must remain available without a native package`);
  check(value?.failure?.code === "native_package_unavailable" && value?.failure?.recoveryAction?.kind === "update_package" && value?.failure?.retryable === false, `${name}: execution must return an actionable native-package failure`);
  check(boundaryResult?.status === 0 && boundaryResult.stderr === "", `${name}: client boundary probes must complete without stderr`);
  check(boundaryValue?.missingKindsValue?.isYtmError === true && boundaryValue?.missingKindsValue?.error?.code === "internal_error" && boundaryValue?.missingKindsValue?.error?.operationName === "kinds", `${name}: a missing kinds result must reject as YtmError`);
  check(boundaryValue?.nullMatrixValue?.isYtmError === true && boundaryValue?.nullMatrixValue?.error?.code === "internal_error" && boundaryValue?.nullMatrixValue?.error?.operationName === "matrix", `${name}: a null matrix result must reject as YtmError`);
  check(boundaryValue?.nativeRejection?.isYtmError === true && boundaryValue?.nativeRejection?.error?.code === "native_package_corrupt", `${name}: a structured native rejection must reject as YtmError`);
}

function normalizeMissingNativeGolden(value, runtimeKey) {
  const normalized = structuredClone(value);
  if (typeof runtimeKey !== "string") return normalized;
  normalized.failure.actual = "<runtime-key>";
  for (const field of ["message", "reason"]) {
    if (typeof normalized.failure[field] === "string") {
      normalized.failure[field] = normalized.failure[field].replaceAll(runtimeKey, "<runtime-key>");
    }
  }
  return normalized;
}

function parseSuccessfulJson(result, name) {
  if (result.status !== 0) return undefined;
  return parseJson(result.stdout, `${name}: successful process`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    failures.push(`${label} emitted invalid JSON: ${error.message}`);
    return undefined;
  }
}

function invokeNode(packageRoot, requestPayload, fixtureConfig) {
  const captureDirectory = mkdtempSync(resolve(tmpdir(), "ytm-judge-"));
  const capturePath = resolve(captureDirectory, "requests.json");
  const result = spawnSync(process.execPath, [resolve(root, "judge/surface-runner.mjs")], {
    encoding: "utf8",
    env: childEnvironment({
      YTM_JUDGE_REQUEST: JSON.stringify({ packageRoot, ...requestPayload }),
      YTM_JUDGE_CAPTURE_PATH: capturePath,
      ...(fixtureConfig ? { YTM_JUDGE_FIXTURE: JSON.stringify(fixtureConfig) } : {})
    }),
    maxBuffer: 4 * 1024 * 1024,
    timeout: childTimeoutMilliseconds
  });
  rmSync(captureDirectory, { recursive: true, force: true });
  if (result.status !== 0) {
    return { ok: false, error: { code: "judge_runner_failure", status: result.status, signal: result.signal, stderr: result.stderr, stdout: result.stdout, reason: result.error?.message }, requests: [] };
  }
  if (result.stderr !== "") {
    return { ok: false, error: { code: "judge_runner_unexpected_stderr", stderr: result.stderr, stdout: result.stdout }, requests: [] };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: { code: "judge_runner_invalid_json", stdout: result.stdout, stderr: result.stderr }, requests: [] };
  }
}

function invokeCli(binary, args, fixtureConfig, { cwd, capturePath } = {}) {
  if (!existsSync(binary)) return { status: null, signal: null, stdout: "", stderr: `standalone CLI does not exist: ${binary}` };
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    cwd,
    env: childEnvironment({ ...(fixtureConfig ? { YTM_JUDGE_FIXTURE: JSON.stringify(fixtureConfig) } : {}), ...(capturePath ? { YTM_JUDGE_CAPTURE_PATH: capturePath } : {}) }),
    maxBuffer: 4 * 1024 * 1024,
    timeout: childTimeoutMilliseconds
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.error ? `standalone CLI did not start: ${result.error.message}` : result.stderr ?? ""
  };
}

function assertRequests(actual, expected, requestPayload, label) {
  check(actual?.length === expected.length, `${label} must make exactly ${expected.length} request(s)`);
  for (let index = 0; index < Math.min(actual?.length || 0, expected.length); index += 1) {
    const request = actual[index];
    check(request.url.endsWith(expected[index].path), `${label} request ${index + 1} must use ${expected[index].path}`);
    check(request.method === "POST", `${label} request ${index + 1} must use POST`);
    check(request.headers["content-type"] === "text/xml; charset=UTF-8", `${label} request ${index + 1} must preserve content type`);
    check(request.headers.accept === "text/xml, */*", `${label} request ${index + 1} must preserve Accept`);
    check(request.signalPresent, `${label} request ${index + 1} must receive cancellation`);
    const expectedCells = expectedRequestCells(requestPayload, expected, index, `${label} request ${index + 1}`);
    const authorityBody = authorityRequestBody(expected[index].path, expectedCells, `${label} request ${index + 1}`);
    check(request.body === authorityBody, `${label} request ${index + 1} body must exactly match the OpenAPI serialization`);
  }
}

function expectedRequestCells(requestPayload, steps, index, label) {
  if (steps[index].expectedCells) return steps[index].expectedCells;
  const input = requestPayload?.input || {};
  const attemptsThroughRequest = steps
    .slice(0, index + 1)
    .filter(({ path }) => path === initPath)
    .length;
  const fallbackOffset = input.fallback === "previous-available"
    ? Math.max(0, attemptsThroughRequest - 1)
    : 0;
  const calBaseDt = compactBaseDate(input.baseDate, fallbackOffset, label);
  const cells = { calBaseDt };
  if (steps[index].path === matrixPath) {
    cells.cboYtmSort = expectedKindCode(input.kind, label);
  }
  return cells;
}

function compactBaseDate(value, daysBack, label) {
  const match = /^(\d{4})(?:-|\.)?(\d{2})(?:-|\.)?(\d{2})$/u.exec(String(value ?? ""));
  check(match !== null, `${label} must have an independently derivable base date`);
  if (match === null) return undefined;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCDate(date.getUTCDate() - daysBack);
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("");
}

function expectedKindCode(value, label) {
  if (typeof value === "number" && Number.isInteger(value)) return String(value).padStart(2, "0");
  const normalized = String(value ?? "").trim();
  if (/^\d+$/u.test(normalized)) return normalized.padStart(2, "0");
  const compactLabel = normalized.replace(/\s+/gu, "");
  if (compactLabel === request.kind.name.replace(/\s+/gu, "")) return request.kind.code;
  if (compactLabel === "회사채(사모)") return "80";
  check(false, `${label} must have an independently derivable kind code`);
  return undefined;
}

function authorityRequestBody(path, expectedCells, label) {
  let expectedBody = authorityRequestExamples.get(path);
  if (typeof expectedBody !== "string") return undefined;
  const dynamicColumns = path === matrixPath ? ["calBaseDt", "cboYtmSort"] : ["calBaseDt"];
  for (const id of dynamicColumns) {
    const pattern = new RegExp(`<Col id="${id}">[^<]*</Col>`, "g");
    const authorityCells = expectedBody.match(pattern) || [];
    check(authorityCells.length === 1, `${label} authority must contain exactly one ${id} cell`);
    check(typeof expectedCells?.[id] === "string", `${label} must define the expected ${id} value`);
    if (authorityCells.length === 1 && typeof expectedCells?.[id] === "string") {
      expectedBody = expectedBody.replace(authorityCells[0], `<Col id="${id}">${expectedCells[id]}</Col>`);
    }
  }
  return expectedBody;
}

async function inspectPackage(packageRoot) {
  const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.ytm;
  const client = pkg.exports?.["."]?.import;
  const types = pkg.exports?.["."]?.types;
  const required = [client, types, "README.md", "SPEC.md", "LICENSE.md", "skills/kisnet-ytm/SKILL.md"];
  const cliFiles = (await Promise.all(["src", "dist"].map(async (directory) => {
    const absolute = resolve(packageRoot, directory);
    return existsSync(absolute) ? listFiles(absolute, directory) : [];
  }))).flat().filter(isNodeCliArtifact);
  return {
    name: pkg.name,
    bin: bin ?? null,
    exportKeys: Object.keys(pkg.exports || {}).sort(),
    client,
    types,
    packageJsonExport: pkg.exports?.["./package.json"],
    engine: pkg.engines?.node,
    cliFiles,
    files: required.map((path) => ({ path, exists: typeof path === "string" && existsSync(resolve(packageRoot, path)) }))
  };
}

async function listFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return listFiles(resolve(directory, entry.name), relative);
    return entry.isFile() ? [relative] : [];
  }))).flat();
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--update-golden") parsed.updateGolden = true;
    else if (option === "--product-root") parsed.productRoot = args[++index];
    else if (option === "--cli-bin") parsed.cliBin = args[++index];
    else if (option === "--scenario") parsed.scenario = args[++index];
    else if (option === "--surface") parsed.surface = args[++index];
    else throw new Error(`Unknown judge option: ${option}`);
  }
  if (parsed.surface && !["node", "cli"].includes(parsed.surface)) throw new Error(`Unknown judge surface: ${parsed.surface}`);
  return parsed;
}
