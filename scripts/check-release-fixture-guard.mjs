import { spawnSync } from "node:child_process";

const result = spawnSync("cargo", [
  "check",
  "--locked",
  "--release",
  "-p",
  "ytm-node",
  "--all-features"
], { encoding: "utf8" });

if (result.error) {
  throw new Error(`Could not run cargo check: ${result.error.message}`, { cause: result.error });
}

const output = `${result.stdout || ""}\n${result.stderr || ""}`;
const expected = "the judge-fixtures transport cannot be compiled into a release artifact";
if (result.status === 0 || !output.includes(expected)) {
  console.error(output);
  throw new Error("Release all-features build did not fail at the judge transport guard.");
}

console.log("release artifacts cannot enable the judge fixture transport");
