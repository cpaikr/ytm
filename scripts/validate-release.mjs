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
  releasePleaseWorkflow,
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
  releaseDraftCreator,
  releaseMetadataPolicy,
  releaseMetadataVerifier,
  releaseStateResolver,
  releaseAssetPlanner,
  releasePublicationTest,
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
  readYaml(".github/workflows/release-please.yml"),
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
  readFile("scripts/create-release-draft.mjs", "utf8"),
  readFile("scripts/release-metadata-policy.mjs", "utf8"),
  readFile("scripts/verify-release-metadata.mjs", "utf8"),
  readFile("scripts/resolve-release-state.mjs", "utf8"),
  readFile("scripts/plan-cli-release-upload.mjs", "utf8"),
  readFile("scripts/test-release-publication.mjs", "utf8"),
  readFile("SPEC.md", "utf8")
]);

check(rootPackage.private === true, "root package must remain private");
check(rootPackage.version === undefined, "root package must not become a release component");
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

equal(Object.keys(releasePleaseWorkflow.jobs || {}), ["release_pr"], "Release Please workflow must only prepare the product release PR");
check(releasePleaseWorkflow.on?.push?.branches?.includes("main"), "Release Please must update release PRs from main");
check(releasePleaseWorkflow.on?.workflow_dispatch !== undefined, "Release Please must support an explicit preparation retry");
check(releasePleaseWorkflow.permissions?.contents === "read", "Release Please workflow default permissions must remain read-only");
const releasePleaseJob = releasePleaseWorkflow.jobs?.release_pr;
check(releasePleaseJob?.if === "${{ vars.RELEASE_PLEASE_ENABLED == 'true' }}", "Release Please must remain externally disabled until release preparation is authorized");
check(releasePleaseJob?.["runs-on"] === "blacksmith-2vcpu-ubuntu-2404" && releasePleaseJob?.["timeout-minutes"] === 10, "Release Please must use the 2-vCPU Blacksmith runner with a bounded timeout");
check(releasePleaseJob?.permissions?.contents === "write" && releasePleaseJob?.permissions?.issues === "write" && releasePleaseJob?.permissions?.["pull-requests"] === "write", "Release Please job permissions must be explicit and sufficient for release PRs");
const releasePleaseStep = findNamedStep(releasePleaseJob, "Create or update the product release PR");
check(/^googleapis\/release-please-action@[0-9a-f]{40}$/.test(releasePleaseStep?.uses || ""), "Release Please action must be pinned to a full commit SHA");
check(releasePleaseStep?.with?.token === "${{ secrets.RELEASE_PLEASE_TOKEN }}", "Release Please must use the configured automation credential so release PR checks run");
check(releasePleaseStep?.with?.["config-file"] === "release-please-config.json" && releasePleaseStep?.with?.["manifest-file"] === ".release-please-manifest.json", "Release Please must use the repository-owned product config and manifest");
check(releasePleaseStep?.with?.["skip-github-release"] === true, "Release preparation must not create a tag or GitHub Release before the protected release workflow");
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
check(cliMetadataJob?.outputs?.matrix === "${{ steps.targets.outputs.matrix }}", "CLI metadata must expose its generated matrix");
check(activeShell(findNamedStep(cliMetadataJob, "Emit CLI target matrix")).includes("scripts/ci-platform-policy.mjs"), "CI CLI matrix must derive from cli-targets.json");

check('merge_group' in ciWorkflow.on && 'workflow_dispatch' in ciWorkflow.on, "CI must cover merge queues and manual full candidates");
for (const name of ['python-candidate', 'cli-artifact-set']) {
  check(ciWorkflow.jobs[name].if === "needs.cli-metadata.outputs.full == 'true'", `${name} must follow the selected full-platform policy`);
}
check(findNamedStep(cliMetadataJob, 'Check out source').with['fetch-depth'] === 0, 'Platform selection must have complete PR diff history');
const platformGate = ciWorkflow.jobs['platform-gate'];
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

