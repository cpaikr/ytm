import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBuildPlan } from "./native-build-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
const printPlan = process.argv.includes("--plan");
if (!rustTarget) throw new Error("Usage: node scripts/build-native-artifact.mjs <rust-target> [--plan]");

const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const plan = nativeBuildPlan(manifest, rustTarget);
if (printPlan) {
  console.log(JSON.stringify({ command: plan.command, args: plan.args, artifactTarget: plan.artifactTarget, usesGlibcFloor: plan.usesGlibcFloor }));
  process.exit(0);
}

const result = spawnSync(plan.command, plan.args, { cwd: repositoryRoot, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const extension = plan.target.npmPlatform === "win32" ? "dll" : plan.target.npmPlatform === "darwin" ? "dylib" : "so";
const prefix = plan.target.npmPlatform === "win32" ? "" : "lib";
const artifact = resolve(repositoryRoot, "target", plan.artifactTarget, "release", `${prefix}ytm_node.${extension}`);
try {
  await access(artifact);
} catch (error) {
  throw new Error(`Native build completed without producing ${artifact}`, { cause: error });
}
console.log(`${rustTarget} production artifact: ${artifact.slice(repositoryRoot.length + 1)}`);
