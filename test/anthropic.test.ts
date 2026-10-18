import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { buildAnthropicRequest, runAnthropic } from "../src/backends/anthropic.ts";
import { decodeReasoning, encodeReasoning } from "../src/carrier.ts";
import { formatSse } from "../src/sse.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import type { BackendContext, ResponsesRequest } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const config = validateConfig({
  upstreams: { messages: { base_url: "https://api.example.com/v1" } },
  models: {
    "messages-model": { upstream: "messages", model: "claude-sonnet-5-5", catalog: "claude-sonnet-5-5" },
    other: { upstream: "messages", model: "other", catalog: "claude-sonnet-5-5" },
    shared: { upstream: "messages", model: "shared", catalog: "claude-sonnet-5-5", replay: { reasoning_from: ["messages-model"] } },
  },
});
const route = resolveModel(config, "messages-model");
function context(request: Partial<ResponsesRequest> = {}): BackendContext {
  return { route, request: { model: route.slug, input: "Hello", ...request }, signal: new AbortController().signal };
}
const tool = { type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } };
const thinking = { type: "thinking", thinking: "Synthetic reasoning.", signature: "synthetic_signature" };
const reasoning = { type: "reasoning", encrypted_content: encodeReasoning({ source: route.origin, format: route.profile.reasoning_format, data: thinking }) };
const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const events = (...values: unknown[]) => values.map((value) => formatSse(value)).join("");
const start = { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 1 } } };
const finish = (stop = "end_turn") => [
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 20 } } },
  { type: "message_stop" },
];
function textEvents(text: string): unknown[] {
  return [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
  ];
}

async function withUpstream<T>(stream: string, fn: (base: string, requests: any[]) => Promise<T>): Promise<T> {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(stream);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try { return await fn(`http://127.0.0.1:${address.port}/v1`, requests); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function writerCapture(): { writer: ResponseWriter; output: () => any[] } {
  let raw = "";
  const writer = new ResponseWriter({ write: (chunk) => { raw += chunk; } }, { model: route.slug });
  writer.start();
  return { writer, output: () => raw.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6))) };
}

