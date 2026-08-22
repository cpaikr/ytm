import { readFile } from "node:fs/promises";
import { Validator } from "@seriousme/openapi-schema-validator";
import { parseDocument } from "yaml";

const failures = [];

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

const evidence = JSON.parse(await readFile(new URL("../contracts/kisnet/cases.json", import.meta.url), "utf8"));
equal(Object.keys(evidence), ["schemaVersion", "requestExample", "expectedTenors", "fixtures", "xmlCases", "expectations"], "evidence manifest must not become a second wire authority");
check(!("initEndpoint" in (evidence.requestExample || {})) && !("matrixEndpoint" in (evidence.requestExample || {})), "evidence examples must not own endpoint paths");
check(!("xmlLimits" in evidence), "evidence manifest must not own parser or transport limits");

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

for (const relativePath of ["../packages/node/src/toolset.js", "../packages/node/src/cli.js", "../packages/node/src/native.js", "../packages/node/src/native.cjs"]) {
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
check(repositorySkill === packagedSkill, "the repository and packaged KIS-NET skills must remain identical");
check(!repositorySkill.includes("Python") && repositorySkill.includes("80` 회사채(사모)"), "the active skill must be Node-only and include canonical kind 80");

const nativeTargets = JSON.parse(await readFile(new URL("../native-targets.json", import.meta.url), "utf8"));
const nodePackage = JSON.parse(await readFile(new URL("../packages/node/package.json", import.meta.url), "utf8"));
check(nativeTargets.schemaVersion === 2, "native target manifest schemaVersion must be 2");
check(nativeTargets.supportClaim === "supported", "native targets must record the clean-install support decision");
check(Number.isInteger(nativeTargets.minimumNodeMajor) && nativeTargets.minimumNodeMajor > 0, "minimum Node major must be a positive integer");
check(nodePackage.engines?.node === `>=${nativeTargets.minimumNodeMajor}`, "Node package engine must match the canonical runtime policy");
check(nativeTargets.validationNodeMajors?.[0] === nativeTargets.minimumNodeMajor, "Node validation must begin with the minimum supported major");
check(nativeTargets.validationNodeMajors?.every((major) => Number.isInteger(major) && major >= nativeTargets.minimumNodeMajor), "Node validation majors must stay within the supported range");
const expectedRustTargets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc"
];
equal(nativeTargets.targets?.map(({ rustTarget }) => rustTarget), expectedRustTargets, "native release target selection must stay explicit");
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
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("wire authority, evidence boundary, and native target selection are valid");
