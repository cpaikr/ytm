import { access, readFile, readdir } from "node:fs/promises";
import { Validator } from "@seriousme/openapi-schema-validator";
import { parseDocument } from "yaml";
import { isNodeCliArtifact } from "./node-cli-artifact-policy.mjs";
import { nativeBuildPlan } from "./native-build-policy.mjs";

const failures = [];

try {
  await access(new URL("../judge/scenarios.json", import.meta.url));
  failures.push("judge/scenarios.json must remain absent; executable judge coverage belongs in judge/run.mjs");
} catch (error) {
  if (error?.code !== "ENOENT") failures.push(`judge/scenarios.json could not be checked: ${error.message}`);
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const openapiText = await readFile(new URL("../contracts/kisnet/openapi.yaml", import.meta.url), "utf8");
const schemaValidation = await new Validator().validate(openapiText);
if (!schemaValidation.valid) {
  const errors = typeof schemaValidation.errors === "string" ? [schemaValidation.errors] : schemaValidation.errors;
  for (const error of errors || []) {
    failures.push(`OpenAPI 3.1 schema: ${error.instancePath || "/"} ${error.message || String(error)}`);
  }
}
const document = parseDocument(openapiText, { prettyErrors: true, strict: true, uniqueKeys: true });
for (const error of document.errors) failures.push(`OpenAPI YAML: ${error.message}`);
const contract = document.toJS();

check(contract?.openapi === "3.1.0", "OpenAPI contract must declare version 3.1.0");
equal(contract?.servers, [{ url: "https://kis-net.kr", description: "Observed KIS-NET mobile source origin" }], "OpenAPI must allow exactly one source origin");
check(contract?.["x-ytm-authority"]?.role === "sole-external-http-wire-authority", "OpenAPI must declare its wire-authority role");

const expectedOperations = [
  {
    path: "/rateInfo/ytmMatrixMobileInitList.do",
    operationId: "initializeYtmMatrix",
    serviceId: "search",
    outDatasets: "ds_tymSort=output1 ds_list=output2",
    selectedDataset: "output1",
    rowSchema: "#/components/schemas/KindRow",
    searchKind: { value: "10" }
  },
  {
    path: "/rateInfo/ytmMatrixMobileList.do",
    operationId: "listYtmMatrix",
    serviceId: "search1",
    outDatasets: "ds_list=output1",
    selectedDataset: "output1",
    rowSchema: "#/components/schemas/MatrixRow",
    searchKind: { valueFrom: "sourceKindCode" }
  }
];
equal(Object.keys(contract?.paths || {}), expectedOperations.map(({ path }) => path), "OpenAPI paths must remain narrow and ordered");
for (const expected of expectedOperations) {
  const pathItem = contract?.paths?.[expected.path];
  equal(Object.keys(pathItem || {}), ["post"], `${expected.path} must expose POST only`);
  const operation = pathItem?.post;
  check(operation?.operationId === expected.operationId, `${expected.path} must preserve operationId ${expected.operationId}`);
  check(operation?.requestBody?.required === true, `${expected.path} request body must be required`);
  equal(Object.keys(operation?.requestBody?.content || {}), ["text/xml; charset=UTF-8"], `${expected.path} request media type must be exact`);
  equal(Object.keys(operation?.responses || {}), ["200", "default"], `${expected.path} must distinguish HTTP 200 from all transport failures`);
  const request = operation?.["x-ytm-nexacro-request"];
  check(request?.serviceId === expected.serviceId, `${expected.path} must preserve serviceId ${expected.serviceId}`);
  check(request?.endpoint === expected.path, `${expected.path} request projection must preserve its endpoint`);
  check(request?.inDatasets === "ds_search=ds_search gds_tranInfo=gds_tranInfo", `${expected.path} must preserve both input datasets`);
  check(request?.outDatasets === expected.outDatasets, `${expected.path} must preserve its output mapping`);
  equal(request?.search?.orderedColumns, [
    { id: "pageIndex", type: "STRING", size: 256, value: "1" },
    { id: "pageSize", type: "STRING", size: 256, value: "10" },
    { id: "pageUnit", type: "STRING", size: 256, value: "10" },
    { id: "calBaseDt", type: "STRING", size: 256, valueFrom: "baseDateCompact" },
    { id: "cboYtmSort", type: "STRING", size: 256, ...expected.searchKind }
  ], `${expected.path} must preserve exact ordered search columns`);
  equal(request?.transaction?.orderedColumns, [
    { id: "svcID", type: "STRING", size: 32, value: expected.serviceId },
    { id: "URL", type: "STRING", size: 32, value: expected.path },
    { id: "inDatasets", type: "STRING", size: 32, value: "ds_search=ds_search gds_tranInfo=gds_tranInfo" },
    { id: "outDatasets", type: "STRING", size: 32, value: expected.outDatasets },
    { id: "browserType", type: "STRING", size: 32, value: "Chrome" }
  ], `${expected.path} must preserve exact ordered transaction columns`);
  const response = operation?.["x-ytm-nexacro-response"];
  check(response?.selectedDataset === expected.selectedDataset, `${expected.path} must select ${expected.selectedDataset}`);
  check(response?.rowSchema === expected.rowSchema, `${expected.path} must preserve its open row schema`);
  check(response?.emptyRows === "source-data-unavailable", `${expected.path} must classify an empty selected dataset explicitly`);
}

const profile = contract?.["x-ytm-nexacro-profile"];
check(profile?.namespace === "http://www.nexacroplatform.com/platform/dataset", "Nexacro namespace must be explicit");
check(profile?.response?.xmlVersion === "1.0", "responses must remain XML 1.0");
check(profile?.response?.encoding === "UTF-8", "responses must remain strict UTF-8");
check(profile?.response?.maxDecompressedBodyBytes === 1_048_576, "response byte limit must remain 1 MiB decompressed");
check(profile?.response?.maxElementDepth === 64 && profile?.response?.rootDepth === 1, "response depth boundary must remain 64 with root at depth 1");
check(profile?.response?.doctype === "forbidden" && profile?.response?.externalResourceResolution === "forbidden", "DTD and external resource handling must remain fail-closed");
check(profile?.response?.parameters?.ErrorCode?.cardinality === "exactly-one", "Nexacro ErrorCode must be singular and required");
check(profile?.response?.directChildRules?.columnInfo === "allowed-and-ignored", "response ColumnInfo metadata must remain non-authoritative");
equal(profile?.response?.interpretationOrder, ["transport-and-body-bounds", "xml-well-formedness-and-profile", "protocol-status", "selected-dataset"], "protocol status must precede selected-dataset interpretation");
check(profile?.request?.declaration === "required" && profile?.request?.bom === "forbidden", "request XML declaration and BOM policy must remain exact");
check(profile?.request?.directChildRules?.columns === "exact-order-matching-column-info", "request serialization must preserve exact column order");
check(profile?.transport?.requestHeaders?.Accept === "text/xml, */*", "request Accept header must remain exact");
check(profile?.transport?.requestDeadlineMilliseconds === 20_000, "request deadline must remain bounded at 20 seconds");
check(profile?.transport?.redirects === "forbidden", "redirects must remain forbidden");
check(profile?.transport?.automaticRetries === 0, "transport retries must remain disabled");

const responseContentTypePattern = contract?.components?.responses?.NexacroResponse?.headers?.["Content-Type"]?.schema?.pattern;
const responseContentType = new RegExp(responseContentTypePattern);
for (const value of ["text/xml; charset=UTF-8", "TEXT/XML ; CHARSET = utf-8"]) {
  check(responseContentType.test(value), `response Content-Type schema must accept ${value}`);
}
for (const value of ["text/xml", "text/html; charset=UTF-8", "text/xml; charset=UTF-8; vendor=x"]) {
  check(!responseContentType.test(value), `response Content-Type schema must reject ${value}`);
}

const requiredMatrixColumns = [
  "pricingGroupCode", "pricingGroupName", "m3", "m6", "m9", "y1", "y15a", "y2", "y25", "y3", "y5", "y7", "y10", "y15", "y20", "y30", "y50"
];
equal(contract?.components?.schemas?.MatrixRow?.required, requiredMatrixColumns, "matrix wire columns must remain complete and ordered");
check(contract?.components?.schemas?.KindRow?.additionalProperties?.type === "string", "kind rows must stay open to unknown source columns");
check(contract?.components?.schemas?.MatrixRow?.additionalProperties?.type === "string", "matrix rows must stay open to unknown source columns");
const yieldCellPattern = new RegExp(contract?.components?.schemas?.YieldCell?.pattern);
for (const value of ["2.500", "   2.500", " +.5", "-", ""]) {
  check(yieldCellPattern.test(value), `YieldCell must accept ${JSON.stringify(value)}`);
}
for (const value of ["2.500 ", " 2 .500", "\t2.500", "\u00a02.500", " -", "   ", "1e3", "NaN"]) {
  check(!yieldCellPattern.test(value), `YieldCell must reject ${JSON.stringify(value)}`);
}

const evidenceText = await readFile(new URL("../contracts/kisnet/cases.json", import.meta.url), "utf8");
let evidence = {};
try {
  evidence = JSON.parse(evidenceText);
} catch (error) {
  failures.push(`Evidence JSON: ${error.message}`);
}
const evidenceDocument = parseDocument(evidenceText, { prettyErrors: true, strict: true, uniqueKeys: true });
for (const error of evidenceDocument.errors) failures.push(`Evidence JSON keys: ${error.message}`);

equal(Object.keys(evidence), ["schemaVersion", "requestExample", "expectedTenors", "fixtures", "xmlCases", "expectations"], "evidence manifest must not become a second wire authority");
check(evidence.schemaVersion === 1, "evidence manifest schemaVersion must be 1");
check(!("initEndpoint" in (evidence.requestExample || {})) && !("matrixEndpoint" in (evidence.requestExample || {})), "evidence examples must not own endpoint paths");
check(!("xmlLimits" in evidence), "evidence manifest must not own parser or transport limits");

const fixtureEntries = Object.entries(evidence.fixtures || {});
const declaredFixtureFiles = fixtureEntries.map(([, file]) => file);
for (const [name, file] of fixtureEntries) {
  check(typeof file === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.xml$/.test(file), `fixture ${name} must name one XML file in contracts/kisnet`);
}
check(new Set(declaredFixtureFiles).size === declaredFixtureFiles.length, "every XML fixture file must be declared exactly once");
const fixtureDirectoryEntries = await readdir(new URL("../contracts/kisnet/", import.meta.url), { withFileTypes: true });
const xmlEntries = fixtureDirectoryEntries.filter(({ name }) => name.endsWith(".xml"));
for (const entry of xmlEntries) check(entry.isFile(), `fixture ${entry.name} must be a regular file`);
equal(
  [...new Set(declaredFixtureFiles)].sort(),
  xmlEntries.map(({ name }) => name).sort(),
  "cases.json fixtures must declare every contracts/kisnet XML file exactly once"
);

for (const expected of expectedOperations) {
  const operation = contract?.paths?.[expected.path]?.post;
  const requestProjection = operation?.["x-ytm-nexacro-request"];
  const example = operation?.requestBody?.content?.["text/xml; charset=UTF-8"]?.example;
  check(
    example === serializeRequestExample(requestProjection, evidence.requestExample),
    `${expected.path} request example must be the exact serialization of its x-ytm-nexacro-request projection`
  );
}

for (const relativePath of ["../SPEC.md", "../packages/node/SPEC.md", "../packages/node/README.md"]) {
  const text = await readFile(new URL(relativePath, import.meta.url), "utf8");
  for (const forbidden of [
    "/rateInfo/ytmMatrixMobileInitList.do",
    "/rateInfo/ytmMatrixMobileList.do",
    "http://www.nexacroplatform.com/platform/dataset",
    "1,048,576"
  ]) {
    check(!text.includes(forbidden), `${relativePath} must link the OpenAPI authority instead of restating ${forbidden}`);
  }
}

for (const relativePath of ["../packages/node/src/toolset.js", "../packages/node/src/native.js", "../packages/node/src/native.cjs"]) {
  const text = await readFile(new URL(relativePath, import.meta.url), "utf8");
  for (const forbidden of [
    "https://kis-net.kr",
    "/rateInfo/",
    "nexacroplatform.com",
    "ds_search",
    "gds_tranInfo",
    "cboYtmSort",
    "text/xml"
  ]) {
    check(!text.includes(forbidden), `${relativePath} must remain a wire-ignorant Node adapter; found ${forbidden}`);
  }
}

const repositorySkill = await readFile(new URL("../skills/kisnet-ytm/SKILL.md", import.meta.url), "utf8");
const packagedSkill = await readFile(new URL("../packages/node/skills/kisnet-ytm/SKILL.md", import.meta.url), "utf8");
const nodeReadme = await readFile(new URL("../packages/node/README.md", import.meta.url), "utf8");
check(!repositorySkill.includes("Python") && repositorySkill.includes("ytm matrix") && repositorySkill.includes("80` 회사채(사모)"), "the repository skill must cover the active Rust CLI and canonical kind 80");
check(packagedSkill.includes("@sjunepark/ytm/toolset") && !packagedSkill.includes("ytm matrix") && !packagedSkill.includes("package-provided"), "the packaged Node skill must describe the SDK without claiming a CLI");
for (const [label, example] of [
  ["repository skill", repositorySkill],
  ["packaged skill", packagedSkill],
  ["Node README", nodeReadme]
]) {
  check(example.includes("validation.ok") && example.includes("validation.input"), `${label} must use the current validation result contract`);
  check(!example.includes("validation.valid") && !example.includes("validation.normalizedInput"), `${label} must not use the retired validation result contract`);
}

for (const path of [
  "package/dist/cli.js",
  "cli.d.ts",
  "cli.mts",
  "cli.cts",
  "cli.d.mts",
  "cli.d.cts",
  "src/ytm-cli.js",
  "package/bin/ytm.js",
  "package/bin/sub/tool"
]) {
  check(isNodeCliArtifact(path), `the Node CLI artifact guard must reject ${path}`);
}
for (const path of ["dist/toolset.js", "src/client.js", "skills/kisnet-ytm/SKILL.md"]) {
  check(!isNodeCliArtifact(path), `the Node CLI artifact guard must allow ${path}`);
}

const nativeTargets = JSON.parse(await readFile(new URL("../native-targets.json", import.meta.url), "utf8"));
const nodePackage = JSON.parse(await readFile(new URL("../packages/node/package.json", import.meta.url), "utf8"));
check(nativeTargets.schemaVersion === 3, "native target manifest schemaVersion must be 3");
check(nativeTargets.supportClaim === "supported", "native targets must record the clean-install support decision");
check(Number.isInteger(nativeTargets.minimumNodeMajor) && nativeTargets.minimumNodeMajor > 0, "minimum Node major must be a positive integer");
check(nodePackage.engines?.node === `>=${nativeTargets.minimumNodeMajor}`, "Node package engine must match the canonical runtime policy");
check(nativeTargets.validationNodeMajors?.[0] === nativeTargets.minimumNodeMajor, "Node validation must begin with the minimum supported major");
check(nativeTargets.validationNodeMajors?.every((major) => Number.isInteger(major) && major >= nativeTargets.minimumNodeMajor), "Node validation majors must stay within the supported range");
equal(nativeTargets.linuxNativeBuild, {
  cargoZigbuildVersion: "0.23.0",
  zigVersion: "0.14.1",
  glibcFloor: "2.28",
  zigArchives: {
    x86_64: {
      url: "https://ziglang.org/download/0.14.1/zig-x86_64-linux-0.14.1.tar.xz",
      sha256: "24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c"
    },
    aarch64: {
      url: "https://ziglang.org/download/0.14.1/zig-aarch64-linux-0.14.1.tar.xz",
      sha256: "f7a654acc967864f7a050ddacfaa778c7504a0eca8d2b678839c21eea47c992b"
    }
  }
}, "Linux native builds must pin cargo-zigbuild, Zig archives, and the glibc floor");
const expectedRustTargets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc"
];
equal(nativeTargets.targets?.map(({ rustTarget }) => rustTarget), expectedRustTargets, "native release target selection must stay explicit");
equal(nativeTargets.targets?.map(({ buildTarget }) => buildTarget), [
  "x86_64-unknown-linux-gnu.2.28",
  "aarch64-unknown-linux-gnu.2.28",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc"
], "native build targets must preserve the explicit Linux glibc floor");
equal(nativeTargets.targets?.map(({ runner }) => runner), [
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "macos-15",
  "windows-2025"
], "native targets must use GitHub-hosted runners for every supported platform");
check(nativeTargets.rootPackage === "packages/node", "native packaging must name the active root package");
check(nativeTargets.nativePackageRoot === "packages/native", "native packaging must name the active native package root");
check(new Set(nativeTargets.targets?.map(({ packageName }) => packageName)).size === expectedRustTargets.length, "every native target must have a unique npm package");
check(new Set(nativeTargets.targets?.map(({ artifactFile }) => artifactFile)).size === expectedRustTargets.length, "every native target must have a unique artifact filename");
check(new Set(nativeTargets.targets?.map((target) => [target.npmPlatform, target.npmArch, target.libc || ""].join("-"))).size === expectedRustTargets.length, "every native target must have a unique runtime platform/architecture/libc key");
for (const target of nativeTargets.targets || []) {
  check(target.packageName?.startsWith("@sjunepark/ytm-"), `${target.rustTarget} must use the ytm npm scope`);
  check(target.artifactFile?.endsWith(".node"), `${target.rustTarget} must name a Node-API artifact`);
  const plan = nativeBuildPlan(nativeTargets, target.rustTarget);
  check(plan.artifactTarget === target.rustTarget, `${target.rustTarget} native assembly must use its exact Cargo artifact target`);
  check(
    target.npmPlatform === "linux" && target.libc === "glibc"
      ? plan.args[0] === "zigbuild" && plan.args[4] === target.buildTarget && target.buildTarget.endsWith(`.${nativeTargets.linuxNativeBuild.glibcFloor}`)
      : plan.args[0] === "build" && target.buildTarget === target.rustTarget,
    `${target.rustTarget} native build must use the declared target policy`
  );
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("wire authority, evidence boundary, and native target selection are valid");

function serializeRequestExample(request, requestExample) {
  if (!request?.search?.orderedColumns || !request?.transaction?.orderedColumns) return undefined;
  const projectedValues = {
    baseDateCompact: requestExample?.baseDateCompact,
    sourceKindCode: requestExample?.kind?.code
  };
  const datasets = [
    [request.search.dataset, request.search.orderedColumns],
    [request.transaction.dataset, request.transaction.orderedColumns]
  ];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Root xmlns="http://www.nexacroplatform.com/platform/dataset">',
    '  <Parameters/>'
  ];
  for (const [dataset, columns] of datasets) {
    lines.push(`  <Dataset id="${escapeXml(dataset)}">`, "    <ColumnInfo>");
    for (const column of columns) {
      lines.push(`      <Column id="${escapeXml(column.id)}" type="${escapeXml(column.type)}" size="${escapeXml(column.size)}"/>`);
    }
    lines.push("    </ColumnInfo>", "    <Rows><Row>");
    for (const column of columns) {
      const value = Object.hasOwn(column, "value") ? column.value : projectedValues[column.valueFrom];
      lines.push(`      <Col id="${escapeXml(column.id)}">${escapeXml(value)}</Col>`);
    }
    lines.push("    </Row></Rows>", "  </Dataset>");
  }
  lines.push("</Root>");
  return lines.join("\n");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