check(!releaseWorkflow.on?.push, "product publishing must not trigger automatically from pushed tags");
equal(Object.keys(releaseWorkflow.on?.workflow_dispatch?.inputs || {}), ["expected_version"], "product publishing must accept only the approved version input");
check(releaseWorkflow.on?.workflow_dispatch?.inputs?.expected_version?.required === true, "product publishing must require an explicitly approved expected version");
check(releaseWorkflow.permissions?.contents === "read", "release workflow defaults must remain read-only");
check(releaseWorkflow.concurrency?.group === "release-${{ inputs.expected_version }}" && releaseWorkflow.concurrency?.["cancel-in-progress"] === false, "release runs must serialize per approved version without cancellation");
equal(Object.keys(releaseWorkflow.jobs || {}), ["release_authority", "python_candidate", "cli_metadata", "cli_archive", "cli_artifact_set", "cli_consumer", "native_packages", "root_package", "npm_candidate", "npm_consumer", "publish_github", "publish_npm", "publish_pypi"], "release workflow must contain only the complete tagged-source lifecycle");

const authorityJob = releaseWorkflow.jobs?.release_authority;
check(authorityJob?.if === "${{ vars.RELEASE_ENABLED == 'true' }}", "external release state must remain disabled until repository settings are authorized");
check(authorityJob?.["runs-on"] === "ubuntu-24.04" && authorityJob?.["timeout-minutes"] === 15, "release authority must use a bounded GitHub-hosted job");
check(authorityJob?.environment?.name === "release" && authorityJob?.permissions?.contents === "write", "tag and draft creation must use the protected release environment with explicit write permission");
check(authorityJob?.outputs?.version === "${{ steps.resolve.outputs.version }}", "release authority must expose verified version");
check(authorityJob?.outputs?.tag === "${{ steps.resolve.outputs.tag }}", "release authority must expose verified tag");
check(authorityJob?.outputs?.source_sha === "${{ steps.resolve.outputs.source_sha }}", "release authority must expose verified source SHA");
check(authorityJob?.outputs?.release_id === "${{ steps.resolve.outputs.release_id }}", "release authority must expose verified release ID");
check(authorityJob?.outputs?.release_url === "${{ steps.resolve.outputs.release_url }}", "release authority must expose verified release URL");
check(authorityJob?.outputs?.publication_mode === "${{ steps.resolve.outputs.publication_mode }}", "release authority must expose draft or projection-only recovery mode");
const authorityCheckout = findNamedStep(authorityJob, "Check out submitted source");
check(authorityCheckout?.with?.ref === "${{ github.sha }}" && authorityCheckout?.with?.["fetch-depth"] === 0 && authorityCheckout?.with?.["persist-credentials"] === false, "release authority must inspect the exact dispatch source without persisted credentials");
const stateStep = findNamedStep(authorityJob, "Validate approved version and classify release state");
check(stateStep?.env?.EXPECTED_VERSION === "${{ inputs.expected_version }}" && activeShell(stateStep).includes("scripts/resolve-release-state.mjs inspect"), "release state inspection must reconcile the submitted version through repository policy");
const protectedReleaseStep = findNamedStep(authorityJob, "Create exact immutable tag and draft");
check(protectedReleaseStep?.if?.includes("create_draft") && activeShell(protectedReleaseStep) === "node scripts/create-release-draft.mjs", "protected release authority must recover only exact tag-without-draft state");
for (const contract of ["git/refs", "target_commitish", "generate_release_notes: false", "releaseMetadataFromChangelog"]) check(releaseDraftCreator.includes(contract), `exact draft creation must retain ${contract}`);
check(releaseMetadataPolicy.includes("first changelog release") && releaseMetadataPolicy.includes("non-empty body"), "release metadata must derive deterministically from the tagged changelog");
check(activeShell(findNamedStep(authorityJob, "Resolve immutable release identity")) === "node scripts/resolve-release-state.mjs resolve", "downstream release identity must come only from repository-owned resolution");
for (const contract of ["approvedReleasePullRequest", "canonicalReleaseUrl", '/commits/${workflowSha}/pulls?per_page=100', "AbortSignal.timeout", "refs/remotes/origin/main", "merge-base", "publication_mode", "FETCH_HEAD^{commit}"]) check(releaseStateResolver.includes(contract), `release state resolution must retain ${contract}`);
check(!releaseStateResolver.includes("release_pr:"), "release inspection must not expose an unused release PR output after validating its identity");
check(releasePublicationTest.includes("ordinary main change") && releaseStateResolver.includes("listPullRequests"), "tag creation must bind the approved version to its exact merged Release Please PR SHA");
check(releaseDraftCreator.includes("normalizeReleaseBody(release.body)") && releaseDraftCreator.includes("AbortSignal.timeout"), "draft creation must normalize GitHub body line endings and bound every mutation request");
check(releaseMetadataVerifier.includes("AbortSignal.timeout"), "release metadata verification must use a bounded GitHub request");
check(releasePublicationTest.includes("line one\\r\\nline two") && releaseMetadataPolicy.includes("normalizeReleaseBody"), "release publication tests must retain CRLF normalization coverage");

