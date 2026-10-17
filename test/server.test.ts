import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { createBridgeServer } from "../src/server.ts";
import { decodeCompaction } from "../src/carrier.ts";
import type { BridgeConfig } from "../src/types.ts";

type Handler = (body: any, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fixture(t: TestContext, handler: Handler, patch: Partial<BridgeConfig> = {}, configure?: (config: BridgeConfig) => void) {
  const seen: { path: string; body: any }[] = [];
  const upstream = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ path: req.url!, body });
      await handler(body, req, res);
    } catch {
      if (!res.destroyed) { res.writeHead(500); res.end(); }
    }
  });
  const origin = await listen(upstream);
  const config: BridgeConfig = {
    upstreams: {
      native: { api: "responses", base_url: `${origin}/native` },
      alternate: { api: "responses", base_url: `${origin}/alternate` },
      messages: { api: "anthropic", base_url: `${origin}/messages` },
      chat: { api: "chat", base_url: `${origin}/chat` },
    },
    models: {
      gpt: { upstream: "native", model: "gpt-example" },
      "gpt-region": { upstream: "alternate", model: "gpt-example" },
      claude: { upstream: "messages", model: "claude-example", max_output_tokens: 1024 },
      flash: { upstream: "chat", model: "deepseek-flash", max_output_tokens: 1024 },
    },
    ...patch,
  };
  configure?.(config);
  let bridge = createBridgeServer(config);
  let url = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  return {
    seen,
    config,
    get url() { return url; },
    async restart() {
      await close(bridge);
      bridge = createBridgeServer(config);
      url = await listen(bridge);
    },
  };
}

function sse(res: ServerResponse, events: any[], finish = true) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (finish) res.end();
}

const nativeUsage = { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 1 } };
const message = (text: string) => ({ type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
function nativeSuccess(res: ServerResponse, output: any[]) {
  sse(res, [{ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output, usage: nativeUsage } }]);
}
function chatSuccess(res: ServerResponse, text: string) {
  sse(res, [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 10 } },
  ]);
}
function messagesSuccess(res: ServerResponse, text: string) {
  sse(res, [
    { type: "message_start", message: { id: "msg_synthetic", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
}
async function post(url: string, body: any, init: RequestInit = {}) {
  return fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
}
async function events(response: Response): Promise<any[]> {
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
}
async function responseJson(response: Response): Promise<any> {
  return response.json();
}

test("HTTP entry authentication protects health, models and requests", async (t) => {
  const variable = "BRIDGE_TEST_HTTP_TOKEN";
  const previous = process.env[variable];
  process.env[variable] = "synthetic-bridge-token";
  t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Hello")]), { token_env: variable });
  for (const path of ["/health", "/v1/models", "/v1/responses"]) {
    const response = await fetch(`${f.url}${path}`);
    assert.equal(response.status, 401);
    assert.equal((await responseJson(response)).error.code, "invalid_api_key");
  }
  const headers = { authorization: "Bearer synthetic-bridge-token" };
  assert.equal((await fetch(`${f.url}/health`, { headers })).status, 200);
  const response = await fetch(`${f.url}/v1/models`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await responseJson(response)).data.map((m: any) => m.id), ["gpt", "gpt-region", "claude", "flash"]);
  assert.equal((await fetch(`${f.url}/missing`, { headers })).status, 404);
  assert.equal(f.seen.length, 0);
  const result = await post(f.url, { model: "gpt", input: "Hello" }, { headers });
  assert.equal(result.status, 200);
  assert.equal((await responseJson(result)).output[0].content[0].text, "Hello");
});

test("HTTP validates requests before opening an SSE stream or calling upstream", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, []));
  const malformed: any[] = [null, [], {}, { model: "missing" }, { model: "gpt", input: 1 }, { model: "gpt", input: [null] }, { model: "gpt", tools: {} }, { model: "gpt", stream: "true" }, { model: "gpt", previous_response_id: "resp_old" }];
  for (const body of malformed) {
    const response = await post(f.url, body);
    assert.equal(response.status, 400);
    assert.equal((await responseJson(response)).error.code, "invalid_prompt");
  }
  const invalidJson = await fetch(`${f.url}/v1/responses`, { method: "POST", body: "{" });
  assert.equal(invalidJson.status, 400);
  assert.equal((await responseJson(invalidJson)).error.message, "Request body must be JSON");
  assert.equal((await fetch(`${f.url}/v1/responses/compact`, { method: "POST", body: "{}" })).status, 404);
  assert.equal(f.seen.length, 0);
});

