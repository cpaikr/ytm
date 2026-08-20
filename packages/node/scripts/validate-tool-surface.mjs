import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { createKisnetYtmToolset } from "../dist/toolset.js";

const failures = [];
const contractDirectory = new URL("../../../contracts/kisnet/", import.meta.url);
const contract = JSON.parse(await readFile(new URL("cases.json", contractDirectory), "utf8"));
const wireContract = parse(await readFile(new URL("../../../contracts/kisnet/openapi.yaml", import.meta.url), "utf8"));
const request = contract.requestExample;
const initEndpoint = wireContract.paths["/rateInfo/ytmMatrixMobileInitList.do"].post["x-ytm-nexacro-request"].endpoint;
const matrixEndpoint = wireContract.paths["/rateInfo/ytmMatrixMobileList.do"].post["x-ytm-nexacro-request"].endpoint;
const xmlLimits = {
  maxBodyBytes: wireContract["x-ytm-nexacro-profile"].response.maxDecompressedBodyBytes,
  maxElementDepth: wireContract["x-ytm-nexacro-profile"].response.maxElementDepth
};
const fixtures = Object.fromEntries(await Promise.all(
  Object.entries(contract.fixtures).map(async ([name, file]) => [name, await readFile(new URL(file, contractDirectory), "utf8")])
));
const utf8Encoder = new TextEncoder();

