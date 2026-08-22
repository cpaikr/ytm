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

  const missingCli = spawnSync(process.execPath, [
    resolve(root, "judge/run.mjs"),
    "--surface", "cli",
    "--scenario", "cli-machine-contract:help",
    "--cli-bin", resolve(temporaryRoot, "missing-ytm")
  ], { encoding: "utf8" });
  if (missingCli.status !== 1 || !missingCli.stderr.includes("standalone CLI does not exist")) {
    throw new Error(`Judge did not report an unavailable CLI cleanly:\n${missingCli.stderr || missingCli.stdout}`);
  }
  if (missingCli.stderr.includes("SyntaxError")) {
    throw new Error(`Judge parsed output from an unavailable CLI:\n${missingCli.stderr}`);
  }

  const unexecutableCli = spawnSync(process.execPath, [
    resolve(root, "judge/run.mjs"),
    "--surface", "cli",
    "--scenario", "cli-machine-contract:help",
    "--cli-bin", resolve(root, "README.md")
  ], { encoding: "utf8" });
  if (unexecutableCli.status !== 1 || !unexecutableCli.stderr.includes("standalone CLI did not start")) {
    throw new Error(`Judge did not report an unexecutable CLI cleanly:\n${unexecutableCli.stderr || unexecutableCli.stdout}`);
  }
  if (unexecutableCli.stderr.includes("public result differs")) {
    throw new Error(`Judge compared output from an unexecutable CLI:\n${unexecutableCli.stderr}`);
  }
  console.log("deliberate-failure proof passed: judge rejected a corrupted public source envelope");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
