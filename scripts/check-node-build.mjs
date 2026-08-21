import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(repositoryRoot, "packages/node");
const sourceDirectory = resolve(packageRoot, "src");
const distDirectory = resolve(packageRoot, "dist");
const sourceFiles = await fileNames(sourceDirectory);
const distFiles = (await fileNames(distDirectory)).filter((filename) => filename !== "ytm.node");
const files = [...new Set([...sourceFiles, ...distFiles])].sort();
const stale = [];
for (const filename of files) {
  const source = await maybeRead(resolve(sourceDirectory, filename));
  const built = await maybeRead(resolve(distDirectory, filename));
  if (!source || !built || !source.equals(built)) stale.push(filename);
}
if (stale.length > 0) {
  console.error(`Node package dist is stale: ${stale.join(", ")}`);
  process.exit(1);
}
console.log("Node package dist is current");

async function fileNames(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function maybeRead(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
