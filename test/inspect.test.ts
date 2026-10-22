import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createBridgeServer } from "../src/server.ts";
import { Inspector, type Exchange } from "../src/inspect/capture.ts";
import { sseEvents } from "../src/inspect/view.ts";
import type { BridgeConfig } from "../src/types.ts";

type Handler = (body: any, req: IncomingMessage, res: ServerResponse) => unknown;

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

async function fixture(t: TestContext, handler: Handler, configure?: (config: BridgeConfig) => void) {
  const seen: { path: string; text: string; headers: IncomingMessage["headers"] }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    seen.push({ path: req.url!, text, headers: req.headers });
    try { await handler(JSON.parse(text), req, res); }
    catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  t.after(async () => close(upstream));
  const origin = await listen(upstream);
  const cache = await mkdtemp(join(tmpdir(), "bridge-inspect-"));
  t.after(() => rm(cache, { recursive: true }));
  const config: BridgeConfig = {
    compaction_cache_dir: cache,
    inspect: { capture: true },
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
  };
  configure?.(config);
  const bridge = createBridgeServer(config);
  const url = await listen(bridge);
  t.after(async () => close(bridge));
  return { url, seen };
}

function sse(res: ServerResponse, events: unknown[], headers: Record<string, string> = {}): string {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  res.writeHead(200, { "content-type": "text/event-stream", ...headers });
  res.end(text);
  return text;
}
const usage = { input_tokens: 20, output_tokens: 3, total_tokens: 23 };
const message = (text: string) => ({ type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const nativeSuccess = (res: ServerResponse, output: unknown[]) => sse(res, [{ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output, usage } }]);
const isCompaction = (body: any) => body.input?.some?.((item: any) => item.type === "compaction_trigger");

async function post(url: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
}
async function api(url: string, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${url}/inspect/api/${path}`, init);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
/** The bridge closes an exchange on the response "close" event, just after the client reads the end. */
async function settled(url: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const state = await api(url, "state");
    if (state.active === 0) return state;
    await delay(5);
  }
  throw new Error("exchanges did not settle");
}
async function latest(url: string): Promise<any> {
  await settled(url);
  const { ids } = await api(url, "exchanges?since=0");
  return api(url, `exchanges/${ids.at(-1)}`);
}

test("capture keeps all four stages byte for byte and redacts only credential headers", async (t) => {
  const variable = "INSPECT_TEST_UPSTREAM_KEY";
  process.env[variable] = "synthetic-upstream-secret";
  t.after(() => { delete process.env[variable]; });
  let upstreamText = "";
  const f = await fixture(t, (_body, _req, res) => {
    upstreamText = sse(res, [
      { choices: [{ index: 0, delta: { reasoning_content: "Think." } }] },
      { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } },
    ], { "x-ratelimit-remaining-tokens": "999" });
  }, config => { config.upstreams.chat.api_key_env = variable; });
  const body = JSON.stringify({ model: "flash", stream: true, input: "Hi", future_field: { kept: true } });
  const response = await fetch(`${f.url}/v1/responses`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "session-id": "session-synthetic", "x-test-api-key": "synthetic-client-secret" },
  });
  const clientText = await response.text();
  const detail = await latest(f.url);

  assert.equal(detail.client.request.body.text, body);
  assert.equal(detail.upstream.length, 1);
  assert.equal(detail.upstream[0].label, "main");
  assert.equal(detail.upstream[0].url.endsWith("/chat/chat/completions"), true);
  assert.equal(detail.upstream[0].body.text, f.seen[0].text);
  assert.equal(detail.upstream[0].response.body.text, upstreamText);
  assert.equal(detail.upstream[0].response.events.length, 3);
  assert.equal(detail.upstream[0].response.headers["x-ratelimit-remaining-tokens"], "999");
  assert.equal(detail.client.response.body.text, clientText);
  assert.equal(JSON.parse(detail.client.response.events.at(-1).data).type, "response.completed");
  assert.match(detail.upstream[0].headers.authorization, /^\[redacted: \d+ chars, sha256 [0-9a-f]{8}\]$/);
  assert.match(detail.client.request.headers["x-test-api-key"], /^\[redacted: /);
  assert.equal(JSON.stringify(detail).includes("synthetic-upstream-secret"), false);
  assert.equal(JSON.stringify(detail).includes("synthetic-client-secret"), false);
  assert.equal(detail.thread.session_id, "session-synthetic");
  assert.equal(detail.route.adapter, "deepseek-chat");
  assert.deepEqual(detail.route.replay.reasoning_from, ["flash"]);
  assert.equal(detail.outcome, "completed");
  assert.equal(detail.preview, "Hi");
  assert.deepEqual(detail.upstream_calls, [{ label: "main", status: 200, end: "complete" }]);
});

test("native compaction and on-demand handoffs have accurate labels and replay annotations", async (t) => {
  const f = await fixture(t, (body, _req, res) => {
    if (_req.url!.endsWith("/messages")) {
      sse(res, [
        { type: "message_start", message: { id: "msg_synthetic", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    } else nativeSuccess(res, isCompaction(body)
      ? [{ type: "compaction", encrypted_content: "synthetic-native-checkpoint" }]
      : [{ type: "reasoning", encrypted_content: "synthetic-reasoning", summary: [] }, message("Portable summary")]);
  }, config => { config.models["gpt-region"].replay = { reasoning_from: ["gpt"] }; });

  const turn: any = await (await post(f.url, { model: "gpt", input: "Remember 42." })).json();
  const reasoning = turn.output.find((item: any) => item.type === "reasoning");
  const first = await latest(f.url);
  assert.deepEqual(first.annotations.map((note: any) => [note.target, note.pointer, note.kind, note.decision]), [
    ["client.response", "/output/0", "reasoning", "output"],
  ]);
  assert.deepEqual(first.annotations[0].source.aliases, ["gpt"]);

  const compacted = await (await post(f.url, { model: "gpt", input: [message("Previous answer"), { type: "compaction_trigger" }], stream: true })).text();
  assert.match(compacted, /response\.completed/);
  const compaction = await latest(f.url);
  assert.equal(compaction.kind, "compaction");
  assert.deepEqual(compaction.upstream.map((call: any) => call.label), ["native"]);
  const output = compaction.annotations.find((note: any) => note.target === "client.response");
  assert.equal(output.kind, "compaction");
  assert.equal(output.decoded.summary, undefined);
  assert.equal(output.decoded.handoff.parameters.model, "gpt");
  assert.equal(output.decoded.native.data.encrypted_content, "synthetic-native-checkpoint");
  const event = compaction.client.response.events[output.event];
  assert.equal(JSON.parse(event.data).type, "response.output_item.done");
  const checkpoint = JSON.parse(event.data).item;
  assert.match(checkpoint.encrypted_content, /^cxbc1:/);

  const history = [checkpoint, reasoning, { type: "reasoning", encrypted_content: "foreign-opaque-state", summary: [] }, { type: "message", role: "user", content: "Continue." }];
  const decisions: Record<string, string[][]> = {};
  const calls: Record<string, string[]> = {};
  for (const model of ["gpt", "gpt-region", "claude"]) {
    assert.equal((await post(f.url, { model, input: history })).status, 200);
    const exchange = await latest(f.url);
    calls[model] = exchange.upstream.map((call: any) => call.label);
    assert.equal(JSON.parse(exchange.client.request.body.text).input[0].encrypted_content, checkpoint.encrypted_content);
    decisions[model] = exchange.annotations
      .filter((note: any) => note.target === "client.request")
      .map((note: any) => [note.pointer, note.decision, note.reason]);
  }
  assert.deepEqual(decisions, {
    gpt: [["/input/0", "native", "native_restored"], ["/input/1", "replay", "same_source"], ["/input/2", "passthrough", "unrecognized_state"]],
    "gpt-region": [["/input/0", "handoff", "source_not_allowed"], ["/input/1", "replay", "allowed_source"], ["/input/2", "passthrough", "unrecognized_state"]],
    claude: [["/input/0", "handoff", "native_replay_disabled"], ["/input/1", "drop", "source_not_allowed"], ["/input/2", "passthrough", "unrecognized_state"]],
  });
  assert.deepEqual(calls, { gpt: ["main"], "gpt-region": ["handoff", "main"], claude: ["main"] });
});

test("unrecognized state annotations match the configured outbound policy", async (t) => {
  for (const policy of ["passthrough", "drop", "error"] as const) {
    const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Done")]), config => {
      config.models.gpt.replay = { unrecognized: policy };
    });
    const input = [
      { type: "reasoning", id: "rs_external", encrypted_content: "cxbr1:unreadable" },
      { type: "compaction", id: "cmp_external", encrypted_content: "external-checkpoint" },
    ];
    const response = await post(f.url, { model: "gpt", input });
    assert.equal(response.status, policy === "error" ? 400 : 200);
    await response.text();
    const detail = await latest(f.url);
    assert.equal(detail.route.replay.unrecognized, policy);
    assert.deepEqual(detail.annotations.filter((note: any) => note.target === "client.request")
      .map((note: any) => [note.kind, note.decision, note.reason]), [
      ["reasoning", policy === "error" ? "reject" : policy, "unrecognized_state"],
      ["compaction", policy === "error" ? "reject" : policy, "unrecognized_state"],
    ]);
    if (policy === "error") assert.equal(f.seen.length, 0);
    else assert.deepEqual(JSON.parse(f.seen[0].text).input, policy === "drop" ? [] : input);
    assert.deepEqual(JSON.parse(detail.client.request.body.text).input, input);
  }
});

test("summary compaction is captured as one text call and reports its portable output", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Portable summary")]), config => {
    config.models.gpt.compaction = { mode: "summary" };
  });
  const response = await post(f.url, { model: "gpt", input: [{ type: "compaction_trigger" }] });
  const body = await response.json() as any;
  assert.match(body.output[0].encrypted_content, /^cxbc1:/);
  const detail = await latest(f.url);
  assert.deepEqual(detail.upstream.map((call: any) => call.label), ["summary"]);
  assert.equal(detail.annotations[0].decoded.summary, "Portable summary");
  assert.equal(detail.annotations[0].decoded.native, undefined);
  await (await post(f.url, { model: "gpt", input: body.output })).text();
  const replay = await latest(f.url);
  assert.equal(replay.annotations[0].decision, "summary");
  assert.equal(replay.annotations[0].reason, "no_native");
});

test("capture is off by default, follows the toggle, and evicts only finished exchanges", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Hello")]), config => {
    delete config.inspect;
    config.inspect = { max_mib: 1 };
  });
  await (await post(f.url, { model: "gpt", input: "not captured" })).text();
  assert.equal((await api(f.url, "state")).exchanges, 0);
  assert.equal((await api(f.url, "capture", { method: "POST", body: JSON.stringify({ enabled: true }) })).capturing, true);
  // Each exchange stores the client request and the passed-through upstream request (about 400 KiB).
  const large = "x".repeat(200 * 1024);
  for (let i = 0; i < 3; i++) await (await post(f.url, { model: "gpt", input: `${i}${large}` })).text();
  const state = await settled(f.url);
  assert.equal(state.evicted, 1);
  assert.equal(state.exchanges, 2);
  assert.ok(state.bytes <= state.max_bytes);
  const { ids } = await api(f.url, "exchanges?since=0");
  assert.deepEqual(ids, ["x2", "x3"]);
  assert.equal((await api(f.url, "capture", { method: "POST", body: JSON.stringify({ enabled: false }) })).capturing, false);
  await (await post(f.url, { model: "gpt", input: "off again" })).text();
  assert.equal((await api(f.url, "state")).exchanges, 2);
  assert.equal((await api(f.url, "exchanges", { method: "DELETE" })).exchanges, 0);
});

test("the last oversized exchange is evicted on close without another request", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Done")]), config => {
    config.inspect!.max_mib = 1;
  });
  const response = await post(f.url, { model: "gpt", input: "x".repeat(600 * 1024) });
  assert.equal((await response.json() as any).output[0].content[0].text, "Done");
  const state = await settled(f.url);
  assert.equal(state.evicted, 1);
  assert.equal(state.exchanges, 0);
  assert.equal(state.bytes, 0);
});

test("closing an over-cap exchange evicts it while another exchange remains active", async (t) => {
  const held: ServerResponse[] = [];
  let ready!: () => void;
  const arrived = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(t, (_body, _req, res) => {
    held.push(res);
    if (held.length === 2) ready();
  }, config => { config.inspect!.max_mib = 1; });
  const first = post(f.url, { model: "gpt", input: "a".repeat(400 * 1024) });
  const second = post(f.url, { model: "gpt", input: "b".repeat(400 * 1024) });
  await arrived;
  const active = await api(f.url, "state");
  assert.equal(active.active, 2);
  assert.equal(active.evicted, 0);
  assert.ok(active.bytes > active.max_bytes);

  // Complete both fetches independently of which request arrived first.
  nativeSuccess(held[0], [message("First")]);
  await Promise.race([first, second]).then(response => response.text());
  const state = await api(f.url, "state");
  assert.equal(state.active, 1);
  assert.equal(state.exchanges, 1);
  assert.equal(state.evicted, 1);
  assert.ok(state.bytes <= state.max_bytes);
  nativeSuccess(held[1], [message("Second")]);
  await Promise.all([first, second]).then(responses => Promise.all(responses.filter(response => !response.bodyUsed).map(response => response.text())));
  assert.equal((await settled(f.url)).exchanges, 1);
});

test("clear releases active capture buffers without interrupting the response", async (t) => {
  const records: Exchange[] = [];
  const begin = Inspector.prototype.begin;
  t.mock.method(Inspector.prototype, "begin", function (this: Inspector, req: IncomingMessage, res: ServerResponse) {
    const exchange = begin.call(this, req, res);
    if (exchange) records.push(exchange);
    return exchange;
  });
  let held!: ServerResponse;
  const f = await fixture(t, (_body, _req, res) => {
    held = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_synthetic" } })}\n\n`);
  });
  const response = await post(f.url, { model: "gpt", input: "x".repeat(64 * 1024), stream: true });
  const exchange = records[0];
  const call = exchange.calls[0];
  assert.ok(exchange.requestText!.length > 64 * 1024);
  assert.ok(call.text.length > 64 * 1024);
  assert.ok(exchange.response.parts.length > 0);
  assert.ok(call.response!.parts.length > 0);

  const cleared = await api(f.url, "exchanges", { method: "DELETE" });
  assert.equal(cleared.exchanges, 0);
  assert.equal(cleared.bytes, 0);
  const assertReleased = () => {
    assert.equal(exchange.requestText, undefined);
    assert.equal(exchange.requestBytes, 0);
    assert.equal(exchange.bytes, 0);
    assert.equal(exchange.calls.length, 0);
    assert.equal(exchange.response.bytes, 0);
    assert.deepEqual(exchange.response.parts, []);
    assert.equal(call.text, "");
    assert.equal(call.bytes, 0);
    assert.equal(call.response!.bytes, 0);
    assert.deepEqual(call.response!.parts, []);
  };
  assertReleased();
  held.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output: [message("Still completes")], usage } })}\n\n`);
  const text = await response.text();
  assert.match(text, /Still completes/);
  assert.match(text, /response\.completed/);
  assertReleased();
  const state = await api(f.url, "state");
  assert.equal(state.exchanges, 0);
  assert.equal(state.bytes, 0);
  assert.equal(state.rev, cleared.rev);
  assert.equal(state.capturing, true);
});

test("stopping capture lets active exchanges finish recording", async (t) => {
  let held!: ServerResponse;
  const f = await fixture(t, (_body, _req, res) => {
    held = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_synthetic" } })}\n\n`);
  });
  const response = await post(f.url, { model: "gpt", input: "Continue recording", stream: true });
  await api(f.url, "capture", { method: "POST", body: JSON.stringify({ enabled: false }) });
  held.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output: [message("After capture stopped")], usage } })}\n\n`);
  const text = await response.text();
  const detail = await latest(f.url);
  assert.equal(detail.client.response.body.text, text);
  assert.match(detail.upstream[0].response.body.text, /After capture stopped/);
  assert.equal(detail.outcome, "completed");
});

test("a client disconnect is recorded as aborted with a cancelled upstream call", async (t) => {
  let held: ServerResponse | undefined;
  const f = await fixture(t, (_body, _req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_synthetic" } })}\n\n`);
    held = res;
  });
  const controller = new AbortController();
  const response = await post(f.url, { model: "gpt", input: "wait", stream: true }, { signal: controller.signal });
  assert.equal(response.status, 200);
  while (!held) await delay(5);
  controller.abort();
  const detail = await latest(f.url);
  held.end();
  assert.equal(detail.outcome, "aborted");
  assert.equal(detail.client.response.end, "cancelled");
  assert.notEqual(detail.upstream[0].response.end, "active");
});