function check(condition, message) {
  if (!condition) failures.push(message);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
check(pkg.name === "@sjunepark/ytm", "package.json must use the configured npm package name");
check(pkg.packageManager?.startsWith("bun@"), "package.json must declare Bun as the development package manager");
check(pkg.engines?.node, "package.json must declare the supported Node engine for npm users");
check(pkg.publishConfig?.access === "public", "scoped npm package must publish with public access");
check(pkg.scripts?.cli === "bun run src/cli.js", "package.json must expose a Bun source-run cli script");
check(pkg.bin && pkg.bin["ytm"] === "dist/cli.js", "package.json must expose bin.ytm -> dist/cli.js");
check(pkg.exports?.["./toolset"]?.import === "./dist/toolset.js", "package.json must export ./toolset import surface");
check(pkg.exports?.["./toolset"]?.types === "./dist/toolset.d.ts", "package.json must export ./toolset types");
check(pkg.exports?.["./package.json"] === "./package.json", "package.json must export ./package.json metadata");
check(existsSync("README.md"), "npm package must include its package-owned README.md");
check(existsSync("SPEC.md"), "npm package must preserve the published tool surface SPEC.md");
check(existsSync("LICENSE.md"), "npm package must include LICENSE.md");
check(existsSync("skills/kisnet-ytm/SKILL.md"), "npm package must preserve the installable kisnet-ytm agent skill");
check(existsSync("dist/cli.js"), "dist/cli.js must exist; run bun run build");
check(existsSync("dist/nexacro.js"), "dist/nexacro.js must exist; run bun run build");
check(existsSync("dist/toolset.js"), "dist/toolset.js must exist; run bun run build");
check(existsSync("dist/toolset.d.ts"), "dist/toolset.d.ts must exist; run bun run build");
const cliSource = await readFile("dist/cli.js", "utf8");
check(cliSource.startsWith("#!/usr/bin/env node"), "dist/cli.js must use the Node shebang for npm bin execution");
const nodeCommand = process.env.NODE || "node";

const toolset = createKisnetYtmToolset();
for (const method of ["help", "listOperations", "getCommandHelp", "validateInput", "execute", "serializeError"]) {
  check(typeof toolset[method] === "function", `toolset.${method} must be a function`);
}
const operations = toolset.listOperations();
check(operations.some((operation) => operation.name === "matrix"), "matrix operation must be discoverable");
check(operations.some((operation) => operation.name === "kinds"), "kinds operation must be discoverable");
for (const operation of operations) {
  check(operation.inputJsonSchema && operation.resultJsonSchema, `${operation.name} must expose input and result JSON schemas`);
  check(Array.isArray(operation.requiredInputKeys), `${operation.name} must expose requiredInputKeys`);
  check(toolset.getCommandHelp(operation.name), `${operation.name} must expose command help`);
}

const missing = toolset.validateInput("matrix", { kind: "국채" });
check(!missing.valid && missing.error.code === "missing_parameter" && missing.error.recoveryAction, "missing baseDate must produce structured recovery metadata");
const unknown = toolset.validateInput("matrix", { baseDate: "2026-06-08", kind: "국채", extra: true });
check(!unknown.valid && unknown.error.code === "unknown_parameter" && unknown.error.parameter === "extra", "unknown parameters must be rejected with parameter metadata");
const invalid = toolset.validateInput("matrix", { baseDate: "2026-99-99", kind: "국채" });
check(!invalid.valid && invalid.error.code === "invalid_parameter" && invalid.error.parameter === "baseDate", "invalid dates must be rejected with recovery metadata");
const valid = toolset.validateInput("matrix", { baseDate: "2026.06.08", kind: "10" });
check(valid.valid && valid.normalizedInput.baseDate === "2026-06-08", "valid input must normalize baseDate");
const fallback = toolset.validateInput("matrix", { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available" });
check(fallback.valid && fallback.normalizedInput.lookbackDays === 10, "previous-available fallback must default lookbackDays");
const invalidFallback = toolset.validateInput("matrix", { baseDate: "2026-06-07", kind: "국채", fallback: "next-weekday" });
check(!invalidFallback.valid && invalidFallback.error.parameter === "fallback", "unsupported fallback policy must be rejected");
const invalidLookback = toolset.validateInput("matrix", { baseDate: "2026-06-07", kind: "국채", lookbackDays: 10 });
check(!invalidLookback.valid && invalidLookback.error.parameter === "lookbackDays", "lookbackDays without fallback must be rejected");
const stringLookback = toolset.validateInput("matrix", { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available", lookbackDays: "10" });
check(!stringLookback.valid && stringLookback.error.parameter === "lookbackDays", "SDK lookbackDays must match its integer schema and reject strings");

const capturedRequests = [];
const fixtureResult = await toolset.execute("matrix", { baseDate: request.baseDate, kind: request.kind.name }, { fetch: fixtureFetch(fixtures.matrix, capturedRequests) });
check(fixtureResult.tenors.join(",") === contract.expectedTenors.map(({ label }) => label).join(","), "matrix result must preserve the expected tenor order from the independent evidence corpus");
check(fixtureResult.rows[0]?.pricingGroupCode === contract.expectations.matrix.pricingGroupCode, "matrix fixture must preserve pricing group code");
check(fixtureResult.rows[0]?.yieldText["3M"] === contract.expectations.matrix.threeMonth, "matrix fixture must preserve raw yield text");
check(String(fixtureResult.rows[0]?.yields["10Y"]) === String(Number(contract.expectations.matrix.tenYear)), "matrix fixture must expose numeric yields");
check(capturedRequests.some(({ url, body }) => url.endsWith(initEndpoint) && body.includes(`<Col id="calBaseDt">${request.baseDateCompact}</Col>`)), "init request must conform to the authoritative endpoint and compact baseDate projection");
check(capturedRequests.some(({ url, body }) => url.endsWith(matrixEndpoint) && body.includes(`<Col id="cboYtmSort">${request.kind.code}</Col>`)), "matrix request must conform to the authoritative endpoint and source kind-code projection");
check(capturedRequests.every(({ signal }) => signal instanceof AbortSignal), "requests without a caller signal must receive a default timeout signal");

const callerAbort = new AbortController();
const callerSignalRequests = [];
await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: fixtureFetch(fixtures.matrix, callerSignalRequests), signal: callerAbort.signal });
check(callerSignalRequests[0]?.signal === callerAbort.signal, "requests must preserve a caller-provided abort signal");

const missingValueResult = await toolset.execute("matrix", { baseDate: request.baseDate, kind: request.kind.name }, { fetch: fixtureFetch(fixtures.missingValues) });
for (const tenor of contract.expectations.missingValues.nullTenors) {
  check(missingValueResult.rows[0]?.yields[tenor] === null, `shared missing value ${tenor} must normalize to null`);
  check(missingValueResult.rows[0]?.yieldText[tenor] === contract.expectations.missingValues.rawValues[tenor], `shared missing value ${tenor} must preserve raw text`);
}

for (const xmlCase of contract.xmlCases.valid) {
  if (xmlCase.operation === "matrix") {
    const result = await toolset.execute("matrix", { baseDate: request.baseDate, kind: request.kind.name }, { fetch: fixtureFetch(fixtures[xmlCase.fixture]) });
    check(result.rows[0]?.raw[xmlCase.expectedRawColumn] === xmlCase.expectedRawValue, `${xmlCase.fixture} must preserve the expected raw column value`);
    if (xmlCase.expectedExtraRawColumn) {
      check(Object.hasOwn(result.rows[0]?.raw || {}, xmlCase.expectedExtraRawColumn), `${xmlCase.fixture} must preserve the expected extra raw column as an own property`);
      check(result.rows[0]?.raw[xmlCase.expectedExtraRawColumn] === xmlCase.expectedExtraRawValue, `${xmlCase.fixture} must preserve the expected extra raw column value`);
    }
    continue;
  }
  const result = await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(fixtures[xmlCase.fixture]) });
  check(result.kinds[0]?.code === xmlCase.expectedKindCode, `${xmlCase.fixture} must preserve the expected kind code`);
  check(result.kinds[0]?.name === xmlCase.expectedKindName, `${xmlCase.fixture} must preserve the expected kind name`);
}

const bomResult = await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(`\uFEFF${fixtures.init}`) });
check(bomResult.kinds[0]?.code === request.kind.code, "a leading UTF-8 BOM must be accepted");