test("Messages preserves signed reasoning, chronological instructions, and grouped tools", () => {
  const foreign = { type: "reasoning", encrypted_content: encodeReasoning({ source: resolveModel(config, "other").origin, format: route.profile.reasoning_format, data: thinking }) };
  const input = [
    message("developer", "Initial rules."), message("user", "Look up a."), foreign, reasoning,
    { type: "function_call", call_id: "call/1", name: "lookup", arguments: '{"q":"a"}' },
    { type: "function_call", call_id: "call/2", name: "lookup", arguments: '{"q":"b"}' },
    { type: "function_call_output", call_id: "call/1", output: "a result" },
    { type: "function_call_output", call_id: "call/2", output: "b result" },
    message("developer", "New constraint."),
  ];
  const before = JSON.stringify(input);
  const { body } = buildAnthropicRequest(context({ input, instructions: "Base rules.", tools: [tool] }));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(body.system.map((b: any) => b.text), ["Base rules.", "Initial rules."]);
  assert.deepEqual(body.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(body.messages[1].content.map((b: any) => b.type), ["thinking", "tool_use", "tool_use"]);
  assert.deepEqual(body.messages[1].content[0], thinking);
  assert.equal(body.messages[1].content[1].id, body.messages[2].content[0].tool_use_id);
  assert.equal(body.messages[2].content[2].text, "<system-reminder>\nNew constraint.\n</system-reminder>");
});

test("Messages preserves reminders between an assistant reply and the next user message", () => {
  const { body } = buildAnthropicRequest(context({ input: [
    message("user", "First."), message("assistant", "Done."),
    message("developer", "New constraint."), message("user", "Next."),
  ] }));
  assert.deepEqual(body.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(body.messages[2].content.map((b: any) => b.text), ["<system-reminder>\nNew constraint.\n</system-reminder>", "Next."]);
});

test("Messages represents empty tool results without content or placeholder text", () => {
  for (const output of ["", [], [{ type: "input_text", text: "" }]]) {
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
      const { body } = buildAnthropicRequest(context({ input: [{ type, call_id: "empty_result", output }] }));
      const result = body.messages[0].content[0];
      assert.equal(result.type, "tool_result");
      assert.equal(result.tool_use_id, "empty_result");
      assert.equal(Object.hasOwn(result, "content"), false);
      assert.deepEqual(body.messages[0].content.map((block: any) => block.type), ["tool_result"]);
    }
  }
});

test("Messages round trips Lite namespaced tools and consumes declarations without reminders", async () => {
  const custom = { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: 'start: "hello"' } };
  const ctx = context({ tool_choice: { type: "custom", name: "exec" }, input: [
    { type: "additional_tools", role: "developer", tools: [
      { type: "namespace", name: "functions", tools: [custom] },
      { type: "namespace", name: "agents", tools: [tool] },
    ] },
    message("developer", "Initial rules."), message("user", "Start."),
    { type: "custom_tool_call", call_id: "earlier", name: "exec", input: "hello" },
    { type: "custom_tool_call_output", call_id: "earlier", output: "Done." },
    { type: "additional_tools", role: "developer", tools: [
      { type: "namespace", name: "agents", tools: [{ ...tool, description: "Updated lookup." }] },
    ] },
    message("developer", "New rule."),
  ] });
  const before = structuredClone(ctx.request);
  const stream = events(start,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "next", name: "functions__exec", input: { input: "hello" } } },
    { type: "content_block_stop", index: 0 }, ...finish("tool_use"));
  await withUpstream(stream, async (base, requests) => {
    const capture = writerCapture();
    const result = await runAnthropic({ ...ctx, route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer);
    capture.writer.complete(result.usage);
    const body = requests[0].body;
    assert.deepEqual(body.tools.map((tool: any) => tool.name), ["functions__exec", "agents__lookup"]);
    assert.match(body.tools[0].description, /start: "hello"/);
    assert.equal(body.tools[1].description, "Updated lookup.");
    assert.deepEqual(body.tool_choice, { type: "tool", name: "functions__exec" });
    assert.deepEqual(body.system.map((block: any) => block.text), ["Initial rules."]);
    assert.deepEqual(body.messages.map((item: any) => item.role), ["user", "assistant", "user"]);
    assert.equal(body.messages[1].content[0].name, "functions__exec");
    assert.deepEqual(body.messages[2].content.map((block: any) => block.type), ["tool_result", "text"]);
    assert.equal(body.messages[2].content[1].text, "<system-reminder>\nNew rule.\n</system-reminder>");
    const call = capture.output().at(-1).response.output[0];
    assert.equal(call.type, "custom_tool_call");
    assert.equal(call.namespace, "functions");
    assert.equal(call.name, "exec");
    assert.equal(call.input, "hello");
    assert.deepEqual(ctx.request, before);
  });
});

