import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isNodeCliArtifact } from "../scripts/node-cli-artifact-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const productRoot = resolve(options.productRoot || resolve(root, "packages/node"));
const cliBin = resolve(options.cliBin || resolve(root, "target/debug/ytm"));
const selectedScenario = options.scenario;
const selectedSurface = options.surface;
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

const evidence = JSON.parse(await readFile(resolve(root, "contracts/kisnet/cases.json"), "utf8"));
const wire = parse(await readFile(resolve(root, "contracts/kisnet/openapi.yaml"), "utf8"));
const fixtureDirectory = resolve(root, "contracts/kisnet");
const initPath = wire.paths["/rateInfo/ytmMatrixMobileInitList.do"].post["x-ytm-nexacro-request"].endpoint;
const matrixPath = wire.paths["/rateInfo/ytmMatrixMobileList.do"].post["x-ytm-nexacro-request"].endpoint;
const maxBodyBytes = wire["x-ytm-nexacro-profile"].response.maxDecompressedBodyBytes;
const maxDepth = wire["x-ytm-nexacro-profile"].response.maxElementDepth;
const request = evidence.requestExample;

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
  const normalized = JSON.parse(JSON.stringify(actual));
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

function publicToolsetResult(result) {
  return { ok: result.ok, value: result.value, error: result.error };
}

function runToolset(name, requestPayload, fixture, assertResult, runnerOptions = {}) {
  if (!surfaceEnabled("node") || !scenarioEnabled(name)) return;
  scenariosRun += 1;
  const product = invokeToolset(productRoot, requestPayload, fixture);
  assertGolden(name, "toolset", publicToolsetResult(product));
  assertResult?.(product, `${name}: product`);
  assertRequests(product.requests, runnerOptions.productSteps ?? fixture?.steps ?? [], `${name}: product`);
}

function runCli(name, args, fixture, assertResult) {
  if (!surfaceEnabled("cli") || !scenarioEnabled(name)) return;
  scenariosRun += 1;
  const product = invokeCli(cliBin, args, fixture);
  if (product.status === null) {
    failures.push(`${name}: ${product.stderr || "standalone CLI did not start"}`);
    return;
  }
  assertGolden(name, "cli", product);
  assertResult?.(product, `${name}: product`);
}

runToolset("toolset-discovery", { action: "inspect" }, undefined, (result, label) => {
  check(result.ok, `${label} must inspect successfully`);
  check(result.value?.methods?.length === 7, `${label} must expose all seven public methods`);
  check(result.value?.operations?.map(({ name }) => name).join(",") === "matrix,kinds", `${label} must preserve operation order`);
  for (const operation of result.value?.operations || []) {
    check(operation.inputJsonSchema && operation.resultJsonSchema, `${label} ${operation.name} must expose schemas`);
    check(Array.isArray(operation.examples) && Array.isArray(operation.limitations), `${label} ${operation.name} must expose examples and limitations`);
  }
});

for (const validation of [
  { id: "missing-base-date", operation: "matrix", input: { kind: "국채" }, code: "missing_parameter", parameter: "baseDate" },
  { id: "unknown-parameter", operation: "matrix", input: { baseDate: request.baseDate, kind: "국채", extra: true }, code: "unknown_parameter", parameter: "extra" },
  { id: "invalid-date", operation: "matrix", input: { baseDate: "2026-99-99", kind: "국채" }, code: "invalid_parameter", parameter: "baseDate" },
  { id: "unknown-operation", operation: "unknown", input: {}, code: "invalid_request" }
]) {
  runToolset(`validation-recovery:${validation.id}`, { action: "validate", operation: validation.operation, input: validation.input }, undefined, (result, label) => {
    const error = result.value?.error;
    check(result.ok && error?.code === validation.code, `${label} must preserve ${validation.code}`);
    check(error?.recoverable === true && error?.retryable === false && error?.recoveryAction, `${label} must preserve machine recovery metadata`);
    if (validation.parameter) check(error?.parameter === validation.parameter, `${label} must identify ${validation.parameter}`);
  });
}

for (const [dateValue, normalized] of [["2026-06-08", "2026-06-08"], ["2026.06.08", "2026-06-08"], ["20260608", "2026-06-08"]]) {
  runToolset(`validation-recovery:date-${dateValue}`, { action: "validate", operation: "matrix", input: { baseDate: dateValue, kind: "10" } }, undefined, (result, label) => {
    check(result.value?.valid === true && result.value?.normalizedInput?.baseDate === normalized, `${label} must normalize supported dates`);
  });
}