try {
  const doubleBom = concatBytes(new Uint8Array([0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF]), utf8Encoder.encode(fixtures.init));
  await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => byteResponse(doubleBom) });
  failures.push(`a duplicate UTF-8 BOM must throw ${contract.expectations.formatError}`);
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.formatError, `a duplicate UTF-8 BOM must throw ${contract.expectations.formatError}`);
}

const replacementCharacterResult = await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(fixtures.init.replace("국채", "국\uFFFD채")) });
check(replacementCharacterResult.kinds[0]?.name === "국\uFFFD채", "a literal XML 1.0 replacement character must remain valid");

for (const unsupportedXmlVersion of ["1.1", "1.2"]) {
  const response = fixtures.init.replace('version="1.0"', `version="${unsupportedXmlVersion}"`);
  try {
    await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(response) });
    failures.push(`XML ${unsupportedXmlVersion} must throw ${contract.expectations.formatError}`);
  } catch (error) {
    check(toolset.serializeError(error).code === contract.expectations.formatError, `XML ${unsupportedXmlVersion} must throw ${contract.expectations.formatError}`);
  }
}

for (const supportedEncoding of ["UTF-8", "utf-8"]) {
  const response = fixtures.init.replace('encoding="UTF-8"', `encoding="${supportedEncoding}"`);
  const result = await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(response) });
  check(result.kinds[0]?.code === request.kind.code, `XML encoding ${supportedEncoding} must remain supported`);
}

for (const unsupportedEncoding of ["UTF8", "ISO-8859-1", "UTF-16"]) {
  const response = fixtures.init.replace('encoding="UTF-8"', `encoding="${unsupportedEncoding}"`);
  try {
    await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(response) });
    failures.push(`XML encoding ${unsupportedEncoding} must throw ${contract.expectations.formatError}`);
  } catch (error) {
    check(toolset.serializeError(error).code === contract.expectations.formatError, `XML encoding ${unsupportedEncoding} must throw ${contract.expectations.formatError}`);
  }
}

