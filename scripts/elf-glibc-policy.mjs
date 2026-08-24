import { readFile } from "node:fs/promises";

export async function validateElfGlibcFloor(artifactPath, floorValue) {
  const artifact = await readFile(artifactPath);
  if (artifact.subarray(0, 4).toString("latin1") !== "\u007fELF") {
    throw new Error(`${artifactPath} is not an ELF artifact.`);
  }
  const floor = parseVersion(floorValue);
  const versions = [...artifact.toString("latin1").matchAll(/GLIBC_(\d+)\.(\d+)/g)]
    .map(([, major, minor]) => ({ major: Number(major), minor: Number(minor) }));
  if (versions.length === 0) throw new Error(`${artifactPath} does not declare any GLIBC symbol versions.`);
  const highest = versions.reduce((maximum, version) => compareVersion(version, maximum) > 0 ? version : maximum);
  if (compareVersion(highest, floor) > 0) {
    throw new Error(`${artifactPath} requires GLIBC_${formatVersion(highest)}, above the declared floor GLIBC_${formatVersion(floor)}.`);
  }
  return { highest: formatVersion(highest), floor: formatVersion(floor) };
}

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
