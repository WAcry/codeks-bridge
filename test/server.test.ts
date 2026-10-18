import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { createBridgeServer } from "../src/server.ts";
import { buildCatalog } from "../src/catalog.ts";
import { decodeCompaction, decodeReasoning } from "../src/carrier.ts";
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
  t.after(async () => close(upstream));
  const origin = await listen(upstream);
  const config: BridgeConfig = {
    upstreams: {
      native: { base_url: `${origin}/native` },
      alternate: { base_url: `${origin}/alternate` },
      messages: { base_url: `${origin}/messages` },
      chat: { base_url: `${origin}/chat` },
    },
    models: {
      gpt: { catalog: "gpt-6.1-sol", upstream: "native", model: "gpt-example" },
      "gpt-region": { catalog: "gpt-6.1-sol", upstream: "alternate", model: "gpt-example" },
      claude: { catalog: "claude-sonnet-5-5", upstream: "messages", model: "claude-example", max_output_tokens: 1024 },
      flash: { catalog: "deepseek-flash", upstream: "chat", model: "deepseek-flash", max_output_tokens: 1024 },
    },
    ...patch,
  };
  configure?.(config);
  let bridge = createBridgeServer(config);
  let url = await listen(bridge);
  t.after(async () => close(bridge));
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

const nativeUsage = { input_tokens: 20, output_tokens: 3, total_tokens: 23, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 1 } };
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

test("credential preparation failures remain terminal HTTP errors without exposing diagnostics", async (t) => {
  const missingEnv = `SYNTHETIC_MISSING_CREDENTIAL_${process.pid}`;
  assert.equal(process.env[missingEnv], undefined);
  const cases = [
    { auth: { api_key_env: missingEnv }, message: `Missing credential environment variable: ${missingEnv}` },
    { auth: { api_key_command: [process.execPath, "-e", "console.log('synthetic-sensitive-value');console.error('synthetic-sensitive-value');process.exit(1)"] }, message: "Credential command failed" },
    { auth: { api_key_command: [process.execPath, "-e", "process.stdout.write('   ')"] }, message: "Credential command returned an empty credential" },
    { auth: { api_key_command: [process.execPath, "-e", "console.log('synthetic-sensitive-value');console.log('second-line')"] }, message: "Credential must be a single line" },
  ];
  for (const { auth, message } of cases) {
    await t.test(message, async (t) => {
      const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, []), {}, config => {
        Object.assign(config.upstreams.native, auth);
      });
      const response = await post(f.url, { model: "gpt", stream: true, input: "hello" });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: { code: "invalid_prompt", message } });
      assert.equal(f.seen.length, 0);
    });
  }
});
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
  const headers = { authorization: "Bearer synthetic-bridge-token", origin: "https://client.example" };
  assert.equal((await fetch(`${f.url}/health`, { headers })).status, 200);
  const response = await fetch(`${f.url}/v1/models`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await responseJson(response)).models.map((m: any) => m.slug), ["gpt", "gpt-region", "claude", "flash"]);
  assert.equal((await fetch(`${f.url}/missing`, { headers })).status, 404);
  assert.equal(f.seen.length, 0);
  const result = await post(f.url, { model: "gpt", input: "Hello" }, { headers });
  assert.equal(result.status, 200);
  assert.equal((await responseJson(result)).output[0].content[0].text, "Hello");
});

test("anonymous loopback requests with a browser Origin never reach upstream", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Hello")]));
  for (const origin of ["https://unrelated.example", "null", "http://localhost:3000"]) {
    const response = await post(f.url, { model: "gpt", input: "Hello" }, { headers: { origin, "content-type": "text/plain" } });
    assert.equal(response.status, 403);
    assert.match((await responseJson(response)).error.message, /bridge token/);
  }
  assert.equal(f.seen.length, 0);
  assert.equal((await post(f.url, { model: "gpt", input: "Hello" })).status, 200);
  assert.equal(f.seen.length, 1);
});

