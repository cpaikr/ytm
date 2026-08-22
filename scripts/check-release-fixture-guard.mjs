import { spawnSync } from "node:child_process";

const expected = "the judge-fixtures transport cannot be compiled into a release artifact";
for (const packageName of ["ytm-node", "ytm-cli"]) {
  const result = spawnSync("cargo", [
    "check",
    "--locked",
    "--release",
    "-p",
    packageName,
    "--all-features"
  ], { encoding: "utf8" });

  if (result.error) {
    throw new Error(`Could not run cargo check for ${packageName}: ${result.error.message}`, { cause: result.error });
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !output.includes(expected)) {
    console.error(output);
    throw new Error(`${packageName} release all-features build did not fail at the judge transport guard.`);
  }
}

console.log("Node and CLI release artifacts cannot enable the judge fixture transport");
