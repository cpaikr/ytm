export function nativeBuildPlan(manifest, rustTarget) {
  const target = manifest.targets?.find((candidate) => candidate.rustTarget === rustTarget);
  if (!target) throw new Error(`Unknown native target: ${rustTarget}`);
  if (!target.buildTarget) throw new Error(`${rustTarget} does not declare a build target.`);

  const linuxGnu = target.npmPlatform === "linux" && target.libc === "glibc";
  const expectedBuildTarget = linuxGnu
    ? `${target.rustTarget}.${manifest.linuxNativeBuild?.glibcFloor}`
    : target.rustTarget;
  if (target.buildTarget !== expectedBuildTarget) {
    throw new Error(`${rustTarget} build target ${target.buildTarget} does not match the declared native build policy ${expectedBuildTarget}.`);
  }
  const command = linuxGnu ? "zigbuild" : "build";
  const args = [command, "--locked", "--release", "--target", target.buildTarget, "-p", "ytm-node"];
  const extension = target.npmPlatform === "win32"
    ? "dll"
    : target.npmPlatform === "darwin"
      ? "dylib"
      : "so";
  const prefix = target.npmPlatform === "win32" ? "" : "lib";
  return {
    target,
    command: "cargo",
    args,
    artifactTarget: target.rustTarget,
    artifactFileName: `${prefix}ytm_node.${extension}`,
    usesGlibcFloor: linuxGnu
  };
}
