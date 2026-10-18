import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { responsesBody, runResponses } from "../src/backends/responses.ts";
import { decodeReasoning, encodeReasoning } from "../src/carrier.ts";
import { formatSse } from "../src/sse.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import type { BackendContext } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const config = validateConfig({
  upstreams: { test: { base_url: "https://example.com/v1" } },
  models: {
    test: { upstream: "test", model: "model-a", catalog: "gpt-6.1-sol" },
    other: { upstream: "test", model: "model-b", catalog: "gpt-6.1-sol" },
    shared: { upstream: "test", model: "model-c", catalog: "gpt-6.1-sol", replay: { reasoning_from: ["test"] } },
  },
});
const route = resolveModel(config, "test");
const carrier = (source = route, data = "cipher-a") => encodeReasoning({ source: source.origin, format: source.profile.reasoning_format, data });
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
    { type: "reasoning", id: "rs_old", encrypted_content: carrier() },
    { type: "reasoning", id: "rs_foreign", encrypted_content: carrier(resolveModel(config, "other"), "cipher-b") },
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
    assert.deepEqual(decodeReasoning(done[0].encrypted_content), { source: route.origin, format: route.profile.reasoning_format, data: "cipher-a" });
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

test("Responses restores explicitly shared reasoning and honors configured request parameters", () => {
  const shared = resolveModel(config, "shared");
  const input = [{ type: "reasoning", encrypted_content: carrier() }];
  assert.equal(responsesBody(context({ route: shared, request: { model: "shared", input } })).input[0].encrypted_content, "cipher-a");
  const customConfig = validateConfig({
    ...config,
    models: { ...config.models, test: { ...config.models.test, reasoning: { default_effort: "brief", effort_map: { brief: "low" } } } },
  });
  const custom = resolveModel(customConfig, "test");
  assert.equal(responsesBody(context({ route: custom })).reasoning.effort, "low");
  const request = { model: "test", input, reasoning: { effort: "future-level" } };
  assert.equal(responsesBody(context({ route: custom, request })).reasoning.effort, "future-level");
  const body = responsesBody(context({ request, route: { ...custom, upstream: { ...custom.upstream, options: { max_output_tokens: 100, reasoning: { effort: "high" } } }, config: { ...custom.config, options: { reasoning: { effort: "custom" }, model: "wrong", input: [], tools: ["wrong"], stream: false } } } }));
  assert.equal(body.reasoning.effort, "custom");
  assert.equal(body.model, "model-a");
  assert.equal(body.input[0].encrypted_content, "cipher-a");
  assert.equal(body.tools, undefined);
  assert.equal(body.stream, true);
});

test("Responses stream errors preserve upstream details and retry hints", async () => {
  const failure = { error: { code: "server_is_overloaded", message: "Capacity unavailable.", headers: { "Retry-After": "12" }, request_id: "synthetic_request" } };
  await fakeUpstream([{ type: "response.failed", response: failure }], async (base) => {
    const { writer } = capture();
    await assert.rejects(runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer), (error: any) => {
      assert.equal(error.message, "Capacity unavailable.");
      assert.deepEqual(error.error, failure.error);
      return true;
    });
  });
});


test("Responses Lite keeps native phases and an unfinished turn without tool calls", async () => {
  const usage = { input_tokens: 4, output_tokens: 2 };
  for (const phase of ["commentary", "partial_answer", "final_answer", undefined]) {
    const message = { type: "message", id: "msg_phase", role: "assistant", phase, content: [{ type: "output_text", text: "Continuing." }] };
    for (const streaming of [true, false]) {
      const completed = { status: "completed", end_turn: false, output: [message], usage };
      const payload = streaming ? [
        { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
        { type: "response.output_text.delta", output_index: 0, item_id: message.id, delta: "Continuing." },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: completed },
      ] : completed;
      await fakeUpstream(payload, async (base) => {
        const { writer, events } = capture();
        let accepted = false;
        const result = await runResponses(context({
          route: { ...route, upstream: { ...route.upstream, base_url: base } }, responsesLite: true,
          onAccepted: () => { assert.equal(writer.hasOutput, false); accepted = true; },
        }), writer);
        assert.equal(accepted, true);
        writer.complete(result.usage, result.endTurn);
        const response = events.at(-1).response;
        assert.equal(response.end_turn, false);
        assert.equal(response.output[0].phase, phase ?? "commentary");
      });
    }
  }
});

