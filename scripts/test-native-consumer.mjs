import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isNodeCliArtifact } from "./node-cli-artifact-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
if (!rustTarget) throw new Error("Usage: node scripts/test-native-consumer.mjs <rust-target>");
const exactNativeDirectory = process.argv[3] ? resolve(process.argv[3]) : null;
const exactRootDirectory = process.argv[4] ? resolve(process.argv[4]) : null;
if (Boolean(exactNativeDirectory) !== Boolean(exactRootDirectory)) {
  throw new Error("Exact consumer mode requires both native and root tarball directories.");
}
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const target = manifest.targets.find((candidate) => candidate.rustTarget === rustTarget);
if (!target) throw new Error(`Unknown native target: ${rustTarget}`);
if (process.platform !== target.npmPlatform || process.arch !== target.npmArch) {
  throw new Error(`Consumer runner is ${process.platform}-${process.arch}, expected ${target.npmPlatform}-${target.npmArch}.`);
}

const npm = process.platform === "win32" ? await resolveWindowsCommand("npm.cmd") : "npm";
const temporary = await mkdtemp(resolve(tmpdir(), "ytm-consumer-"));
try {
  const nativeTarball = exactNativeDirectory
    ? await findPackageTarball(exactNativeDirectory, target.packageName)
    : pack(resolve(repositoryRoot, manifest.nativePackageRoot, target.packageDirectory));
  const rootTarball = exactRootDirectory
    ? await findPackageTarball(exactRootDirectory, JSON.parse(await readFile(resolve(repositoryRoot, manifest.rootPackage, "package.json"), "utf8")).name)
    : pack(resolve(repositoryRoot, manifest.rootPackage));
  if (!exactRootDirectory) {
    const rootPack = JSON.parse(exec(npm, ["pack", "--dry-run", "--json", resolve(repositoryRoot, manifest.rootPackage)], { encoding: "utf8" }))[0];
    if (rootPack.files.some(({ path }) => path.endsWith(".node"))) {
      throw new Error("The root package must not embed a native artifact.");
    }
    if (rootPack.files.some(({ path }) => isNodeCliArtifact(path))) {
      throw new Error("The root Node SDK package must not contain a JavaScript CLI entry point.");
    }
  }

  await writeFile(resolve(temporary, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@sjunepark/ytm": `file:${rootTarball}`,
      [target.packageName]: `file:${nativeTarball}`
    }
  }, null, 2)}\n`);
  run(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], temporary);

  const inspection = run(process.execPath, [
    "--input-type=module",
    "-e",
    "const m=await import('@sjunepark/ytm/toolset');const t=m.createKisnetYtmToolset();const v=t.validateInput('matrix',{baseDate:'20260820',kind:'80'});const kinds=await t.execute('kinds');console.log(JSON.stringify({methods:['help','listOperations','getOperation','getCommandHelp','validateInput','execute','serializeError'].every(k=>typeof t[k]==='function'),operations:t.listOperations().map(x=>x.name),kind80:t.help().availableKinds.includes('80 = 회사채(사모)'),valid:v.ok,baseDate:v.input?.baseDate,nativeKinds:kinds.kinds?.map(x=>x.code)}));"
  ], temporary);
  const capability = parseJson(inspection, "installed toolset inspection");
  if (!capability.methods || capability.operations.join(",") !== "matrix,kinds" || !capability.kind80 || !capability.valid || capability.baseDate !== "2026-08-20" || capability.nativeKinds?.[0] !== "10" || !capability.nativeKinds.includes("80")) {
    throw new Error(`Installed toolset capability check failed: ${inspection.stdout}`);
  }

  const installedPackage = JSON.parse(await readFile(resolve(temporary, "node_modules/@sjunepark/ytm/package.json"), "utf8"));
  if (installedPackage.bin !== undefined) throw new Error("Installed Node SDK must not declare or distribute a CLI bin.");
  console.log(`${exactNativeDirectory ? "exact aggregated" : "clean"} Node SDK consumer passed ${rustTarget} on Node ${process.versions.node}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function pack(directory) {
  const result = JSON.parse(exec(npm, ["pack", "--json", "--pack-destination", temporary, directory], { encoding: "utf8" }))[0];
  if (!result?.filename) throw new Error(`npm pack did not report an artifact for ${directory}.`);
  return resolve(temporary, result.filename);
}

async function findPackageTarball(directory, expectedName) {
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => resolve(directory, entry.name));
  const matches = candidates.filter((tarball) => JSON.parse(tarballEntry(tarball, "package/package.json")).name === expectedName);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${expectedName} tarball in ${directory}, found ${matches.length}.`);
  return matches[0];
}

function tarballEntry(tarball, entry) {
  const result = spawn("tar", ["-xOf", tarball, entry]);
  if (result.status !== 0) throw new Error(`Could not read ${entry} from ${tarball}:\n${result.stderr}`);
  return result.stdout;
}

function run(command, args, cwd) {
  const result = spawn(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`${label} did not emit JSON (status ${result.status}):\n${result.stdout}\n${result.stderr}`, { cause });
  }
}

function spawn(command, args, cwd) {
  const invocation = commandInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    ...invocation.options
  });
}

function exec(command, args, options) {
  const invocation = commandInvocation(command, args);
  return execFileSync(invocation.command, invocation.args, {
    ...options,
    ...invocation.options
  });
}

function commandInvocation(command, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  const commandLine = [command, ...args].map(quoteCmdArgument).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    options: { windowsVerbatimArguments: true }
  };
}

async function resolveWindowsCommand(command) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, command);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`Could not resolve ${command} from PATH.`);
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (/[\0\r\n"]/.test(text)) {
    throw new Error("Windows command arguments must not contain NUL, line breaks, or quotes.");
  }
  return `"${text.replace(/%/g, "%%")}"`;
}
