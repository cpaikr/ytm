import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  throw new Error("The pinned Linux native toolchain may only be installed on Linux runners.");
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const policy = manifest.linuxNativeBuild;
const zigArch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
if (!zigArch) throw new Error(`Unsupported Linux runner architecture ${process.arch}.`);
const archive = policy?.zigArchives?.[zigArch];
if (!archive) throw new Error(`No pinned Zig archive is declared for ${zigArch}.`);

const archiveName = `zig-${zigArch}-linux-${policy.zigVersion}.tar.xz`;
const installRoot = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "ytm-zig-"));
const archivePath = join(installRoot, archiveName);
const response = await fetch(archive.url);
if (!response.ok) throw new Error(`Could not download Zig ${policy.zigVersion}: HTTP ${response.status}.`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== archive.sha256) {
  throw new Error(`Zig archive checksum mismatch for ${zigArch}: expected ${archive.sha256}, received ${digest}.`);
}
await writeFile(archivePath, bytes);

execFileSync("tar", ["-xJf", archivePath, "-C", installRoot], { stdio: "inherit" });
const zigDirectory = join(installRoot, `zig-${zigArch}-linux-${policy.zigVersion}`);
const toolEnvironment = {
  ...process.env,
  PATH: `${zigDirectory}${process.env.PATH ? `:${process.env.PATH}` : ""}`
};
execFileSync(join(zigDirectory, "zig"), ["version"], { env: toolEnvironment, stdio: "inherit" });

const cargoInstall = spawnSync("cargo", ["install", "--locked", "cargo-zigbuild", "--version", policy.cargoZigbuildVersion], {
  cwd: repositoryRoot,
  env: toolEnvironment,
  stdio: "inherit"
});
if (cargoInstall.error) throw cargoInstall.error;
if (cargoInstall.status !== 0) process.exit(cargoInstall.status ?? 1);
execFileSync("cargo-zigbuild", ["--version"], { env: toolEnvironment, stdio: "inherit" });

if (process.env.GITHUB_PATH) await appendFile(process.env.GITHUB_PATH, `${zigDirectory}\n`);
console.log(`installed Zig ${policy.zigVersion} and cargo-zigbuild ${policy.cargoZigbuildVersion} for ${zigArch}`);