test("Messages converts custom grammar tools and images in tool results", () => {
  const custom = { type: "custom", name: "edit", description: "Edit a file.", format: { type: "grammar", syntax: "regex", definition: "EDIT .+" } };
  const { body } = buildAnthropicRequest(context({ tools: [custom], input: [
    message("user", "Edit it."),
    { type: "custom_tool_call", call_id: "edit1", name: "edit", input: "EDIT file" },
    { type: "custom_tool_call_output", call_id: "edit1", output: [
      { type: "input_text", text: "Screenshot" }, { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" },
      { type: "input_image", image_url: "https://example.com/image.png" },
    ] },
  ] }));
  assert.match(body.tools[0].description, /EDIT \.+/);
  assert.deepEqual(body.messages[1].content[0].input, { input: "EDIT file" });
  const result = body.messages[2].content[0];
  assert.deepEqual(result.content.map((part: any) => part.type), ["text", "image", "image"]);
  assert.equal(result.content[1].source.media_type, "image/png");
  assert.equal(result.content[2].source.type, "url");
});

test("Messages keeps four ordered cache breakpoints and only shortens the compaction suffix", () => {
  const base = context({ tools: [tool], instructions: "System.", input: [
    message("user", "First."), message("assistant", "Reply."), message("user", "Summarize."),
  ] });
  const normal = buildAnthropicRequest(base).body;
  const compact = buildAnthropicRequest({ ...base, compacting: true }).body;
  for (const body of [normal, compact]) {
    assert.equal(body.tools[0].cache_control.ttl, "1h");
    assert.equal(body.system[0].cache_control.ttl, "1h");
    assert.equal(body.messages[0].content[0].cache_control.ttl, "1h");
  }
  assert.equal(normal.messages[2].content[0].cache_control.ttl, "1h");
  assert.equal(compact.messages[2].content[0].cache_control.ttl, "5m");
});

test("Messages uses adaptive thinking and permits explicit endpoint options", () => {
  const ctx = context({ reasoning: { effort: "low", summary: "none" }, tools: [tool], tool_choice: "none" });
  let body = buildAnthropicRequest(ctx).body;
  assert.deepEqual(body.thinking, { type: "adaptive", display: "omitted" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.tool_choice, { type: "none" });
  body = buildAnthropicRequest({ ...ctx, route: { ...route, config: { ...route.config, options: { thinking: { type: "enabled", budget_tokens: 2048 } } } } }).body;
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
});

test("Messages rejects unavailable selected tools and lets configured tool choice override the request", () => {
  for (const tool_choice of [
    { type: "function", name: "missing" }, { type: "custom", name: "lookup" },
    { type: "function", name: "look.up" },
  ]) {
    assert.throws(() => buildAnthropicRequest(context({ tools: [tool, { ...tool, name: "look_up" }], tool_choice })), /selected tool is not available/);
  }
  const ctx = context({ tools: [tool], tool_choice: "auto" });
  const body = buildAnthropicRequest({ ...ctx, route: { ...route, upstream: { ...route.upstream, options: { tool_choice: { type: "any" } } } } }).body;
  assert.deepEqual(body.tool_choice, { type: "any" });
});

test("Messages preserves the client parallel tool policy including Lite declarations", () => {
  const ctx = context({ parallel_tool_calls: false, input: [
    { type: "additional_tools", tools: [tool] }, message("user", "Look up a."),
  ] });
  assert.deepEqual(buildAnthropicRequest(ctx).body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  for (const [parallel_tool_calls, tool_choice, expected] of [
    [undefined, undefined, undefined],
    [true, "auto", { type: "auto", disable_parallel_tool_use: false }],
    [false, "none", { type: "none" }],
    [false, "required", { type: "any", disable_parallel_tool_use: true }],
    [false, { type: "function", name: "lookup" }, { type: "tool", name: "lookup", disable_parallel_tool_use: true }],
  ] as const) {
    assert.deepEqual(buildAnthropicRequest(context({ tools: [tool], parallel_tool_calls, tool_choice })).body.tool_choice, expected);
  }
  assert.equal(buildAnthropicRequest(context({ parallel_tool_calls: false })).body.tool_choice, undefined);
  const body = buildAnthropicRequest({ ...ctx, route: { ...route, config: { ...route.config,
    options: { tool_choice: { type: "auto", disable_parallel_tool_use: false } },
  } } }).body;
  assert.deepEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: false });
});

test("Messages applies endpoint options after generated output limits", () => {
  const ctx = context();
  const configured = { ...route, config: { ...route.config, max_output_tokens: 2000, options: { max_tokens: 1000 } }, upstream: { ...route.upstream, options: { max_tokens: 500 } } };
  assert.equal(buildAnthropicRequest({ ...ctx, route: configured }).body.max_tokens, 1000);
  assert.equal(buildAnthropicRequest({ ...ctx, request: { ...ctx.request, max_output_tokens: 3000 }, route: configured }).body.max_tokens, 1000);
  assert.equal(buildAnthropicRequest({ ...ctx, route: { ...configured, config: { ...configured.config, max_output_tokens: undefined } } }).body.max_tokens, 1000);
  assert.equal(buildAnthropicRequest(ctx).body.max_tokens, 128000);
});

test("Messages compaction forces no tools and removes only the structured format", () => {
  const output_config = { effort: "high", format: { type: "json_schema", schema: { type: "object" } } };
  const ctx = { ...context({ tools: [tool], parallel_tool_calls: false, tool_choice: { type: "function", name: "lookup" }, text: { format: { type: "json_schema", schema: { type: "string" } } } }), compacting: true,
    route: { ...route, config: { ...route.config, options: { output_config, tool_choice: { type: "any" } } } } };
  const body = buildAnthropicRequest(ctx).body;
  assert.deepEqual(body.tool_choice, { type: "none" });
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.ok(output_config.format);
  assert.equal(body.tools.length, 1);
});

test("Messages maps the requested JSON schema and preserves other output options", async () => {
  const schema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
  const ctx = context({ text: { format: { type: "json_schema", name: "answer", strict: true, schema } }, reasoning: { effort: "low" } });
  const { body } = buildAnthropicRequest(ctx);
  assert.deepEqual(body.output_config, { effort: "low", format: { type: "json_schema", schema } });
  await withUpstream(events(start, ...textEvents('{"answer":42}'), ...finish()), async (base, requests) => {
    const capture = writerCapture();
    const result = await runAnthropic({ ...ctx, route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer);
    capture.writer.complete(result.usage);
    assert.deepEqual(requests[0].body.output_config.format, { type: "json_schema", schema });
    const output = capture.output().at(-1).response.output;
    assert.deepEqual(JSON.parse(output.at(-1).content[0].text), { answer: 42 });
  });
});

test("Messages rejects untranslatable output formats and preserves configured output parameters", () => {
  for (const format of [{ type: "json_object" }, { type: "unknown" }]) {
    assert.throws(() => buildAnthropicRequest(context({ text: { format } })), { code: "invalid_prompt" });
  }
  const output_config = { effort: "high", format: { type: "json_schema", schema: { type: "object" } } };
  const ctx = { ...context({ text: { format: { type: "text" } } }), route: { ...route, config: { ...route.config, options: { output_config } } } };
  assert.deepEqual(buildAnthropicRequest(ctx).body.output_config, output_config);
  assert.ok(output_config.format);
  assert.deepEqual(buildAnthropicRequest(context({ text: { format: { type: "text" } } })).body.output_config, { effort: "medium" });
});

test("Messages streams text, restores reasoning, and totals cached usage", async () => {
  const stream = events(start,
    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: thinking.thinking } },
    { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: thinking.signature } },
    { type: "content_block_stop", index: 1 }, ...textEvents("Done."), ...finish());
  await withUpstream(stream, async (base, requests) => {
    const capture = writerCapture();
    const result = await runAnthropic({ ...context(), route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer);
    assert.deepEqual(result, { endTurn: true, usage: { input_tokens: 130, cached_tokens: 100, cache_write_tokens: 20, output_tokens: 30, reasoning_tokens: 20 } });
    assert.equal(capture.writer.isFinished, false);
    capture.writer.complete(result.usage);
    const out = capture.output();
    const stored = out.find((e) => e.type === "response.output_item.done" && e.item.type === "reasoning").item;
    assert.deepEqual(decodeReasoning(stored.encrypted_content)!.data, thinking);
    assert.equal(out.at(-1).response.output.at(-1).phase, "final_answer");
    assert.equal(requests[0].path, "/v1/messages");
  });
});