test("HTTP nonstream and SSE responses contain complete output and usage", async (t) => {
  const f = await fixture(t, (_body, req, res) => {
    if (req.url!.endsWith("chat/completions")) chatSuccess(res, "Chat answer");
    else nativeSuccess(res, [message("Native answer")]);
  });
  const response = await post(f.url, { model: "gpt", input: "Hello" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const json = await responseJson(response);
  assert.equal(json.status, "completed");
  assert.equal(json.output[0].content[0].text, "Native answer");
  assert.equal(json.usage.total_tokens, 23);
  assert.equal(json.end_turn, true);
  const stream = await events(await post(f.url, { model: "flash", input: "Hello", stream: true }));
  assert.equal(stream[0].type, "response.created");
  const completed = stream.find((event) => event.type === "response.completed").response;
  assert.equal(completed.output[0].content[0].text, "Chat answer");
  assert.equal(completed.output[0].phase, "final_answer");
  assert.equal(completed.usage.input_tokens_details.cached_tokens, 10);
  assert.equal(completed.end_turn, true);
});

test("HTTP and SSE errors preserve capacity classification and Retry-After", async (t) => {
  let status = 429;
  let code = "rate_limit_exceeded";
  const f = await fixture(t, (_body, _req, res) => {
    res.writeHead(status, { "content-type": "application/json", "retry-after": "17" });
    res.end(JSON.stringify({ error: { code, message: "Synthetic upstream failure" } }));
  });
  for (const failure of [{ status: 429, code: "rate_limit_exceeded" }, { status: 503, code: "server_is_overloaded" }, { status: 429, code: "insufficient_quota" }]) {
    ({ status, code } = failure);
    const response = await post(f.url, { model: "flash", input: "Hello" });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "17");
    assert.equal((await responseJson(response)).error.code, code);
    const frames = await events(await post(f.url, { model: "flash", input: "Hello", stream: true }));
    assert.equal(frames.some((frame) => frame.type === "response.completed"), false);
    const failed = frames.find((frame) => frame.type === "response.failed").response;
    assert.equal(failed.error.code, code);
    assert.deepEqual(failed.error.headers, { "retry-after": "17" });
  }
});

test("a failed SSE response exposes no executable tool calls", async (t) => {
  const f = await fixture(t, (_body, req, res) => {
    if (req.url!.startsWith("/chat")) {
      sse(res, [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_synthetic", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] },
        { error: { code: "server_is_overloaded", message: "Capacity interrupted the stream" } },
      ]);
    } else {
      const item = { type: "function_call", id: "fc_synthetic", call_id: "call_synthetic", name: "lookup", arguments: "{}" };
      sse(res, [
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.failed", response: { error: { code: "server_is_overloaded", message: "Capacity interrupted the stream" } } },
      ]);
    }
  });
  for (const model of ["gpt", "flash"]) {
    const frames = await events(await post(f.url, { model, input: "Use lookup", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }], stream: true }));
    assert.equal(frames.at(-1).type, "response.failed");
    assert.equal(frames.some((frame) => ["function_call", "custom_tool_call"].includes(frame.item?.type)), false);
    assert.deepEqual(frames.at(-1).response.output, []);
  }
});