function raw(url: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${url}${path}`, { headers }, res => { res.resume(); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers })); });
    req.on("error", reject);
    req.end();
  });
}

test("the inspector API accepts only local same-origin pages without a token", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, []));
  const host = new URL(f.url).host;
  assert.equal((await raw(f.url, "/inspect/api/state", {})).status, 200);
  assert.equal((await raw(f.url, "/inspect/api/state", { origin: `http://${host}` })).status, 200);
  assert.equal((await raw(f.url, "/inspect/api/state", { origin: "http://attacker.example" })).status, 403);
  assert.equal((await raw(f.url, "/inspect/api/state", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await raw(f.url, "/inspect/api/state", { host: "rebound.example" })).status, 403);

  const page = await raw(f.url, "/inspect/", {});
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
  const redirect = await raw(f.url, "/inspect", {});
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, "/inspect/");
  assert.equal((await raw(f.url, "/inspect/%2e%2e%2fpackage.json", {})).status, 404);
  assert.equal((await raw(f.url, "/inspect/missing.js", {})).status, 404);
});

test("with a bridge token the inspector API requires it and pages stay public", async (t) => {
  const variable = "INSPECT_TEST_BRIDGE_TOKEN";
  process.env[variable] = "synthetic-bridge-token";
  t.after(() => { delete process.env[variable]; });
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, []), config => { config.token_env = variable; });
  assert.equal((await fetch(`${f.url}/inspect/api/state`)).status, 401);
  const state = await api(f.url, "state", { headers: { authorization: "Bearer synthetic-bridge-token" } });
  assert.equal(state.capturing, true);
  assert.equal((await fetch(`${f.url}/inspect/`)).status, 200);
});