test("message phase provided only on item completion is retained", async () => {
  const message = { type: "message", id: "msg_late_phase", role: "assistant", content: [{ type: "output_text", text: "A partial answer." }] };
  await fakeUpstream([
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: message.id, delta: "A partial answer." },
    { type: "response.output_item.done", output_index: 0, item: { ...message, phase: "partial_answer" } },
    { type: "response.completed", response: { status: "completed", end_turn: false, output: [], usage: { input_tokens: 2, output_tokens: 3 } } },
  ], async (base) => {
    const { writer, events } = capture();
    const result = await runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer);
    writer.complete(result.usage, result.endTurn);
    assert.equal(events.at(-1).response.output[0].phase, "partial_answer");
  });
});

test("GPT summary parts retain boundaries in streaming and complete JSON responses", async () => {
  const summary = [{ type: "summary_text", text: "First." }, { type: "summary_text", text: "Second." }];
  const item = { type: "reasoning", id: "rs_parts", summary, encrypted_content: "synthetic-cipher" };
  const completed = { status: "completed", output: [item], usage: { input_tokens: 4, output_tokens: 2 } };
  const streamed = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, summary: [], encrypted_content: null } },
    ...summary.flatMap((part, summary_index) => [
      { type: "response.reasoning_summary_part.added", item_id: item.id, output_index: 0, summary_index, part: { ...part, text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: 0, summary_index, delta: part.text },
      { type: "response.reasoning_summary_text.done", item_id: item.id, output_index: 0, summary_index, text: part.text },
      { type: "response.reasoning_summary_part.done", item_id: item.id, output_index: 0, summary_index, part },
    ]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
  for (const payload of [streamed, completed]) {
    await fakeUpstream(payload, async (base) => {
      const { writer, events } = capture();
      const result = await runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer);
      writer.complete(result.usage, result.endTurn);
      assert.deepEqual(events.at(-1).response.output[0].summary, summary);
      assert.deepEqual(events.filter((event) => event.type === "response.reasoning_summary_part.added").map((event) => event.summary_index), [0, 1]);
      assert.deepEqual(events.filter((event) => event.type === "response.reasoning_summary_part.done").map((event) => event.part), summary);
      assert.deepEqual(events.filter((event) => event.type === "response.reasoning_summary_text.delta").map((event) => [event.summary_index, event.delta]), [[0, "First."], [1, "Second."]]);
      assert.equal(decodeReasoning(events.at(-1).response.output[0].encrypted_content)?.data, "synthetic-cipher");
    });
  }
});

test("GPT stream and JSON failures retain unrecognized native codes and details", async () => {
  for (const code of ["cyber_policy", "bio_policy", "misalignment_policy_violation", "usage_not_included", "flex_unavailable", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "future_native_code"]) {
    const error = { code, message: "Synthetic failure.", misalignment: { category: "synthetic" }, plan_type: "synthetic", resets_at: 1234567890 };
    for (const payload of [[{ type: "response.failed", response: { status: "failed", error } }], { status: "failed", error }]) {
      await fakeUpstream(payload, async (base) => {
        const { writer } = capture();
        await assert.rejects(runResponses(context({ route: { ...route, upstream: { ...route.upstream, base_url: base } } }), writer), (failure: any) => {
          assert.deepEqual(failure.error, error);
          return true;
        });
      });
    }
  }
});