test("client cancellation closes the active upstream stream", { timeout: 5000 }, async (t) => {
  let upstreamStarted!: () => void;
  let upstreamClosed!: () => void;
  const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const f = await fixture(t, (_body, _req, res) => {
    res.on("close", upstreamClosed);
    sse(res, [{ choices: [{ index: 0, delta: { content: "Starting" }, finish_reason: null }] }], false);
    upstreamStarted();
  });
  const controller = new AbortController();
  const response = await post(f.url, { model: "flash", input: "Hello", stream: true }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(response.text(), /abort/i);
  await closed;
});

for (const stage of ["headers", "body"] as const) {
  test(`idle upstream ${stage} time out despite downstream keepalives`, { timeout: 5000 }, async (t) => {
    // Run the server's heartbeat more often so the test exercises keepalives
    // without waiting for the production 15-second interval.
    const originalInterval = globalThis.setInterval;
    t.mock.method(globalThis, "setInterval", (callback: any, delay: any, ...args: any[]) => originalInterval(callback, delay === 15_000 ? 5 : delay, ...args));
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    const f = await fixture(t, (_body, _req, res) => {
      res.on("close", upstreamClosed);
      if (stage === "body") sse(res, [{ choices: [{ index: 0, delta: { content: "Started" }, finish_reason: null }] }], false);
    }, {}, (config) => { config.upstreams.chat.stream_idle_timeout_ms = 50; });
    const frames = await events(await post(f.url, { model: "flash", input: "Hello", stream: true }));
    assert.ok(frames.some((event) => event.type === "keepalive"));
    assert.equal(frames.at(-1).type, "response.failed");
    assert.equal(frames.at(-1).response.error.code, "stream_error");
    assert.equal(frames.some((event) => event.type === "response.completed"), false);
    await closed;
  });
}

test("native and portable checkpoints survive server restart and switches between APIs and regions", async (t) => {
  const summary = "Keep the verified answer 42 and continue the task.";
  const f = await fixture(t, (body, req, res) => {
    if (req.url!.endsWith("chat/completions")) chatSuccess(res, summary);
    else if (req.url!.endsWith("/messages")) messagesSuccess(res, summary);
    else {
      const native = body.input?.some((item: any) => item.type === "compaction_trigger");
      nativeSuccess(res, native ? [{ type: "compaction", id: "cmp_native_synthetic", encrypted_content: "native-checkpoint-synthetic" }] : [message(summary)]);
    }
  });
  const frames = await events(await post(f.url, {
    model: "gpt", input: [{ type: "message", role: "user", content: "The answer is 42." }, { type: "compaction_trigger" }], stream: true,
  }));
  const completed = frames.find((frame) => frame.type === "response.completed").response;
  const checkpoint = JSON.parse(JSON.stringify(completed.output[0]));
  assert.equal(checkpoint.type, "compaction");
  assert.equal(decodeCompaction(checkpoint.encrypted_content)?.summary, summary);
  assert.equal(decodeCompaction(checkpoint.encrypted_content)?.native?.item.encrypted_content, "native-checkpoint-synthetic");
  assert.equal(completed.usage.input_tokens, 40);
  assert.equal(f.seen.length, 2);
  await f.restart();

  for (const model of ["gpt", "claude", "flash", "gpt-region", "gpt"]) {
    const input = [checkpoint, { type: "message", role: "user", content: "Continue." }];
    const snapshot = JSON.stringify(input);
    const response = await post(f.url, { model, input });
    assert.equal(response.status, 200, JSON.stringify(await responseJson(response.clone())));
    assert.equal((await responseJson(response)).status, "completed");
    const upstream = f.seen.at(-1)!;
    const serialized = JSON.stringify(upstream.body);
    if (model === "gpt") {
      assert.equal(upstream.body.input[0].type, "compaction");
      assert.equal(upstream.body.input[0].encrypted_content, "native-checkpoint-synthetic");
      assert.equal(serialized.includes(summary), false);
    } else {
      assert.ok(serialized.includes(summary));
      assert.equal(serialized.includes("native-checkpoint-synthetic"), false);
      assert.equal(serialized.includes("cxbc1:"), false);
    }
    assert.equal(JSON.stringify(input), snapshot);
  }

  // A checkpoint created on a function-only API is portable in every direction.
  for (const source of ["claude", "flash"]) {
    const response = await post(f.url, { model: source, input: [{ type: "message", role: "user", content: "Remember 42." }, { type: "compaction_trigger" }] });
    assert.equal(response.status, 200);
    const portable = (await responseJson(response)).output[0];
    assert.equal(decodeCompaction(portable.encrypted_content)?.native, undefined);
    await f.restart();
    const resumed = await post(f.url, { model: "gpt", input: [portable, { type: "message", role: "user", content: "Continue" }] });
    assert.equal(resumed.status, 200);
    assert.ok(JSON.stringify(f.seen.at(-1)!.body.input).includes(summary));
    assert.equal(JSON.stringify(f.seen.at(-1)!.body.input).includes("cxbc1:"), false);
  }
});