test("Messages maps namespaced and custom calls after the complete stream", async () => {
  const stream = events(start, ...textEvents("Running tools."),
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "files__lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"sample"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_b", name: "changes__edit", input: { input: "raw patch" } } },
    { type: "content_block_stop", index: 2 }, ...finish("tool_use"));
  await withUpstream(stream, async (base) => {
    const capture = writerCapture();
    const ctx = context({ tools: [{ type: "namespace", name: "files", tools: [tool] }, { type: "namespace", name: "changes", tools: [{ type: "custom", name: "edit" }] }] });
    const result = await runAnthropic({ ...ctx, route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer);
    assert.equal(result.endTurn, false);
    assert.equal(capture.output().some((e) => e.item?.type === "function_call"), false);
    capture.writer.complete(result.usage);
    const output = capture.output().at(-1).response.output;
    assert.equal(output[0].phase, "commentary");
    assert.equal(output[1].namespace, "files");
    assert.equal(output[1].name, "lookup");
    assert.equal(output[1].arguments, '{"q":"sample"}');
    assert.equal(output[2].input, "raw patch");
    assert.equal(output[2].namespace, "changes");
  });
});

test("Messages rejects incomplete streams and does not emit tool calls", async () => {
  const stream = events(start,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "lookup", input: {} } },
    { type: "content_block_stop", index: 0 });
  await withUpstream(stream, async (base) => {
    const capture = writerCapture();
    const ctx = { ...context({ tools: [tool] }), route: { ...route, upstream: { ...route.upstream, base_url: base } } };
    await assert.rejects(runAnthropic(ctx, capture.writer), { code: "upstream_error" });
    assert.equal(capture.writer.toolCallCount, 0);
  });
});