const exactLimitXml = xmlAtByteLength(fixtures.init, xmlLimits.maxBodyBytes);
const exactLimitResult = await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(exactLimitXml, { headers: { "content-length": String(xmlLimits.maxBodyBytes) } }) });
check(exactLimitResult.kinds[0]?.code === request.kind.code, "a response at the exact XML byte limit must succeed");

let oversizedStreamCancelled = false;
const oversizedBytes = utf8Encoder.encode(xmlAtByteLength(fixtures.init, xmlLimits.maxBodyBytes + 1));
const oversizedStream = new ReadableStream({
  start(controller) {
    controller.enqueue(oversizedBytes);
  },
  cancel() {
    oversizedStreamCancelled = true;
  }
});
try {
  await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => Promise.resolve(new Response(oversizedStream, { status: 200, headers: { "content-length": "1" } })) });
  failures.push(`an oversized measured body must throw ${contract.expectations.formatError}`);
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.formatError, `an oversized measured body must throw ${contract.expectations.formatError}`);
  check(oversizedStreamCancelled, "an oversized measured body must cancel its response stream");
}

const misleadingLengthResult = await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(fixtures.init, { headers: { "content-length": String(xmlLimits.maxBodyBytes + 1), "content-encoding": "gzip" } }) });
check(misleadingLengthResult.kinds[0]?.code === request.kind.code, "the measured decompressed body, not encoded Content-Length, must determine the limit");

let nonstreamingArrayBufferCalled = false;
try {
  await toolset.execute("kinds", { baseDate: request.baseDate }, {
    fetch: () => Promise.resolve({
      ok: true,
      status: 200,
      body: null,
      arrayBuffer() {
        nonstreamingArrayBufferCalled = true;
        return Promise.resolve(utf8Encoder.encode(fixtures.init).buffer);
      }
    })
  });
  failures.push(`a non-streaming response must throw ${contract.expectations.formatError}`);
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.formatError, `a non-streaming response must throw ${contract.expectations.formatError}`);
  check(!nonstreamingArrayBufferCalled, "a non-streaming response must not be buffered before rejection");
}

try {
  const invalidUtf8 = concatBytes(utf8Encoder.encode(fixtures.init), new Uint8Array([0xFF]));
  await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => byteResponse(invalidUtf8) });
  failures.push(`invalid UTF-8 response bytes must throw ${contract.expectations.formatError}`);
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.formatError, `invalid UTF-8 response bytes must throw ${contract.expectations.formatError}`);
}

for (const fixtureName of contract.xmlCases.invalid) {
  try {
    await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(fixtures[fixtureName]) });
    failures.push(`${fixtureName} fixture must throw ${contract.expectations.formatError}`);
  } catch (error) {
    check(toolset.serializeError(error).code === contract.expectations.formatError, `${fixtureName} fixture must throw ${contract.expectations.formatError}`);
  }
}

const excessiveDepthResponse = `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters>${"<Extra>".repeat(xmlLimits.maxElementDepth)}${"</Extra>".repeat(xmlLimits.maxElementDepth)}<Dataset id="output1"><Rows><Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row></Rows></Dataset></Root>`;
try {
  await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(excessiveDepthResponse) });
  failures.push(`XML element depth above ${xmlLimits.maxElementDepth} must throw ${contract.expectations.formatError}`);
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.formatError, `excessive XML depth must throw ${contract.expectations.formatError}`);
}
const maximumDepthResponse = excessiveDepthResponse.replace("<Extra>", "").replace("</Extra>", "");
const maximumDepthResult = await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(maximumDepthResponse) });
check(maximumDepthResult.kinds[0]?.code === "10", `XML element depth ${xmlLimits.maxElementDepth} must not be rejected solely for depth`);

