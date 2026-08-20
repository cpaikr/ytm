import { access, readFile } from "node:fs/promises";
import { parse } from "yaml";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readYaml = async (path) => parse(await readFile(path, "utf8"));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const hasOwn = (value, key) => value != null && Object.hasOwn(value, key);
const findNamedStep = (job, name) => job?.steps?.find((step) => step.name === name);
const usesAction = (step, action) => typeof step?.uses === "string" && step.uses.startsWith(`${action}@`);
const activeShell = (step) => typeof step?.run === "string"
  ? step.run.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).join("\n")
  : "";

const [
  rootPackage,
  nodePackage,
  manifest,
  config,
  pyproject,
  uvLock,
  bunLock,
  ciWorkflow,
  npmWorkflow,
  pypiWorkflow,
  nodeChangelog,
  pythonChangelog
] = await Promise.all([
  readJson("package.json"),
  readJson("packages/node/package.json"),
  readJson(".release-please-manifest.json"),
  readJson("release-please-config.json"),
  readFile("packages/python/pyproject.toml", "utf8"),
  readFile("packages/python/uv.lock", "utf8"),
  readFile("bun.lock", "utf8"),
  readYaml(".github/workflows/ci.yml"),
  readYaml(".github/workflows/release.yml"),
  readYaml(".github/workflows/release-python.yml"),
  readFile("packages/node/CHANGELOG.md", "utf8"),
  readFile("packages/python/CHANGELOG.md", "utf8")
]);
const releasePleaseWorkflowPresent = await access(".github/workflows/release-please.yml")
  .then(() => true, () => false);

const pythonVersion = /^version = "([^"]+)"$/m.exec(pyproject)?.[1];
const uvVersion = /\[\[package\]\]\nname = "kisnet-ytm"\nversion = "([^"]+)"/.exec(uvLock)?.[1];
const bunVersion = /"packages\/node"\s*:\s*\{[\s\S]*?"version":\s*"([^"]+)"/.exec(bunLock)?.[1];
const expectedManifestPaths = ["packages/node", "packages/python"];
const manifestPaths = Object.keys(manifest).sort();
const manifestVersions = expectedManifestPaths.map((path) => manifest[path]);
const versions = [nodePackage.version, pythonVersion, uvVersion, bunVersion, ...manifestVersions];

check(rootPackage.private === true, "root package must remain private");
check(rootPackage.version === undefined, "root package must not become a release component");
check(JSON.stringify(rootPackage.workspaces) === JSON.stringify(["packages/*"]), "root workspaces must remain packages/*");
check(JSON.stringify(manifestPaths) === JSON.stringify(expectedManifestPaths), "Release Please manifest must contain exactly the Node and Python package paths");
check(manifestVersions.every((version) => typeof version === "string" && version.length > 0), "Release Please manifest versions must be non-empty strings");
check(versions.every((version) => version === nodePackage.version), `all package, lock, and manifest versions must match: ${versions.join(", ")}`);
check(uvLock.includes(`version = "${nodePackage.version}" # x-release-please-version`), "uv.lock package version must retain its Release Please annotation");
check(bunLock.includes(`"version": "${nodePackage.version}", // x-release-please-version`), "bun.lock workspace version must retain its Release Please annotation");

const packagePaths = Object.keys(config.packages || {}).sort();
check(JSON.stringify(packagePaths) === JSON.stringify(["packages/node", "packages/python"]), "Release Please must manage exactly the Node and Python package paths");
check(config["bootstrap-sha"] === "7f837f20deb08008361ed2c280f8342dff42da98", "Release Please must bootstrap from the historical v0.1.1 release commit");
check(config["include-component-in-tag"] === true, "Release Please tags must include components");
check(config["include-v-in-tag"] === true, "Release Please component tags must retain the v prefix");
check(!Object.hasOwn(config, "release-as") && packagePaths.every((path) => !Object.hasOwn(config.packages[path], "release-as")), "the first shared release version must not be selected in repository config");
const nodeRelease = config.packages?.["packages/node"];
const pythonRelease = config.packages?.["packages/python"];
check(nodeRelease?.["release-type"] === "node" && nodeRelease?.component === "node", "Node Release Please component must use the node strategy and component");
check(pythonRelease?.["release-type"] === "python" && pythonRelease?.component === "python", "Python Release Please component must use the python strategy and component");
check(nodeRelease?.["changelog-path"] === "CHANGELOG.md" && nodeChangelog.startsWith("# Changelog"), "Node must own a package-local changelog");
check(pythonRelease?.["changelog-path"] === "CHANGELOG.md" && pythonChangelog.startsWith("# Changelog"), "Python must own a package-local changelog");
check(JSON.stringify(nodeRelease?.["extra-files"]) === JSON.stringify(["/bun.lock"]), "Node release must update the root Bun lock");
check(JSON.stringify(pythonRelease?.["extra-files"]) === JSON.stringify(["/packages/python/uv.lock"]), "Python release must update its uv lock");
const linked = config.plugins?.find((plugin) => plugin.type === "linked-versions");
check(linked?.groupName === "ytm", "Release Please must use the ytm linked-version group");
check(JSON.stringify([...(linked?.components || [])].sort()) === JSON.stringify(["node", "python"]), "linked-version group must contain node and python");

check(!releasePleaseWorkflowPresent, "Release Please automation must remain absent until a release process is explicitly reintroduced");

const ciPackageValidation = findNamedStep(ciWorkflow.jobs?.["python-package"], "Validate wheel and extracted source distribution");
check(ciPackageValidation?.["working-directory"] === "packages/python" && ciPackageValidation?.run === "uv run --locked --python 3.11 python scripts/validate_dist.py --python-version 3.11", "CI must validate the extracted Python source distribution from packages/python");

