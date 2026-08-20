import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeDirectory = resolve(repositoryRoot, process.argv[2] || "dist/native");
const rootDirectory = resolve(repositoryRoot, process.argv[3] || "dist/root");
const targets = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const rootSource = JSON.parse(await readFile(resolve(repositoryRoot, targets.rootPackage, "package.json"), "utf8"));
const expectedNative = new Map(targets.targets.map((target) => [target.packageName, target]));

const nativeTarballs = await tarballs(nativeDirectory);
const rootTarballs = await tarballs(rootDirectory);
if (nativeTarballs.length !== expectedNative.size) {
  throw new Error(`Expected ${expectedNative.size} native tarballs, found ${nativeTarballs.length}.`);
}
if (rootTarballs.length !== 1) {
  throw new Error(`Expected one root tarball, found ${rootTarballs.length}.`);
}

const seen = new Set();
for (const tarball of nativeTarballs) {
  const pkg = packageJson(tarball);
  const target = expectedNative.get(pkg.name);
  if (!target) throw new Error(`Unexpected native package ${pkg.name} in ${tarball}.`);
  if (seen.has(pkg.name)) throw new Error(`Duplicate native package ${pkg.name}.`);
  seen.add(pkg.name);
  if (pkg.version !== rootSource.version) throw new Error(`${pkg.name} version ${pkg.version} does not match ${rootSource.version}.`);
  if (pkg.main !== target.artifactFile || JSON.stringify(pkg.files) !== JSON.stringify([target.artifactFile, "LICENSE.md"])) {
    throw new Error(`${pkg.name} does not declare its native artifact and license exactly.`);
  }
  const entries = listTarball(tarball);
  const nativeEntries = entries.filter((entry) => entry.endsWith(".node"));
  if (JSON.stringify(nativeEntries) !== JSON.stringify([`package/${target.artifactFile}`])) {
    throw new Error(`${pkg.name} tarball must contain exactly package/${target.artifactFile}.`);
  }
  if (!entries.includes("package/LICENSE.md")) {
    throw new Error(`${pkg.name} tarball must contain LICENSE.md.`);
  }
}

const root = packageJson(rootTarballs[0]);
if (root.name !== rootSource.name || root.version !== rootSource.version) {
  throw new Error(`Root tarball identity ${root.name}@${root.version} does not match ${rootSource.name}@${rootSource.version}.`);
}
const expectedOptional = Object.fromEntries(targets.targets.map((target) => [target.packageName, rootSource.version]));
if (JSON.stringify(root.optionalDependencies) !== JSON.stringify(expectedOptional)) {
  throw new Error("Root tarball optionalDependencies do not match the native target manifest.");
}
const rootEntries = listTarball(rootTarballs[0]);
if (rootEntries.some((entry) => entry.endsWith(".node"))) {
  throw new Error("Root tarball must not contain a native artifact.");
}

console.log(`release artifact set is complete for ${root.name}@${root.version}`);

async function tarballs(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

function packageJson(tarball) {
  const result = spawnSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not read package.json from ${tarball}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function listTarball(tarball) {
  const result = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not list ${tarball}: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
