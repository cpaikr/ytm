import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const validationSteps = JSON.parse(await readFile(
  new URL("repository-validation.json", import.meta.url),
  "utf8"
));

for (const [command, args] of validationSteps) {
  const rendered = [command, ...args].join(" ");
  console.log(`\n==> ${rendered}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false
  });
  if (result.error) {
    console.error(`Unable to run ${rendered}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Validation failed: ${rendered}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nRepository validation passed");
