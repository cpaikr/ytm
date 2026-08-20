import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(repositoryRoot, "candidate/node");
const files = ["cli.js", "native.cjs", "native.js", "toolset.d.ts", "toolset.js"];
const stale = [];
for (const filename of files) {
  const source = await readFile(resolve(packageRoot, "src", filename));
  let built;
  try {
    built = await readFile(resolve(packageRoot, "dist", filename));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!built || !source.equals(built)) stale.push(filename);
}
if (stale.length > 0) {
  console.error(`Candidate dist is stale: ${stale.join(", ")}`);
  process.exit(1);
}
console.log("candidate dist is current");
