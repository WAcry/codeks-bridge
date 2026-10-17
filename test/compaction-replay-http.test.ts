import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { encodeCompaction, decodeCompaction, encodeReasoning } from "../src/carrier.ts";
import { resolveModel } from "../src/config.ts";
import { createBridgeServer } from "../src/server.ts";
import type { BridgeConfig } from "../src/types.ts";

type Handler = (body: any, request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
const usage = { input_tokens: 12, output_tokens: 3 };
const summary = "The verified answer is 42; continue from this saved progress.";
const rejection = { code: "invalid_encrypted_content", message: "The encrypted compaction content could not be decrypted." };
const metadata = { thread_id: "thread_synthetic_parent", turn_id: "turn_synthetic_one" };

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fixture(t: TestContext, handler: Handler) {
  const seen: { path: string; body: any }[] = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ path: request.url!, body });
      await handler(body, request, response);
    } catch {
      if (!response.destroyed) { response.writeHead(500); response.end(); }
    }
  });
  const origin = await listen(upstream);
  const config: BridgeConfig = {
    upstreams: {
      primary: { api: "responses", base_url: `${origin}/primary` },
      region: { api: "responses", base_url: `${origin}/region` },
    },
    models: {
      gpt: { upstream: "primary", model: "gpt-synthetic-one" },
      alias: { upstream: "primary", model: "gpt-synthetic-one" },
      other: { upstream: "primary", model: "gpt-synthetic-two" },
      region: { upstream: "region", model: "gpt-synthetic-one" },
      options: { upstream: "primary", model: "gpt-synthetic-one", options: { service_tier: "priority" } },
    },
  };
  let bridge = createBridgeServer(config);
  let url = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  return {
    config, seen,
    get url() { return url; },
    async restart() {
      await close(bridge);
      bridge = createBridgeServer(config);
      url = await listen(bridge);
    },
  };
}

function checkpoint(ciphertext = "synthetic-native-checkpoint") {
  return {
    type: "compaction", id: "cmp_synthetic_carrier",
    encrypted_content: encodeCompaction({
      v: 1, summary,
      native: { key: "synthetic-origin-model-key", item: { type: "compaction", id: "cmp_synthetic_native", encrypted_content: ciphertext } },
    }),
  };
}

function input(ciphertext?: string) {
  return [checkpoint(ciphertext), { type: "message", role: "user", content: "Continue." }];
}

function nativeInput(body: any): boolean {
  return body.input.some((item: any) => ["compaction", "compaction_summary"].includes(item.type));
}

function sse(response: ServerResponse, events: unknown[], finish = true) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  if (finish) response.end();
}

function success(response: ServerResponse, output: unknown[] = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Continued." }] }]) {
  sse(response, [{ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output, usage } }]);
}

function fail(response: ServerResponse, status = 400, error: unknown = rejection) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
}