test("oversized HTTP catalogs fail explicitly while static catalogs and inference remain usable", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Hello")]), {}, config => {
    config.models = Object.fromEntries(Array.from({ length: 20 }, (_,index) => [`preset-${index}`, { ...config.models.gpt }]));
  });
  const exported = buildCatalog(f.config);
  assert.equal(exported.models.length, 20);
  assert(Buffer.byteLength(JSON.stringify(exported)) > 1024 * 1024);
  const response = await fetch(`${f.url}/v1/models`);
  assert.equal(response.status, 413);
  assert.match((await responseJson(response)).error.message, /model_catalog_json/);
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
  assert.equal((await post(f.url, { model: "preset-0", input: "Hello" })).status, 200);
});

test("native success retains response metadata and upstream diagnostic request IDs", async (t) => {
  const reply = {
    id: "resp_synthetic_original", object: "response", created_at: 123,
    status: "completed", model: "gpt-example", output: [message("Hello")],
    usage: { ...nativeUsage, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 4 }, synthetic_detail: 17 },
    synthetic_metadata: { original: true },
  };
  const f = await fixture(t, (_body, _req, res) => {
    res.setHeader("x-request-id", "req_synthetic_original");
    res.setHeader("request-id", "req_synthetic_alternate");
    sse(res, [{ type: "response.created", response: { ...reply, status: "in_progress", output: [] } },
      { type: "response.completed", response: reply }]);
  });
  for (const stream of [false, true]) {
    const response = await post(f.url, { model: "gpt", input: "Hello", stream });
    assert.equal(response.headers.get("x-request-id"), "req_synthetic_original");
    assert.equal(response.headers.get("request-id"), "req_synthetic_alternate");
    const body = stream ? (await events(response)).find(event => event.type === "response.completed").response : await response.json();
    assert.equal(body.id, reply.id);
    assert.equal(body.created_at, reply.created_at);
    assert.equal(body.model, "gpt");
    assert.deepEqual(body.usage, reply.usage);
    assert.deepEqual(body.synthetic_metadata, reply.synthetic_metadata);
  }
});

test("HTTP model catalogs expose reviewed client metadata without connection or credential details", async (t) => {
  const f = await fixture(t, () => assert.fail("Catalog reads must not call upstream"), {}, (config) => {
    config.upstreams.native.headers = { "x-synthetic-auth": "synthetic-secret-value" };
    config.upstreams.native.api_key_command = [process.execPath, "-e", "throw new Error('catalog-must-not-run-auth')"];
    config.models.gpt.model = "synthetic-private-deployment";
    config.models.gpt.options = { custom_flag: "synthetic-private-option" };
  });
  const response = await fetch(`${f.url}/v1/models?client_version=0.163.0`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = await response.text();
  const catalog = JSON.parse(body);
  assert.deepEqual(Object.keys(catalog), ["models"]);
  assert.deepEqual(catalog.models.map((model: any) => model.slug), ["gpt", "gpt-region", "claude", "flash"]);
  assert(catalog.models.every((model: any) => model.model_messages.instructions_template.length > 100));
  assert(catalog.models.every((model: any) => model.tool_mode === "code_mode_only" && model.use_responses_lite));
  for (const value of [
    f.config.upstreams.native.base_url, "synthetic-secret-value", "synthetic-private-deployment",
    "synthetic-private-option", "catalog-must-not-run-auth", "api_key_command", "x-synthetic-auth",
  ]) assert(!body.includes(value), `Client catalog leaked ${value}`);
  assert.equal(f.seen.length, 0);
});

test("catalog ETags identify the same metadata on reads and both response transports", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Hello")]));
  const first = await fetch(`${f.url}/v1/models`);
  const etag = first.headers.get("etag");
  assert(etag);
  const initial = await responseJson(first);
  assert.equal((await fetch(`${f.url}/v1/models?client_version=0.163.0`)).headers.get("etag"), etag);
  for (const stream of [false, true]) {
    const response = await post(f.url, { model: "gpt", input: "Hello", stream });
    assert.equal(response.headers.get("x-models-etag"), etag);
    await response.text();
  }
  f.config.models.gpt.context_window = 128000;
  await f.restart();
  const updated = await fetch(`${f.url}/v1/models`);
  const newEtag = updated.headers.get("etag");
  assert(newEtag);
  assert.notEqual(newEtag, etag);
  const catalog = await responseJson(updated);
  assert.equal(catalog.models[0].context_window, 128000);
  assert.notDeepEqual(catalog, initial);
  const response = await post(f.url, { model: "gpt", input: "Hello" });
  assert.equal(response.headers.get("x-models-etag"), newEtag);
  await response.text();
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
    else if (req.url!.endsWith("/messages")) messagesSuccess(res, "Messages answer");
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
  const anthropic = await responseJson(await post(f.url, { model: "claude", input: "Hello" }));
  assert.equal(anthropic.output[0].content[0].text, "Messages answer");
  assert.equal(anthropic.usage.total_tokens, 23);
  assert.equal(anthropic.end_turn, true);
});

