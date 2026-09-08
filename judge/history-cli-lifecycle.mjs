import { spawnSync } from "node:child_process";
const result = spawnSync(process.env.PYO3_PYTHON || "python3", ["judge/history-cli-lifecycle.py"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
