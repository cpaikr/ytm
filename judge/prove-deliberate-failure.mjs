import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const productRoot = resolve(root, "packages/node");
const sourceToolsetPath = resolve(productRoot, "dist/toolset.js");
if (!existsSync(sourceToolsetPath)) {
  throw new Error("Missing packages/node/dist/toolset.js; run `bun run build:judge` before proving judge sensitivity");
}
const temporaryRoot = await mkdtemp(join(tmpdir(), "ytm-judge-broken-"));

try {
  await cp(productRoot, temporaryRoot, { recursive: true });
  const toolsetPath = resolve(temporaryRoot, "dist/toolset.js");
  const source = await readFile(toolsetPath, "utf8");
  const marker = "return envelope.value;";
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 1) throw new Error(`Expected one native-result handoff marker, found ${occurrences}`);
  await writeFile(toolsetPath, source.replace(marker, "return { ...envelope.value, source: null };"));

  const proof = spawnSync(process.execPath, [
    resolve(root, "judge/run.mjs"),
    "--product-root", temporaryRoot,
    "--scenario", "matrix-success"
  ], { encoding: "utf8" });

  if (proof.status === 0) throw new Error("Judge accepted a deliberately corrupted public result envelope");
  if (!proof.stderr.includes("matrix-success: toolset public result differs from the approved golden result")) {
    throw new Error(`Judge failed for the wrong reason:\n${proof.stderr || proof.stdout}`);
  }
  console.log("deliberate-failure proof passed: judge rejected a corrupted public source envelope");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