test("GPT keeps Lite declarations, transport and reasoning through dual compaction", async (t) => {
  const headers: (string | string[] | undefined)[] = [];
  const f = await fixture(t, (body, req, res) => {
    headers.push(req.headers["x-openai-internal-codex-responses-lite"]);
    const output = body.input?.some?.((item: any) => item.type === "compaction_trigger")
      ? [{ type: "compaction", encrypted_content: "synthetic-native-checkpoint" }]
      : [message("Portable summary")];
    nativeSuccess(res, output);
  });
  const declaration = {
    type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [
      { type: "custom", name: "exec", description: "Run code", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
    ] }],
  };
  const input = [declaration, { type: "message", role: "user", content: "Hello" }];
  const body = { model: "gpt", input, reasoning: { effort: "high", context: "all_turns" }, parallel_tool_calls: false };
  assert.equal((await responseJson(await post(f.url, body))).status, "completed");
  // The header also identifies Lite when the client declares no tools.
  assert.equal((await responseJson(await post(f.url, { model: "gpt-region", input: "Hello" }, {
    headers: { "content-type": "application/json", "x-openai-internal-codex-responses-lite": "true" },
  }))).status, "completed");
  const compacted = await responseJson(await post(f.url, { ...body, input: [...input, { type: "compaction_trigger" }] }));
  assert.equal(compacted.status, "completed");
  const checkpoint = decodeCompaction(compacted.output[0].encrypted_content)!;
  assert.equal(checkpoint.summary, "Portable summary");
  assert.equal((checkpoint.native!.data as Record<string, unknown>).encrypted_content, "synthetic-native-checkpoint");
  assert.deepEqual(headers, ["true", "true", "true", "true"]);
  assert.deepEqual(f.seen[0].body.input, input);
  for (const { body: sent } of [f.seen[0], ...f.seen.slice(2)]) {
    assert.equal(Object.hasOwn(sent, "tools"), false);
    assert.deepEqual(sent.input[0], declaration);
    assert.equal(sent.reasoning.context, "all_turns");
    assert.equal(sent.parallel_tool_calls, false);
  }
  assert(f.seen.slice(2).some(({ body: sent }) => sent.input.at(-1).type === "compaction_trigger"));
  assert(f.seen.slice(2).some(({ body: sent }) => sent.tool_choice === "none"));
});