test("Messages maps stream overload and refuses truncated completion", async () => {
  for (const [stream, code] of [
    [events(start, { type: "error", error: { type: "overloaded_error", message: "Busy." } }), "server_is_overloaded"],
    [events(start, ...textEvents("Partial"), ...finish("max_tokens")), "invalid_prompt"],
    [events(start, ...textEvents("No."), ...finish("refusal")), "invalid_prompt"],
  ]) {
    await withUpstream(stream!, async (base) => {
      const capture = writerCapture();
      await assert.rejects(runAnthropic({ ...context(), route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer), { code });
    });
  }
});

test("Messages maps context window exhaustion without delivering buffered tools", async () => {
  const stream = events(start, ...textEvents("Partial response."),
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call", name: "lookup", input: { q: "sample" } } },
    { type: "content_block_stop", index: 1 }, ...finish("model_context_window_exceeded"));
  await withUpstream(stream, async (base) => {
    let accepted = false;
    const capture = writerCapture();
    await assert.rejects(runAnthropic({
      ...context({ tools: [tool] }),
      route: { ...route, upstream: { ...route.upstream, base_url: base } },
      onAccepted: () => { accepted = true; },
    }, capture.writer), { code: "context_length_exceeded" });
    assert.equal(accepted, true);
    assert.equal(capture.writer.toolCallCount, 0);
    assert.equal(capture.output().some((event) => event.item?.type === "function_call"), false);
  });
});

test("Messages rejects missing, nonnumeric, or negative usage without emitting tools", async () => {
  const done = { type: "message_stop" };
  const delta = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
  const streams = [
    events({ type: "message_start", message: {} }, ...textEvents("Done."), delta, done),
    events(...textEvents("Done."), delta, done),
    events(start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "lookup", input: { q: "sample" } } },
      { type: "content_block_stop", index: 0 }, { ...delta, usage: undefined }, done),
    ...[-1, "5", null, Infinity].map((output_tokens) => events(start, ...textEvents("Done."), { ...delta, usage: { output_tokens } }, done)),
    events({ ...start, message: { usage: { ...start.message.usage, cache_read_input_tokens: -1 } } }, delta, done),
    events(start, { ...delta, usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: -1 } } }, done),
  ];
  for (const stream of streams) {
    await withUpstream(stream, async (base) => {
      const capture = writerCapture();
      await assert.rejects(runAnthropic({ ...context({ tools: [tool] }), route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer), { code: "upstream_error" });
      assert.equal(capture.writer.toolCallCount, 0);
    });
  }
});

test("Messages accepts zero newly processed input when the entire prefix is cached", async () => {
  const zeroStart = { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 40 } } };
  await withUpstream(events(zeroStart, ...textEvents("Done."), ...finish()), async (base) => {
    const capture = writerCapture();
    const result = await runAnthropic({ ...context(), route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer);
    assert.equal(result.usage.input_tokens, 40);
    assert.equal(result.usage.output_tokens, 30);
    assert.equal(result.usage.cache_write_tokens, 0);
  });
});

test("Messages preserves redacted thinking and requests continuation on pause_turn", async () => {
  const redacted = { type: "redacted_thinking", data: "synthetic_encrypted_data" };
  await withUpstream(events(start,
    { type: "content_block_start", index: 0, content_block: redacted },
    { type: "content_block_stop", index: 0 }, ...finish("pause_turn")), async (base) => {
    const capture = writerCapture();
    const result = await runAnthropic({ ...context(), route: { ...route, upstream: { ...route.upstream, base_url: base } } }, capture.writer);
    assert.equal(result.endTurn, false);
    const stored = capture.output().find((e) => e.type === "response.output_item.done").item;
    assert.deepEqual(decodeReasoning(stored.encrypted_content)!.data, redacted);
  });
});

test("Messages restores allowed foreign thinking without a second backend identity check", () => {
  const shared = resolveModel(config, "shared");
  const { body } = buildAnthropicRequest({ ...context({ input: [reasoning, message("assistant", "Done.")] }), route: shared });
  assert.deepEqual(body.messages[0].content[0], thinking);
});

