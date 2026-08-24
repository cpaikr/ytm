import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export async function loadCliReleasePolicy(repositoryRoot) {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "cli-targets.json"), "utf8"));
  const reference = manifest.linuxBuildPolicy;
  if (reference?.manifest !== "native-targets.json" || reference?.field !== "linuxNativeBuild") {
    throw new Error("CLI Linux builds must reference native-targets.json#linuxNativeBuild.");
  }
  const shared = JSON.parse(await readFile(resolve(repositoryRoot, reference.manifest), "utf8"));
  const linuxBuild = shared[reference.field];
  if (!linuxBuild) throw new Error("The shared Linux build policy is missing.");
  validateCliManifest(manifest, linuxBuild);
  return { manifest, linuxBuild };
}

export function validateCliManifest(manifest, linuxBuild) {
  if (manifest.schemaVersion !== 1) throw new Error("CLI target manifest schemaVersion must be 1.");
  if (manifest.supportClaim !== "supported") throw new Error("CLI targets must declare the supported claim.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository || "")) {
    throw new Error("CLI target manifest must declare an owner/repository identity.");
  }
  if (manifest.binaryName !== "ytm" || manifest.assetPrefix !== "ytm") {
    throw new Error("CLI binary and asset identity must remain ytm.");
  }
  if (manifest.checksumFile !== "SHA256SUMS") throw new Error("CLI checksum asset must be SHA256SUMS.");
  if (manifest.installerAssets?.shell !== "install.sh" || manifest.installerAssets?.powershell !== "install.ps1") {
    throw new Error("CLI installer asset names must remain install.sh and install.ps1.");
  }
  if (JSON.stringify(manifest.licenseFiles) !== JSON.stringify(["LICENSE.md", "THIRD_PARTY_LICENSES.html"])) {
    throw new Error("CLI archives must contain the repository license and third-party notices.");
  }
  if (!/^\d+\.\d+$/.test(linuxBuild?.glibcFloor || "")) throw new Error("CLI Linux builds require a numeric glibc floor.");

  const targets = manifest.targets || [];
  if (targets.length === 0) throw new Error("CLI target manifest must declare at least one target.");
  for (const field of ["key", "rustTarget"]) {
    if (new Set(targets.map((target) => target[field])).size !== targets.length) {
      throw new Error(`Every CLI target must have a unique ${field}.`);
    }
  }
  for (const target of targets) validateTarget(target);
}

function validateTarget(target) {
  if (!/^[a-z0-9-]+$/.test(target.key || "")) throw new Error(`Invalid CLI target key ${JSON.stringify(target.key)}.`);
  if (!/^[A-Za-z0-9_.-]+$/.test(target.rustTarget || "")) throw new Error(`${target.key} has an invalid Rust target.`);
  if (!target.runner) throw new Error(`${target.key} must declare a GitHub-hosted runner.`);
  if (!new Set(["linux", "darwin", "win32"]).has(target.os)) throw new Error(`${target.key} has unsupported OS ${target.os}.`);
  if (!new Set(["x64", "arm64"]).has(target.arch)) throw new Error(`${target.key} has unsupported architecture ${target.arch}.`);
  const expectedFormat = target.os === "win32" ? "zip" : "tar.gz";
  const expectedExecutable = target.os === "win32" ? "ytm.exe" : "ytm";
  if (target.archiveFormat !== expectedFormat) throw new Error(`${target.key} must use ${expectedFormat}.`);
  if (target.executableFile !== expectedExecutable) throw new Error(`${target.key} must package ${expectedExecutable}.`);
  if (target.os === "linux" && target.libc !== "glibc") throw new Error(`${target.key} must declare glibc.`);
  if (target.os !== "linux" && target.libc !== undefined) throw new Error(`${target.key} must not declare a libc.`);
  if (target.os === "win32") {
    if (target.shellKernel !== undefined || target.shellMachines !== undefined) throw new Error(`${target.key} must not declare shell selectors.`);
  } else if (!target.shellKernel || !Array.isArray(target.shellMachines) || target.shellMachines.length === 0) {
    throw new Error(`${target.key} must declare shell platform selectors.`);
  }
}

export function cliBuildPlan(manifest, linuxBuild, rustTarget) {
  const target = manifest.targets.find((candidate) => candidate.rustTarget === rustTarget);
  if (!target) throw new Error(`Unknown CLI target: ${rustTarget}`);
  const usesGlibcFloor = target.os === "linux" && target.libc === "glibc";
  const buildTarget = usesGlibcFloor ? `${target.rustTarget}.${linuxBuild.glibcFloor}` : target.rustTarget;
  return {
    target,
    command: "cargo",
    args: [usesGlibcFloor ? "zigbuild" : "build", "--locked", "--release", "--target", buildTarget, "-p", "ytm-cli"],
    artifactTarget: target.rustTarget,
    artifactFileName: target.executableFile,
    buildTarget,
    usesGlibcFloor
  };
}

export function assertReleaseIdentity(version, sourceCommit) {
  if (!VERSION_PATTERN.test(version || "")) throw new Error(`Invalid release version ${JSON.stringify(version)}.`);
  if (!SHA_PATTERN.test(sourceCommit || "")) throw new Error(`Invalid source commit ${JSON.stringify(sourceCommit)}.`);
}

export function cliArchiveName(manifest, target, version) {
  if (!VERSION_PATTERN.test(version || "")) throw new Error(`Invalid release version ${JSON.stringify(version)}.`);
  return `${manifest.assetPrefix}-v${version}-${target.key}.${target.archiveFormat}`;
}

export function cliArchiveRoot(manifest, target, version) {
  return `${manifest.assetPrefix}-v${version}-${target.key}`;
}

export function expectedArchiveEntries(manifest, target, version) {
  const root = cliArchiveRoot(manifest, target, version);
  return [target.executableFile, ...manifest.licenseFiles].map((file) => `${root}/${file}`);
}

export function releaseBaseUrl(manifest, version) {
  return `https://github.com/${manifest.repository}/releases/download/v${version}`;
}