test("dual compaction waits for both successful upstream headers before sending HTTP 200", { timeout: 5000 }, async (t) => {
  let nativeResponse!: ServerResponse;
  let ready!: () => void;
  let calls = 0;
  const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
  const f = await fixture(t, (body, _req, res) => {
    if (body.input.some((item: any) => item.type === "compaction_trigger")) nativeResponse = res;
    else nativeSuccess(res, [message("Portable summary")]);
    if (++calls === 2) ready();
  });
  let responseReceived = false;
  const pending = post(f.url, { model: "gpt", input: [{ type: "compaction_trigger" }], stream: true })
    .then((response) => { responseReceived = true; return response; });
  await bothStarted;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(responseReceived, false);
  nativeSuccess(nativeResponse, [{ type: "compaction", encrypted_content: "synthetic-checkpoint" }]);
  const response = await pending;
  assert.equal(response.status, 200);
  const frames = await events(response);
  assert.equal(frames.at(-1).type, "response.completed");
  assert.equal(frames.at(-1).response.output[0].type, "compaction");
  assert.equal(f.seen.length, 2);
});

test("a dual-compaction HTTP failure keeps its HTTP error and cancels the accepted sibling", { timeout: 5000 }, async (t) => {
  let ready!: () => void;
  let closed!: () => void;
  let calls = 0;
  const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
  const siblingClosed = new Promise<void>((resolve) => { closed = resolve; });
  const body = { error: { code: "invalid_encrypted_content", message: "Synthetic checkpoint rejection" } };
  const f = await fixture(t, async (request, _req, res) => {
    const native = request.input.some((item: any) => item.type === "compaction_trigger");
    if (!native) {
      res.on("close", closed);
      sse(res, [{ type: "response.created", response: { id: "resp_summary" } }], false);
    }
    if (++calls === 2) ready();
    await bothStarted;
    if (native) {
      res.writeHead(400, { "content-type": "application/json", "retry-after": "11" });
      res.end(JSON.stringify(body));
    }
  });
  const response = await post(f.url, { model: "gpt", input: [{ type: "compaction_trigger" }], stream: true });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("retry-after"), "11");
  assert.deepEqual(await responseJson(response), body);
  await siblingClosed;
  assert.equal(f.seen.length, 2);
});

for (const siblingAccepted of [false, true]) {
  test(`dual-compaction native stream failure survives with sibling headers ${siblingAccepted ? "accepted" : "pending"}`, { timeout: 5000 }, async (t) => {
    const error = { code: "misalignment_policy_violation", message: "Synthetic policy failure", misalignment: { reason: "synthetic_reason" }, future_field: { retained: true } };
    let ready!: () => void;
    let closed!: () => void;
    let failNative!: () => void;
    let calls = 0;
    const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
    const siblingClosed = new Promise<void>((resolve) => { closed = resolve; });
    const f = await fixture(t, async (request, _req, res) => {
      const native = request.input.some((item: any) => item.type === "compaction_trigger");
      if (native) {
        sse(res, [{ type: "response.created", response: { id: "resp_native" } }], false);
        failNative = () => res.end(`data: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`);
      } else {
        res.on("close", closed);
        if (siblingAccepted) sse(res, [{ type: "response.created", response: { id: "resp_summary" } }], false);
      }
      if (++calls === 2) ready();
    });
    const pending = post(f.url, { model: "gpt", input: [{ type: "compaction_trigger" }], stream: true });
    await bothStarted;
    // Once both headers are accepted the downstream stream must already exist.
    const response = siblingAccepted ? await pending : undefined;
    failNative();
    const received = response ?? await pending;
    assert.equal(received.status, 200);
    const frames = await events(received);
    assert.equal(frames.at(-1).type, "response.failed");
    assert.deepEqual(frames.at(-1).response.error, error);
    assert.equal(frames.some((frame) => frame.type === "response.completed" || frame.item?.type === "compaction"), false);
    await siblingClosed;
    assert.equal(f.seen.length, 2);
  });
}

