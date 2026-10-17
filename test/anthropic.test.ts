import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { buildAnthropicRequest, runAnthropic } from "../src/backends/anthropic.ts";
import { decodeJsonPayload, decodeReasoning, encodeJsonPayload, encodeReasoning } from "../src/carrier.ts";
import { formatSse } from "../src/sse.ts";
import type { BackendContext, ResolvedModel, ResponsesRequest } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const route: ResolvedModel = {
  slug: "messages-model", key: "endpoint/model", config: { upstream: "messages", model: "claude-sonnet-5-5" },
  upstream: { api: "anthropic", base_url: "https://api.example.com/v1" },
};
function context(request: Partial<ResponsesRequest> = {}): BackendContext {
  return { route, request: { model: route.slug, input: "Hello", ...request }, signal: new AbortController().signal };
}
const tool = { type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } };
const thinking = { type: "thinking", thinking: "Synthetic reasoning.", signature: "synthetic_signature" };
const reasoning = { type: "reasoning", encrypted_content: encodeReasoning(route.key, encodeJsonPayload(thinking)) };
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
  const foreign = { type: "reasoning", encrypted_content: encodeReasoning("another-model", encodeJsonPayload(thinking)) };
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
  const ctx = context({ reasoning: { effort: "minimal", summary: "none" }, tools: [tool], tool_choice: "none" });
  let body = buildAnthropicRequest(ctx).body;
  assert.deepEqual(body.thinking, { type: "adaptive", display: "omitted" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.tool_choice, { type: "none" });
  body = buildAnthropicRequest({ ...ctx, route: { ...route, config: { ...route.config, options: { thinking: { type: "enabled", budget_tokens: 2048 } } } } }).body;
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
});

test("Messages rejects unavailable selected tools and respects explicit auto choice", () => {
  for (const tool_choice of [
    { type: "function", name: "missing" }, { type: "custom", name: "lookup" },
    { type: "function", name: "look.up" },
  ]) {
    assert.throws(() => buildAnthropicRequest(context({ tools: [tool, { ...tool, name: "look_up" }], tool_choice })), /selected tool is not available/);
  }
  const ctx = context({ tools: [tool], tool_choice: "auto" });
  const body = buildAnthropicRequest({ ...ctx, route: { ...route, upstream: { ...route.upstream, options: { tool_choice: { type: "any" } } } } }).body;
  assert.deepEqual(body.tool_choice, { type: "auto" });
});

test("Messages gives explicit output limits priority over configured defaults", () => {
  const ctx = context();
  const configured = { ...route, config: { ...route.config, max_output_tokens: 2000, options: { max_tokens: 1000 } }, upstream: { ...route.upstream, options: { max_tokens: 500 } } };
  assert.equal(buildAnthropicRequest({ ...ctx, route: configured }).body.max_tokens, 2000);
  assert.equal(buildAnthropicRequest({ ...ctx, request: { ...ctx.request, max_output_tokens: 3000 }, route: configured }).body.max_tokens, 3000);
  assert.equal(buildAnthropicRequest({ ...ctx, route: { ...configured, config: { ...configured.config, max_output_tokens: undefined } } }).body.max_tokens, 1000);
  assert.equal(buildAnthropicRequest(ctx).body.max_tokens, 16384);
});

test("Messages compaction forces no tools and removes only the structured format", () => {
  const output_config = { effort: "high", format: { type: "json_schema", schema: { type: "object" } } };
  const ctx = { ...context({ tools: [tool], tool_choice: { type: "function", name: "lookup" }, text: { format: { type: "json_schema", schema: { type: "string" } } } }), compacting: true,
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

test("Messages rejects unsupported output formats and text clears a configured format", () => {
  for (const format of [{ type: "json_object" }, { type: "unknown" }, { type: "json_schema" }]) {
    assert.throws(() => buildAnthropicRequest(context({ text: { format } })), { code: "invalid_prompt" });
  }
  const output_config = { effort: "high", format: { type: "json_schema", schema: { type: "object" } } };
  const ctx = { ...context({ text: { format: { type: "text" } } }), route: { ...route, config: { ...route.config, options: { output_config } } } };
  assert.deepEqual(buildAnthropicRequest(ctx).body.output_config, { effort: "high" });
  assert.ok(output_config.format);
  assert.equal(buildAnthropicRequest(context({ text: { format: { type: "text" } } })).body.output_config, undefined);
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
    assert.deepEqual(decodeJsonPayload(decodeReasoning(stored.encrypted_content)!.payload), thinking);
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
    assert.deepEqual(decodeJsonPayload(decodeReasoning(stored.encrypted_content)!.payload), redacted);
  });
});