for (const dateValue of ["2026.06-08", "2026-0608", "202606-08", "2026..06.08"]) {
  runToolset(`validation-recovery:reject-date-${dateValue}`, { action: "validate", operation: "matrix", input: { baseDate: dateValue, kind: "10" } }, undefined, (result, label) => {
    check(result.value?.valid === false && result.value?.error?.parameter === "baseDate", `${label} must reject an undocumented date shape`);
  });
}

runToolset("toolset-operation-immutability", { action: "operation-mutation" }, undefined, (result, label) => {
  check(result.ok, `${label} must complete the mutation probe`);
  check(result.value?.operation?.examples?.[0]?.input?.baseDate === "2026-06-08", `${label} getOperation must return a deep copy`);
  check(result.value?.listed?.limitations?.[0] !== "mutated", `${label} listOperations must return a deep copy`);
});

const successFixture = fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.matrix }
]);
runToolset("matrix-success", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name } }, successFixture, (result, label) => {
  check(result.ok, `${label} must succeed`);
  check(result.value?.tenors?.join(",") === evidence.expectedTenors.map(({ label: tenor }) => tenor).join(","), `${label} must preserve tenor order`);
  check(result.value?.rows?.[0]?.pricingGroupCode === evidence.expectations.matrix.pricingGroupCode, `${label} must preserve pricing group code`);
  check(result.value?.rows?.[0]?.yieldText?.["3M"] === evidence.expectations.matrix.threeMonth, `${label} must preserve raw yield text`);
  check(result.requests?.[0]?.body.includes(`<Col id="calBaseDt">${request.baseDateCompact}</Col>`), `${label} must project the compact date`);
  check(result.requests?.[1]?.body.includes(`<Col id="cboYtmSort">${request.kind.code}</Col>`), `${label} must project the resolved kind code`);
});

runToolset("missing-values", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.missingValues }
]), (result, label) => {
  for (const tenor of evidence.expectations.missingValues.nullTenors) {
    check(result.value?.rows?.[0]?.yields?.[tenor] === null, `${label} must normalize missing ${tenor} to null`);
    check(result.value?.rows?.[0]?.yieldText?.[tenor] === evidence.expectations.missingValues.rawValues[tenor], `${label} must retain raw ${tenor}`);
  }
});

runToolset("unknown-kind-recovery", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: "not-a-kind" } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(!result.ok && result.error?.code === "invalid_parameter" && result.error?.parameter === "kind", `${label} must reject the unknown kind`);
  check(result.error?.expected?.some(({ code }) => code === "80"), `${label} must expose the accepted catalog`);
  check(result.error?.exampleInput?.baseDate === request.baseDate && result.error?.exampleInput?.kind, `${label} must expose a usable example`);
  check(result.error?.recoveryAction === "inspect_command_help" && result.error?.retryable === false, `${label} must preserve kind-specific recovery metadata`);
});

runToolset("fallback-order", { action: "execute", operation: "matrix", input: { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available", lookbackDays: 2 } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.unavailable },
  { path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures.matrix }
]), (result, label) => {
  check(result.value?.baseDate === "2026-06-05", `${label} must resolve the first available prior date`);
  check(result.value?.dateResolution?.attemptedDates?.join(",") === "2026-06-07,2026-06-06,2026-06-05", `${label} must preserve attempted-date order`);
});

runToolset("cancellation", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name }, abortBeforeExecute: true }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.transportError, `${label} must preserve cancellation as ${evidence.expectations.transportError}`);
  check(result.requests?.length === 0, `${label} must not start HTTP after pre-cancellation`);
}, { productSteps: [] });

for (const failure of [
  { name: "protocol-error", second: { fixture: evidence.fixtures.protocolError }, code: evidence.expectations.protocolError },
  { name: "format-error", second: { fixture: evidence.fixtures.malformed }, code: evidence.expectations.formatError },
  { name: "transport-error", second: { transportError: "deliberate fixture transport failure" }, code: evidence.expectations.transportError },
  { name: "unavailable-data", second: { fixture: evidence.fixtures.unavailable }, code: evidence.expectations.unavailableError }
]) {
  runToolset(failure.name, { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: request.kind.name } }, fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, ...failure.second }
  ]), (result, label) => {
    check(!result.ok && result.error?.code === failure.code, `${label} must return ${failure.code}`);
  });
}

