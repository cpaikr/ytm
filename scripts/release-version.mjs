import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const [mode, tag] = process.argv.slice(2);
const run = (command, args) => execFileSync(command, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024,
}).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const replace = (path, pattern, replacement) => {
  const source = readFileSync(path, "utf8");
  assert.match(source, pattern, `${path} is missing its version field`);
  writeFileSync(path, source.replace(pattern, replacement));
};

if (mode === "upstream") {
  assert.equal(run("git", ["branch", "--show-current"]), "main");
  assert.equal(run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
  assert.equal(run("git", ["status", "--porcelain"]), "", "release preparation requires a clean checkout");
  run("git", ["fetch", "origin", "main"]);
  assert.equal(run("git", ["rev-parse", "HEAD"]), run("git", ["rev-parse", "origin/main"]),
    "release preparation requires main synchronized with freshly fetched origin/main");
} else if (mode === "sync" || mode === "check") {
  const { version } = json("package.json");
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "release version must be stable SemVer");
  if (mode === "sync") {
    writeFileSync("VERSION", `${version}\n`);
    replace("Cargo.toml", /(\[workspace\.package\][^[]*?^version = ")[^"]+("$)/m, `$1${version}$2`);
    for (const path of ["crates/ytm-cli/Cargo.toml", "crates/ytm-node/Cargo.toml", "crates/ytm-python/Cargo.toml", "tests/rust-sdk-consumer/Cargo.toml"]) {
      replace(path, /(ytm-core = \{[^\n]*version = "=)[^"]+("[^\n]*)/, `$1${version}$2`);
    }
    replace("packages/python/pyproject.toml", /(\[project\][^[]*?^version = ")[^"]+("$)/m, `$1${version}$2`);
    const nodePackage = json("packages/node/package.json");
    nodePackage.version = version;
    writeJson("packages/node/package.json", nodePackage);
    run(process.execPath, ["scripts/generate-native-packages.mjs"]);
    // Cargo owns Rust lockfile updates and dependency resolution.
    run("cargo", ["metadata", "--offline", "--format-version", "1"]);
    run("cargo", ["metadata", "--offline", "--format-version", "1", "--manifest-path", "tests/rust-sdk-consumer/Cargo.toml"]);
    // Bun 1.3.13 retains stale workspace version metadata even on install.
    // Update only source-owned workspace fields; preserve every resolved dependency.
    const lock = parseYaml(readFileSync("bun.lock", "utf8"));
    const targets = json("native-targets.json");
    for (const path of [targets.rootPackage, ...targets.targets.map(target => `${targets.nativePackageRoot}/${target.packageDirectory}`)]) {
      const source = json(`${path}/package.json`);
      assert.equal(lock.workspaces[path]?.name, source.name, `missing Bun workspace ${path}`);
      lock.workspaces[path].version = version;
      if (source.optionalDependencies) lock.workspaces[path].optionalDependencies = source.optionalDependencies;
    }
    writeJson("bun.lock", lock);
    run("bun", ["install", "--lockfile-only", "--ignore-scripts"]);
  }
  run(process.execPath, ["scripts/validate-product-version.mjs"]);
  if (tag) {
    assert.equal(tag, `v${version}`, "release tag must match the product version");
    assert.equal(run("git", ["rev-parse", "HEAD"]), run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]), "release tag must identify this checkout");
    run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  }
  console.log(`Release version ${version}: ${mode} passed`);
} else {
  throw new Error("Usage: release-version.mjs upstream | sync | check [tag]");
}