const npmMetadata = findNamedStep(npmWorkflow.jobs?.metadata, "Validate component metadata");
const npmMetadataCheckout = findNamedStep(npmWorkflow.jobs?.metadata, "Check out source");
const npmValidationCheckout = findNamedStep(npmWorkflow.jobs?.npm_validation, "Check out source");
const npmPublishJob = npmWorkflow.jobs?.publish;
const npmPublishCheckout = findNamedStep(npmPublishJob, "Check out source");
const npmPublish = findNamedStep(npmPublishJob, "Publish npm package");
check(JSON.stringify(npmWorkflow.on?.push?.tags) === JSON.stringify(["node-v*.*.*"]), "npm workflow must trigger only from Node component tags");
check(npmWorkflow.on?.workflow_dispatch?.inputs?.tag?.required === true, "npm workflow must support dispatching an existing required tag");
check(npmMetadataCheckout?.with?.ref === "${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.sha }}", "npm metadata must resolve manual dispatches through the exact tag namespace and tag pushes through the event commit");
check(npmWorkflow.jobs?.metadata?.outputs?.source_sha === "${{ steps.package.outputs.source_sha }}" && activeShell(npmMetadata).includes("SOURCE_SHA=$(git rev-parse HEAD)") && activeShell(npmMetadata).includes('echo "source_sha=$SOURCE_SHA" >> "$GITHUB_OUTPUT"'), "npm metadata must resolve and expose the immutable release commit");
check(npmValidationCheckout?.with?.ref === "${{ needs.metadata.outputs.source_sha }}" && npmPublishCheckout?.with?.ref === "${{ needs.metadata.outputs.source_sha }}", "npm validation and publishing must check out the immutable release commit");
check(activeShell(npmMetadata).includes('if [ "$SOURCE_TAG" != "node-v$PACKAGE_VERSION" ]; then'), "npm metadata job must verify its component tag and version");
check(npmPublishJob?.environment?.name === "npm", "npm publish job must use the npm GitHub environment");
check(npmPublishJob?.permissions?.contents === "read" && npmPublishJob?.permissions?.["id-token"] === "write", "npm publish job must retain read contents and OIDC permissions");
check(npmPublish?.["working-directory"] === "packages/node", "npm publish must run from packages/node");
check(activeShell(npmPublish).includes("npm publish --access public"), "npm publish job must publish the public package");

const pypiMetadata = findNamedStep(pypiWorkflow.jobs?.metadata, "Validate component metadata");
const pypiMetadataCheckout = findNamedStep(pypiWorkflow.jobs?.metadata, "Check out source");
const pypiValidationJob = pypiWorkflow.jobs?.python_validation;
const pypiValidationCheckout = findNamedStep(pypiValidationJob, "Check out source");
const pypiDistributionValidation = findNamedStep(pypiValidationJob, "Validate wheel and extracted source distribution");
const pypiUpload = findNamedStep(pypiValidationJob, "Upload Python distributions");
const pypiPublishJob = pypiWorkflow.jobs?.publish;
const pypiDownload = findNamedStep(pypiPublishJob, "Download Python distributions");
const pypiPublish = findNamedStep(pypiPublishJob, "Publish Python package");
check(JSON.stringify(pypiWorkflow.on?.push?.tags) === JSON.stringify(["python-v*.*.*"]), "PyPI workflow must trigger only from Python component tags");
check(pypiWorkflow.on?.workflow_dispatch?.inputs?.tag?.required === true, "PyPI workflow must support dispatching an existing required tag");
check(pypiMetadataCheckout?.with?.ref === "${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.sha }}", "PyPI metadata must resolve manual dispatches through the exact tag namespace and tag pushes through the event commit");
check(pypiWorkflow.jobs?.metadata?.outputs?.source_sha === "${{ steps.package.outputs.source_sha }}" && activeShell(pypiMetadata).includes("SOURCE_SHA=$(git rev-parse HEAD)") && activeShell(pypiMetadata).includes('echo "source_sha=$SOURCE_SHA" >> "$GITHUB_OUTPUT"'), "PyPI metadata must resolve and expose the immutable release commit");
check(pypiValidationCheckout?.with?.ref === "${{ needs.metadata.outputs.source_sha }}", "PyPI validation must check out the immutable release commit");
check(activeShell(pypiMetadata).includes('if [ "$SOURCE_TAG" != "python-v$PACKAGE_VERSION" ]; then'), "PyPI metadata job must verify its component tag and version");
check(pypiDistributionValidation?.["working-directory"] === "packages/python" && pypiDistributionValidation?.run === "uv run --locked --python 3.11 python scripts/validate_dist.py --python-version 3.11", "PyPI release validation must test the extracted source distribution from packages/python");
check(usesAction(pypiUpload, "actions/upload-artifact") && pypiUpload?.with?.path === "packages/python/dist/*", "PyPI validation job must upload the built distributions");
check(usesAction(pypiDownload, "actions/download-artifact") && pypiDownload?.with?.path === "dist", "PyPI publish job must download the validated distributions");
check(pypiPublishJob?.environment?.name === "pypi", "PyPI publish job must use the pypi GitHub environment");
check(pypiPublishJob?.permissions?.contents === "read" && pypiPublishJob?.permissions?.["id-token"] === "write", "PyPI publish job must retain read contents and OIDC permissions");
check(pypiPublish?.run === "uv publish --check-url https://pypi.org/simple/ --trusted-publishing always dist/*", "PyPI workflow must publish idempotently with trusted publishing");

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`release configuration valid at shared baseline ${nodePackage.version}`);