for (const invalidCharacter of ["\u0001", "&#0;", "&#xD800;", "&#xFFFE;", "&#x110000;"]) {
  const response = `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters><Dataset id="output1"><Rows><Row><Col id="divCode">10</Col><Col id="divName">${invalidCharacter}</Col></Row></Rows></Dataset></Root>`;
  try {
    await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(response) });
    failures.push(`XML 1.0 character ${JSON.stringify(invalidCharacter)} must throw ${contract.expectations.formatError}`);
  } catch (error) {
    check(toolset.serializeError(error).code === contract.expectations.formatError, `invalid XML 1.0 character must throw ${contract.expectations.formatError}`);
  }
}
const invalidAttributeCharacterResponse = `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters><Dataset id="output1"><Rows><Row><Col id="divCode">10</Col><Col id="&#0;">ignored</Col><Col id="divName">국채</Col></Row></Rows></Dataset></Root>`;
try {
  await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(invalidAttributeCharacterResponse) });
  failures.push(`an invalid XML 1.0 attribute character must throw ${contract.expectations.formatError}`);
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.formatError, `an invalid XML 1.0 attribute character must throw ${contract.expectations.formatError}`);
}

for (const [fixtureName, expectedCode] of [
  ["unavailable", contract.expectations.unavailableError],
  ["invalidErrorCode", contract.expectations.formatError],
  ["malformed", contract.expectations.formatError],
  ["invalidNumeric", contract.expectations.formatError],
  ["missingColumn", contract.expectations.formatError]
]) {
  try {
    await toolset.execute("matrix", { baseDate: request.baseDate, kind: request.kind.name }, { fetch: fixtureFetch(fixtures[fixtureName]) });
    failures.push(`${fixtureName} fixture must throw ${expectedCode}`);
  } catch (error) {
    const serialized = toolset.serializeError(error);
    check(serialized.code === expectedCode, `${fixtureName} fixture must throw ${expectedCode}`);
    if (fixtureName === "invalidErrorCode") {
      check(serialized.reason.includes("invalid ErrorCode"), "invalidErrorCode fixture must fail on the malformed protocol status");
    }
  }
}

for (const fixtureName of ["protocolError", "protocolWarning"]) {
  const expected = contract.expectations.protocolStatuses[fixtureName];
  try {
    await toolset.execute("matrix", { baseDate: request.baseDate, kind: request.kind.name }, { fetch: fixtureFetch(fixtures[fixtureName]) });
    failures.push(`${fixtureName} fixture must throw ${contract.expectations.protocolError}`);
  } catch (error) {
    const serialized = toolset.serializeError(error);
    check(serialized.code === contract.expectations.protocolError, `${fixtureName} fixture must throw ${contract.expectations.protocolError}`);
    check(serialized.sourceErrorCode === expected.errorCode, `${fixtureName} fixture must preserve ErrorCode`);
    check(serialized.sourceErrorMessage === expected.errorMessage, `${fixtureName} fixture must preserve ErrorMsg`);
  }

  try {
    await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(fixtures[fixtureName]) });
    failures.push(`${fixtureName} kinds response must throw ${contract.expectations.protocolError}`);
  } catch (error) {
    const serialized = toolset.serializeError(error);
    check(serialized.code === contract.expectations.protocolError, `${fixtureName} kinds response must throw ${contract.expectations.protocolError}`);
    check(serialized.sourceErrorCode === expected.errorCode, `${fixtureName} kinds response must preserve ErrorCode`);
    check(serialized.sourceErrorMessage === expected.errorMessage, `${fixtureName} kinds response must preserve ErrorMsg`);
  }
}

