import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBuildPlan } from "./native-build-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
if (!rustTarget) throw new Error("Usage: node scripts/validate-native-artifact.mjs <rust-target>");

const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const target = manifest.targets.find((candidate) => candidate.rustTarget === rustTarget);
if (!target) throw new Error(`Unknown native target: ${rustTarget}`);
if (target.npmPlatform !== "linux" || target.libc !== "glibc") {
  throw new Error(`${rustTarget} is not a Linux GNU target with a glibc floor.`);
}

const plan = nativeBuildPlan(manifest, rustTarget);
const artifactPath = resolve(
  repositoryRoot,
  "target",
  plan.artifactTarget,
  "release",
  plan.artifactFileName
);
const artifact = await readFile(artifactPath);
if (artifact.subarray(0, 4).toString("latin1") !== "\u007fELF") {
  throw new Error(`${artifactPath} is not an ELF native artifact.`);
}

const floor = parseVersion(manifest.linuxNativeBuild?.glibcFloor);
const versions = [...artifact.toString("latin1").matchAll(/GLIBC_(\d+)\.(\d+)/g)]
  .map(([, major, minor]) => ({ major: Number(major), minor: Number(minor) }));
if (versions.length === 0) throw new Error(`${artifactPath} does not declare any GLIBC symbol versions.`);
const highest = versions.reduce((maximum, version) => compareVersion(version, maximum) > 0 ? version : maximum);
if (compareVersion(highest, floor) > 0) {
  throw new Error(`${artifactPath} requires GLIBC_${formatVersion(highest)}, above the declared floor GLIBC_${formatVersion(floor)}.`);
}
console.log(`${rustTarget} artifact requires at most GLIBC_${formatVersion(highest)} (floor GLIBC_${formatVersion(floor)})`);

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)$/.exec(value || "");
  if (!match) throw new Error(`Invalid glibc version ${JSON.stringify(value)}.`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function compareVersion(left, right) {
  return left.major - right.major || left.minor - right.minor;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}`;
}
