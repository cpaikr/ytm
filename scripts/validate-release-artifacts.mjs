import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeDirectory = resolve(repositoryRoot, process.argv[2] || "dist/native");
const rootDirectory = resolve(repositoryRoot, process.argv[3] || "dist/root");
const targets = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const rootSource = JSON.parse(await readFile(resolve(repositoryRoot, targets.rootPackage, "package.json"), "utf8"));
const expectedLicense = await readFile(resolve(repositoryRoot, "LICENSE.md"), "utf8");
const expectedThirdPartyLicenses = await readFile(resolve(repositoryRoot, "THIRD_PARTY_LICENSES.html"), "utf8");
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
  if (pkg.main !== target.artifactFile || JSON.stringify(pkg.files) !== JSON.stringify([target.artifactFile, "LICENSE.md", "THIRD_PARTY_LICENSES.html"])) {
    throw new Error(`${pkg.name} does not declare its native artifact and license notices exactly.`);
  }
  const entries = listTarball(tarball);
  const nativeEntries = entries.filter((entry) => entry.endsWith(".node"));
  if (JSON.stringify(nativeEntries) !== JSON.stringify([`package/${target.artifactFile}`])) {
    throw new Error(`${pkg.name} tarball must contain exactly package/${target.artifactFile}.`);
  }
  if (!entries.includes("package/LICENSE.md")) {
    throw new Error(`${pkg.name} tarball must contain LICENSE.md.`);
  }
  if (!entries.includes("package/THIRD_PARTY_LICENSES.html")) {
    throw new Error(`${pkg.name} tarball must contain THIRD_PARTY_LICENSES.html.`);
  }
  if (tarballEntry(tarball, "package/LICENSE.md") !== expectedLicense) {
    throw new Error(`${pkg.name} tarball LICENSE.md does not match the immutable source.`);
  }
  if (tarballEntry(tarball, "package/THIRD_PARTY_LICENSES.html") !== expectedThirdPartyLicenses) {
    throw new Error(`${pkg.name} tarball THIRD_PARTY_LICENSES.html does not match the immutable source.`);
  }
}

const root = packageJson(rootTarballs[0]);
if (root.name !== rootSource.name || root.version !== rootSource.version) {
  throw new Error(`Root tarball identity ${root.name}@${root.version} does not match ${rootSource.name}@${rootSource.version}.`);
}
if (root.bin !== undefined || rootSource.bin !== undefined) {
  throw new Error("The Node SDK root package must not declare a CLI bin.");
}
const expectedOptional = Object.fromEntries(targets.targets.map((target) => [target.packageName, rootSource.version]));
if (JSON.stringify(root.optionalDependencies) !== JSON.stringify(expectedOptional)) {
  throw new Error("Root tarball optionalDependencies do not match the native target manifest.");
}
const rootEntries = listTarball(rootTarballs[0]);
if (rootEntries.some((entry) => entry.endsWith(".node"))) {
  throw new Error("Root tarball must not contain a native artifact.");
}
if (rootEntries.some((entry) => /(?:^|\/)cli\.(?:[cm]?js|ts)$/.test(entry))) {
  throw new Error("Root Node SDK tarball must not contain a JavaScript CLI entry point.");
}
const binPaths = typeof rootSource.bin === "string" ? [rootSource.bin] : Object.values(rootSource.bin || {});
const expectedRootPaths = new Set([
  "package.json",
  ...binPaths,
  ...collectStringLeaves(rootSource.exports).map((entry) => entry.replace(/^\.\//, "")),
  "dist/native.cjs",
  "dist/native.js",
  "CHANGELOG.md",
  "LICENSE.md",
  "README.md",
  "SPEC.md",
  "skills/kisnet-ytm/SKILL.md"
]);
const expectedRootEntries = [...expectedRootPaths].map((entry) => `package/${entry}`);
const missingRootEntries = expectedRootEntries.filter((entry) => !rootEntries.includes(entry));
if (missingRootEntries.length > 0) {
  throw new Error(`Root tarball is missing required package entries: ${missingRootEntries.join(", ")}.`);
}

console.log(`release artifact set is complete for ${root.name}@${root.version}`);

async function tarballs(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

function packageJson(tarball) {
  return JSON.parse(tarballEntry(tarball, "package/package.json"));
}

function tarballEntry(tarball, entry) {
  const result = spawnSync("tar", ["-xOf", tarball, entry], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not read ${entry} from ${tarball}: ${result.stderr}`);
  return result.stdout;
}

function listTarball(tarball) {
  const result = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not list ${tarball}: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function collectStringLeaves(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStringLeaves);
}
