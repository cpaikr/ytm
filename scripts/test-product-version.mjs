import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const validator = resolve(import.meta.dirname, "validate-product-version.mjs");
const currentVersion = (await readFile(join(repositoryRoot, "VERSION"), "utf8")).trim();
const fixtureFiles = [
  "VERSION",
  "package.json",
  "Cargo.toml",
  "Cargo.lock",
  "crates/ytm-cli/Cargo.toml",
  "crates/ytm-node/Cargo.toml",
  "crates/ytm-python/Cargo.toml",
  "tests/rust-sdk-consumer/Cargo.toml",
  "tests/rust-sdk-consumer/Cargo.lock",
  "packages/node/package.json",
  "packages/python/pyproject.toml",
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

const cases = [
  {
    name: "Python package drift",
    mutate: (root) => replace(root, "packages/python/pyproject.toml", `version = "${currentVersion}"`, 'version = "9.9.9"'),
    diagnostic: "Python package version must match VERSION",
  },
  {
    name: "Python binding lock drift",
    mutate: (root) => replace(root, "Cargo.lock", `name = "ytm-python"\nversion = "${currentVersion}"`, 'name = "ytm-python"\nversion = "9.9.9"'),
    diagnostic: "Cargo.lock ytm-python version must match VERSION",
  },
  {
    name: "release-it workspace drift",
    mutate: (root) => replace(root, "package.json", `"${currentVersion}"`, '"9.9.9"'),
    diagnostic: "release-it workspace version must match VERSION",
  },
  {
    name: "changelog drift",
    mutate: (root) => replace(root, "CHANGELOG.md", `[${currentVersion}]`, "[9.9.9]"),
    diagnostic: "latest product changelog entry must match VERSION",
  },
  {
    name: "Cargo workspace drift",
    mutate: (root) => replace(root, "Cargo.toml", `version = "${currentVersion}"`, 'version = "9.9.9"'),
    diagnostic: "Cargo workspace version must match VERSION",
  },
  {
    name: "Rust consumer lock drift",
    mutate: (root) => replace(root, "tests/rust-sdk-consumer/Cargo.lock", `name = "ytm-core"\nversion = "${currentVersion}"`, 'name = "ytm-core"\nversion = "9.9.9"'),
    diagnostic: "Rust consumer lock ytm-core version must match VERSION",
  },
  {
    name: "Node package drift",
    mutate: (root) => replace(root, "packages/node/package.json", `"version": "${currentVersion}"`, '"version": "9.9.9"'),
    diagnostic: "Node package version must match VERSION",
  },
  {
    name: "Bun lock drift",
    mutate: (root) => replace(root, "bun.lock", `"packages/node": {\n      "name": "@sjunepark/ytm",\n      "version": "${currentVersion}"`, '"packages/node": {\n      "name": "@sjunepark/ytm",\n      "version": "9.9.9"'),
    diagnostic: "bun.lock Node workspace version must match VERSION",
  },

];

const temporaryRoot = await mkdtemp(join(tmpdir(), "ytm-version-test-"));
try {
  const baselineRoot = join(temporaryRoot, "baseline");
  await copyFixture(baselineRoot);
  const baseline = runValidator(baselineRoot);
  if (baseline.status !== 0) throw new Error(`baseline validation failed:\n${baseline.stderr}`);

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