const immutableRef = "${{ needs.release_authority.outputs.source_sha }}";
for (const name of ["cli_metadata", "cli_archive", "cli_artifact_set", "cli_consumer", "native_packages", "root_package", "npm_candidate", "npm_consumer", "publish_github", "publish_npm"]) {
  check(findNamedStep(releaseWorkflow.jobs?.[name], "Check out immutable release source")?.with?.ref === immutableRef, `${name} must check out the verified tagged source`);
}
const releaseCliMetadata = releaseWorkflow.jobs?.cli_metadata;
check(activeShell(findNamedStep(releaseCliMetadata, "Emit CLI target matrix")).includes("scripts/print-cli-matrix.mjs"), "release CLI targets must derive from cli-targets.json");
const releaseCliArchive = releaseWorkflow.jobs?.cli_archive;
check(releaseCliArchive?.strategy?.matrix === "${{ fromJSON(needs.cli_metadata.outputs.matrix) }}" && releaseCliArchive?.["runs-on"] === "${{ matrix.runner }}", "release CLI builders must consume the generated native-runner matrix");
check(releaseCliArchive?.env?.SOURCE_COMMIT === immutableRef, "release CLI archive identity must use the verified source SHA");
check(activeShell(findNamedStep(releaseCliArchive, "Assemble and inspect standalone CLI archive")).includes("--source-commit \"$SOURCE_COMMIT\""), "release CLI archives must embed the verified source SHA");
const releaseCliCandidate = activeShell(findNamedStep(releaseWorkflow.jobs?.cli_artifact_set, "Generate and validate complete CLI candidate"));
for (const command of ["scripts/generate-cli-installers.mjs", "scripts/finalize-cli-artifacts.mjs", "scripts/validate-cli-artifact-set.mjs"]) check(releaseCliCandidate.includes(command), `release CLI aggregation must invoke ${command}`);
check(findNamedStep(releaseWorkflow.jobs?.cli_artifact_set, "Upload complete CLI candidate")?.with?.["retention-days"] === 90, "release CLI candidates must outlive protected-environment approval delays");
check(activeShell(findNamedStep(releaseWorkflow.jobs?.cli_consumer, "Test exact standalone CLI consumer")) === "node scripts/test-cli-release-consumer.mjs dist/cli", "release CLI consumers must exercise the exact aggregated candidate");

const nativeJob = releaseWorkflow.jobs?.native_packages;
check(nativeJob?.["timeout-minutes"] === 30, "release native packages must have a bounded timeout");
equal(nativeJob?.strategy?.matrix?.target?.map(({ rust }) => rust), nativeTargets.targets.map(({ rustTarget }) => rustTarget), "release native matrix must match the target manifest");
equal(nativeJob?.strategy?.matrix?.target?.map(({ runner }) => runner), nativeTargets.targets.map(({ runner }) => runner), "release native matrix must use the manifest runners");
const releaseLinuxToolchain = findNamedStep(nativeJob, "Install pinned Linux native build toolchain");
check(releaseLinuxToolchain?.if === linuxNativeCondition && activeShell(releaseLinuxToolchain).includes("scripts/install-linux-native-toolchain.mjs"), "Release Linux native builds must install the pinned toolchain");
check(activeShell(findNamedStep(nativeJob, "Build native artifact")).includes("scripts/build-native-artifact.mjs"), "Release native builds must use the target policy build script");
check(activeShell(findNamedStep(nativeJob, "Assemble and pack native package")).includes("scripts/assemble-native-package.mjs"), "native release jobs must assemble generated packages");

