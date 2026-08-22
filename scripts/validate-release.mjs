import { access, readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readYaml = async (path) => parse(await readFile(path, "utf8"));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const equal = (actual, expected, message) => {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
};
const findNamedStep = (job, name) => job?.steps?.find((step) => step.name === name);
const activeShell = (step) => typeof step?.run === "string"
  ? step.run.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).join("\n")
  : "";
const pathExists = (path) => access(path).then(() => true, () => false);

const [
  rootPackage,
  nodePackage,
  nativeTargets,
  bunLock,
  ciWorkflow,
  liveWorkflow,
  npmWorkflow,
  releasePleaseWorkflowPresent,
  releasePleaseConfigPresent,
  releasePleaseManifestPresent,
  pythonPackagePresent,
  pythonWorkflowPresent
] = await Promise.all([
  readJson("package.json"),
  readJson("packages/node/package.json"),
  readJson("native-targets.json"),
  readFile("bun.lock", "utf8"),
  readYaml(".github/workflows/ci.yml"),
  readYaml(".github/workflows/live-smoke.yml"),
  readYaml(".github/workflows/release.yml"),
  pathExists(".github/workflows/release-please.yml"),
  pathExists("release-please-config.json"),
  pathExists(".release-please-manifest.json"),
  pathExists("packages/python/pyproject.toml"),
  pathExists(".github/workflows/release-python.yml")
]);

