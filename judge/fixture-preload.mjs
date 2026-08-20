import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const encodedConfig = process.env.YTM_JUDGE_FIXTURE;
if (encodedConfig) {
  const config = JSON.parse(encodedConfig);
  const fixtureDirectory = resolve(config.fixtureDirectory);
  const requests = [];
  let nextStep = 0;

  globalThis.__YTM_JUDGE_REQUESTS__ = requests;
  globalThis.fetch = async (url, init = {}) => {
    const step = config.steps?.[nextStep++];
    if (!step) throw new Error(`Judge fixture received unexpected request ${String(url)}`);
    const request = {
      url: String(url),
      method: init.method || "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: String(init.body || ""),
      signalPresent: init.signal instanceof AbortSignal,
      signalAborted: init.signal?.aborted === true
    };
    requests.push(request);
    if (step.path && !request.url.endsWith(step.path)) {
      throw new Error(`Judge fixture expected ${step.path}, received ${request.url}`);
    }
    if (step.transportError) throw new TypeError(step.transportError);
    if (init.signal?.aborted) throw init.signal.reason;
    const bytes = responseBytes(step, fixtureDirectory);
    return new Response(bytes, {
      status: step.status ?? 200,
      headers: step.headers
    });
  };
}

function responseBytes(step, fixtureDirectory) {
  if (step.depth !== undefined) {
    const nesting = "<Extra>".repeat(step.depth - 1);
    const closing = "</Extra>".repeat(step.depth - 1);
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters>${nesting}${closing}<Dataset id="output1"><Rows><Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row></Rows></Dataset></Root>`);
  }
  let bytes = step.fixture
    ? readFileSync(resolve(fixtureDirectory, step.fixture))
    : Buffer.from(step.body || "", "utf8");
  if (step.replace) {
    let text = bytes.toString("utf8");
    for (const [from, to] of step.replace) text = text.replace(from, to);
    bytes = Buffer.from(text, "utf8");
  }
  if (step.padToBytes !== undefined) {
    const prefix = Buffer.concat([bytes, Buffer.from("<!--")]);
    const suffix = Buffer.from("-->");
    const padding = step.padToBytes - prefix.length - suffix.length;
    if (padding < 0) throw new Error(`Fixture cannot be padded down to ${step.padToBytes} bytes`);
    bytes = Buffer.concat([prefix, Buffer.alloc(padding, 0x78), suffix]);
  }
  if (step.bom) bytes = Buffer.concat([...Array.from({ length: step.bom }, () => Buffer.from([0xef, 0xbb, 0xbf])), bytes]);
  if (step.invalidUtf8) bytes = Buffer.concat([bytes, Buffer.from([0xff])]);
  return bytes;
}
