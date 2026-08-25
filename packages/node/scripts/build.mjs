import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const dist = resolve(packageRoot, "dist");
const sdkOnly = process.argv.includes("--sdk-only");
const extension = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
const prefix = process.platform === "win32" ? "" : "lib";
const native = resolve(repositoryRoot, `target/debug/${prefix}ytm_node.${extension}`);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const sourceFiles = (await readdir(resolve(packageRoot, "src"), { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
for (const filename of sourceFiles) {
  await copyFile(resolve(packageRoot, "src", filename), resolve(dist, filename));
}
if (!sdkOnly) await copyFile(native, resolve(dist, "ytm.node"));
