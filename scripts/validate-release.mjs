import { platformMatrices } from './ci-platform-policy.mjs';
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
  repositoryValidation,
  repositoryValidator,
  nodePackage,
  nativeTargets,
  cliTargets,
  bunLock,
  ciWorkflow,
  liveWorkflow,
  releaseWorkflow,
  pythonPackagePresent,
  pythonWorkflowPresent,
  cliCargo,
  cliBuildScript,
  cliSource,
  releaseManagement,
  installerGenerator,
  cliArtifactTest,
  cliConsumerTest,
  nativeConsumerTest,
  specification
] = await Promise.all([
  readJson("package.json"),
  readJson("scripts/repository-validation.json"),
  readFile("scripts/validate-repository.mjs", "utf8"),
  readJson("packages/node/package.json"),
  readJson("native-targets.json"),
  readJson("cli-targets.json"),
  readFile("bun.lock", "utf8"),
  readYaml(".github/workflows/ci.yml"),
  readYaml(".github/workflows/live-smoke.yml"),
  readYaml(".github/workflows/release.yml"),
  pathExists("packages/python/pyproject.toml"),
  pathExists(".github/workflows/release-python.yml"),
  readFile("crates/ytm-cli/Cargo.toml", "utf8"),
  readFile("crates/ytm-cli/build.rs", "utf8"),
  readFile("crates/ytm-cli/src/lib.rs", "utf8"),
  readFile("crates/ytm-cli/src/release_management.rs", "utf8"),
  readFile("scripts/generate-cli-installers.mjs", "utf8"),
  readFile("scripts/test-cli-release-artifacts.mjs", "utf8"),
  readFile("scripts/test-cli-release-consumer.mjs", "utf8"),
  readFile("scripts/test-native-consumer.mjs", "utf8"),
  readFile("SPEC.md", "utf8")
]);