test("Messages sends disabled thinking, custom effort maps, and unknown efforts to the endpoint", () => {
  const disabled = buildAnthropicRequest(context({ reasoning: { effort: "none" } })).body;
  assert.deepEqual(disabled.thinking, { type: "disabled" });
  assert.equal(disabled.output_config, undefined);
  const customConfig = validateConfig({ ...config, models: { ...config.models, "messages-model": {
    ...config.models["messages-model"], reasoning: { default_effort: "brief", effort_map: { brief: "low" } },
  } } });
  const custom = resolveModel(customConfig, "messages-model");
  assert.equal(buildAnthropicRequest({ ...context(), route: custom }).body.output_config.effort, "low");
  assert.equal(buildAnthropicRequest({ ...context({ reasoning: { effort: "future" } }), route: custom }).body.output_config.effort, "future");
  const overridden = buildAnthropicRequest({ ...context(), route: { ...custom, config: { ...custom.config, options: {
    max_tokens: 500, model: "wrong", messages: [], system: "wrong", tools: ["wrong"], stream: false,
  } } } }).body;
  assert.equal(overridden.max_tokens, 500);
  assert.equal(overridden.model, "claude-sonnet-5-5");
  assert.equal(overridden.messages[0].content[0].text, "Hello");
  assert.equal(overridden.system, undefined);
  assert.equal(overridden.tools, undefined);
  assert.equal(overridden.stream, true);
});

test("Messages stream errors preserve the original upstream event", async () => {
  const failure = { type: "error", error: { type: "overloaded_error", message: "Capacity unavailable.", headers: { "Retry-After": "12" } }, request_id: "synthetic_request" };
  await withUpstream(events(start, failure), async (base) => {
    const { writer } = writerCapture();
    await assert.rejects(runAnthropic({ ...context(), route: { ...route, upstream: { ...route.upstream, base_url: base } } }, writer), (error: any) => {
      assert.equal(error.message, "Capacity unavailable.");
      assert.equal(error.code, "server_is_overloaded");
      assert.deepEqual(error.headers, { "retry-after": "12" });
      assert.deepEqual(error.upstream.body, failure);
      return true;
    });
  });
});

test("Messages summary display follows the request without disabling thinking or replay", () => {
  for (const summary of [undefined, "none", "auto", "concise", "detailed"]) {
    const { body } = buildAnthropicRequest(context({
      reasoning: { effort: "medium", ...(summary ? { summary } : {}) },
      input: [message("user", "Earlier task"), reasoning, message("assistant", "Done"), message("user", "Continue")],
    }));
    assert.deepEqual(body.thinking, { type: "adaptive", display: summary && summary !== "none" ? "summarized" : "omitted" });
    assert.deepEqual(body.messages[1].content[0], thinking);
  }
});

test("Messages signed thinking and tools retain their exact interleaved replay order", async () => {
  const blocks = [
    { type: "thinking", thinking: "Before the first call.", signature: "synthetic_a" },
    { type: "tool_use", id: "call_a", name: "lookup", input: { q: "first" } },
    { type: "thinking", thinking: "Before the second call.", signature: "synthetic_b" },
    { type: "tool_use", id: "call_b", name: "lookup", input: { q: "second" } },
  ];
  const stream = events(start, ...blocks.flatMap((content_block, index) => [
    { type: "content_block_start", index, content_block }, { type: "content_block_stop", index },
  ]), ...finish("tool_use"));
  await withUpstream(stream, async (base) => {
    const capture = writerCapture();
    const ctx = { ...context({ tools: [tool] }), route: { ...route, upstream: { ...route.upstream, base_url: base } } };
    const result = await runAnthropic(ctx, capture.writer);
    assert.deepEqual(capture.output().filter((event) => event.type === "response.output_item.done").map((event) => event.item.type), ["reasoning"]);
    capture.writer.complete(result.usage, result.endTurn);
    const input = [...capture.writer.outputItems];
    assert.deepEqual(input.map((item) => item.type), ["reasoning", "function_call", "reasoning", "function_call"]);
    const replay = buildAnthropicRequest({ ...ctx, request: { model: ctx.request.model, tools: [tool], input } });
    assert.deepEqual(replay.body.messages[0].content, blocks);
  });
});