const rootJob = releaseWorkflow.jobs?.root_package;
check(rootJob?.["timeout-minutes"] === 45 && rootJob?.["runs-on"] === "ubuntu-24.04", "release root package must allow bounded time for pinned security-tool builds on a GitHub-hosted job");
checkPythonValidation(rootJob);
const validationToolInstall = activeShell(findNamedStep(rootJob, "Install pinned validation tools"));
for (const install of requiredValidationToolInstalls) check(validationToolInstall.includes(install), `root package validation must install ${install}`);
const immutableSourceValidation = activeShell(findNamedStep(rootJob, "Validate immutable source"));
check(immutableSourceValidation === "bun run validate", "release source validation must invoke the complete repository validation command exactly");
check(activeShell(findNamedStep(rootJob, "Pack root package without a native binary")).includes("build:sdk"), "root release artifact must be packed without a native binary");

const npmCandidateJob = releaseWorkflow.jobs?.npm_candidate;
equal(npmCandidateJob?.needs, ["release_authority", "native_packages", "root_package"], "npm aggregation must wait for every package builder");
check(activeShell(findNamedStep(npmCandidateJob, "Validate complete npm artifact set")) === "node scripts/validate-release-artifacts.mjs dist/native dist/root", "npm aggregation must validate the exact five-tarball set");
check(/^actions\/upload-artifact@[0-9a-f]{40}$/.test(findNamedStep(npmCandidateJob, "Upload complete npm candidate")?.uses || ""), "npm candidate upload must be commit-pinned");
check(findNamedStep(npmCandidateJob, "Upload complete npm candidate")?.with?.["retention-days"] === 90, "npm candidates must outlive protected-environment approval delays");
check(findNamedStep(npmCandidateJob, "Upload complete npm candidate")?.with?.path?.includes("dist/native/*.tgz") && findNamedStep(npmCandidateJob, "Upload complete npm candidate")?.with?.path?.includes("dist/root/*.tgz"), "npm candidate artifacts must retain native and root directory layout");
const npmConsumerJob = releaseWorkflow.jobs?.npm_consumer;
equal(npmConsumerJob?.strategy?.matrix?.node, nativeTargets.validationNodeMajors, "exact npm consumers must cover every declared Node major");
equal(npmConsumerJob?.strategy?.matrix?.target?.map(({ rust }) => rust), nativeTargets.targets.map(({ rustTarget }) => rustTarget), "exact npm consumers must cover every native target");
check(activeShell(findNamedStep(npmConsumerJob, "Test exact aggregated Node SDK consumer")).includes("dist/native dist/root"), "npm consumers must install downloaded aggregate tarballs without repacking");
check(nativeConsumerTest.includes("findPackageTarball") && nativeConsumerTest.includes("listTarball(rootTarball)") && nativeConsumerTest.includes("exact aggregated"), "Node consumer harness must inspect exact aggregate tarball contents without repacking");

