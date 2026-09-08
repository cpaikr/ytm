import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const equal = (actual, expected, message) => {
  check(actual === expected, `${message}: expected ${expected}, received ${actual}`);
};

const version = (await readFile("VERSION", "utf8")).trim();
check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), `VERSION must contain a stable SemVer value, received ${version}`);

const [
  rootPackage,
  cargoWorkspace,
  cargoLock,
  cliManifest,
  nodeRustManifest,
  pythonRustManifest,
  pythonManifest,
  rustConsumerManifest,
  rustConsumerLock,
  nodePackage,
  bunLock,
  changelog,
] = await Promise.all([
  readJson("package.json"),
  readFile("Cargo.toml", "utf8"),
  readFile("Cargo.lock", "utf8"),
  readFile("crates/ytm-cli/Cargo.toml", "utf8"),
  readFile("crates/ytm-node/Cargo.toml", "utf8"),
  readFile("crates/ytm-python/Cargo.toml", "utf8"),
  readFile("packages/python/pyproject.toml", "utf8"),
  readFile("tests/rust-sdk-consumer/Cargo.toml", "utf8"),
  readFile("tests/rust-sdk-consumer/Cargo.lock", "utf8"),
  readJson("packages/node/package.json"),
  readFile("bun.lock", "utf8").then(parseYaml),
  readFile("CHANGELOG.md", "utf8"),
]);

equal(rootPackage.version, version, "release-it workspace version must match VERSION");

const workspaceVersion = cargoWorkspace.match(/\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"/)?.[1];
equal(workspaceVersion, version, "Cargo workspace version must match VERSION");
for (const [path, contents] of [
  ["crates/ytm-cli/Cargo.toml", cliManifest],
  ["crates/ytm-node/Cargo.toml", nodeRustManifest],
  ["crates/ytm-python/Cargo.toml", pythonRustManifest],
  ["tests/rust-sdk-consumer/Cargo.toml", rustConsumerManifest],
]) {
  const dependencyVersion = contents.match(/ytm-core = \{[^\n]*version = "=([^"]+)"/)?.[1];
  equal(dependencyVersion, version, `${path} ytm-core dependency must match VERSION`);
}
const rustConsumerLockVersion = rustConsumerLock.match(/name = "ytm-core"\nversion = "([^"]+)"/)?.[1];
equal(rustConsumerLockVersion, version, "Rust consumer lock ytm-core version must match VERSION");
for (const crate of ["ytm-cli", "ytm-core", "ytm-node", "ytm-python"]) {
  const escaped = crate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lockVersion = cargoLock.match(new RegExp(`name = "${escaped}"\\nversion = "([^"]+)"`))?.[1];
  equal(lockVersion, version, `Cargo.lock ${crate} version must match VERSION`);
}

equal(pythonManifest.match(/\[project\][\s\S]*?\nversion = "([^"]+)"/)?.[1], version, "Python package version must match VERSION");

equal(nodePackage.version, version, "Node package version must match VERSION");
for (const [name, dependencyVersion] of Object.entries(nodePackage.optionalDependencies)) {
  equal(dependencyVersion, version, `${name} optional dependency must match VERSION`);
}
for (const target of ["darwin-arm64", "linux-arm64-gnu", "linux-x64-gnu", "win32-x64-msvc"]) {
  const nativePackage = await readJson(`packages/native/${target}/package.json`);
  equal(nativePackage.version, version, `${nativePackage.name} version must match VERSION`);
  equal(bunLock.workspaces[`packages/native/${target}`]?.version, version, `bun.lock ${target} workspace version must match VERSION`);
}
equal(bunLock.workspaces["packages/node"]?.version, version, "bun.lock Node workspace version must match VERSION");
for (const [name, dependencyVersion] of Object.entries(bunLock.workspaces["packages/node"]?.optionalDependencies || {})) {
  equal(dependencyVersion, version, `bun.lock ${name} optional dependency must match VERSION`);
}

const changelogVersion = changelog.match(/^##? (?:\[)?(\d+\.\d+\.\d+)(?:\])?/m)?.[1];
equal(changelogVersion, version, "latest product changelog entry must match VERSION");

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Product version authority is reconciled at ${version}`);