check(rootPackage.private === true, "root package must remain private");
check(rootPackage.version === nodePackage.version, "release-it workspace version must match the SDK source");
equal(rootPackage.workspaces, ["packages/node", "packages/native/*"], "root workspaces must contain only the Node root and native packages");
check(rootPackage.scripts?.validate === "bun run release:check && node scripts/validate-repository.mjs", "root validation must enforce release policy before delegating the remaining repository gate");
equal(repositoryValidation, [
  ["bun", ["run", "contracts:check"]],
  ["bun", ["run", "licenses:check"]],
  ["bun", ["run", "build:check"]],
  ["cargo", ["fmt", "--all", "--check"]],
  ["cargo", ["clippy", "--locked", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"]],
  ["cargo", ["test", "--locked", "--workspace", "--all-targets", "--all-features"]],
  ["cargo", ["test", "--locked", "-p", "ytm-core", "--doc"]],
  ["bun", ["run", "rust:consumer:check"]],
  ["bun", ["run", "validate:node"]],
  ["bun", ["run", "validate:python"]],
  ["cargo", ["audit"]],
  ["cargo", ["deny", "check"]],
  ["bun", ["run", "test"]],
  ["bun", ["run", "judge:broken"]],
  ["bun", ["run", "pack:node"]]
], "repository validation must retain the complete local, CI, and release gate");
check(repositoryValidator.includes('new URL("repository-validation.json", import.meta.url)'), "repository validation must load its command policy relative to the orchestrator");
check(repositoryValidator.includes("spawnSync(command, args") && repositoryValidator.includes('stdio: "inherit"') && repositoryValidator.includes('shell: false'), "repository validation must execute each command directly with visible output");
check(repositoryValidator.includes("result.status !== 0") && repositoryValidator.includes("process.exit(result.status ?? 1)"), "repository validation must stop on the first failed command");
check(nodePackage.name === "@sjunepark/ytm", "Node package identity must remain @sjunepark/ytm");
check(nodePackage.bin === undefined, "Node package must not own or distribute a CLI bin");
check(nodePackage.private === true && nodePackage.publishConfig === undefined, "Node SDK development packages must not publish to npm");
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
const declaredCliTargets = Array.isArray(cliTargets?.targets) ? cliTargets.targets : [];
equal(declaredCliTargets.map((target) => target?.rustTarget), expectedCliTargets, "CLI support targets must remain explicit");
try {
  check(new Set(declaredCliTargets.map((target) => cliArchiveName(cliTargets, target, nodePackage.version))).size === expectedCliTargets.length, "CLI targets must derive unique archive names");
} catch (error) {
  check(false, `CLI archive naming policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
}
for (const target of declaredCliTargets) {
  let plan;
  try {
    plan = cliBuildPlan(cliTargets, nativeTargets.linuxNativeBuild, target?.rustTarget);
  } catch (error) {
    check(false, `${target?.rustTarget || "unknown target"} CLI build policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
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
for (const dependency of ["futures-util.workspace = true", "reqwest.workspace = true", "semver.workspace = true", "sha2.workspace = true"]) {
  check(cliCargo.includes(dependency), `standalone CLI managed upgrade must declare ${dependency}`);
}
for (const identity of ["YTM_CLI_TARGET_KEY", "YTM_CLI_EXECUTABLE_FILE", "YTM_CLI_REPOSITORY", "YTM_CLI_CHECKSUM_FILE", "YTM_CLI_INSTALLER_ASSET", "YTM_CLI_ARCHIVE_ASSET"]) {
  check(cliBuildScript.includes(identity), `standalone CLI build identity must derive ${identity} from cli-targets.json`);
  check(releaseManagement.includes(identity), `managed upgrade must consume manifest-derived ${identity}`);
}
check(cliSource.includes('first == "upgrade"') && cliSource.includes("UpgradeMode::Check") && cliSource.includes("UpgradeMode::Install"), "standalone CLI must expose explicit upgrade and upgrade --check paths");
for (const contract of ["schema=1", "installed_sha256", "release_source", "YTM_MANAGED_UPGRADE", ".ytm.previous", ".ytm.exe.previous"]) {
  check(installerGenerator.includes(contract), `generated installers must implement managed-install contract ${contract}`);
}
check(cliArtifactTest.includes("testShellManagedInstall") && cliArtifactTest.includes("injected receipt-publication failure"), "CLI artifact tests must execute fresh receipt installation and managed rollback");
for (const contract of ["assertInstalledPair", "testFreshFailure", 'testManagedUpgrade("success")', 'testManagedUpgrade("interruption")', 'testManagedUpgrade("restoration")', 'testManagedUpgrade("status")', "status_error=", "waitForWindowsTerminalState"]) {
  check(cliConsumerTest.includes(contract), `exact CLI consumer tests must retain ${contract}`);
}
check(specification.includes("ytm upgrade --check") && specification.includes("installed_sha256"), "SPEC must define managed upgrade and its exact receipt fields");
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

check(pythonPackagePresent && !pythonWorkflowPresent, "Python foundation must exist without an independent publishing workflow");
equal(Object.keys(ciWorkflow.jobs || {}), ["python-candidate", "validate", "cli-metadata", "cli-archive", "cli-artifact-set", "cli-consumer", "native-consumer", "platform-gate"], "CI must contain validation, CLI artifacts, and native consumers only");
equal(Object.keys(liveWorkflow.jobs || {}), ["rust-cli"], "live smoke must exercise only the standalone Rust CLI");
equal(ciWorkflow.on?.push?.branches, ["main", "dev"], "CI pushes must cover only the long-lived main and integration branches");
check(ciWorkflow.jobs?.validate?.["timeout-minutes"] === 20, "CI validation must have a bounded timeout");
check(liveWorkflow.jobs?.["rust-cli"]?.["timeout-minutes"] === 20, "live smoke must have a bounded timeout");
equal(ciWorkflow.jobs?.validate?.steps?.map((step) => step.name), [
  "Check out source",
  "Set up Bun",
  "Set up Node",
  "Install frozen JavaScript dependencies",
  "Set up Python",
  "Select Python for workspace and wheel validation",
  "Install pinned validation tools",
  "Validate repository"
], "CI validation must install its prerequisites and delegate the complete gate once");
check(activeShell(findNamedStep(ciWorkflow.jobs?.validate, "Validate repository")) === "bun run validate", "CI must invoke the complete repository validation command exactly");
const requiredValidationToolInstalls = [
  "cargo install --locked --features cli cargo-about --version 0.9.2",
  "cargo install --locked cargo-audit --version 0.22.2",
  "cargo install --locked cargo-deny --version 0.19.0"
];
const checkPythonValidation = (job) => {
  const setup = findNamedStep(job, "Set up Python");
  check(setup?.uses === "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1" && setup?.with?.["python-version"] === "3.11", "workspace validation must provision CPython 3.11 with the pinned action");
  const selection = activeShell(findNamedStep(job, "Select Python for workspace and wheel validation"));
  check(selection.includes("sys.version_info[:2] == (3, 11)") && selection.includes('PYO3_PYTHON=$(command -v python)'), "workspace validation must select and verify CPython 3.11");
};
checkPythonValidation(ciWorkflow.jobs?.validate);

const ciValidationToolInstall = activeShell(findNamedStep(ciWorkflow.jobs?.validate, "Install pinned validation tools"));
for (const install of requiredValidationToolInstalls) check(ciValidationToolInstall.includes(install), `CI validation must install ${install}`);
const liveSmoke = activeShell(findNamedStep(liveWorkflow.jobs?.["rust-cli"], "Run live smoke"));
check(liveSmoke.includes('target/debug/ytm matrix') && liveSmoke.includes("--fallback previous-available") && liveSmoke.includes("jq -e"), "live smoke must use bounded fallback through the standalone Rust CLI");
const ciNativeJob = ciWorkflow.jobs?.["native-consumer"];
const ciMatrices = await platformMatrices(true);
check(ciNativeJob.needs === "cli-metadata" && ciNativeJob.strategy.matrix === "${{ fromJSON(needs.cli-metadata.outputs.native) }}", "Native CI must use selected manifest targets");
const linuxNativeCondition = "matrix.target.rust == 'x86_64-unknown-linux-gnu' || matrix.target.rust == 'aarch64-unknown-linux-gnu'";
check(ciNativeJob?.["timeout-minutes"] === 20, "CI native consumers must have a bounded timeout");
equal(ciMatrices.native.node, nativeTargets.validationNodeMajors, "CI native consumers must cover every declared Node major");
equal(ciMatrices.native.target?.map(({ rust }) => rust), nativeTargets.targets.map(({ rustTarget }) => rustTarget), "CI native consumers must cover every supported target");
equal(ciMatrices.native.target?.map(({ runner }) => runner), nativeTargets.targets.map(({ rustTarget, runner }) => rustTarget === "x86_64-unknown-linux-gnu" ? "blacksmith-2vcpu-ubuntu-2404" : runner), "CI native consumers must use the manifest runners");
equal(ciMatrices.native.target?.map(({ arch }) => arch), nativeTargets.targets.map(({ npmArch }) => npmArch), "CI native consumers must use the manifest architectures");
equal(ciMatrices.native.target?.map(({ directory }) => directory), nativeTargets.targets.map(({ packageDirectory }) => packageDirectory), "CI native consumers must use the manifest package directories");
const ciLinuxToolchain = findNamedStep(ciNativeJob, "Install pinned Linux native build toolchain");
check(ciLinuxToolchain?.if === linuxNativeCondition, "CI Linux native builds must install their pinned toolchain only on Linux targets");
check(activeShell(ciLinuxToolchain).includes("scripts/install-linux-native-toolchain.mjs"), "CI Linux native builds must install the pinned cargo-zigbuild and Zig toolchain");
const ciNativeBuild = findNamedStep(ciNativeJob, "Build production native artifact");
check(activeShell(ciNativeBuild).includes("scripts/build-native-artifact.mjs"), "CI native consumers must use the target policy build script");
check(!activeShell(ciNativeBuild).includes("cargo build --locked --release --target"), "CI native consumers must not silently use host-glibc cargo builds");
const ciGlibcValidation = findNamedStep(ciNativeJob, "Validate Linux artifact glibc floor");
check(ciGlibcValidation?.if === linuxNativeCondition && activeShell(ciGlibcValidation).includes("scripts/validate-native-artifact.mjs"), "CI Linux native consumers must validate the built artifact glibc floor");
check(findNamedStep(ciNativeJob, "Smoke standalone Rust CLI") === undefined, "Node consumer jobs must not duplicate standalone CLI artifact coverage");
const ciPackageAssembly = activeShell(findNamedStep(ciNativeJob, "Assemble product packages"));
check(ciPackageAssembly.includes("npm run build:sdk") && ciPackageAssembly.includes("scripts/assemble-native-package.mjs"), "CI native consumers must build the root SDK through its public script using the runtime already provisioned for every matrix lane");
check(findNamedStep(ciNativeJob, "Assemble product packages")?.shell === "bash" && activeShell(findNamedStep(ciNativeJob, "Assemble product packages")).includes("npm pack --pack-destination .artifacts/native"), "CI native consumers must pack exact tarballs portably before installation");
const ciExactNativeConsumer = activeShell(findNamedStep(ciNativeJob, "Test exact packed Node SDK"));
check(ciExactNativeConsumer.includes("scripts/test-native-consumer.mjs") && ciExactNativeConsumer.includes(".artifacts/native .artifacts/root"), "CI native consumers must install the exact packed SDK tarballs");

const cliMetadataJob = ciWorkflow.jobs?.["cli-metadata"];
check(cliMetadataJob?.["runs-on"] === "blacksmith-2vcpu-ubuntu-2404" && cliMetadataJob?.["timeout-minutes"] === 5, "CLI matrix metadata must use a bounded Blacksmith job");
equal(cliMetadataJob?.outputs, {
  matrix: "${{ steps.targets.outputs.matrix }}",
  native: "${{ steps.targets.outputs.native }}",
  full: "${{ steps.targets.outputs.full }}"
}, "Platform metadata must expose every generated output consumed by CI");
check(activeShell(findNamedStep(cliMetadataJob, "Emit CLI target matrix")).includes("scripts/ci-platform-policy.mjs"), "CI CLI matrix must derive from cli-targets.json");

check('merge_group' in ciWorkflow.on && 'workflow_dispatch' in ciWorkflow.on, "CI must cover merge queues and manual full candidates");
for (const name of ['python-candidate', 'cli-artifact-set', 'cli-consumer']) {
  check(ciWorkflow.jobs[name].if === "needs.cli-metadata.outputs.full == 'true'", `${name} must follow the selected full-platform policy`);
}
const platformGate = ciWorkflow.jobs['platform-gate'];
equal(platformGate.name, 'Platform compatibility', 'Platform gate must retain its required GitHub check name');
check(platformGate.if === 'always()', 'Platform gate must report failed and skipped prerequisites');
equal(platformGate.needs, ['validate', 'cli-metadata', 'cli-archive', 'cli-artifact-set', 'cli-consumer', 'native-consumer', 'python-candidate'], 'Platform gate must cover every selected consumer');

const cliArchiveJob = ciWorkflow.jobs?.["cli-archive"];
check(cliArchiveJob?.needs === "cli-metadata" && cliArchiveJob?.["runs-on"] === "${{ matrix.runner }}", "CLI archive jobs must consume the generated target matrix");
check(cliArchiveJob?.["timeout-minutes"] === 20 && cliArchiveJob?.strategy?.["fail-fast"] === false, "CLI archive matrix must be bounded and collect every target result");
check(cliArchiveJob?.strategy?.matrix === "${{ fromJSON(needs.cli-metadata.outputs.matrix) }}", "CLI archive matrix must use only generated target data");
check(cliArchiveJob?.defaults?.run?.shell === "bash", "CLI archive jobs must use one quoted shell contract on every runner");
check(cliArchiveJob?.env?.RUST_TARGET === "${{ matrix.rust }}" && cliArchiveJob?.env?.SOURCE_COMMIT === "${{ github.sha }}", "CLI archive jobs must pass generated values through the environment");
const cliLinuxCondition = "matrix.usesGlibcFloor";
check(findNamedStep(cliArchiveJob, "Install pinned Linux native build toolchain")?.if === cliLinuxCondition, "CLI Linux targets must install the shared pinned toolchain");
check(activeShell(findNamedStep(cliArchiveJob, "Build standalone CLI artifact")) === 'node scripts/build-cli-artifact.mjs "$RUST_TARGET"', "CLI archive jobs must use the repository build policy");
check(findNamedStep(cliArchiveJob, "Validate Linux CLI glibc floor")?.if === cliLinuxCondition, "CLI Linux artifacts must enforce the shared glibc floor");
const cliAssembly = activeShell(findNamedStep(cliArchiveJob, "Assemble and inspect standalone CLI archive"));
check(cliAssembly.includes('scripts/assemble-cli-archive.mjs "$RUST_TARGET"') && cliAssembly.includes('--source-commit "$SOURCE_COMMIT"') && cliAssembly.includes('scripts/validate-cli-archive.mjs "$RUST_TARGET"') && cliAssembly.includes("--execute"), "CLI archive jobs must reconcile source, inspect the archive, and execute the exact binary");
check(/^actions\/upload-artifact@[0-9a-f]{40}$/.test(findNamedStep(cliArchiveJob, "Upload standalone CLI archive")?.uses || ""), "CLI archive upload action must be commit-pinned");
const cliSetJob = ciWorkflow.jobs?.["cli-artifact-set"];
check(JSON.stringify(cliSetJob?.needs) === JSON.stringify(["cli-metadata", "cli-archive"]) && cliSetJob?.["runs-on"] === "blacksmith-2vcpu-ubuntu-2404" && cliSetJob?.["timeout-minutes"] === 10, "CLI artifact aggregation must wait for every archive on a bounded Blacksmith job");
check(/^actions\/download-artifact@[0-9a-f]{40}$/.test(findNamedStep(cliSetJob, "Download standalone CLI archives")?.uses || ""), "CLI archive download action must be commit-pinned");
const cliCandidate = activeShell(findNamedStep(cliSetJob, "Generate and validate complete CLI candidate"));
for (const command of ["scripts/generate-cli-installers.mjs", "scripts/finalize-cli-artifacts.mjs", "scripts/validate-cli-artifact-set.mjs"]) {
  check(cliCandidate.includes(command), `complete CLI candidate must invoke ${command}`);
}
check(/^actions\/upload-artifact@[0-9a-f]{40}$/.test(findNamedStep(cliSetJob, "Upload complete CLI candidate")?.uses || ""), "complete CLI candidate upload must be commit-pinned");
const cliConsumerJob = ciWorkflow.jobs?.["cli-consumer"];
equal(cliConsumerJob?.needs, ["cli-metadata", "cli-artifact-set"], "CLI consumers must wait for generated metadata and the complete candidate");
check(cliConsumerJob?.["runs-on"] === "${{ matrix.runner }}" && cliConsumerJob?.["timeout-minutes"] === 20, "CLI consumers must use bounded manifest runners");
check(cliConsumerJob?.strategy?.["fail-fast"] === false && cliConsumerJob?.strategy?.matrix === "${{ fromJSON(needs.cli-metadata.outputs.matrix) }}", "CLI consumers must reuse the complete generated target matrix");
check(cliConsumerJob?.env?.RUST_TARGET === "${{ matrix.rust }}", "CLI consumers must receive their generated Rust target through the environment");
const cliConsumerDownload = findNamedStep(cliConsumerJob, "Download exact complete CLI candidate");
check(/^actions\/download-artifact@[0-9a-f]{40}$/.test(cliConsumerDownload?.uses || ""), "CLI candidate download action must be commit-pinned");
check(cliConsumerDownload?.with?.name === "cli-candidate-${{ github.sha }}" && cliConsumerDownload?.with?.path === "dist/cli", "CLI consumers must download the exact aggregated candidate without repacking it");
check(activeShell(findNamedStep(cliConsumerJob, "Test exact standalone CLI consumer")) === "node scripts/test-cli-release-consumer.mjs dist/cli", "CLI consumers must run the repository-owned exact-distributable harness");

const preparation = rootPackage['release-it'];
check(rootPackage.scripts.release === 'release-it', 'release command must use release-it');
check(preparation?.npm?.publish === false && preparation?.github?.release === false, 'local preparation must not publish assets or registry packages');
check(preparation?.git?.requireBranch === 'main' && preparation.git.requireUpstream === true && preparation.git.requireCleanWorkingDir === true, 'preparation requires clean main with an upstream');
check(preparation?.git?.tagName === 'v${version}', 'release tags must use the unified version');
equal(preparation?.hooks?.['after:@release-it/conventional-changelog:beforeRelease'], ['node scripts/release-version.mjs sync', 'bun run validate'], 'version synchronization and validation must finish before commit/tag/push');
check(preparation?.hooks?.['after:init'] === 'node scripts/release-version.mjs upstream', 'preparation must verify freshly fetched origin/main');
check(preparation?.plugins?.['@release-it/conventional-changelog']?.infile === 'CHANGELOG.md', 'release-it must own the product changelog');
for (const path of ['.release-please-manifest.json', 'release-please-config.json', '.github/workflows/release-please.yml']) {
  check(!await pathExists(path), `${path} must not retain a second release authority`);
}
equal(releaseWorkflow.on, {workflow_dispatch: {}}, 'cross-platform release builds must be manual-only');
check(releaseWorkflow.permissions?.contents === 'read', 'release default token must be read-only');
equal(releaseWorkflow.concurrency, {group: 'release-${{ github.ref }}', 'cancel-in-progress': false}, 'same-tag release runs must serialize without interruption');
equal(Object.keys(releaseWorkflow.jobs), ['verify', 'cli_metadata', 'cli_archive', 'cli_artifact_set', 'cli_consumer', 'publish'], 'release contains only source verification and CLI delivery');
const verify = releaseWorkflow.jobs.verify;
check(activeShell(findNamedStep(verify, 'Validate repository')) === 'bun run validate', 'tagged source must pass the complete repository gate');
checkPythonValidation(verify);
for (const install of requiredValidationToolInstalls) check(activeShell(findNamedStep(verify, 'Install pinned validation tools')).includes(install), `release source verification must install ${install}`);
check(activeShell(findNamedStep(verify, 'Verify version and tag identity')).includes('release-version.mjs check "$RELEASE_TAG"'), 'tag identity must be reconciled before building');
check(verify.outputs?.source_sha === '${{ github.sha }}', 'release jobs must share the immutable workflow SHA');
const sourceRef = '${{ needs.verify.outputs.source_sha }}';
for (const [name, job] of Object.entries(releaseWorkflow.jobs)) {
  check(job['timeout-minutes'] > 0, `${name} must have a timeout`);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  check(checkout?.with?.ref === (name === 'verify' ? '${{ github.sha }}' : sourceRef), `${name} must check out the exact verified source`);
  check(checkout?.with?.['persist-credentials'] === false, `${name} must not retain checkout credentials`);
  for (const step of job.steps.filter(step => step.uses)) check(/@[0-9a-f]{40}$/.test(step.uses), `${name} actions must be commit-pinned`);
  check(name === 'publish' || job.permissions?.contents !== 'write', `${name} must not publish`);
}
const releaseJobs = releaseWorkflow.jobs;
check(activeShell(findNamedStep(releaseJobs.cli_metadata, 'Emit CLI target matrix')).includes('scripts/print-cli-matrix.mjs'), 'release matrix must include every declared CLI target');
for (const name of ['cli_archive', 'cli_consumer']) {
  check(releaseJobs[name].strategy?.matrix === '${{ fromJSON(needs.cli_metadata.outputs.matrix) }}' && !releaseJobs[name].if, `${name} must run every release target`);
  check(releaseJobs[name]['runs-on'] === '${{ matrix.runner }}', `${name} must run natively on the declared target`);
}
equal(releaseJobs.cli_artifact_set.needs, ['verify', 'cli_archive'], 'candidate must await all archives');
equal(releaseJobs.cli_consumer.needs, ['verify', 'cli_metadata', 'cli_artifact_set'], 'consumers must await the complete candidate');
check(releaseJobs.cli_archive.env.SOURCE_COMMIT === sourceRef, 'archive assembly must verify the exact source');
const releaseAssembly = activeShell(findNamedStep(releaseJobs.cli_archive, 'Assemble and inspect standalone CLI archive'));
check(releaseAssembly.includes('--source-commit "$SOURCE_COMMIT"') && releaseAssembly.includes('--execute'), 'each archived binary must pass identity checks');
const releaseCandidate = activeShell(findNamedStep(releaseJobs.cli_artifact_set, 'Generate and validate complete CLI candidate'));
for (const command of ['generate-cli-installers.mjs', 'finalize-cli-artifacts.mjs', 'validate-cli-artifact-set.mjs']) check(releaseCandidate.includes(command), `release aggregation must run ${command}`);
check(activeShell(findNamedStep(releaseJobs.cli_consumer, 'Test exact standalone CLI consumer')) === 'node scripts/test-cli-release-consumer.mjs dist/cli', 'every target must test the exact archives and installers');
const publication = releaseJobs.publish;
check(publication.if === "github.event_name == 'workflow_dispatch' && github.ref_type == 'tag'", 'only explicit manual tag dispatch may publish');
equal(publication.needs, ['verify', 'cli_artifact_set', 'cli_consumer'], 'publication must await all release certification');
equal(publication.permissions, {contents:'write'}, 'only GitHub contents permission is needed to publish');
check(activeShell(findNamedStep(publication, 'Publish immutable GitHub assets')) === 'node scripts/publish-release.mjs dist/cli "$RELEASE_TAG"', 'publication must use the immutable CLI publisher');
for (const [job, stepName] of [[releaseJobs.cli_consumer, 'Download exact complete CLI candidate'], [publication, 'Download exact verified CLI candidate']]) {
  const download = findNamedStep(job, stepName);
  check(download?.with?.name === 'cli-candidate-${{ needs.verify.outputs.source_sha }}' && download.with.path === 'dist/cli', 'consumers and publisher must use identical candidate bytes');
}
for (const target of nativeTargets.targets) {
  const native = await readJson(`${nativeTargets.nativePackageRoot}/${target.packageDirectory}/package.json`);
  check(native.private === true && native.publishConfig === undefined, 'native SDK development packages must not publish to npm');
}
const pythonWorkflow = await readYaml('.github/workflows/python-candidate.yml');
const pythonTargets = await readJson('python-targets.json');
equal(pythonTargets.targets.map(t => t.rust), nativeTargets.targets.map(t => t.rustTarget), 'Python development checks must retain the supported native targets');
check(ciWorkflow.jobs['python-candidate'].uses === './.github/workflows/python-candidate.yml', 'CI must retain Python consumer validation');
equal(Object.keys(pythonWorkflow.jobs), ['matrix','build','aggregate','consumer'], 'Python development candidates must retain clean consumer checks');
const manualCandidate = await readYaml('.github/workflows/cross-platform-candidate.yml');
check(manualCandidate.jobs.candidate.uses === './.github/workflows/ci.yml', 'full development candidates must reuse CI');

if (failures.length > 0) {
  console.error(failures.map(failure => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`CLI release and SDK development configuration is valid at ${rootPackage.version}`);
