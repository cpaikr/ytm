import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = spawnSync("cargo", ["about", "--version"], { encoding: "utf8" });
if (version.status !== 0) {
  throw new Error(`cargo-about 0.9.2 is required: ${version.stderr.trim()}`);
}
if (version.stdout.trim() !== "cargo-about 0.9.2") {
  throw new Error(`Expected cargo-about 0.9.2, received ${version.stdout.trim()}.`);
}

const generated = spawnSync(
  "cargo",
  ["about", "generate", "about.hbs", "--locked", "--fail"],
  { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
);
if (generated.status !== 0) {
  throw new Error(`Could not generate third-party licenses:\n${generated.stderr.trim()}`);
}

const expected = await readFile(resolve(repositoryRoot, "THIRD_PARTY_LICENSES.html"), "utf8");
if (generated.stdout !== `${expected}\n`) {
  throw new Error("THIRD_PARTY_LICENSES.html is stale; run bun run licenses:generate.");
}
console.log("third-party license notices are current");