test("translated HTTP errors preserve capacity classification and Retry-After before starting a stream", async (t) => {
  let status = 429;
  let code = "rate_limit_exceeded";
  const f = await fixture(t, (_body, _req, res) => {
    res.writeHead(status, { "content-type": "application/json", "retry-after": "17" });
    res.end(JSON.stringify({ error: { code, message: "Synthetic upstream failure" } }));
  });
  for (const failure of [{ status: 429, code: "rate_limit_exceeded" }, { status: 503, code: "server_is_overloaded" }, { status: 429, code: "insufficient_quota" }]) {
    ({ status, code } = failure);
    for (const stream of [false, true]) {
      const response = await post(f.url, { model: "flash", input: "Hello", stream });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "17");
      const error = (await responseJson(response)).error;
      assert.equal(error.code, code);
      assert.deepEqual(error.upstream, { status, body: { error: { code, message: "Synthetic upstream failure" } } });
    }
  }
  assert.equal(f.seen.length, 6);
});

test("native HTTP failures preserve status, original fields and body without retries", async (t) => {
  const failures = [
    { status: 429, error: { code: "usage_limit_reached", type: "usage_limit_reached", message: "Synthetic plan limit", plan_type: "plus", resets_at: 1900000000 } },
    { status: 403, error: { code: "organization_spend_limit_exceeded", type: "budget_error", message: "Synthetic budget limit", limit: 100 } },
    { status: 400, error: { code: "misalignment_policy_violation", message: "Synthetic policy failure", misalignment: { type: "synthetic_policy", reason: "synthetic_reason" } } },
  ];
  let current = failures[0];
  const f = await fixture(t, (_body, _req, res) => {
    res.writeHead(current.status, { "content-type": "application/json", "retry-after": "19", "x-request-id": "synthetic-request" });
    res.end(JSON.stringify({ error: current.error }, null, 2));
  });
  for (const failure of failures) {
    current = failure;
    const before = f.seen.length;
    const response = await post(f.url, { model: "gpt", input: "Hello", stream: true });
    assert.equal(response.status, failure.status);
    assert.equal(response.headers.get("retry-after"), "19");
    assert.equal(response.headers.get("x-request-id"), "synthetic-request");
    assert.equal(await response.text(), JSON.stringify({ error: failure.error }, null, 2));
    assert.equal(f.seen.length, before + 1);
  }
});

test("native HTTP text failures forward decoded content without stale compression or connection headers", async (t) => {
  const text = "Synthetic upstream access failure.\n";
  const compressed = gzipSync(text);
  const f = await fixture(t, (_body, _req, res) => {
    res.writeHead(403, {
      "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip", "content-length": String(compressed.length),
      connection: "close, x-synthetic-hop", "x-synthetic-hop": "upstream-only", "x-request-id": "synthetic-compressed-request",
    });
    res.end(compressed);
  });
  const response = await post(f.url, { model: "gpt", input: "Hello", stream: true });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("x-synthetic-hop"), null);
  assert.equal(response.headers.get("x-request-id"), "synthetic-compressed-request");
  assert.equal(await response.text(), text);
  assert.equal(f.seen.length, 1);
});

