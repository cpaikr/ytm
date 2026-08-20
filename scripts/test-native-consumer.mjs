import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
if (!rustTarget) throw new Error("Usage: node scripts/test-native-consumer.mjs <rust-target>");
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const target = manifest.targets.find((candidate) => candidate.rustTarget === rustTarget);
if (!target) throw new Error(`Unknown native target: ${rustTarget}`);
if (process.platform !== target.npmPlatform || process.arch !== target.npmArch) {
  throw new Error(`Consumer runner is ${process.platform}-${process.arch}, expected ${target.npmPlatform}-${target.npmArch}.`);
}

const npm = process.platform === "win32" ? await resolveWindowsCommand("npm.cmd") : "npm";
const temporary = await mkdtemp(resolve(tmpdir(), "ytm-consumer-"));
try {
  const nativeTarball = pack(resolve(repositoryRoot, manifest.candidateNativePackageRoot, target.packageDirectory));
  const rootTarball = pack(resolve(repositoryRoot, manifest.candidateRootPackage));
  const rootPack = JSON.parse(exec(npm, ["pack", "--dry-run", "--json", resolve(repositoryRoot, manifest.candidateRootPackage)], { encoding: "utf8" }))[0];
  if (rootPack.files.some(({ path }) => path.endsWith(".node"))) {
    throw new Error("The root package must not embed a native artifact.");
  }

  await writeFile(resolve(temporary, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@sjunepark/ytm": `file:${rootTarball}`,
      [target.packageName]: `file:${nativeTarball}`
    }
  }, null, 2)}\n`);
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], temporary);

  const inspection = run(process.execPath, [
    "--input-type=module",
    "-e",
    "const m=await import('@sjunepark/ytm/toolset');const t=m.createKisnetYtmToolset();const v=t.validateInput('matrix',{baseDate:'20260820',kind:'80'});console.log(JSON.stringify({methods:['help','listOperations','getOperation','getCommandHelp','validateInput','execute','serializeError'].every(k=>typeof t[k]==='function'),operations:t.listOperations().map(x=>x.name),kind80:t.help().includes('80 = 회사채(사모)'),valid:v.valid,baseDate:v.normalizedInput?.baseDate}));"
  ], temporary);
  const capability = JSON.parse(inspection.stdout);
  if (!capability.methods || capability.operations.join(",") !== "matrix,kinds" || !capability.kind80 || !capability.valid || capability.baseDate !== "2026-08-20") {
    throw new Error(`Installed toolset capability check failed: ${inspection.stdout}`);
  }

  const cli = resolve(temporary, "node_modules/.bin", process.platform === "win32" ? "ytm.cmd" : "ytm");
  const kinds = run(cli, ["kinds", "--format", "json"], temporary);
  const kindsResult = JSON.parse(kinds.stdout);
  if (kindsResult.result?.kinds?.at(-1)?.code !== "80") throw new Error("Installed CLI omitted canonical kind 80.");
  const invalid = spawn(cli, ["matrix", "--kind", "80"], temporary);
  if (invalid.status !== 2 || JSON.parse(invalid.stdout).error?.code !== "missing_parameter" || !invalid.stderr.includes("matrix")) {
    throw new Error("Installed CLI validation/stdout/stderr contract failed.");
  }
  console.log(`clean consumer passed ${rustTarget} on Node ${process.versions.node}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function pack(directory) {
  const result = JSON.parse(exec(npm, ["pack", "--json", "--pack-destination", temporary, directory], { encoding: "utf8" }))[0];
  if (!result?.filename) throw new Error(`npm pack did not report an artifact for ${directory}.`);
  return resolve(temporary, result.filename);
}

function run(command, args, cwd) {
  const result = spawn(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
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
