import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { isNodeCliArtifact } from "./node-cli-artifact-policy.mjs";
import { nativeBuildPlan } from "./native-build-policy.mjs";
import { cliArchiveName, cliBuildPlan, validateCliManifest } from "./cli-release-policy.mjs";

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
const listFiles = async (directory, prefix = "") => (await Promise.all(
  (await readdir(directory, { withFileTypes: true })).map((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(resolve(directory, entry.name), relative);
    return entry.isFile() ? [relative] : [];
  })
)).flat();

const [
  rootPackage,
  nodePackage,
  nativeTargets,
  cliTargets,
  bunLock,
  ciWorkflow,
  liveWorkflow,
  npmWorkflow,
  releasePleaseWorkflow,
  pythonPackagePresent,
  pythonWorkflowPresent
] = await Promise.all([
  readJson("package.json"),
  readJson("packages/node/package.json"),
  readJson("native-targets.json"),
  readJson("cli-targets.json"),
  readFile("bun.lock", "utf8"),
  readYaml(".github/workflows/ci.yml"),
  readYaml(".github/workflows/live-smoke.yml"),
  readYaml(".github/workflows/release.yml"),
  readYaml(".github/workflows/release-please.yml"),
  pathExists("packages/python/pyproject.toml"),
  pathExists(".github/workflows/release-python.yml")
]);