test("all adapters complete tool calls and report usage through the HTTP stream", async (t) => {
  const f = await fixture(t, (_body, req, res) => {
    if (req.url!.startsWith("/native")) {
      nativeSuccess(res, [{ type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"query":"example"}' }]);
    } else if (req.url!.startsWith("/messages")) {
      sse(res, [
        { type: "message_start", message: { id: "msg_synthetic", content: [], usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_lookup", name: "lookup", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"example"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    } else {
      sse(res, [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"query":"example"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 10 } },
      ]);
    }
  });
  for (const model of ["gpt", "claude", "flash"]) {
    const frames = await events(await post(f.url, {
      model, input: "Use lookup", stream: true,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }));
    const completed = frames.at(-1).response;
    assert.equal(frames.at(-1).type, "response.completed");
    assert.equal(completed.end_turn, false);
    assert.equal(completed.output.length, 1);
    assert.equal(completed.output[0].type, "function_call");
    assert.equal(completed.output[0].name, "lookup");
    assert.deepEqual(JSON.parse(completed.output[0].arguments), { query: "example" });
    assert.equal(completed.usage.total_tokens, model === "claude" ? 33 : 23);
    assert.equal(completed.usage.input_tokens_details.cached_tokens, 10);
  }
});

test("a failed SSE response exposes no executable tool calls", async (t) => {
  const f = await fixture(t, (_body, req, res) => {
    if (req.url!.startsWith("/chat")) {
      sse(res, [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_synthetic", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] },
        { error: { code: "server_is_overloaded", message: "Capacity interrupted the stream" } },
      ]);
    } else if (req.url!.startsWith("/messages")) {
      sse(res, [
        { type: "message_start", message: { id: "msg_synthetic", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_synthetic", name: "lookup", input: {} } },
        { type: "content_block_stop", index: 0 },
        { type: "error", error: { type: "overloaded_error", message: "Capacity interrupted the stream" } },
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
  for (const model of ["gpt", "claude", "flash"]) {
    const frames = await events(await post(f.url, { model, input: "Use lookup", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }], stream: true }));
    assert.equal(frames.at(-1).type, "response.failed");
    assert.equal(frames.some((frame) => ["function_call", "custom_tool_call"].includes(frame.item?.type)), false);
    assert.deepEqual(frames.at(-1).response.output, model === "gpt" ? undefined : []);
  }
});

for (const model of ["gpt", "claude", "flash"]) {
  test(`${model}: client cancellation closes the active upstream stream`, { timeout: 5000 }, async (t) => {
    let upstreamStarted!: () => void;
    let upstreamClosed!: () => void;
    const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    const f = await fixture(t, (_body, _req, res) => {
      res.on("close", upstreamClosed);
      const first = model === "gpt"
        ? { type: "response.created", response: { id: "resp_synthetic" } }
        : model === "claude"
          ? { type: "message_start", message: { id: "msg_synthetic", content: [], usage: { input_tokens: 20, output_tokens: 0 } } }
          : { choices: [{ index: 0, delta: { content: "Starting" }, finish_reason: null }] };
      sse(res, [first], false);
      upstreamStarted();
    });
    const controller = new AbortController();
    const response = await post(f.url, { model, input: "Hello", stream: true }, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(response.text(), /abort/i);
    await closed;
  });
}

test("client cancellation before response headers aborts the pending upstream request", { timeout: 5000 }, async (t) => {
  let upstreamStarted!: () => void;
  let upstreamClosed!: () => void;
  const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const f = await fixture(t, (_body, _req, res) => {
    res.on("close", upstreamClosed);
    upstreamStarted();
  });
  const controller = new AbortController();
  const pending = post(f.url, { model: "gpt", input: "Hello", stream: true }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await closed;
  assert.equal(f.seen.length, 1);
});

for (const stage of ["headers", "body"] as const) {
  test(`idle upstream ${stage} time out using the accepted transport`, { timeout: 5000 }, async (t) => {
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
    const response = await post(f.url, { model: "flash", input: "Hello", stream: true });
    if (stage === "headers") {
      assert.equal(response.status, 504);
      assert.equal((await responseJson(response)).error.code, "stream_error");
    } else {
      assert.equal(response.status, 200);
      const frames = await events(response);
      assert.ok(frames.some((event) => event.type === "keepalive"));
      assert.equal(frames.at(-1).type, "response.failed");
      assert.equal(frames.at(-1).response.error.code, "stream_error");
      assert.equal(frames.some((event) => event.type === "response.completed"), false);
    }
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
  assert.equal((decodeCompaction(checkpoint.encrypted_content)?.native?.data as any)?.encrypted_content, "native-checkpoint-synthetic");
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
      assert.equal(serialized.includes("cxbc2:"), false);
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
    assert.equal(JSON.stringify(f.seen.at(-1)!.body.input).includes("cxbc2:"), false);
  }
});

test("replay policy changes apply to saved state independently and only in the configured direction", async (t) => {
  const summary = "Portable checkpoint summary.";
  const f = await fixture(t, (body, req, res) => {
    const source = req.url!.startsWith("/native") ? "first" : "second";
    nativeSuccess(res, body.input.some((item: any) => item.type === "compaction_trigger")
      ? [{ type: "compaction", encrypted_content: `${source}-native-checkpoint` }]
      : [{ type: "reasoning", encrypted_content: `${source}-reasoning`, summary: [] }, message(summary)]);
  });
  const normal = await responseJson(await post(f.url, { model: "gpt", input: "Remember this." }));
  const reasoning = normal.output.find((item: any) => item.type === "reasoning");
  assert.ok(decodeReasoning(reasoning.encrypted_content));
  const compacted = await responseJson(await post(f.url, { model: "gpt", input: [message("Previous answer"), { type: "compaction_trigger" }] }));
  const checkpoint = compacted.output[0];
  const saved = JSON.stringify([checkpoint, reasoning, message("Previous answer")]);

  async function replay(model: string, history: string, expectedReasoning: boolean, expectedNative: boolean) {
    const response = await post(f.url, { model, input: JSON.parse(history) });
    assert.equal(response.status, 200);
    const outbound = f.seen.at(-1)!.body.input;
    assert.equal(outbound.some((item: any) => item.type === "reasoning"), expectedReasoning);
    assert.equal(outbound.some((item: any) => item.type === "compaction"), expectedNative);
    assert.equal(JSON.stringify(outbound).includes(summary), !expectedNative);
    assert.doesNotMatch(JSON.stringify(outbound), /cxbr2:|cxbc2:/);
    return responseJson(response);
  }

  await replay("gpt-region", saved, false, false);
  f.config.models["gpt-region"].replay = { reasoning_from: ["gpt"] };
  await f.restart();
  await replay("gpt-region", saved, true, false);
  f.config.models["gpt-region"].replay!.native_compaction_from = ["gpt"];
  await f.restart();
  const reverse = await replay("gpt-region", saved, true, true);
  const reversedCheckpoint = await responseJson(await post(f.url, {
    model: "gpt-region", input: [message("Other answer"), { type: "compaction_trigger" }],
  }));
  await replay("gpt", JSON.stringify([
    reversedCheckpoint.output[0], reverse.output.find((item: any) => item.type === "reasoning"),
  ]), false, false);

  // A third target accepting the second does not implicitly accept the first.
  f.config.models.third = {
    upstream: "alternate", catalog: "gpt-6.1-sol", model: "gpt-third",
    replay: { reasoning_from: ["gpt-region"], native_compaction_from: ["gpt-region"] },
  };
  await f.restart();
  await replay("third", saved, false, false);
  await replay("third", JSON.stringify([
    reversedCheckpoint.output[0], reverse.output.find((item: any) => item.type === "reasoning"),
  ]), true, true);

  f.config.models["gpt-region"].replay!.reasoning_from = [];
  f.config.models["gpt-region"].compaction = { mode: "summary", native_replay: true };
  await f.restart();
  await replay("gpt-region", saved, false, true);
  f.config.models["gpt-region"].compaction.native_replay = false;
  await f.restart();
  await replay("gpt-region", saved, false, false);
  assert.equal(JSON.stringify([checkpoint, reasoning, message("Previous answer")]), saved);
});

test("explicitly shared native state rejected upstream returns its original error without retry or summary fallback", async (t) => {
  const f = await fixture(t, (body, req, res) => {
    if (req.url!.startsWith("/alternate")) {
      assert.ok(body.input.some((item: any) => item.type === "compaction"));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_encrypted_content", message: "Synthetic endpoint cannot decrypt this checkpoint." } }));
      return;
    }
    nativeSuccess(res, body.input.some((item: any) => item.type === "compaction_trigger")
      ? [{ type: "compaction", encrypted_content: "first-native-checkpoint" }]
      : [message("Portable checkpoint summary.")]);
  }, {}, (config) => {
    config.models["gpt-region"].replay = { native_compaction_from: ["gpt"] };
  });
  const compacted = await responseJson(await post(f.url, { model: "gpt", input: [{ type: "compaction_trigger" }] }));
  for (const stream of [false, true]) {
    const before = f.seen.length;
    const response = await post(f.url, { model: "gpt-region", input: compacted.output, stream });
    assert.equal(response.status, 400);
    const error = (await responseJson(response)).error;
    assert.equal(error.code, "invalid_encrypted_content");
    assert.equal(Object.hasOwn(error, "upstream"), false);
    assert.equal(error.message, "Synthetic endpoint cannot decrypt this checkpoint.");
    assert.equal(f.seen.length, before + 1);
  }
});

test("a Responses model configured for summary compaction sends exactly one ordinary request", async (t) => {
  const f = await fixture(t, (_body, _req, res) => {
    res.setHeader("x-request-id", "req_summary_only");
    nativeSuccess(res, [message("Portable summary only.")]);
  }, {}, (config) => {
    config.models.gpt.compaction = { mode: "summary" };
  });
  const response = await post(f.url, { model: "gpt", input: [{ type: "message", role: "user", content: "Remember this." }, { type: "compaction_trigger" }] });
  assert.equal(response.headers.get("x-request-id"), "req_summary_only");
  assert.equal(response.status, 200);
  const result = await responseJson(response);
  const checkpoint = decodeCompaction(result.output[0].encrypted_content);
  assert.equal(checkpoint?.summary, "Portable summary only.");
  assert.equal(checkpoint?.native, undefined);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].body.input.some((item: any) => item.type === "compaction_trigger"), false);
  assert.equal(f.seen[0].body.tool_choice, "none");
  assert.equal(result.usage.input_tokens, 20);
});

test("HTTP summary opt-in controls visible reasoning while preserving replay carriers", async (t) => {
  const text = "Synthetic visible reasoning";
  const f = await fixture(t, (body, req, res) => {
    if (req.url!.endsWith("chat/completions")) {
      sse(res, [
        { choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } },
      ]);
    } else if (req.url!.endsWith("/messages")) {
      sse(res, [
        { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: text, signature: "synthetic-signature" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "Answer" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    } else nativeSuccess(res, [
      { type: "reasoning", summary: body.reasoning?.summary && body.reasoning.summary !== "none" ? [{ type: "summary_text", text }] : [], encrypted_content: "synthetic-encrypted-reasoning" },
      message("Answer"),
    ]);
  });
  for (const model of ["gpt", "claude", "flash"]) {
    for (const [summary, stream] of [[undefined, true], ["none", false], ["auto", true], ["concise", false], ["detailed", true]] as const) {
      const visible = summary !== undefined && summary !== "none";
      const response = await post(f.url, { model, input: "Hello", reasoning: { effort: "medium", ...(summary ? { summary } : {}) }, stream });
      assert.equal(response.status, 200);
      let result;
      if (stream) {
        const received = await events(response);
        // Native terminal-only responses keep their summary without invented deltas.
        assert.equal(received.some((event) => event.type === "response.reasoning_summary_text.delta"), model === "gpt" ? false : visible);
        result = received.at(-1).response;
      } else result = await responseJson(response);
      const item = result.output.find((item: any) => item.type === "reasoning");
      if (model === "gpt") assert.equal(f.seen.at(-1)!.body.reasoning.summary, summary);
      assert.deepEqual(item.summary, visible ? [{ type: "summary_text", text }] : []);
      const carrier = decodeReasoning(item.encrypted_content);
      assert(carrier, "Hidden reasoning still has a carrier for future turns");
      if (model === "flash") assert.equal(carrier.data, text);
      if (model === "claude") assert.equal((carrier.data as any).signature, "synthetic-signature");
    }
  }
});
