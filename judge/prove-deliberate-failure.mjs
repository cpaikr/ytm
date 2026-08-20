import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselineRoot = resolve(root, "packages/node");
const temporaryRoot = await mkdtemp(join(tmpdir(), "ytm-judge-broken-"));

try {
  await cp(baselineRoot, temporaryRoot, { recursive: true });
  const toolsetPath = resolve(temporaryRoot, "dist/toolset.js");
  const source = await readFile(toolsetPath, "utf8");
  const marker = "yields[label] = null;";
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 1) throw new Error(`Expected one missing-yield normalization marker, found ${occurrences}`);
  await writeFile(toolsetPath, source.replace(marker, "yields[label] = 0;"));

  const proof = spawnSync(process.execPath, [
    resolve(root, "judge/run.mjs"),
    "--baseline-root", baselineRoot,
    "--candidate-root", temporaryRoot,
    "--scenario", "missing-values"
  ], { encoding: "utf8" });

  if (proof.status === 0) throw new Error("Judge accepted deliberately broken missing-value behavior");
  if (!proof.stderr.includes("missing-values: public result differs")) {
    throw new Error(`Judge failed for the wrong reason:\n${proof.stderr || proof.stdout}`);
  }
  console.log("deliberate-failure proof passed: judge rejected missing-value null-to-zero mutation");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
