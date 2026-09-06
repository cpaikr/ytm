import { spawnSync } from "node:child_process";
const python = process.env.PYO3_PYTHON || "python3";
const result = spawnSync(python, ["scripts/validate-python.py"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
