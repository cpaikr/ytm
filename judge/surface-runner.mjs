import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const request = JSON.parse(process.env.YTM_JUDGE_REQUEST || "{}");
const packageRoot = resolve(request.packageRoot);
const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const exportTarget = pkg.exports?.["."]?.import;
if (!exportTarget) throw new Error("Package does not declare the root Node SDK export");
const module = await import(pathToFileURL(resolve(packageRoot, exportTarget)).href);
const client = new module.YtmClient();

let value;
let error;
try {
  if (request.action === "inspect") {
    value = {
      exports: Object.keys(module).sort(),
      methods: Object.entries(
        Object.getOwnPropertyDescriptors(Object.getPrototypeOf(client))
      )
        .filter(([name, descriptor]) => name !== "constructor" && typeof descriptor.value === "function")
        .map(([name]) => name)
    };
  } else if (request.action === "validate") {
    value = request.operation === "matrix"
      ? module.validateMatrixInput(request.input)
      : module.validateKindsInput(request.input);
  } else if (request.action === "client-regressions") {
    const circularDetails = {
      ok: true,
      code: "foreign_error",
      reason: "Foreign failure",
      retained: { value: 7 },
      ignored() {},
      large: 42n
    };
    circularDetails.self = circularDetails;
    const sharedDetails = { value: 11 };
    const hostileError = {};
    Object.defineProperty(hostileError, "details", {
      get() { throw new Error("hostile details getter"); }
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    let hostileConstructor;
    try {
      hostileConstructor = new module.YtmError(revoked.proxy).details;
    } catch (caught) {
      hostileConstructor = { threw: true, name: caught?.name };
    }
    value = {
      kindsWithoutInput: await client.kinds(),
      nonObject: module.validateMatrixInput(null),
      blankKind: module.validateMatrixInput({ baseDate: request.baseDate, kind: "   " }),
      earlyYearDates: ["0000-02-29", "0001-01-01", "0099-12-31"]
        .map((baseDate) => module.validateMatrixInput({ baseDate, kind: "10" })),
      invalidEarlyLeapDay: module.validateMatrixInput({ baseDate: "0001-02-29", kind: "10" }),
      nonFiniteKinds: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
        .map((kind) => module.validateMatrixInput({ baseDate: request.baseDate, kind })),
      scalarDetails: module.serializeYtmError({ details: "not-an-error-envelope" }),
      arrayDetails: module.serializeYtmError({ details: ["not-an-error-envelope"] }),
      objectDetails: module.serializeYtmError({ details: { code: "sentinel" } }),
      unknownRecoveryAction: module.serializeYtmError({
        details: {
          code: "foreign_error",
          operationName: "matrix",
          recoveryAction: { kind: "restart_database" }
        }
      }),
      invalidMethodRecoveryAction: module.serializeYtmError({
        details: {
          code: "foreign_error",
          operationName: "kinds",
          recoveryAction: { kind: "review_method_input", method: "sorts" }
        }
      }),
      foreignDetails: module.serializeYtmError({ details: circularDetails }),
      sharedReferences: module.serializeYtmError({
        details: {
          code: "foreign_error",
          reason: "Shared diagnostics",
          expected: sharedDetails,
          actual: sharedDetails
        }
      }),
      hostileDetails: module.serializeYtmError(hostileError),
      hostileConstructor
    };
  } else if (request.action === "execute") {
    let context;
    if (request.abortBeforeExecute) {
      const controller = new AbortController();
      controller.abort(new Error("judge cancellation"));
      context = { signal: controller.signal };
    }
    value = await client[request.operation](request.input, context);
  } else if (request.action === "abort-handler-preservation") {
    const controller = new AbortController();
    let handlerCalls = 0;
    const handler = () => { handlerCalls += 1; };
    controller.signal.onabort = handler;
    const execution = client
      .kinds(request.input, { signal: controller.signal })
      .then(
        () => ({ ok: true }),
        (caught) => ({ ok: false, caught })
      );
    const preservedDuringExecution = controller.signal.onabort === handler;
    const requestAtEntry = await waitForCapturedRequest();
    controller.abort(new Error("judge cancellation"));
    const outcome = await execution;
    const cancellation = outcome.ok
      ? { code: "unexpected_success" }
      : module.serializeYtmError(outcome.caught);
    value = {
      preservedDuringExecution,
      preservedAfterAbort: controller.signal.onabort === handler,
      handlerCalls,
      signalAbortedAtEntry: requestAtEntry.signalAborted,
      cancellationCode: cancellation.code,
      cancellationIsYtmError: outcome.ok ? false : outcome.caught instanceof module.YtmError
    };
  } else {
    throw new Error(`Unknown runner action: ${request.action}`);
  }
} catch (caught) {
  error = module.serializeYtmError(caught);
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

async function waitForCapturedRequest() {
  const capturePath = process.env.YTM_JUDGE_CAPTURE_PATH;
  if (!capturePath) throw new Error("Cancellation probe requires a capture path");
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await readFile(capturePath, "utf8");
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw caught;
    }
    if (raw !== undefined) {
      try {
        const captures = JSON.parse(raw);
        if (captures.length > 0) return captures[0];
      } catch (caught) {
        if (!(caught instanceof SyntaxError)) throw caught;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error("Cancellation probe timed out waiting for transport entry");
}