test("export streams every exchange in the capture file format", async (t) => {
  const f = await fixture(t, (_body, _req, res) => nativeSuccess(res, [message("Hello")]));
  for (const input of ["one", "two"]) await (await post(f.url, { model: "gpt", input })).text();
  await settled(f.url);
  const response = await fetch(`${f.url}/inspect/api/export`);
  assert.match(String(response.headers.get("content-disposition")), /^attachment; filename="codeks-bridge-capture-/);
  const file: any = await response.json();
  assert.equal(file.format, "codeks-bridge-capture");
  assert.equal(file.version, 1);
  assert.deepEqual(file.exchanges.map((exchange: any) => exchange.preview), ["one", "two"]);
  assert.equal(typeof file.exchanges[0].upstream[0].body.text, "string");
});

test("SSE parsing handles line breaks split across chunks and keeps chunk times", () => {
  const events = sseEvents([
    { t: 1, text: "event: a\r" },
    { t: 2, text: "\ndata: {\"n\":1}\r\n\r" },
    { t: 3, text: "\n: keepalive\n\ndata: two\ndata: lines\n\ndata: tail" },
  ]);
  assert.deepEqual(events, [
    { t: 3, event: "a", data: "{\"n\":1}" },
    { t: 3, event: null, data: "two\nlines" },
    { t: 3, event: null, data: "tail" },
  ]);
});
