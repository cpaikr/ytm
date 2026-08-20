import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const baselineRoot = resolve(options.baselineRoot || resolve(root, "packages/node"));
const candidateRoot = resolve(options.candidateRoot || baselineRoot);
const selectedScenario = options.scenario;
const failures = [];
let scenariosRun = 0;

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

function compare(name, baseline, candidate) {
  if (name === "cancellation") return;
  const left = comparisonProjection({ ok: baseline.ok, value: baseline.value, error: baseline.error });
  const right = comparisonProjection({ ok: candidate.ok, value: candidate.value, error: candidate.error }, left);
  if (name === "package-surface") right.value.engine = left.value.engine;
  check(isDeepStrictEqual(left, right), `${name}: public result differs between baseline and candidate`);
}

function comparisonProjection(result, baseline) {
  const projected = structuredClone(result);
  normalizeCatalogText(projected);
  if (baseline?.value?.kinds && projected.value?.kinds) {
    const legacyCodes = new Set(baseline.value.kinds.map(({ code }) => code));
    projected.value.kinds = projected.value.kinds.filter(({ code }) => legacyCodes.has(code));
    if (baseline.value.source?.note && projected.value.source?.note) {
      projected.value.source.note = baseline.value.source.note;
    }
  }
  if (projected.error?.code === "source_format_error") delete projected.error.reason;
  return projected;
}

function normalizeCatalogText(value) {
  if (typeof value === "string") {
    return value
      .replace(/^[ \t]*80 = 회사채\(사모\)\n?/gm, "")
      .replace(/^80\t회사채\(사모\)\n?/gm, "");
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = normalizeCatalogText(value[index]);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) value[key] = normalizeCatalogText(child);
  }
  return value;
}

function runToolset(name, requestPayload, fixture, assertResult, options = {}) {
  if (!scenarioEnabled(name)) return;
  scenariosRun += 1;
  const baseline = invokeToolset(baselineRoot, requestPayload, fixture);
  const candidate = invokeToolset(candidateRoot, requestPayload, fixture);
  compare(name, baseline, candidate);
  assertResult?.(candidate, `${name}: candidate`);
  assertRequests(candidate.requests, options.candidateSteps ?? fixture?.steps ?? [], `${name}: candidate`);
}

function runCli(name, args, fixture, assertResult) {
  if (!scenarioEnabled(name)) return;
  scenariosRun += 1;
  const baseline = invokeCli(baselineRoot, args, fixture);
  const candidate = invokeCli(candidateRoot, args, fixture);
  const projectedBaseline = normalizeCliResult(structuredClone(baseline));
  const projectedCandidate = normalizeCliResult(structuredClone(candidate));
  check(isDeepStrictEqual(projectedBaseline, projectedCandidate), `${name}: CLI process result differs between baseline and candidate`);
  assertResult?.(candidate, `${name}: candidate`);
}

function runCandidateToolset(name, requestPayload, fixture, assertResult) {
  if (!scenarioEnabled(name)) return;
  scenariosRun += 1;
  const candidate = invokeToolset(candidateRoot, requestPayload, fixture);
  assertResult(candidate, `${name}: candidate`);
  assertRequests(candidate.requests, fixture?.steps || [], `${name}: candidate`);
}

function runCandidateCli(name, args, fixture, assertResult) {
  if (!scenarioEnabled(name)) return;
  scenariosRun += 1;
  const candidate = invokeCli(candidateRoot, args, fixture);
  assertResult(candidate, `${name}: candidate`);
}

function normalizeCliResult(result) {
  result.stdout = normalizeCatalogText(result.stdout);
  result.stderr = normalizeCatalogText(result.stderr);
  return result;
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
}, { candidateSteps: [] });

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

for (const xmlCase of evidence.xmlCases.valid) {
  const operation = xmlCase.operation;
  const replacement = xmlCase.expectedKindCode === "10" && xmlCase.expectedKindName !== "국채"
    ? { replace: [["<Col id=\"divCode\">10</Col>", "<Col id=\"divCode\">90</Col>"]] }
    : {};
  const steps = operation === "matrix"
    ? [{ path: initPath, fixture: evidence.fixtures.init }, { path: matrixPath, fixture: evidence.fixtures[xmlCase.fixture] }]
    : [{ path: initPath, fixture: evidence.fixtures[xmlCase.fixture], ...replacement }];
  const input = operation === "matrix" ? { baseDate: request.baseDate, kind: request.kind.name } : { baseDate: request.baseDate };
  runToolset(`xml-fixture-corpus:valid-${xmlCase.fixture}`, { action: "execute", operation, input }, fixture(steps), (result, label) => {
    check(result.ok, `${label} must accept the valid XML evidence`);
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
runCli("cli-machine-contract:csv", ["matrix", "--base-date", request.baseDate, "--kind", request.kind.name, "--format", "csv"], successFixture, (result, label) => {
  check(result.status === 0 && result.stdout.startsWith("requestedBaseDate,baseDate,usedFallback,kindCode,kindName"), `${label} CSV must preserve its header`);
});
runCli("cli-machine-contract:tsv", ["kinds", "--format", "tsv"], undefined, (result, label) => {
  check(result.status === 0 && result.stdout.startsWith("code\tname"), `${label} TSV must preserve its header`);
});

runCandidateToolset("kind-80:offline-catalog", { action: "execute", operation: "kinds", input: {} }, undefined, (result, label) => {
  check(result.ok, `${label} must return the offline canonical catalog`);
  const privateBond = result.value?.kinds?.find(({ code }) => code === "80");
  check(privateBond?.name === "회사채(사모)", `${label} must include canonical kind 80`);
});

runCandidateToolset("kind-80:dated-catalog", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init }
]), (result, label) => {
  check(result.ok && result.value?.kinds?.at(-1)?.code === "80", `${label} must retain kind 80 when discovery omits it`);
});