runToolset("fallback-stops-on-format-error", { action: "execute", operation: "matrix", input: {
  baseDate: request.baseDate,
  kind: request.kind.name,
  fallback: "previous-available",
  lookbackDays: 1
} }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.invalidNumeric }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} must stop on source-format failure`);
  check(result.requests?.length === 2, `${label} must not advance fallback after a source-format failure`);
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
  runToolset(`xml-fixture-corpus:valid-${xmlCase.fixture}`, { action: "execute", operation, input }, fixture(steps), (result, label) => {
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
  runToolset(`xml-fixture-corpus:invalid-${fixtureName}`, { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
    { path: initPath, fixture: evidence.fixtures[fixtureName] }
  ]), (result, label) => {
    check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} must reject invalid XML evidence`);
  });
}

for (const boundary of [
  { id: "single-bom", step: { fixture: evidence.fixtures.init, bom: 1 }, succeeds: true },
  { id: "double-bom", step: { fixture: evidence.fixtures.init, bom: 2 }, succeeds: false },
  { id: "invalid-utf8", step: { fixture: evidence.fixtures.init, invalidUtf8: true }, succeeds: false },
  { id: "exact-body-limit", step: { fixture: evidence.fixtures.init, padToBytes: maxBodyBytes }, succeeds: true },
  { id: "body-limit-plus-one", step: { fixture: evidence.fixtures.init, padToBytes: maxBodyBytes + 1 }, succeeds: false },
  { id: "exact-depth-limit", step: { depth: maxDepth }, succeeds: true },
  { id: "depth-limit-plus-one", step: { depth: maxDepth + 1 }, succeeds: false }
]) {
  runToolset(`xml-generated-bounds:${boundary.id}`, { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
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
runCli("cli-machine-contract:unknown-command-help", ["not-a-command", "--help"], undefined, (result, label) => {
  check(result.status === 2 && result.stdout.startsWith("Unknown command: not-a-command") && result.stderr === "", `${label} unknown-command help must preserve the legacy plain stdout diagnostic`);
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
runCli("cli-machine-contract:aliases", ["matrix", "--baseDate", request.baseDate, "--kind", request.kind.name, "--fallback", "previous-available", "--lookbackDays", "2"], successFixture, (result, label) => {
  check(result.status === 0 && JSON.parse(result.stdout).result?.baseDate === request.baseDate, `${label} camel-case aliases must execute`);
});
runCli("cli-machine-contract:input-json", ["matrix", "--input-json", JSON.stringify({ baseDate: request.baseDate, kind: request.kind.name })], successFixture, (result, label) => {
  check(result.status === 0 && JSON.parse(result.stdout).result?.kind?.code === request.kind.code, `${label} input JSON must merge into execution input`);
});
for (const [id, input, parameter] of [
  ["null-base-date", '{"baseDate":null,"kind":"10"}', "baseDate"],
  ["empty-base-date", '{"baseDate":"","kind":"10"}', "baseDate"],
  ["null-kind", `{"baseDate":${JSON.stringify(request.baseDate)},"kind":null}`, "kind"]
]) {
  runCli(`cli-machine-contract:input-json-${id}`, ["matrix", "--input-json", input], undefined, (result, label) => {
    const parsed = JSON.parse(result.stdout);
    check(result.status === 2 && parsed.error?.code === "missing_parameter" && parsed.error?.parameter === parameter, `${label} must classify empty required JSON fields as missing`);
  });
}
for (const [id, kind] of [["decimal-kind", "10.0"], ["exponent-kind", "1e1"]]) {
  runCli(`cli-machine-contract:input-json-${id}`, ["matrix", "--input-json", `{"baseDate":${JSON.stringify(request.baseDate)},"kind":${kind}}`], successFixture, (result, label) => {
    const parsed = JSON.parse(result.stdout);
    check(result.status === 0 && parsed.result?.kind?.code === "10", `${label} must normalize integral JSON numbers like JavaScript`);
  });
}
runCli("cli-machine-contract:input-json-order", ["matrix", "--kind", "20", "--input-json", JSON.stringify({ baseDate: request.baseDate, kind: "30" }), "--kind", request.kind.code], successFixture, (result, label) => {
  check(result.status === 0 && JSON.parse(result.stdout).result?.kind?.code === request.kind.code, `${label} flags and input JSON must apply in argv order with the last value winning`);
});
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
  check(result.status === 2 && error?.code === "invalid_parameter" && error?.parameter === "format", `${label} missing format values must preserve the legacy invalid-parameter contract`);
});
runCli("cli-machine-contract:empty-format", ["matrix", "--format", ""], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "invalid_parameter" && error?.actual === "", `${label} empty format values must preserve the legacy actual value`);
});
runCli("cli-machine-contract:empty-base-date", ["matrix", "--base-date", ""], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "missing_parameter" && error?.reason === "--base-date requires a 기준일 value.", `${label} empty option values must preserve the legacy missing-parameter contract`);
});
runCli("cli-machine-contract:invalid-fallback", ["matrix", "--base-date", request.baseDate, "--kind", "10", "--fallback", "unsupported"], undefined, (result, label) => {
  const error = JSON.parse(result.stdout).error;
  check(result.status === 2 && error?.code === "invalid_parameter" && error?.exampleInput?.fallback === "previous-available", `${label} fallback failures must preserve the recovery example`);
});

