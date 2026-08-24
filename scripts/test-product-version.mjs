import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const validator = resolve(import.meta.dirname, "validate-product-version.mjs");
const fixtureFiles = [
  "VERSION",
  ".release-please-manifest.json",
  "release-please-config.json",
  "Cargo.toml",
  "Cargo.lock",
  "crates/ytm-cli/Cargo.toml",
  "crates/ytm-node/Cargo.toml",
  "tests/rust-sdk-consumer/Cargo.toml",
  "tests/rust-sdk-consumer/Cargo.lock",
  "packages/node/package.json",
  "packages/native/darwin-arm64/package.json",
  "packages/native/linux-arm64-gnu/package.json",
  "packages/native/linux-x64-gnu/package.json",
  "packages/native/win32-x64-msvc/package.json",
  "bun.lock",
  "CHANGELOG.md",
];

const copyFixture = async (root) => {
  for (const relative of fixtureFiles) {
    const destination = join(root, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repositoryRoot, relative), destination);
  }
};

const replace = async (root, relative, from, to) => {
  const path = join(root, relative);
  const contents = await readFile(path, "utf8");
  if (!contents.includes(from)) throw new Error(`fixture ${relative} does not contain ${from}`);
  await writeFile(path, contents.replace(from, to));
};

const runValidator = (root) => spawnSync(process.execPath, [validator], {
  cwd: root,
  encoding: "utf8",
});

// Mirrors the Generic updater in pinned release-please-action 4.4.1
// (release-please 17.3.0). This protects the exact Cargo requirement syntax
// that the TOML updater normalizes away when it serializes a value.
const applyReleasePleaseGenericVersion = (contents, nextVersion) => contents
  .split(/\r?\n/)
  .map((line) => line.includes("x-release-please-version")
    ? line.replace(/\d+\.\d+\.\d+(-[\w.]+)?(\+[-\w.]+)?/, nextVersion)
    : line)
  .join("\n");

const cases = [
  {
    name: "manifest drift",
    mutate: (root) => replace(root, ".release-please-manifest.json", '"0.2.0"', '"9.9.9"'),
    diagnostic: "Release Please manifest must match VERSION",
  },
  {
    name: "changelog drift",
    mutate: (root) => replace(root, "CHANGELOG.md", "## [0.2.0]", "## [9.9.9]"),
    diagnostic: "latest product changelog entry must match VERSION",
  },
  {
    name: "Cargo workspace drift",
    mutate: (root) => replace(root, "Cargo.toml", 'version = "0.2.0"', 'version = "9.9.9"'),
    diagnostic: "Cargo workspace version must match VERSION",
  },
  {
    name: "Rust consumer lock drift",
    mutate: (root) => replace(root, "tests/rust-sdk-consumer/Cargo.lock", 'name = "ytm-core"\nversion = "0.2.0"', 'name = "ytm-core"\nversion = "9.9.9"'),
    diagnostic: "Rust consumer lock ytm-core version must match VERSION",
  },
  {
    name: "Node package drift",
    mutate: (root) => replace(root, "packages/node/package.json", '"version": "0.2.0"', '"version": "9.9.9"'),
    diagnostic: "Node package version must match VERSION",
  },
  {
    name: "Bun lock drift",
    mutate: (root) => replace(root, "bun.lock", '"packages/node": {\n      "name": "@sjunepark/ytm",\n      "version": "0.2.0"', '"packages/node": {\n      "name": "@sjunepark/ytm",\n      "version": "9.9.9"'),
    diagnostic: "bun.lock Node workspace version must match VERSION",
  },
  {
    name: "Release Please update-set drift",
    mutate: async (root) => {
      const path = join(root, "release-please-config.json");
      const config = JSON.parse(await readFile(path, "utf8"));
      config.packages["."]["extra-files"].pop();
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    },
    diagnostic: "Release Please update set is missing",
  },
];

const temporaryRoot = await mkdtemp(join(tmpdir(), "ytm-version-test-"));
try {
  const baselineRoot = join(temporaryRoot, "baseline");
  await copyFixture(baselineRoot);
  const baseline = runValidator(baselineRoot);
  if (baseline.status !== 0) throw new Error(`baseline validation failed:\n${baseline.stderr}`);

  for (const relative of [
    "crates/ytm-cli/Cargo.toml",
    "crates/ytm-node/Cargo.toml",
    "tests/rust-sdk-consumer/Cargo.toml",
  ]) {
    const contents = await readFile(join(baselineRoot, relative), "utf8");
    const updated = applyReleasePleaseGenericVersion(contents, "9.9.9");
    if (!updated.includes('version = "=9.9.9"')) {
      throw new Error(`Release Please generic update did not preserve the exact requirement in ${relative}`);
    }
  }

  for (const testCase of cases) {
    const caseRoot = join(temporaryRoot, testCase.name.replaceAll(" ", "-"));
    await copyFixture(caseRoot);
    await testCase.mutate(caseRoot);
    const result = runValidator(caseRoot);
    if (result.status === 0) throw new Error(`${testCase.name} was not rejected`);
    if (!result.stderr.includes(testCase.diagnostic)) {
      throw new Error(`${testCase.name} did not report ${testCase.diagnostic}:\n${result.stderr}`);
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`Product version validator rejected ${cases.length} injected failures`);