check(rootPackage.private === true, "root package must remain private");
check(rootPackage.version === undefined, "root package must not become a release component");
equal(rootPackage.workspaces, ["packages/node", "packages/native/*"], "root workspaces must contain only the Node root and native packages");
check(nodePackage.name === "@sjunepark/ytm", "Node package identity must remain @sjunepark/ytm");
check(nodePackage.bin === undefined, "Node package must not own or distribute a CLI bin");
check(nodePackage.private !== true, "Node package must be publishable");
check(nodePackage.publishConfig?.access === "public", "Node package must retain public scoped publishing");
check(
  nodePackage.engines?.node === `>=${nativeTargets.minimumNodeMajor}`,
  "Node package engine must match the canonical native target policy"
);
check(nativeTargets.schemaVersion === 3, "native release policy must use the glibc-floor manifest schema");
check(nativeTargets.linuxNativeBuild?.cargoZigbuildVersion === "0.23.0", "native release policy must pin cargo-zigbuild 0.23.0");
check(nativeTargets.linuxNativeBuild?.zigVersion === "0.14.1", "native release policy must pin Zig 0.14.1");
check(nativeTargets.linuxNativeBuild?.glibcFloor === "2.28", "native release policy must retain the GLIBC_2.28 floor");
try {
  validateCliManifest(cliTargets, nativeTargets.linuxNativeBuild);
} catch (error) {
  check(false, `CLI release target policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
}
const expectedCliTargets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc"
];
equal(cliTargets.targets?.map(({ rustTarget }) => rustTarget), expectedCliTargets, "CLI support targets must remain explicit");
check(new Set(cliTargets.targets?.map((target) => cliArchiveName(cliTargets, target, nodePackage.version))).size === expectedCliTargets.length, "CLI targets must derive unique archive names");
for (const target of cliTargets.targets || []) {
  let plan;
  try {
    plan = cliBuildPlan(cliTargets, nativeTargets.linuxNativeBuild, target.rustTarget);
  } catch (error) {
    check(false, `${target.rustTarget} CLI build policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  check(plan.args.at(-1) === "ytm-cli", `${target.rustTarget} CLI build must select ytm-cli`);
  check(plan.artifactTarget === target.rustTarget, `${target.rustTarget} CLI artifact must use its exact Rust target directory`);
  check(plan.usesGlibcFloor ? plan.buildTarget === `${target.rustTarget}.${nativeTargets.linuxNativeBuild.glibcFloor}` : plan.buildTarget === target.rustTarget, `${target.rustTarget} CLI build target must match the shared Linux policy`);
  const overlappingNative = nativeTargets.targets.find((candidate) => candidate.rustTarget === target.rustTarget);
  if (overlappingNative) {
    check(overlappingNative.runner === target.runner, `${target.rustTarget} shared runner fact must agree across Node and CLI targets`);
    check(overlappingNative.npmArch === target.arch, `${target.rustTarget} shared architecture fact must agree across Node and CLI targets`);
  }
}
for (const target of nativeTargets.targets || []) {
  let plan;
  try {
    plan = nativeBuildPlan(nativeTargets, target.rustTarget);
  } catch (error) {
    check(false, `${target.rustTarget} release build policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  check(plan.artifactTarget === target.rustTarget, `${target.rustTarget} release assembly must use the exact Cargo artifact target`);
  check(typeof plan.artifactFileName === "string" && plan.artifactFileName.length > 0, `${target.rustTarget} release build must expose its platform artifact filename`);
  check(target.npmPlatform === "linux" && target.libc === "glibc" ? plan.args[0] === "zigbuild" : plan.args[0] === "build", `${target.rustTarget} release build command must match its target policy`);
}
check(nodePackage.repository?.url === "git+https://github.com/cpaikr/ytm.git" && nodePackage.repository?.directory === "packages/node", "Node package repository metadata must use cpaikr/ytm");
check(!nodePackage.dependencies?.["@xmldom/xmldom"], "legacy JavaScript XML dependencies must be absent");
const adapterSourceFiles = (await readdir("packages/node/src", { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
const nodeCliFiles = [
  ...(await listFiles("packages/node/src", "src")),
  ...(await pathExists("packages/node/dist") ? await listFiles("packages/node/dist", "dist") : []),
  ...(nodePackage.files || [])
].filter(isNodeCliArtifact);
check(nodeCliFiles.length === 0, `Node package must not retain JavaScript CLI source or distribution files: ${nodeCliFiles.join(", ")}`);
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

equal(Object.keys(releasePleaseWorkflow.jobs || {}), ["release_pr"], "Release Please workflow must only prepare the product release PR");
check(releasePleaseWorkflow.on?.push?.branches?.includes("main"), "Release Please must update release PRs from main");
check(releasePleaseWorkflow.on?.workflow_dispatch !== undefined, "Release Please must support an explicit preparation retry");
check(releasePleaseWorkflow.permissions?.contents === "read", "Release Please workflow default permissions must remain read-only");
const releasePleaseJob = releasePleaseWorkflow.jobs?.release_pr;
check(releasePleaseJob?.if === "${{ vars.RELEASE_PLEASE_ENABLED == 'true' }}", "Release Please must remain externally disabled until release preparation is authorized");
check(releasePleaseJob?.["runs-on"] === "ubuntu-24.04" && releasePleaseJob?.["timeout-minutes"] === 10, "Release Please must use a pinned GitHub-hosted runner with a bounded timeout");
check(releasePleaseJob?.permissions?.contents === "write" && releasePleaseJob?.permissions?.issues === "write" && releasePleaseJob?.permissions?.["pull-requests"] === "write", "Release Please job permissions must be explicit and sufficient for release PRs");
const releasePleaseStep = findNamedStep(releasePleaseJob, "Create or update the product release PR");
check(/^googleapis\/release-please-action@[0-9a-f]{40}$/.test(releasePleaseStep?.uses || ""), "Release Please action must be pinned to a full commit SHA");
check(releasePleaseStep?.with?.token === "${{ secrets.RELEASE_PLEASE_TOKEN }}", "Release Please must use the configured automation credential so release PR checks run");
check(releasePleaseStep?.with?.["config-file"] === "release-please-config.json" && releasePleaseStep?.with?.["manifest-file"] === ".release-please-manifest.json", "Release Please must use the repository-owned product config and manifest");
check(releasePleaseStep?.with?.["skip-github-release"] === true, "Release preparation must not create a tag or GitHub Release before the protected release workflow");
check(!pythonPackagePresent && !pythonWorkflowPresent, "Python product and publishing workflow must remain absent");
equal(Object.keys(ciWorkflow.jobs || {}), ["validate", "cli-metadata", "cli-archive", "cli-artifact-set", "native-consumer"], "CI must contain validation, CLI artifacts, and native consumers only");
equal(Object.keys(liveWorkflow.jobs || {}), ["rust-cli"], "live smoke must exercise only the standalone Rust CLI");
check(ciWorkflow.jobs?.validate?.["timeout-minutes"] === 20, "CI validation must have a bounded timeout");
check(liveWorkflow.jobs?.["rust-cli"]?.["timeout-minutes"] === 20, "live smoke must have a bounded timeout");
check(activeShell(findNamedStep(ciWorkflow.jobs?.validate, "Validate contracts, generated artifacts, and release configuration")).includes("bun run licenses:check"), "CI validation must check third-party notice freshness");
const liveSmoke = activeShell(findNamedStep(liveWorkflow.jobs?.["rust-cli"], "Run live smoke"));
check(liveSmoke.includes('target/debug/ytm matrix') && liveSmoke.includes("--fallback previous-available") && liveSmoke.includes("jq -e"), "live smoke must use bounded fallback through the standalone Rust CLI");
const ciNativeJob = ciWorkflow.jobs?.["native-consumer"];
const linuxNativeCondition = "matrix.target.rust == 'x86_64-unknown-linux-gnu' || matrix.target.rust == 'aarch64-unknown-linux-gnu'";
check(ciNativeJob?.["timeout-minutes"] === 20, "CI native consumers must have a bounded timeout");
equal(ciNativeJob?.strategy?.matrix?.node, nativeTargets.validationNodeMajors, "CI native consumers must cover every declared Node major");
equal(ciNativeJob?.strategy?.matrix?.target?.map(({ rust }) => rust), nativeTargets.targets.map(({ rustTarget }) => rustTarget), "CI native consumers must cover every supported target");
equal(ciNativeJob?.strategy?.matrix?.target?.map(({ runner }) => runner), nativeTargets.targets.map(({ runner }) => runner), "CI native consumers must use the manifest runners");
equal(ciNativeJob?.strategy?.matrix?.target?.map(({ arch }) => arch), nativeTargets.targets.map(({ npmArch }) => npmArch), "CI native consumers must use the manifest architectures");
const ciLinuxToolchain = findNamedStep(ciNativeJob, "Install pinned Linux native build toolchain");
check(ciLinuxToolchain?.if === linuxNativeCondition, "CI Linux native builds must install their pinned toolchain only on Linux targets");
check(activeShell(ciLinuxToolchain).includes("scripts/install-linux-native-toolchain.mjs"), "CI Linux native builds must install the pinned cargo-zigbuild and Zig toolchain");
const ciNativeBuild = findNamedStep(ciNativeJob, "Build production native artifact");
check(activeShell(ciNativeBuild).includes("scripts/build-native-artifact.mjs"), "CI native consumers must use the target policy build script");
check(!activeShell(ciNativeBuild).includes("cargo build --locked --release --target"), "CI native consumers must not silently use host-glibc cargo builds");
const ciGlibcValidation = findNamedStep(ciNativeJob, "Validate Linux artifact glibc floor");
check(ciGlibcValidation?.if === linuxNativeCondition && activeShell(ciGlibcValidation).includes("scripts/validate-native-artifact.mjs"), "CI Linux native consumers must validate the built artifact glibc floor");
check(findNamedStep(ciNativeJob, "Smoke standalone Rust CLI") === undefined, "Node consumer jobs must not duplicate standalone CLI artifact coverage");
check(activeShell(findNamedStep(ciNativeJob, "Assemble product packages")).includes("scripts/assemble-native-package.mjs"), "CI native consumers must assemble platform packages");
check(activeShell(findNamedStep(ciNativeJob, "Test clean installed Node SDK")).includes("scripts/test-native-consumer.mjs"), "CI native consumers must exercise clean SDK installs");

const cliMetadataJob = ciWorkflow.jobs?.["cli-metadata"];
check(cliMetadataJob?.["runs-on"] === "ubuntu-24.04" && cliMetadataJob?.["timeout-minutes"] === 5, "CLI matrix metadata must use a bounded GitHub-hosted job");
check(cliMetadataJob?.outputs?.matrix === "${{ steps.targets.outputs.matrix }}", "CLI metadata must expose its generated matrix");
check(activeShell(findNamedStep(cliMetadataJob, "Emit CLI target matrix")).includes("scripts/print-cli-matrix.mjs"), "CI CLI matrix must derive from cli-targets.json");
const cliArchiveJob = ciWorkflow.jobs?.["cli-archive"];
check(cliArchiveJob?.needs === "cli-metadata" && cliArchiveJob?.["runs-on"] === "${{ matrix.runner }}", "CLI archive jobs must consume the generated target matrix");
check(cliArchiveJob?.["timeout-minutes"] === 20 && cliArchiveJob?.strategy?.["fail-fast"] === false, "CLI archive matrix must be bounded and collect every target result");
check(cliArchiveJob?.strategy?.matrix === "${{ fromJSON(needs.cli-metadata.outputs.matrix) }}", "CLI archive matrix must use only generated target data");
const cliLinuxCondition = "matrix.usesGlibcFloor";
check(findNamedStep(cliArchiveJob, "Install pinned Linux native build toolchain")?.if === cliLinuxCondition, "CLI Linux targets must install the shared pinned toolchain");
check(activeShell(findNamedStep(cliArchiveJob, "Build standalone CLI artifact")) === "node scripts/build-cli-artifact.mjs ${{ matrix.rust }}", "CLI archive jobs must use the repository build policy");
check(findNamedStep(cliArchiveJob, "Validate Linux CLI glibc floor")?.if === cliLinuxCondition, "CLI Linux artifacts must enforce the shared glibc floor");
const cliAssembly = activeShell(findNamedStep(cliArchiveJob, "Assemble and inspect standalone CLI archive"));
check(cliAssembly.includes("scripts/assemble-cli-archive.mjs") && cliAssembly.includes("--source-commit ${{ github.sha }}") && cliAssembly.includes("scripts/validate-cli-archive.mjs") && cliAssembly.includes("--execute"), "CLI archive jobs must reconcile source, inspect the archive, and execute the exact binary");
check(/^actions\/upload-artifact@[0-9a-f]{40}$/.test(findNamedStep(cliArchiveJob, "Upload standalone CLI archive")?.uses || ""), "CLI archive upload action must be commit-pinned");
const cliSetJob = ciWorkflow.jobs?.["cli-artifact-set"];
check(cliSetJob?.needs === "cli-archive" && cliSetJob?.["runs-on"] === "ubuntu-24.04" && cliSetJob?.["timeout-minutes"] === 10, "CLI artifact aggregation must wait for every archive on a bounded GitHub-hosted job");
check(/^actions\/download-artifact@[0-9a-f]{40}$/.test(findNamedStep(cliSetJob, "Download standalone CLI archives")?.uses || ""), "CLI archive download action must be commit-pinned");
const cliCandidate = activeShell(findNamedStep(cliSetJob, "Generate and validate complete CLI candidate"));
for (const command of ["scripts/generate-cli-installers.mjs", "scripts/finalize-cli-artifacts.mjs", "scripts/validate-cli-artifact-set.mjs"]) {
  check(cliCandidate.includes(command), `complete CLI candidate must invoke ${command}`);
}
check(/^actions\/upload-artifact@[0-9a-f]{40}$/.test(findNamedStep(cliSetJob, "Upload complete CLI candidate")?.uses || ""), "complete CLI candidate upload must be commit-pinned");

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
const releaseLinuxToolchain = findNamedStep(nativeJob, "Install pinned Linux native build toolchain");
check(releaseLinuxToolchain?.if === linuxNativeCondition, "Release Linux native builds must install their pinned toolchain only on Linux targets");
check(activeShell(releaseLinuxToolchain).includes("scripts/install-linux-native-toolchain.mjs"), "Release Linux native builds must install the pinned cargo-zigbuild and Zig toolchain");
const releaseNativeBuild = findNamedStep(nativeJob, "Build native artifact");
check(activeShell(releaseNativeBuild).includes("scripts/build-native-artifact.mjs"), "Release native builds must use the target policy build script");
check(!activeShell(releaseNativeBuild).includes("cargo build --locked --release --target"), "Release native builds must not silently use host-glibc cargo builds");
const releaseGlibcValidation = findNamedStep(nativeJob, "Validate Linux artifact glibc floor");
check(releaseGlibcValidation?.if === linuxNativeCondition && activeShell(releaseGlibcValidation).includes("scripts/validate-native-artifact.mjs"), "Release Linux native builds must validate the built artifact glibc floor");
check(activeShell(findNamedStep(nativeJob, "Assemble and pack native package")).includes("scripts/assemble-native-package.mjs"), "native release jobs must assemble generated packages");
check(activeShell(findNamedStep(nativeJob, "Assemble and pack native package")).includes("scripts/test-native-consumer.mjs"), "native release jobs must clean-install their exact artifacts before upload");

const rootJob = npmWorkflow.jobs?.root_package;
check(rootJob?.["timeout-minutes"] === 30, "release root package must have a bounded timeout");
check(rootJob?.["runs-on"] === "ubuntu-24.04", "release root package must build on a GitHub-hosted runner");
check(findNamedStep(rootJob, "Check out immutable release source")?.with?.ref === "${{ needs.metadata.outputs.source_sha }}", "root package validation must use the immutable release commit");
const rustSecurityInstall = activeShell(findNamedStep(rootJob, "Install pinned Rust security checks"));
check(rustSecurityInstall.includes("cargo install --locked cargo-audit --version 0.22.2") && rustSecurityInstall.includes("cargo install --locked cargo-deny --version 0.19.0"), "root package validation must install the pinned Rust security checks");
const immutableSourceValidation = activeShell(findNamedStep(rootJob, "Validate immutable source"));
check(immutableSourceValidation.includes("cargo audit") && immutableSourceValidation.includes("cargo deny check"), "root package validation must audit the immutable source before publication");
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
console.log(`Transitional release configuration is valid at ${nodePackage.version}`);