const githubPublishJob = releaseWorkflow.jobs?.publish_github;
equal(githubPublishJob?.needs, ["release_authority", "cli_artifact_set", "cli_consumer", "npm_candidate", "npm_consumer", "python_candidate"], "canonical publication must wait for both exact-distributable consumer matrices");
check(githubPublishJob?.environment?.name === "release" && githubPublishJob?.permissions?.contents === "write", "canonical publication must use the protected release environment");
const githubSourceValidation = activeShell(findNamedStep(githubPublishJob, "Validate tagged candidates and source identity"));
for (const command of ["validate-product-version.mjs", "validate-cli-artifact-set.mjs", "validate-release-artifacts.mjs", "FETCH_HEAD^{commit}"]) check(githubSourceValidation.includes(command), `canonical publication must revalidate ${command}`);
const githubRegistryPreflight = activeShell(findNamedStep(githubPublishJob, "Verify npm projection state before visibility"));
check(githubRegistryPreflight.includes("registry-projection.mjs npm dist/product") && githubRegistryPreflight.includes("public") && githubRegistryPreflight.includes("draft"), "canonical publication must fail closed unless every npm package is absent");
const reconcileAssets = activeShell(findNamedStep(githubPublishJob, "Reconcile canonical assets without replacement"));
const uploadAssets = activeShell(findNamedStep(githubPublishJob, "Upload only missing canonical assets"));
const verifyDraft = activeShell(findNamedStep(githubPublishJob, "Re-download and verify canonical assets"));
check(reconcileAssets.includes("product-artifacts.mjs plan") && uploadAssets.includes("gh release upload") && !uploadAssets.includes("--clobber"), "draft recovery must reuse only byte-identical assets and upload only missing assets");
check(reconcileAssets.includes("RELEASE_MODE") && reconcileAssets.includes(".missing | length == 0"), "projection-only recovery must require the public GitHub asset set to remain exact");
check(verifyDraft.includes("product-artifacts.mjs plan") && verifyDraft.includes("product-artifacts.mjs validate"), "canonical publication must re-download and validate every draft asset");
const canonicalPublish = activeShell(findNamedStep(githubPublishJob, "Publish canonical GitHub Release"));
check(canonicalPublish.includes("--method PATCH") && canonicalPublish.includes("draft=false"), "GitHub publication must be the explicit canonical visibility transition");
check(findNamedStep(githubPublishJob, "Publish canonical GitHub Release")?.if === "env.RELEASE_MODE != 'project'", "projection-only recovery must never mutate the public GitHub Release");
check(activeShell(findNamedStep(githubPublishJob, "Revalidate immutable Release metadata")).includes("verify-release-metadata.mjs"), "canonical publication must revalidate changelog-derived metadata immediately before visibility changes");
check(activeShell(findNamedStep(githubPublishJob, "Verify canonical GitHub Release is public")).includes("verify-release-metadata.mjs"), "canonical publication and projection recovery must finish by re-reading public metadata");
check(releaseMetadataVerifier.includes("release.name !== metadata.name") && releaseMetadataVerifier.includes("normalizeReleaseBody(release.body) !== metadata.body"), "Release metadata verification must compare immutable name and normalized body");
check(releaseAssetPlanner.includes("does not match the rebuilt candidate") && releaseAssetPlanner.includes("unexpected assets"), "draft asset planner must fail closed on replacement or unexpected state");
check(releasePublicationTest.includes("main has advanced") && releasePublicationTest.includes("unexpected assets"), "release publication tests must inject source-state and draft-asset failures");

const publishJob = releaseWorkflow.jobs?.publish_npm;
equal(publishJob?.needs, ["release_authority", "npm_candidate", "publish_github"], "npm projection must start only after canonical GitHub publication");
check(publishJob?.["timeout-minutes"] === 30 && publishJob?.["runs-on"] === "ubuntu-latest", "npm trusted publishing must use a bounded GitHub-hosted job");
check(publishJob?.environment?.name === "npm", "npm publishing must use the npm environment");
check(publishJob?.permissions?.contents === "read" && publishJob?.permissions?.["id-token"] === "write", "npm publishing must retain read contents and OIDC permissions");
const npmReleaseVerification = activeShell(findNamedStep(publishJob, "Verify canonical release and exact npm candidate"));
check(npmReleaseVerification.includes("verify-release-metadata.mjs") && npmReleaseVerification.includes("product-artifacts.mjs validate"), "npm must revalidate the public canonical release and exact aggregate");
const registryPreflight = activeShell(findNamedStep(publishJob, "Classify exact npm projection"));
check(registryPreflight.includes("registry-projection.mjs npm dist/product public") && findNamedStep(publishJob, "Publish native packages, then root package")?.if === "steps.registry.outputs.state == 'absent'", "npm must re-prove complete registry absence before its first publish");
const publishShell = activeShell(findNamedStep(publishJob, "Publish native packages, then root package"));
check(publishShell.includes("mapfile -t root_tarballs") && publishShell.includes("Expected exactly one root package tarball") && publishShell.includes("if ! package_name=") && publishShell.includes("for tarball in dist/native/*.tgz") && publishShell.indexOf("dist/native/*.tgz") < publishShell.indexOf('root_tarballs[0]'), "npm publication must validate package identity, require one root tarball, and publish all native packages before it");
check(publishShell.includes("--provenance --access public") && publishShell.includes("npm projection incomplete") && publishShell.includes("Never repair published bytes"), "npm trusted publication must emit provenance and explicit partial-failure guidance");
check(!publishShell.includes("npm view") && !publishShell.includes("skipping"), "npm publication must not repair a partial version in place");