async function post(url: string, body: Record<string, unknown>, init: RequestInit = {}) {
  return fetch(`${url}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt", input: input(), client_metadata: metadata, ...body }), ...init,
  });
}

async function events(response: Response): Promise<any[]> {
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return (await response.text()).split("\n\n").filter(Boolean)
    .map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
}

async function json(response: Response): Promise<any> {
  return response.json();
}

test("Responses reuse a foreign native checkpoint while reasoning stays model-specific", async (t) => {
  const f = await fixture(t, (_body, _request, response) => success(response));
  const source = input();
  source.splice(1, 0, {
    type: "reasoning", encrypted_content: encodeReasoning("synthetic-origin-model-key", "synthetic-foreign-reasoning"),
  } as any, {
    type: "reasoning", encrypted_content: encodeReasoning(resolveModel(f.config, "gpt").key, "synthetic-current-reasoning"),
  } as any);
  const original = structuredClone(source);
  const response = await post(f.url, { input: source });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).status, "completed");
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].body.input[0].encrypted_content, "synthetic-native-checkpoint");
  assert.deepEqual(f.seen[0].body.input.filter((item: any) => item.type === "reasoning")
    .map((item: any) => item.encrypted_content), ["synthetic-current-reasoning"]);
  assert.equal(JSON.stringify(f.seen[0].body).includes(summary), false);
  assert.deepEqual(source, original);
});

test("successful summary fallback is reused only for the same turn, thread, target and checkpoint", async (t) => {
  const f = await fixture(t, (body, _request, response) => nativeInput(body) ? fail(response) : success(response));
  const cases = [
    { body: {}, native: true },
    { body: {}, native: false },
    { body: { model: "alias" }, native: false },
    { body: { model: "other" }, native: true },
    { body: { model: "region" }, native: true },
    { body: { model: "options" }, native: true },
    { body: { input: input("synthetic-new-checkpoint") }, native: true },
    { body: { client_metadata: { ...metadata, thread_id: "thread_synthetic_child" } }, native: true },
    { body: { client_metadata: { ...metadata, turn_id: "turn_synthetic_two" } }, native: true },
  ];
  for (const entry of cases) {
    const start = f.seen.length;
    const response = await post(f.url, entry.body);
    assert.equal(response.status, 200, JSON.stringify(entry.body));
    assert.equal((await json(response)).status, "completed");
    const attempts = f.seen.slice(start).map(item => nativeInput(item.body));
    assert.deepEqual(attempts, entry.native ? [true, false] : [false], JSON.stringify(entry.body));
    const finalInput = f.seen.at(-1)!.body.input;
    assert.ok(JSON.stringify(finalInput).includes(summary));
    assert.equal(JSON.stringify(finalInput).includes("cxbc1:"), false);
  }
  f.config.upstreams.primary.options = { service_tier: "flex" };
  const start = f.seen.length;
  assert.equal((await post(f.url, {})).status, 200);
  assert.deepEqual(f.seen.slice(start).map(item => nativeInput(item.body)), [true, false]);
  await f.restart();
  const restartStart = f.seen.length;
  assert.equal((await post(f.url, {})).status, 200);
  assert.deepEqual(f.seen.slice(restartStart).map(item => nativeInput(item.body)), [true, false]);
});

test("absent or incomplete turn metadata allows fallback without sharing a decision across requests", async (t) => {
  const f = await fixture(t, (body, _request, response) => nativeInput(body) ? fail(response) : success(response));
  for (const client_metadata of [undefined, { thread_id: metadata.thread_id }, { turn_id: metadata.turn_id }]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const start = f.seen.length;
      const response = await post(f.url, { client_metadata });
      assert.equal(response.status, 200);
      await response.json();
      assert.deepEqual(f.seen.slice(start).map(item => nativeInput(item.body)), [true, false]);
    }
  }
});

for (const transport of ["HTTP", "nested HTTP", "SSE"] as const) {
  test(`${transport} encrypted compaction rejection falls back once before output`, async (t) => {
    const f = await fixture(t, (body, _request, response) => {
      if (!nativeInput(body)) { success(response); return; }
      if (transport === "SSE") {
        sse(response, [{ type: "response.created", response: { id: "resp_rejected", status: "in_progress" } },
          { type: "response.failed", response: { error: rejection } }]);
      } else if (transport === "nested HTTP") {
        fail(response, 400, { code: "400", message: `Upstream rejected request: ${JSON.stringify({ error: rejection })}` });
      } else fail(response);
    });
    const history: Record<string, any>[] = input();
    history.splice(1, 0, {
      type: "reasoning", encrypted_content: encodeReasoning(resolveModel(f.config, "gpt").key, "synthetic-matching-reasoning"),
    }, {
      type: "reasoning", encrypted_content: encodeReasoning("synthetic-foreign-model", "synthetic-unrelated-reasoning"),
    });
    const original = structuredClone(history);
    const frames = await events(await post(f.url, { stream: true, input: history }));
    assert.equal(frames.filter(frame => frame.type === "response.created").length, 1);
    assert.equal(frames.filter(frame => frame.type === "response.completed").length, 1);
    assert.equal(frames.some(frame => frame.type === "response.failed"), false);
    assert.deepEqual(f.seen.map(item => nativeInput(item.body)), [true, false]);
    assert.equal(frames.at(-1).response.output[0].content[0].text, "Continued.");
    for (const attempt of f.seen) {
      assert.deepEqual(attempt.body.input.filter((item: any) => item.type === "reasoning")
        .map((item: any) => item.encrypted_content), ["synthetic-matching-reasoning"]);
    }
    assert.deepEqual(history, original);
  });
}

test("a rejected attempt cannot leak buffered tool calls into the successful fallback", async (t) => {
  const f = await fixture(t, (body, _request, response) => {
    if (!nativeInput(body)) { success(response); return; }
    const item = { type: "function_call", id: "fc_synthetic", call_id: "call_synthetic", name: "lookup", arguments: "{}" };
    sse(response, [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.failed", response: { error: rejection } },
    ]);
  });
  const frames = await events(await post(f.url, {
    stream: true, tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
  }));
  assert.equal(frames.at(-1).type, "response.completed");
  assert.equal(frames.some(frame => frame.item?.type === "function_call"), false);
  assert.equal(frames.at(-1).response.output.some((item: any) => item.type === "function_call"), false);
  assert.deepEqual(f.seen.map(item => nativeInput(item.body)), [true, false]);
});

for (const failure of [
  { status: 429, code: "rate_limit_exceeded", message: "Too many requests" },
  { status: 503, code: "server_is_overloaded", message: "No capacity available" },
  { status: 400, code: "invalid_request_error", message: "Unsupported request field" },
]) {
  test(`ordinary ${failure.status} ${failure.code} errors do not trigger a compaction fallback`, async (t) => {
    const f = await fixture(t, (_body, _request, response) => fail(response, failure.status, failure));
    const response = await post(f.url, {});
    assert.equal(response.status, failure.status);
    assert.equal((await json(response)).error.code, failure.status === 400 ? "invalid_prompt" : failure.code);
    assert.equal(f.seen.length, 1);
    assert.equal(nativeInput(f.seen[0].body), true);
  });
}

for (const emitted of ["text", "reasoning"] as const) {
  test(`encrypted compaction rejection after streamed ${emitted} does not restart the response`, async (t) => {
    const f = await fixture(t, (_body, _request, response) => sse(response, [
      { type: emitted === "text" ? "response.output_text.delta" : "response.reasoning_summary_text.delta", output_index: 0, delta: "Already visible" },
      { type: "response.failed", response: { error: rejection } },
    ]));
    const frames = await events(await post(f.url, { stream: true }));
    assert.equal(frames.at(-1).type, "response.failed");
    assert.ok(frames.some(frame => frame.delta === "Already visible"));
    assert.equal(frames.some(frame => frame.type === "response.completed"), false);
    assert.equal(f.seen.length, 1);
  });
}

test("failed summary fallback is tried only once and does not suppress native replay on the next request", async (t) => {
  let succeed = false;
  const f = await fixture(t, (body, _request, response) => {
    if (nativeInput(body) || !succeed) fail(response);
    else success(response);
  });
  const first = await post(f.url, {});
  assert.equal(first.status, 400);
  await first.json();
  assert.deepEqual(f.seen.map(item => nativeInput(item.body)), [true, false]);
  succeed = true;
  const second = await post(f.url, {});
  assert.equal(second.status, 200);
  await second.json();
  assert.deepEqual(f.seen.map(item => nativeInput(item.body)), [true, false, true, false]);
  const third = await post(f.url, {});
  assert.equal(third.status, 200);
  await third.json();
  assert.deepEqual(f.seen.map(item => nativeInput(item.body)), [true, false, true, false, false]);
});

test("cancelling a summary fallback closes its upstream and does not remember success", { timeout: 5000 }, async (t) => {
  let fallbackStarted!: () => void;
  let fallbackClosed!: () => void;
  const started = new Promise<void>(resolve => { fallbackStarted = resolve; });
  const closed = new Promise<void>(resolve => { fallbackClosed = resolve; });
  let hold = true;
  const f = await fixture(t, (body, _request, response) => {
    if (nativeInput(body)) { fail(response); return; }
    if (!hold) { success(response); return; }
    response.on("close", fallbackClosed);
    sse(response, [{ type: "response.created", response: { id: "resp_pending", status: "in_progress" } }], false);
    fallbackStarted();
  });
  const controller = new AbortController();
  const response = await post(f.url, { stream: true }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(response.text(), /abort/i);
  await closed;
  hold = false;
  const retry = await post(f.url, {});
  assert.equal(retry.status, 200);
  await retry.json();
  assert.deepEqual(f.seen.map(item => nativeInput(item.body)), [true, false, true, false]);
});

for (const failSummary of [false, true]) {
  test(`dual compaction independently falls back on both legs and ${failSummary ? "publishes no half-checkpoint when one fails" : "publishes one checkpoint only after both succeed"}`, async (t) => {
    const waiting: ServerResponse[] = [];
    const f = await fixture(t, (body, _request, response) => {
      if (nativeInput(body)) {
        // Force both legs to receive the old native checkpoint before either fallback can succeed.
        waiting.push(response);
        if (waiting.length === 2) for (const pending of waiting) fail(pending);
        return;
      }
      if (body.input.at(-1)?.type === "compaction_trigger") {
        success(response, [{ type: "compaction", encrypted_content: "synthetic-new-native-checkpoint" }]);
      } else if (failSummary) {
        fail(response, 503, { code: "server_is_overloaded", message: "No capacity for the summary" });
      } else {
        success(response, [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "New portable summary." }] }]);
      }
    });
    const history = [...input(), { type: "compaction_trigger" }];
    const original = structuredClone(history);
    const frames = await events(await post(f.url, { input: history, stream: true }));
    assert.equal(f.seen.filter(item => nativeInput(item.body)).length, 2);
    assert.equal(f.seen.filter(item => !nativeInput(item.body)).length, 2);
    assert.deepEqual(history, original);
    const published = frames.filter(frame => frame.type === "response.output_item.done" && frame.item.type === "compaction");
    if (failSummary) {
      assert.equal(frames.at(-1).type, "response.failed");
      assert.equal(frames.at(-1).response.error.code, "server_is_overloaded");
      assert.equal(published.length, 0);
      assert.equal(frames.some(frame => frame.type === "response.completed"), false);
    } else {
      assert.equal(frames.at(-1).type, "response.completed");
      assert.equal(published.length, 1);
      const saved = decodeCompaction(published[0].item.encrypted_content)!;
      assert.equal(saved.summary, "New portable summary.");
      assert.equal(saved.native?.item.encrypted_content, "synthetic-new-native-checkpoint");
      assert.equal(frames.at(-1).response.usage.input_tokens, 24);
    }
  });
}
