import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const request = JSON.parse(process.env.YTM_JUDGE_REQUEST || "{}");
const packageRoot = resolve(request.packageRoot);
const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const exportTarget = pkg.exports?.["./toolset"]?.import;
if (!exportTarget) throw new Error("Package does not declare the ./toolset import export");
const module = await import(pathToFileURL(resolve(packageRoot, exportTarget)).href);
const toolset = module.createKisnetYtmToolset();

let value;
let error;
try {
  if (request.action === "inspect") {
    const operations = toolset.listOperations();
    value = {
      id: toolset.id,
      label: toolset.label,
      description: toolset.description,
      methods: ["help", "listOperations", "getOperation", "getCommandHelp", "validateInput", "execute", "serializeError"]
        .filter((name) => typeof toolset[name] === "function"),
      help: toolset.help(),
      operations,
      commandHelp: Object.fromEntries(operations.map(({ name }) => [name, toolset.getCommandHelp(name)]))
    };
  } else if (request.action === "validate") {
    value = toolset.validateInput(request.operation, request.input);
  } else if (request.action === "operation-mutation") {
    const operation = toolset.getOperation("matrix");
    operation.inputJsonSchema.properties.baseDate.description = "mutated";
    operation.examples[0].input.baseDate = "mutated";
    const listed = toolset.listOperations();
    listed[0].limitations[0] = "mutated";
    value = {
      operation: toolset.getOperation("matrix"),
      listed: toolset.listOperations()[0]
    };
  } else if (request.action === "execute") {
    let context;
    if (request.abortBeforeExecute) {
      const controller = new AbortController();
      controller.abort(new Error("judge cancellation"));
      context = { signal: controller.signal };
    }
    value = await toolset.execute(request.operation, request.input, context);
  } else {
    throw new Error(`Unknown runner action: ${request.action}`);
  }
} catch (caught) {
  error = toolset.serializeError(caught);
}

let requests = [];
if (process.env.YTM_JUDGE_CAPTURE_PATH) {
  try {
    requests = JSON.parse(await readFile(process.env.YTM_JUDGE_CAPTURE_PATH, "utf8"));
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
  }
}

process.stdout.write(`${JSON.stringify({
  ok: error === undefined,
  value,
  error,
  requests
})}\n`);