for (const [id, kind] of [["code", "80"], ["number", 80], ["label", "회사채(사모)"], ["normalized-label", "회사채 (사모)"]]) {
  runCandidateToolset(`kind-80:matrix-${id}`, { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind } }, fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, fixture: evidence.fixtures.missingValues }
  ]), (result, label) => {
    check(result.ok && result.value?.kind?.code === "80" && result.value?.kind?.name === "회사채(사모)", `${label} must resolve canonical kind 80`);
    check(result.value?.rows?.[0]?.groupName === "회사채(사모)", `${label} must preserve the canonical row group`);
    check(result.value?.rows?.[0]?.yields?.["6M"] === null && result.value?.rows?.[0]?.yieldText?.["6M"] === "-", `${label} must preserve generic missing-value semantics`);
    check(result.requests?.[1]?.body.includes('<Col id="cboYtmSort">80</Col>'), `${label} must send only code 80`);
    check(!result.requests?.[1]?.body.includes('<Col id="cboYtmSort">70</Col>'), `${label} must never substitute code 70`);
  });
}

runCandidateToolset("kind-80:unavailable", { action: "execute", operation: "matrix", input: { baseDate: request.baseDate, kind: "80" } }, fixture([
  { path: initPath, fixture: evidence.fixtures.init },
  { path: matrixPath, fixture: evidence.fixtures.unavailable }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.unavailableError, `${label} must preserve unavailable semantics`);
  check(result.requests?.[1]?.body.includes('<Col id="cboYtmSort">80</Col>'), `${label} must attempt code 80 directly`);
});

runCandidateToolset("kind-80:discovery-conflict", { action: "execute", operation: "kinds", input: { baseDate: request.baseDate } }, fixture([
  {
    path: initPath,
    fixture: evidence.fixtures.init,
    replace: [["<Col id=\"divCode\">70</Col>", "<Col id=\"divCode\">80</Col>"]]
  }
]), (result, label) => {
  check(!result.ok && result.error?.code === evidence.expectations.formatError, `${label} must reject a live label conflict`);
});

for (const [id, kind] of [["code", "80"], ["label", "회사채(사모)"]]) {
  runCandidateCli(`kind-80:cli-${id}`, ["matrix", "--base-date", request.baseDate, "--kind", kind], fixture([
    { path: initPath, fixture: evidence.fixtures.init },
    { path: matrixPath, fixture: evidence.fixtures.matrix }
  ]), (result, label) => {
    check(result.status === 0 && JSON.parse(result.stdout).result?.kind?.code === "80", `${label} must execute kind 80`);
  });
}

if (scenarioEnabled("package-surface")) {
  scenariosRun += 1;
  const baseline = await inspectPackage(baselineRoot);
  const candidate = await inspectPackage(candidateRoot);
  compare("package-surface", { ok: true, value: baseline }, { ok: true, value: candidate });
  check(candidate.name === "@sjunepark/ytm", "package-surface: candidate must preserve package identity");
  check(candidate.engine === ">=22", "package-surface: candidate must require Node 22 or newer");
  check(candidate.bin === "dist/cli.js" && candidate.toolset === "./dist/toolset.js", "package-surface: candidate must preserve bin and toolset exports");
  check(candidate.files.every(({ exists }) => exists), "package-surface: candidate must ship all required public files");
}

if (selectedScenario && scenariosRun === 0) failures.push(`Unknown or unavailable scenario filter: ${selectedScenario}`);
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`public-surface judge passed ${scenariosRun} scenario(s)`);

function fixture(steps) {
  return { fixtureDirectory, steps };
}

function invokeToolset(packageRoot, requestPayload, fixtureConfig) {
  const captureDirectory = mkdtempSync(resolve(tmpdir(), "ytm-judge-"));
  const capturePath = resolve(captureDirectory, "requests.json");
  const result = spawnSync(process.execPath, ["--import", resolve(root, "judge/fixture-preload.mjs"), resolve(root, "judge/surface-runner.mjs")], {
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

function invokeCli(packageRoot, args, fixtureConfig) {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.ytm;
  if (!bin) return { status: null, signal: null, stdout: "", stderr: "package does not declare bin.ytm" };
  const result = spawnSync(process.execPath, ["--import", resolve(root, "judge/fixture-preload.mjs"), resolve(packageRoot, bin), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(fixtureConfig ? { YTM_JUDGE_FIXTURE: JSON.stringify(fixtureConfig) } : {}) },
    maxBuffer: 4 * 1024 * 1024
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
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
  const required = [bin, toolset, types, "README.md", "SPEC.md", "LICENSE.md", "skills/kisnet-ytm/SKILL.md"];
  return {
    name: pkg.name,
    bin,
    toolset,
    types,
    packageJsonExport: pkg.exports?.["./package.json"],
    engine: pkg.engines?.node,
    files: required.map((path) => ({ path, exists: typeof path === "string" && existsSync(resolve(packageRoot, path)) }))
  };
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--baseline-root") parsed.baselineRoot = value;
    else if (option === "--candidate-root") parsed.candidateRoot = value;
    else if (option === "--scenario") parsed.scenario = value;
    else throw new Error(`Unknown judge option: ${option}`);
    index += 1;
  }
  return parsed;
}
