import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliBuildPlan, loadCliReleasePolicy } from "./cli-release-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
const printPlan = process.argv.includes("--plan");
if (!rustTarget) throw new Error("Usage: node scripts/build-cli-artifact.mjs <rust-target> [--plan]");

const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
const plan = cliBuildPlan(manifest, linuxBuild, rustTarget);
if (printPlan) {
  console.log(JSON.stringify({
    command: plan.command,
    args: plan.args,
    artifactTarget: plan.artifactTarget,
    artifactFileName: plan.artifactFileName,
    buildTarget: plan.buildTarget,
    usesGlibcFloor: plan.usesGlibcFloor
  }));
  process.exit(0);
}

const result = spawnSync(plan.command, plan.args, { cwd: repositoryRoot, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const artifact = resolve(repositoryRoot, "target", plan.artifactTarget, "release", plan.artifactFileName);
await access(artifact).catch((error) => {
  throw new Error(`CLI build completed without producing ${artifact}`, { cause: error });
});
const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
const versionResult = spawnSync(artifact, ["--version"], { encoding: "utf8" });
if (versionResult.error) throw versionResult.error;
if (versionResult.status !== 0 || versionResult.stdout !== `ytm ${version}\n` || versionResult.stderr !== "") {
  throw new Error(`${rustTarget} executable identity mismatch: expected "ytm ${version}", received stdout=${JSON.stringify(versionResult.stdout)} stderr=${JSON.stringify(versionResult.stderr)} status=${versionResult.status}.`);
}
console.log(`${rustTarget} standalone CLI: ${artifact.slice(repositoryRoot.length + 1)}`);