runNativePreabort();
runToolset("abort-handler-preservation", {
  action: "abort-handler-preservation",
  input: { baseDate: request.baseDate }
}, fixture([{ path: initPath, waitForCancellation: true }]), (result, label) => {
  check(result.ok, `${label} must complete its cancellation probe`);
  check(result.value?.preservedDuringExecution === true, `${label} must preserve onabort while executing`);
  check(result.value?.preservedAfterAbort === true, `${label} must preserve onabort after cancellation`);
  check(result.value?.handlerCalls === 1, `${label} must call the consumer handler exactly once`);
  check(result.value?.signalAbortedAtEntry === false, `${label} must cancel after transport work begins`);
  check(result.value?.cancellationCode === evidence.expectations.transportError, `${label} must forward cancellation into the native operation`);
});
runWithoutNative();

runToolset("kind-80:offline-catalog", { action: "execute", operation: "kinds", input: {} }, undefined, (result, label) => {
  check(result.ok, `${label} must return the offline canonical catalog`);
  const privateBond = result.value?.kinds?.find(({ code }) => code === "80");
  check(privateBond?.name === "회사채(사모)", `${label} must include canonical kind 80`);
});

runToolset("kind-80:dated-catalog", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(result.ok && result.value?.kinds?.at(-1)?.code === "80", `${label} must retain kind 80 when discovery omits it`);
});

for (const [id, kind] of [["code", "80"], ["number", 80], ["label", "회사채(사모)"], ["normalized-label", "회사채 (사모)"]]) {
  runToolset(`kind-80:matrix-${id}`, { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind } }, fixture([
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

runToolset("kind-80:unavailable", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: "80" } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.unavailable }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.unavailableError, `${label} must preserve unavailable semantics`);
  check(result.requests?.[1]?.body.includes('<Col id="cboYtmSort">80</Col>'), `${label} must attempt code 80 directly`);
});