const pythonWorkflow = await readYaml(".github/workflows/python-candidate.yml");
const pythonTargets = await readJson("python-targets.json");
equal(pythonTargets.pythonVersions, ["3.11", "3.12", "3.13", "3.14"], "Python consumers must enumerate validated stable conventional CPython versions");
equal(pythonTargets.targets.map(t => t.rust), nativeTargets.targets.map(t => t.rustTarget), "Python targets must cover the approved native matrix");
equal(Object.keys(pythonWorkflow.jobs), ["matrix", "build", "aggregate", "consumer"], "Python candidate must build, aggregate, then consume");
for (const job of Object.values(pythonWorkflow.jobs)) {
  const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  check(checkout?.with?.ref === "${{ inputs.source_sha }}" && checkout.with["persist-credentials"] === false, "Python jobs must use exact source without stored credentials");
  for (const step of job.steps.filter(step => step.uses)) check(/@[0-9a-f]{40}$/.test(step.uses), "Python actions must be commit-pinned");
}
check(pythonWorkflow.jobs.build.strategy.matrix.includes("needs.matrix.outputs.builds") && pythonWorkflow.jobs.consumer.strategy.matrix.includes("needs.matrix.outputs.consumers"), "Python build/consumer matrix must come from one authority");
equal(pythonWorkflow.jobs.consumer.needs, ["matrix", "aggregate"], "Python consumers must await complete aggregate");
check(ciWorkflow.jobs["python-candidate"].uses === "./.github/workflows/python-candidate.yml" && ciWorkflow.jobs["python-candidate"].with.source_sha === "${{ github.sha }}", "CI must use shared Python candidate validation");
check(releaseWorkflow.jobs.python_candidate.uses === "./.github/workflows/python-candidate.yml" && releaseWorkflow.jobs.python_candidate.with.source_sha === "${{ needs.release_authority.outputs.source_sha }}", "Release must use identical tagged Python candidate validation");
const pypi = releaseWorkflow.jobs.publish_pypi;
equal(pypi.needs, ["release_authority", "publish_github"], "PyPI must follow canonical visibility independently of npm");
check(pypi.if === "vars.PYPI_RELEASE_ENABLED == 'true'" && pypi.environment.name === "pypi", "PyPI must remain separately gated and protected");
check(pypi.permissions["id-token"] === "write" && pypi.permissions.contents === "read", "PyPI must use scoped trusted identity");
const pypiUpload = findNamedStep(pypi, "Publish exact canonical wheels through trusted publishing");
check(pypiUpload.uses === "pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33" && pypiUpload.if === "steps.registry.outputs.state == 'absent'" && pypiUpload.with["skip-existing"] === false && pypiUpload.with["packages-dir"] === "dist/pypi", "PyPI must upload only wholly absent canonical wheels without repair");
check(findNamedStep(githubPublishJob, "Verify enabled PyPI projection state before visibility")?.if === "vars.PYPI_RELEASE_ENABLED == 'true'", "Enabled PyPI must pass absence policy before canonical visibility");
for (const [job, label] of [[publishJob, "npm"], [pypi, "PyPI"]]) {
  check(activeShell(findNamedStep(job, `Download immutable canonical product assets`)).includes("gh release download"), `${label} must use canonical downloaded bytes`);
  check(findNamedStep(job, `Verify complete ${label} projection`)?.run?.endsWith('public --wait-complete'), 'Post-publication verification must bound registry propagation');
  check(activeShell(findNamedStep(job, `Require complete ${label} projection`)).includes("= complete"), `${label} must verify completed publication`);
}

const manualCandidate = await readYaml('.github/workflows/cross-platform-candidate.yml');
equal(Object.keys(manualCandidate.on), ['workflow_dispatch'], 'Named cross-platform candidate must remain manual');
check('workflow_call' in ciWorkflow.on, 'CI must expose the shared candidate workflow');
equal(Object.keys(manualCandidate.jobs), ['candidate'], 'Manual candidate must reuse CI without duplicating its matrix');
check(manualCandidate.jobs.candidate.uses === './.github/workflows/ci.yml', 'Manual candidates must run the same validated CI jobs');

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Tagged-source release configuration is valid at ${nodePackage.version}`);