for (const errorCode of ["00", "+0", "-0"]) {
  const signedZeroFixture = fixtures.matrix.replace('<Parameter id="ErrorCode">0</Parameter>', `<Parameter id="ErrorCode">${errorCode}</Parameter>`);
  const result = await toolset.execute("matrix", { baseDate: request.baseDate, kind: request.kind.name }, { fetch: fixtureFetch(signedZeroFixture) });
  check(result.rows[0]?.pricingGroupCode === contract.expectations.matrix.pricingGroupCode, `ErrorCode ${errorCode} must remain a successful status`);
}

for (const fixtureName of ["initMalformedMixed", "initMalformedAll"]) {
  try {
    await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(fixtures[fixtureName]) });
    failures.push(`${fixtureName} fixture must throw ${contract.expectations.formatError}`);
  } catch (error) {
    check(toolset.serializeError(error).code === contract.expectations.formatError, `${fixtureName} fixture must throw ${contract.expectations.formatError}`);
  }
}

try {
  await toolset.execute("matrix", { baseDate: request.baseDate, kind: request.kind.name }, { fetch: async () => { throw new TypeError("fixture transport failure"); } });
  failures.push("transport failure must throw source_transport_error");
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.transportError, "transport failure must remain distinct from unavailable, protocol, and malformed source data");
}

try {
  const failedStream = new ReadableStream({ pull() { throw new TypeError("fixture stream failure"); } });
  await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => Promise.resolve(new Response(failedStream, { status: 200 })) });
  failures.push("response stream failure must throw source_transport_error");
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.transportError, "response stream failure must throw source_transport_error");
}

try {
  await toolset.execute("kinds", { baseDate: request.baseDate }, { fetch: () => xmlResponse(fixtures.init, { status: 503 }) });
  failures.push("HTTP failure must throw source_transport_error");
} catch (error) {
  check(toolset.serializeError(error).code === contract.expectations.transportError, "HTTP failure must throw source_transport_error");
}