runToolset("kind-80:fallback-preserves-kind", { action: "execute", operation: "matrix", input: {
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

runToolset("kind-80:discovery-conflict", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
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
  check(product.bin === null && product.toolset === "./dist/toolset.js", "package-surface: Node SDK must omit a bin and preserve the toolset export");
  check(product.cliFiles.length === 0, "package-surface: Node SDK must not retain JavaScript CLI source or distribution files");
  check(product.files.every(({ exists }) => exists), "package-surface: product must ship all required public files");
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
  let result;
  let envelope;
  let captures = [];
  try {
    result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: {
        ...process.env,
        YTM_JUDGE_CAPTURE_PATH: capturePath,
        YTM_JUDGE_FIXTURE: JSON.stringify(fixture([{ path: initPath, fixture: evidence.fixtures.init }]))
      }
    });
    envelope = parseSuccessfulJson(result, name);
    captures = existsSync(capturePath) ? parseJson(readFileSync(capturePath, "utf8"), `${name}: request capture`) ?? [] : [];
  } finally {
    rmSync(captureDirectory, { recursive: true, force: true });
  }
  assertGolden(name, "binding", { status: result.status, envelope, stderr: result.stderr === "" ? "empty" : "nonempty" });
  check(result.stderr === "", `${name}: binding must not write to stderr`);
  check(result.status === 0 && envelope?.error?.code === evidence.expectations.transportError, `${name}: binding must preserve a pre-aborted signal`);
  check(captures.length === 1 && captures[0]?.signalAborted === true, `${name}: cancellation must reach Rust before transport work begins`);
}

function runWithoutNative() {
  const name = "node-adapter:missing-native";
  if (!surfaceEnabled("node") || !scenarioEnabled(name)) return;
  scenariosRun += 1;
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "ytm-no-native-"));
  let result;
  let value;
  try {
    cpSync(resolve(productRoot, "src"), resolve(isolatedRoot, "src"), { recursive: true });
    writeFileSync(resolve(isolatedRoot, "package.json"), '{"type":"module"}\n');
    const toolsetUrl = pathToFileURL(resolve(isolatedRoot, "src/toolset.js")).href;
    const code = `const m=await import(${JSON.stringify(toolsetUrl)});const t=m.createKisnetYtmToolset();const validation=t.validateInput('matrix',{baseDate:'20260820',kind:'80'});let failure;try{await t.execute('kinds',{});}catch(error){failure=t.serializeError(error)}process.stdout.write(JSON.stringify({help:t.help(),validation,failure}));`;
    result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    value = parseSuccessfulJson(result, name);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
  assertGolden(name, "toolset", { status: result.status, value, stderr: result.stderr === "" ? "empty" : "nonempty" });
  check(result.stderr === "", `${name}: toolset must not write to stderr`);
  check(result.status === 0 && value?.help?.includes("Native capabilities unavailable"), `${name}: help must remain available without a native package`);
  check(value?.validation?.valid === true, `${name}: pure validation must remain available without a native package`);
  check(value?.failure?.code === "internal_error" && value?.failure?.retryable === false, `${name}: execution must return a stable internal failure`);
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

function invokeToolset(packageRoot, requestPayload, fixtureConfig) {
  const captureDirectory = mkdtempSync(resolve(tmpdir(), "ytm-judge-"));
  const capturePath = resolve(captureDirectory, "requests.json");
  const result = spawnSync(process.execPath, [resolve(root, "judge/surface-runner.mjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      YTM_JUDGE_REQUEST: JSON.stringify({ packageRoot, ...requestPayload }),
      YTM_JUDGE_CAPTURE_PATH: capturePath,
      ...(fixtureConfig ? { YTM_JUDGE_FIXTURE: JSON.stringify(fixtureConfig) } : {})
    },
    maxBuffer: 4 * 1024 * 1024
  });
  rmSync(captureDirectory, { recursive: true, force: true });
  if (result.status !== 0) {
    return { ok: false, error: { code: "judge_runner_failure", status: result.status, stderr: result.stderr, stdout: result.stdout }, requests: [] };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: { code: "judge_runner_invalid_json", stdout: result.stdout, stderr: result.stderr }, requests: [] };
  }
}

function invokeCli(binary, args, fixtureConfig) {
  if (!existsSync(binary)) return { status: null, signal: null, stdout: "", stderr: `standalone CLI does not exist: ${binary}` };
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: { ...process.env, ...(fixtureConfig ? { YTM_JUDGE_FIXTURE: JSON.stringify(fixtureConfig) } : {}) },
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.error ? `standalone CLI did not start: ${result.error.message}` : result.stderr ?? ""
  };
}

function assertRequests(actual, expected, label) {
  check(actual?.length === expected.length, `${label} must make exactly ${expected.length} request(s)`);
  for (let index = 0; index < Math.min(actual?.length || 0, expected.length); index += 1) {
    const request = actual[index];
    check(request.url.endsWith(expected[index].path), `${label} request ${index + 1} must use ${expected[index].path}`);
    check(request.method === "POST", `${label} request ${index + 1} must use POST`);
    check(request.headers["content-type"] === "text/xml; charset=UTF-8", `${label} request ${index + 1} must preserve content type`);
    check(request.headers.accept === "text/xml, */*", `${label} request ${index + 1} must preserve Accept`);
    check(request.signalPresent, `${label} request ${index + 1} must receive cancellation`);
  }
}

async function inspectPackage(packageRoot) {
  const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.ytm;
  const toolset = pkg.exports?.["./toolset"]?.import;
  const types = pkg.exports?.["./toolset"]?.types;
  const required = [toolset, types, "README.md", "SPEC.md", "LICENSE.md", "skills/kisnet-ytm/SKILL.md"];
  const cliFiles = (await Promise.all(["src", "dist"].map(async (directory) => {
    const absolute = resolve(packageRoot, directory);
    return existsSync(absolute) ? listFiles(absolute, directory) : [];
  }))).flat().filter(isNodeCliArtifact);
  return {
    name: pkg.name,
    bin: bin ?? null,
    toolset,
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
