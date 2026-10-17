import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { responsesBody, runResponses } from "../src/backends/responses.ts";
import { decodeReasoning, encodeReasoning } from "../src/carrier.ts";
import { formatSse } from "../src/sse.ts";
import type { BackendContext, ResolvedModel } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const route: ResolvedModel = {
  slug: "test", key: "endpoint-a/model-a", config: { upstream: "test", model: "model-a" },
  upstream: { api: "responses", base_url: "https://example.com/v1" },
};
const context = (extra: Partial<BackendContext> = {}): BackendContext => ({
  route, request: { model: "test", input: "Hello" }, signal: new AbortController().signal, ...extra,
});

function capture() {
  const events: any[] = [];
  const writer = new ResponseWriter({ write: (text) => events.push(JSON.parse(text.slice(6))) }, { model: "test" });
  writer.start();
  return { writer, events };
}

async function fakeUpstream(payload: any[] | Record<string, any>, run: (base: string, requests: any[]) => Promise<void>) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (Array.isArray(payload)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(payload.map((item) => formatSse(item)).join(""));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}/v1`, requests); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("request replay unwraps only matching reasoning and removes linked item ids", () => {
  const input = [
    { type: "reasoning", id: "rs_old", encrypted_content: encodeReasoning(route.key, "cipher-a") },
    { type: "reasoning", id: "rs_foreign", encrypted_content: encodeReasoning("other", "cipher-b") },
    { type: "message", id: "msg_orphan", role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
    { type: "function_call", id: "fc_old", namespace: "actions", name: "read", call_id: "call_a", arguments: "{}" },
    { type: "function_call_output", id: "fco_old", call_id: "call_a", output: "42" },
  ];
  const body = responsesBody(context({ request: { model: "alias", input, store: true, stream: false } }));
  assert.equal(body.model, "model-a");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.input.length, 4);
  assert.equal(body.input[0].encrypted_content, "cipher-a");
  assert(body.input.every((item: any) => item.id === undefined));
  assert.equal(body.input[2].call_id, "call_a");
  assert.equal(body.input[2].namespace, "actions");
  assert.equal(input[0].id, "rs_old");
  assert.throws(() => responsesBody(context({ request: { model: "test", previous_response_id: "resp_stored" } })), /complete conversation/);
});

test("compaction summary stays plain text without tool calls despite options", () => {
  const configured = { ...route, config: { ...route.config, max_output_tokens: 1000, options: { tool_choice: "required", text: { format: { type: "json_object" } } } } };
  const body = responsesBody(context({ route: configured, compacting: true, request: { model: "test", input: "Summarize", max_output_tokens: 2000 } }));
  assert.equal(body.max_output_tokens, 2000);
  assert.equal(body.tool_choice, "none");
  assert.equal(body.text, undefined);
  const native = responsesBody(context({
    route: { ...configured, config: { ...configured.config, options: { ...configured.config.options, max_output_tokens: 5000 } } },
    compacting: true, request: { model: "test", input: [{ type: "compaction_trigger" }], max_output_tokens: 4000 },
  }));
  assert.equal(native.tool_choice, "required");
  assert.equal(native.max_output_tokens, undefined);
});

test("SSE reasoning and text stream once; the completed carrier is replayable", async () => {
  const reasoning = { type: "reasoning", id: "rs_test", summary: [{ type: "summary_text", text: "Brief thought" }], encrypted_content: "cipher-a" };
  const message = { type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "Hello world" }] };
  const usage = { input_tokens: 80, input_tokens_details: { cached_tokens: 40 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 7 } };
  await fakeUpstream([
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_test", delta: "Brief thought" },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_test", delta: "Hello " },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_test", delta: "world" },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response: { status: "completed", output: [reasoning, message], usage } },
  ], async (base, requests) => {
    const { writer, events } = capture();
    const result = await runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer);
    assert.equal(writer.isFinished, false);
    writer.complete(result.usage, result.endTurn);
    const done = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
    assert.equal(done.length, 2);
    assert.deepEqual(decodeReasoning(done[0].encrypted_content), { key: route.key, payload: "cipher-a" });
    assert.equal(done[1].content[0].text, "Hello world");
    assert.equal(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), "Hello world");
    assert.deepEqual(result, { usage: { input_tokens: 80, cached_tokens: 40, output_tokens: 12, reasoning_tokens: 7 }, endTurn: true });
    assert.equal(requests[0].url, "/v1/responses");
  });
});

test("function and grammar tool calls keep original names and wait for completed", async () => {
  const calls = [
    { type: "function_call", id: "fc_test", namespace: "agents", name: "spawn_agent", call_id: "call_one", arguments: '{"message":"Inspect the file"}' },
    { type: "custom_tool_call", id: "ctc_test", name: "apply_patch", call_id: "call_two", input: "*** Begin Patch\n*** End Patch" },
  ];
  await fakeUpstream({ status: "completed", output: calls, usage: { input_tokens: 5, output_tokens: 7 } }, async (base) => {
    const { writer, events } = capture();
    const result = await runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer);
    assert.equal(result.endTurn, false);
    assert.equal(events.filter((event) => event.type === "response.output_item.done").length, 0);
    writer.complete(result.usage, result.endTurn);
    const output = events.at(-1).response.output;
    assert.equal(output[0].namespace, "agents");
    assert.equal(output[0].name, "spawn_agent");
    assert.deepEqual(output[0].encrypted_function_args, []);
    assert.equal(output[1].input, calls[1].input);
  });
});

test("native compaction keeps the trigger and returns the unwrapped native item", async () => {
  const item = { type: "compaction", id: "cmp_test", encrypted_content: "native-checkpoint" };
  await fakeUpstream({ status: "completed", output: [item], usage: { input_tokens: 30, output_tokens: 4 } }, async (base, requests) => {
    const { writer, events } = capture();
    await runResponses(context({
      compacting: true, route: { ...route, upstream: { ...route.upstream, base_url: base } },
      request: { model: "test", input: [{ type: "compaction_trigger" }] },
    }), writer);
    assert.deepEqual(requests[0].body.input, [{ type: "compaction_trigger" }]);
    assert.deepEqual(events.find((event) => event.type === "response.output_item.done").item, item);
  });
});

test("failed, incomplete and disconnected streams do not release tool calls", async () => {
  const call = { type: "function_call", name: "read", call_id: "call_test", arguments: "{}" };
  const endings = [
    { type: "response.failed", response: { error: { code: "server_is_overloaded", message: "Busy", headers: { "retry-after": "10" } } } },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    null,
  ];
  for (const ending of endings) {
    await fakeUpstream([
      { type: "response.output_item.done", output_index: 0, item: call },
      ...(ending ? [ending] : []),
    ], async (base) => {
      const { writer, events } = capture();
      await assert.rejects(runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer));
      assert.equal(events.some((event) => event.type === "response.output_item.done"), false);
      assert.equal(writer.toolCallCount, 0);
    });
  }
});

test("HTTP 200 does not turn an error or unfinished JSON response into success", async () => {
  for (const payload of [
    { error: { code: "server_is_overloaded", message: "Busy" } },
    { status: "in_progress", output: [] },
  ]) {
    await fakeUpstream(payload, async (base) => {
      const { writer, events } = capture();
      await assert.rejects(runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer));
      assert.equal(events.some((event) => event.type === "response.completed"), false);
    });
  }
});

test("invalid or missing usage fails before buffered tools are released", async () => {
  const call = { type: "function_call", name: "read", call_id: "call_test", arguments: "{}" };
  const valid = { input_tokens: 10, output_tokens: 2 };
  for (const usage of [
    undefined,
    { input_tokens: 10 },
    { ...valid, input_tokens: "10" },
    { ...valid, output_tokens: -1 },
    { ...valid, input_tokens: 0.5 },
    { ...valid, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, input_tokens_details: { cached_tokens: null } },
    { ...valid, output_tokens_details: { reasoning_tokens: -1 } },
  ]) {
    await fakeUpstream([
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { status: "completed", output: [call], usage } },
    ], async (base) => {
      const { writer, events } = capture();
      await assert.rejects(runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer),
        { code: "upstream_error", status: 502 });
      assert.equal(writer.toolCallCount, 0);
      assert.equal(events.some((event) => event.type === "response.output_item.done"), false);
    });
  }
});

test("zero token counts are valid and detail counts remain optional", async () => {
  await fakeUpstream({ status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } }, async (base) => {
    const { writer } = capture();
    const result = await runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer);
    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
  });
});