const fallbackResult = await toolset.execute("matrix", { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available", lookbackDays: 2 }, { fetch: fakeFallbackFetch });
check(fallbackResult.baseDate === "2026-06-05", "previous-available fallback must resolve to the first prior date with rows");
check(fallbackResult.requestedBaseDate === "2026-06-07", "fallback result must preserve requestedBaseDate");
check(fallbackResult.dateResolution.usedFallback === true, "fallback result must mark usedFallback");
check(fallbackResult.dateResolution.attemptedDates.join(",") === "2026-06-07,2026-06-06,2026-06-05", "fallback result must record attempted dates");
for (const fixtureName of ["protocolError", "protocolWarning"]) {
  const attemptedDates = [];
  try {
    await toolset.execute("matrix", { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available", lookbackDays: 2 }, { fetch: protocolFallbackFetch(fixtures[fixtureName], attemptedDates) });
    failures.push(`${fixtureName} must stop previous-available fallback`);
  } catch (error) {
    check(toolset.serializeError(error).code === contract.expectations.protocolError, `${fixtureName} must stop previous-available fallback with its protocol error`);
    check(attemptedDates.join(",") === "20260607", `${fixtureName} must not probe a prior date`);
  }
}
try {
  await toolset.execute("matrix", { baseDate: "2026-06-07", kind: "국채", fallback: "previous-available", lookbackDays: 1 }, { fetch: fakeUnavailableFetch });
  failures.push("exhausted fallback must throw source_data_unavailable");
} catch (error) {
  const serialized = toolset.serializeError(error);
  check(serialized.code === "source_data_unavailable", "exhausted fallback must preserve source_data_unavailable code");
  check(serialized.recoveryAction === "try_nearby_business_day", "exhausted fallback must not ask clients to repeat the same fallback action");
  check(serialized.attemptedDates?.join(",") === "2026-06-07,2026-06-06", "exhausted fallback must report all attempted dates");
}

const help = spawnSync(nodeCommand, ["dist/cli.js", "--help"], { encoding: "utf8" });
check(help.status === 0 && help.stdout.includes("matrix"), "CLI --help must succeed and list commands");
const bad = spawnSync(nodeCommand, ["dist/cli.js", "matrix", "--kind", "국채"], { encoding: "utf8" });
check(bad.status !== 0, "invalid CLI command must exit non-zero");
check(bad.stderr.includes("matrix") && bad.stderr.includes("10 = 국채"), "invalid CLI command must print command help to stderr");
try {
  const payload = JSON.parse(bad.stdout);
  check(payload.ok === false && payload.error?.code === "missing_parameter" && payload.error?.recoveryAction, "invalid CLI command must print one JSON failure object");
} catch {
  failures.push("invalid CLI command stdout must be JSON");
}
const list = spawnSync(nodeCommand, ["dist/cli.js", "kinds", "--format", "json"], { encoding: "utf8" });
check(list.status === 0, "safe kinds command must exit zero");
try {
  const payload = JSON.parse(list.stdout);
  check(payload.ok === true && payload.result?.kinds?.some((kind) => kind.name === "국채"), "kinds JSON result must include 국채");
} catch {
  failures.push("kinds stdout must be JSON");
}

function fakeFallbackFetch(url, init) {
  const body = String(init?.body || "");
  const date = /<Col id="calBaseDt">(\d+)<\/Col>/.exec(body)?.[1];
  if (String(url).endsWith("/rateInfo/ytmMatrixMobileInitList.do")) {
    return xmlResponse(fixtures.init);
  }
  return xmlResponse(date === "20260605" ? fixtures.matrix : fixtures.unavailable);
}

function fakeUnavailableFetch(url) {
  if (String(url).endsWith("/rateInfo/ytmMatrixMobileInitList.do")) {
    return xmlResponse(fixtures.init);
  }
  return xmlResponse(fixtures.unavailable);
}

function protocolFallbackFetch(protocolFixture, attemptedDates) {
  return (url, init) => {
    if (String(url).endsWith(initEndpoint)) {
      return xmlResponse(fixtures.init);
    }
    attemptedDates.push(/<Col id="calBaseDt">(\d+)<\/Col>/.exec(String(init?.body || ""))?.[1]);
    return xmlResponse(protocolFixture);
  };
}

function fixtureFetch(matrixFixture, capturedRequests = []) {
  return (url, init) => {
    const request = { url: String(url), body: String(init?.body || ""), signal: init?.signal };
    capturedRequests.push(request);
    return xmlResponse(request.url.endsWith(initEndpoint) ? fixtures.init : matrixFixture);
  };
}

function xmlResponse(xml, init = {}) {
  return byteResponse(utf8Encoder.encode(xml), init);
}

function byteResponse(bytes, init = {}) {
  return Promise.resolve(new Response(bytes, { status: init.status ?? 200, headers: init.headers }));
}

function concatBytes(...arrays) {
  const result = new Uint8Array(arrays.reduce((total, array) => total + array.byteLength, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.byteLength;
  }
  return result;
}

function xmlAtByteLength(xml, targetBytes) {
  const prefix = `${xml}<!--`;
  const suffix = "-->";
  const paddingBytes = targetBytes - utf8Encoder.encode(prefix + suffix).byteLength;
  if (paddingBytes < 0) throw new Error(`target XML byte length ${targetBytes} is too small`);
  return `${prefix}${"x".repeat(paddingBytes)}${suffix}`;
}

if (process.env.KISNET_SMOKE_NETWORK === "1") {
  const smoke = spawnSync(nodeCommand, ["dist/cli.js", "matrix", "--base-date", "2026-06-08", "--kind", "국채", "--format", "json"], { encoding: "utf8", timeout: 20000 });
  check(smoke.status === 0, `network smoke must exit zero: ${smoke.stderr || smoke.stdout}`);
  if (smoke.status === 0) {
    const payload = JSON.parse(smoke.stdout);
    check(payload.result.rows.length > 0, "network smoke must return at least one matrix row");
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("tool surface validation passed");