check(rootPackage.private === true, "root package must remain private");
check(rootPackage.version === undefined, "root package must not become a release component");
equal(rootPackage.workspaces, ["packages/node", "packages/native/*"], "root workspaces must contain only the Node root and native packages");
check(nodePackage.name === "@sjunepark/ytm", "Node package identity must remain @sjunepark/ytm");
check(nodePackage.private !== true, "Node package must be publishable");
check(nodePackage.publishConfig?.access === "public", "Node package must retain public scoped publishing");
check(
  nodePackage.engines?.node === `>=${nativeTargets.minimumNodeMajor}`,
  "Node package engine must match the canonical native target policy"
);
check(nodePackage.repository?.url === "git+https://github.com/cpaikr/ytm.git" && nodePackage.repository?.directory === "packages/node", "Node package repository metadata must use cpaikr/ytm");
check(!nodePackage.dependencies?.["@xmldom/xmldom"], "legacy JavaScript XML dependencies must be absent");
const adapterSourceFiles = (await readdir("packages/node/src", { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
const packagedAdapterFiles = (nodePackage.files || [])
  .filter((path) => path.startsWith("dist/"))
  .map((path) => path.slice("dist/".length))
  .sort();
equal(packagedAdapterFiles, adapterSourceFiles, "every Node adapter source must have an explicitly packaged dist output");
const nodeLockWorkspace = parse(bunLock)?.workspaces?.["packages/node"];
check(nodeLockWorkspace?.name === nodePackage.name && nodeLockWorkspace?.version === nodePackage.version, "Bun lock must retain the Node workspace version");
check(!bunLock.includes("@xmldom/xmldom"), "Bun lock must not retain the legacy JavaScript XML parser");

const expectedOptionalDependencies = Object.fromEntries(nativeTargets.targets.map((target) => [target.packageName, nodePackage.version]));
equal(nodePackage.optionalDependencies, expectedOptionalDependencies, "root package optional dependencies must match the native target manifest");
for (const target of nativeTargets.targets) {
  const nativePackage = await readJson(`${nativeTargets.nativePackageRoot}/${target.packageDirectory}/package.json`);
  check(nativePackage.name === target.packageName, `${target.rustTarget} native package name must match the manifest`);
  check(nativePackage.version === nodePackage.version, `${target.rustTarget} native package version must match the root package`);
  check(nativePackage.main === target.artifactFile, `${target.rustTarget} native package artifact must match the manifest`);
  equal(nativePackage.files, [target.artifactFile, "LICENSE.md", "THIRD_PARTY_LICENSES.html"], `${target.rustTarget} native package files must contain the artifact and license notices`);
  equal(nativePackage.os, [target.npmPlatform], `${target.rustTarget} native package OS must match the target manifest`);
  equal(nativePackage.cpu, [target.npmArch], `${target.rustTarget} native package CPU must match the target manifest`);
  equal(nativePackage.libc, target.libc ? [target.libc] : undefined, `${target.rustTarget} native package libc must match the target manifest`);
  check(nativePackage.engines?.node === `>=${nativeTargets.minimumNodeMajor}`, `${target.rustTarget} native package engine must match the canonical policy`);
  check(await pathExists(`${nativeTargets.nativePackageRoot}/${target.packageDirectory}/LICENSE.md`), `${target.rustTarget} native package must ship the repository license`);
  check(await pathExists(`${nativeTargets.nativePackageRoot}/${target.packageDirectory}/THIRD_PARTY_LICENSES.html`), `${target.rustTarget} native package must ship third-party notices`);
}

check(!releasePleaseWorkflowPresent && !releasePleaseConfigPresent && !releasePleaseManifestPresent, "Release Please workflow and metadata must remain absent");
check(!pythonPackagePresent && !pythonWorkflowPresent, "Python product and publishing workflow must remain absent");
equal(Object.keys(ciWorkflow.jobs || {}), ["validate", "native-consumer"], "CI must contain only Node/Rust validation and native consumers");
equal(Object.keys(liveWorkflow.jobs || {}), ["node"], "live smoke must contain only the Node product");
check(ciWorkflow.jobs?.validate?.["timeout-minutes"] === 20, "CI validation must have a bounded timeout");
check(activeShell(findNamedStep(ciWorkflow.jobs?.validate, "Validate contracts, generated artifacts, and release configuration")).includes("bun run licenses:check"), "CI validation must check third-party notice freshness");
check(activeShell(findNamedStep(liveWorkflow.jobs?.node, "Run live smoke")).includes('process.stdin.setEncoding("utf8")'), "live smoke must decode streamed JSON as UTF-8");
const ciNativeJob = ciWorkflow.jobs?.["native-consumer"];
check(ciNativeJob?.["timeout-minutes"] === 20, "CI native consumers must have a bounded timeout");
equal(ciNativeJob?.strategy?.matrix?.node, nativeTargets.validationNodeMajors, "CI native consumers must cover every declared Node major");
equal(ciNativeJob?.strategy?.matrix?.target?.map(({ rust }) => rust), nativeTargets.targets.map(({ rustTarget }) => rustTarget), "CI native consumers must cover every supported target");
equal(ciNativeJob?.strategy?.matrix?.target?.map(({ runner }) => runner), nativeTargets.targets.map(({ runner }) => runner), "CI native consumers must use the manifest runners");
equal(ciNativeJob?.strategy?.matrix?.target?.map(({ arch }) => arch), nativeTargets.targets.map(({ npmArch }) => npmArch), "CI native consumers must use the manifest architectures");
check(activeShell(findNamedStep(ciNativeJob, "Build production native artifact")).includes("cargo build --locked --release"), "CI native consumers must build production artifacts");
check(activeShell(findNamedStep(ciNativeJob, "Assemble product packages")).includes("scripts/assemble-native-package.mjs"), "CI native consumers must assemble platform packages");
check(activeShell(findNamedStep(ciNativeJob, "Test clean installed CLI and toolset")).includes("scripts/test-native-consumer.mjs"), "CI native consumers must exercise clean installs");

check(!npmWorkflow.on?.push, "npm publishing must not trigger automatically from pushed tags");
check(npmWorkflow.on?.workflow_dispatch?.inputs?.tag?.required === true, "npm publishing must require an explicitly authorized tag input");
const metadataJob = npmWorkflow.jobs?.metadata;
const metadataCheckout = findNamedStep(metadataJob, "Check out source");
const metadataNode = findNamedStep(metadataJob, "Set up Node");
const metadataStep = findNamedStep(metadataJob, "Validate release metadata");
check(metadataJob?.["timeout-minutes"] === 30, "release metadata must have a bounded timeout");
check(metadataJob?.["runs-on"] === "ubuntu-24.04", "release metadata must run on a GitHub-hosted runner");
check(metadataCheckout?.with?.ref === "refs/tags/${{ inputs.tag }}" && metadataCheckout?.with?.["fetch-depth"] === 0 && metadataCheckout?.with?.["persist-credentials"] === false, "release metadata must check out the requested immutable tag without persisted credentials");
check(metadataNode?.with?.["node-version"] === 24 && metadataNode?.with?.["package-manager-cache"] === false, "release metadata must pin Node 24 without package-manager caching");
check(metadataStep?.env?.RELEASE_TAG === "${{ inputs.tag }}", "release metadata must receive the authorized tag as explicit input");
check(activeShell(metadataStep).includes('if [ "$GITHUB_REF" != "refs/heads/main" ]; then'), "release metadata must require dispatch from main");
check(activeShell(metadataStep).includes('if [ "$RELEASE_TAG" != "node-v$PACKAGE_VERSION" ]; then'), "release metadata must verify the requested Node tag and package version");
check(activeShell(metadataStep).includes('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main'), "release metadata must require the tag commit to be on main");
check(metadataJob?.outputs?.source_sha === "${{ steps.package.outputs.source_sha }}", "release metadata must expose the immutable source commit");

const nativeJob = npmWorkflow.jobs?.native_packages;
check(nativeJob?.["timeout-minutes"] === 30, "release native packages must have a bounded timeout");
equal(nativeJob?.strategy?.matrix?.target?.map(({ rust }) => rust), nativeTargets.targets.map(({ rustTarget }) => rustTarget), "release native matrix must match the target manifest");
equal(nativeJob?.strategy?.matrix?.target?.map(({ runner }) => runner), nativeTargets.targets.map(({ runner }) => runner), "release native matrix must use the manifest runners");
equal(nativeJob?.strategy?.matrix?.target?.map(({ runner }) => runner), ["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15", "windows-2025"], "release native packages must build on the approved GitHub-hosted runners");
check(findNamedStep(nativeJob, "Check out immutable release source")?.with?.ref === "${{ needs.metadata.outputs.source_sha }}", "native builds must use the immutable release commit");
check(activeShell(findNamedStep(nativeJob, "Assemble and pack native package")).includes("scripts/assemble-native-package.mjs"), "native release jobs must assemble generated packages");
check(activeShell(findNamedStep(nativeJob, "Assemble and pack native package")).includes("scripts/test-native-consumer.mjs"), "native release jobs must clean-install their exact artifacts before upload");

const rootJob = npmWorkflow.jobs?.root_package;
check(rootJob?.["timeout-minutes"] === 30, "release root package must have a bounded timeout");
check(rootJob?.["runs-on"] === "ubuntu-24.04", "release root package must build on a GitHub-hosted runner");
check(findNamedStep(rootJob, "Check out immutable release source")?.with?.ref === "${{ needs.metadata.outputs.source_sha }}", "root package validation must use the immutable release commit");
check(activeShell(findNamedStep(rootJob, "Pack root package without a native binary")).includes("build:facade"), "root release artifact must be packed without a native binary");

const publishJob = npmWorkflow.jobs?.publish;
check(publishJob?.["timeout-minutes"] === 30, "npm publishing must have a bounded timeout");
equal(publishJob?.needs, ["metadata", "native_packages", "root_package"], "publishing must wait for metadata and all assembled packages");
check(publishJob?.["runs-on"] === "ubuntu-latest", "npm trusted publishing must use a GitHub-hosted runner");
check(publishJob?.environment?.name === "npm", "npm publishing must use the npm environment");
check(publishJob?.permissions?.contents === "read" && publishJob?.permissions?.["id-token"] === "write", "npm publishing must retain read contents and OIDC permissions");
check(findNamedStep(publishJob, "Check out immutable release source")?.with?.ref === "${{ needs.metadata.outputs.source_sha }}", "publishing preflight must use the immutable release source");
check(activeShell(findNamedStep(publishJob, "Validate complete release artifact set")) === "node scripts/validate-release-artifacts.mjs dist/native dist/root", "publishing must validate the complete artifact set before npm publish");
const registryPreflight = activeShell(findNamedStep(publishJob, "Reject an already-published version"));
check(registryPreflight.includes("npm view") && registryPreflight.includes("E404") && registryPreflight.includes("Could not prove"), "publishing must reject existing versions and fail closed on registry errors before the first publish");
const publishShell = activeShell(findNamedStep(publishJob, "Publish native packages, then root package"));
check(publishShell.includes("for tarball in dist/native/*.tgz") && publishShell.indexOf("dist/native/*.tgz") < publishShell.indexOf("root_tarball="), "all native packages must publish before the root package");
check(!publishShell.includes("npm view") && !publishShell.includes("skipping"), "publishing must not repair a partial version in place");

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Node-only release configuration is valid at ${nodePackage.version}`);
