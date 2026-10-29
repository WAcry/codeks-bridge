import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { buildDeepSeekRequest, runDeepSeek } from "../src/backends/deepseek.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { decodeReasoning, encodeReasoning } from "../src/carrier.ts";
import { ResponseWriter } from "../src/writer.ts";
import type { BackendContext, ResolvedModel } from "../src/types.ts";

const toolDefinitions = [
  { type: "namespace", name: "agents", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: { prompt: { type: "string", encrypted: true } } } }] },
  { type: "custom", name: "apply_patch", description: "Edit files.", format: { type: "grammar", syntax: "lark", definition: 'start: "hello"' } },
];

function modelConfig() {
  return validateConfig({
    upstreams: { test: { base_url: "http://127.0.0.1:1" }, other: { base_url: "http://127.0.0.1:2" } },
    models: {
      flash: { upstream: "test", model: "deployment-a", catalog: "deepseek-flash", max_output_tokens: 2048 },
      other: { upstream: "other", model: "deployment-b", catalog: "deepseek-flash" },
      shared: { upstream: "test", model: "deployment-c", catalog: "deepseek-flash", replay: { reasoning_from: ["other"] } },
    },
  });
}

function context(input: any = "Hello"): BackendContext {
  return {
    request: { model: "flash", input, tools: toolDefinitions, reasoning: { effort: "high" } },
    route: resolveModel(modelConfig(), "flash"),
    signal: new AbortController().signal,
  };
}

function reasoning(route: ResolvedModel, text: string) {
  return { type: "reasoning", encrypted_content: encodeReasoning({ source: route.origin, format: route.profile.reasoning_format, data: text }) };
}

const delta = (value: any, finish: string | null = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const usage = { prompt_tokens: 41, completion_tokens: 9, prompt_cache_hit_tokens: 16, completion_tokens_details: { reasoning_tokens: 6 } };

async function exchange(ctx: BackendContext, chunks: any[], callback: (events: any[], body: any, result: any) => void) {
  let body: any;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/chat/completions");
    const received: Buffer[] = [];
    for await (const chunk of req) received.push(chunk);
    body = JSON.parse(Buffer.concat(received).toString());
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  ctx.route.upstream.base_url = `http://127.0.0.1:${port}`;
  const events: any[] = [];
  const writer = new ResponseWriter({ write: (line) => events.push(JSON.parse(line.slice(line.indexOf("data: ") + 6).trim())) }, { model: "flash" });
  writer.start();
  try {
    const result = await runDeepSeek(ctx, writer);
    assert.equal(events.some((event) => event.type === "response.completed"), false);
    writer.complete(result.usage);
    callback(events, body, result);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("Chat combines matching reasoning, assistant text and parallel tool calls in one message", () => {
  const ctx = context();
  ctx.request.input = [
    { type: "message", role: "user", content: "Do two tasks." },
    reasoning(ctx.route, "I will delegate."),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Starting." }] },
    { type: "function_call", call_id: "first", namespace: "agents", name: "spawn_agent", arguments: '{"prompt":"Task one"}' },
    { type: "custom_tool_call", call_id: "second", name: "apply_patch", input: "hello" },
    { type: "function_call_output", call_id: "first", output: "Done" },
    { type: "custom_tool_call_output", call_id: "second", output: "Applied" },
  ];
  const { body } = buildDeepSeekRequest(ctx);
  assert.equal(body.messages.length, 4);
  assert.equal(body.messages[1].reasoning_content, "I will delegate.");
  assert.equal(body.messages[1].content, "Starting.");
  assert.deepEqual(body.messages[1].tool_calls.map((c: any) => c.function.name), ["agents__spawn_agent", "apply_patch"]);
  assert.equal(body.messages[1].tool_calls[1].function.arguments, '{"input":"hello"}');
  assert.equal(body.tools[0].function.parameters.properties.prompt.encrypted, undefined);
  assert.match(body.tools[1].function.description, /Lark grammar/);
  assert.equal(body.max_tokens, 2048);
});

test("DeepSeek round trips Lite tools, keeps instruction order, and does not mutate the request", async () => {
  const ctx = context([
    { type: "additional_tools", role: "developer", tools: [
      toolDefinitions[0], { type: "namespace", name: "functions", tools: [toolDefinitions[1]] },
    ] },
    { type: "message", role: "user", content: "Do the task." },
    { type: "custom_tool_call", call_id: "earlier", name: "apply_patch", input: "hello" },
    { type: "custom_tool_call_output", call_id: "earlier", output: "Applied." },
    { type: "additional_tools", role: "developer", tools: [
      { type: "namespace", name: "agents", tools: [{ ...toolDefinitions[0].tools![0], description: "Updated task." }] },
    ] },
    { type: "message", role: "developer", content: "New rule." },
  ]);
  delete ctx.request.tools;
  ctx.request.tool_choice = { type: "custom", name: "apply_patch" };
  const before = structuredClone(ctx.request);
  await exchange(ctx, [
    delta({ tool_calls: [
      { index: 0, id: "next", type: "function", function: { name: "functions__apply_patch", arguments: '{"input":"hello"}' } },
      { index: 1, id: "agent", type: "function", function: { name: "agents__spawn_agent", arguments: '{"prompt":"Task"}' } },
    ] }, "tool_calls"), { choices: [], usage },
  ], (events, body) => {
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ["agents__spawn_agent", "functions__apply_patch"]);
    assert.equal(body.tools[0].function.description, "Updated task.");
    assert.match(body.tools[1].function.description, /start: "hello"/);
    assert.deepEqual(body.tool_choice, { type: "function", function: { name: "functions__apply_patch" } });
    assert.deepEqual(body.messages.map((item: any) => item.role), ["user", "assistant", "tool", "system"]);
    assert.equal(body.messages[1].tool_calls[0].function.name, "functions__apply_patch");
    assert.equal(body.messages[3].content, "New rule.");
    const output = events.at(-1).response.output;
    assert.equal(output[0].type, "custom_tool_call");
    assert.equal(output[0].namespace, "functions");
    assert.equal(output[0].name, "apply_patch");
    assert.equal(output[0].input, "hello");
    assert.equal(output[1].namespace, "agents");
    assert.equal(output[1].name, "spawn_agent");
    assert.deepEqual(ctx.request, before);
  });
});

test("DeepSeek filters foreign reasoning by default and restores explicitly allowed state", () => {
  const ctx = context();
  const foreign = reasoning(resolveModel(modelConfig(), "other"), "Foreign reasoning");
  ctx.request.input = [foreign, { type: "function_call", call_id: "foreign_call", namespace: "agents", name: "spawn_agent", arguments: "{}" }, { type: "function_call_output", call_id: "foreign_call", output: "Done" }];
  const snapshot = structuredClone(ctx.request.input);
  const { body } = buildDeepSeekRequest(ctx);
  assert.equal(body.messages[0].reasoning_content, "");
  assert.equal(JSON.stringify(body).includes("Foreign reasoning"), false);
  assert.deepEqual(ctx.request.input, snapshot);
  ctx.route = resolveModel(modelConfig(), "shared");
  assert.equal(buildDeepSeekRequest(ctx).body.messages[0].reasoning_content, "Foreign reasoning");
});

test("Chat preserves system updates and places tool images after all parallel results", () => {
  const ctx = context([
    { type: "message", role: "developer", content: "First instruction." },
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/image.png", detail: "original" }] },
    { type: "function_call", call_id: "a", name: "snapshot", arguments: "{}" },
    { type: "function_call", call_id: "b", name: "snapshot", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: [{ type: "input_text", text: "Screenshot" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "function_call_output", call_id: "b", output: "Finished" },
    { type: "message", role: "developer", content: "Updated instruction." },
  ]);
  const { body } = buildDeepSeekRequest(ctx);
  assert.deepEqual(body.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool", "tool", "user", "system"]);
  assert.equal(body.messages[1].content[0].image_url.detail, "high");
  assert.equal(body.messages[3].content, "Screenshot");
  assert.equal(body.messages[5].content[1].type, "image_url");
  assert.equal(body.messages[6].content, "Updated instruction.");
});

test("DeepSeek maps efforts for any deployment name, forced tools and JSON output", () => {
  const ctx = context();
  for (const [incoming, outgoing] of [["low", "low"], ["high", "high"], ["max", "max"], ["ultra", "max"]]) {
    ctx.request.reasoning = { effort: incoming };
    assert.equal(buildDeepSeekRequest(ctx).body.reasoning_effort, outgoing);
  }
  ctx.request.tool_choice = { type: "function", namespace: "agents", name: "spawn_agent" };
  assert.deepEqual(buildDeepSeekRequest(ctx).body.tool_choice, { type: "function", function: { name: "agents__spawn_agent" } });
  ctx.request.text = { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } };
  assert.deepEqual(buildDeepSeekRequest(ctx).body.response_format, { type: "json_object" });
  const { body } = buildDeepSeekRequest(ctx);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "agents__spawn_agent" } });
  ctx.compacting = true;
  assert.deepEqual(buildDeepSeekRequest(ctx).body.tool_choice, { type: "function", function: { name: "agents__spawn_agent" } });
  assert.equal(buildDeepSeekRequest(ctx).body.response_format, undefined);
});

test("DeepSeek uses configured effort mappings and lets options override derived parameters", () => {
  const config = modelConfig();
  config.models.flash.reasoning = { default_effort: "brief", effort_map: { brief: "low", thorough: "max" } };
  const ctx = context();
  ctx.route = resolveModel(validateConfig(config), "flash");
  delete ctx.request.reasoning;
  assert.equal(buildDeepSeekRequest(ctx).body.reasoning_effort, "low");
  ctx.request.reasoning = { effort: "thorough" };
  assert.equal(buildDeepSeekRequest(ctx).body.reasoning_effort, "max");
  ctx.request.reasoning = { effort: "future-level" };
  assert.equal(buildDeepSeekRequest(ctx).body.reasoning_effort, "future-level");
  ctx.route.upstream.options = { temperature: 0.1, max_tokens: 100, reasoning_effort: "low" };
  ctx.route.config.options = { reasoning_effort: "custom", temperature: 0.2, max_tokens: 500,
    messages: [], tools: [], model: "wrong", stream: false, stream_options: { include_usage: false, extra: true } };
  ctx.request.temperature = 0.9;
  ctx.request.max_output_tokens = 2000;
  ctx.request.input = [reasoning(ctx.route, "A thought"), { type: "message", role: "assistant", content: "Hi" }];
  const { body } = buildDeepSeekRequest(ctx);
  assert.equal(body.messages[0].reasoning_content, "A thought");
  assert.equal(body.reasoning_effort, "custom");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 500);
  assert.equal(body.model, "deployment-a");
  assert.equal(body.stream, true);
  assert.equal(body.tools.length, 2);
  assert.deepEqual(body.stream_options, { include_usage: true, extra: true });
});

test("Chat rejects unsupported content and explicit hosted tool selection", () => {
  const ctx = context([{ type: "message", role: "user", content: [{ type: "input_audio", data: "AAAA" }] }]);
  assert.throws(() => buildDeepSeekRequest(ctx), /does not support content part input_audio/);
  ctx.request.input = "Hello";
  ctx.request.tool_choice = { type: "web_search" };
  assert.throws(() => buildDeepSeekRequest(ctx), /does not support this tool_choice/);
});

test("Chat SSE round trip retains reasoning and waits to emit both complete tool calls", async () => {
  const ctx = context();
  await exchange(ctx, [
    delta({ reasoning_content: "First " }), delta({ reasoning_content: "think." }),
    delta({ content: "Working." }),
    delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "agents__spawn_agent", arguments: '{"prompt":' } }, { index: 1, id: "call_b", type: "function", function: { name: "apply_patch", arguments: '{"input":' } }] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: '"hello"}' } }, { index: 0, function: { arguments: '"Do it"}' } }] }, "tool_calls"),
    { choices: [], usage },
  ], (events, body, result) => {
    assert.equal(body.stream_options.include_usage, true);
    assert.deepEqual(result.usage, { input_tokens: 41, output_tokens: 9, cached_tokens: 16, reasoning_tokens: 6 });
    assert.equal(result.endTurn, false);
    const items = events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    assert.deepEqual(items.map((i) => i.type), ["reasoning", "message", "function_call", "custom_tool_call"]);
    const carrier = decodeReasoning(items[0].encrypted_content)!;
    assert.deepEqual(carrier.source, ctx.route.origin);
    assert.equal(carrier.format, "reasoning.text.v1");
    assert.equal(carrier.data, "First think.");
    assert.equal(items[1].phase, "commentary");
    assert.equal(items[2].namespace, "agents");
    assert.equal(items[2].name, "spawn_agent");
    assert.equal(items[3].input, "hello");
  });
});

test("Chat final text becomes final_answer and can carry an empty reasoning carrier", async () => {
  await exchange(context(), [delta({ reasoning_content: "" }), delta({ content: "Hello" }, "stop"), { choices: [], usage }], (events, _body, result) => {
    assert.equal(result.endTurn, true);
    const items = events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    assert.equal(items[1].phase, "final_answer");
    assert.equal(decodeReasoning(items[0].encrypted_content)!.data, "");
  });
});

test("Chat rejects truncated streams, missing usage and length-limited calls", async () => {
  await assert.rejects(exchange(context(), [delta({ content: "Partial" })], () => {}), /before a finish_reason/);
  await assert.rejects(exchange(context(), [delta({ content: "Partial" }, "stop")], () => {}), /without token usage/);
  await assert.rejects(exchange(context(), [delta({ tool_calls: [{ index: 0, id: "call_partial", function: { name: "apply_patch", arguments: "{" } }] }, "length"), { choices: [], usage }], () => {}), /token limit/);
});

test("Chat rejects malformed custom tool arguments before exposing calls", async () => {
  await assert.rejects(exchange(context(), [delta({ tool_calls: [{ index: 0, id: "call_bad", function: { name: "apply_patch", arguments: '{"input":7}' } }] }, "tool_calls"), { choices: [], usage }], () => {}), /no string input/);
});

test("Chat capacity interruption remains retryable", async () => {
  await assert.rejects(exchange(context(), [delta({}, "insufficient_system_resource"), { choices: [], usage }], () => {}), (error: any) => error.code === "server_is_overloaded");
});

test("Chat forced tool selection preserves the original identity and kind", () => {
  const ctx = context();
  ctx.request.tools = [{ type: "function", name: "look_up", parameters: { type: "object" } }];
  for (const selected of [
    { type: "function", name: "look.up" },
    { type: "custom", name: "look_up" },
    { type: "function", namespace: "missing", name: "look_up" },
  ]) {
    ctx.request.tool_choice = selected;
    assert.throws(() => buildDeepSeekRequest(ctx), /not available/);
  }
  ctx.request.tool_choice = { type: "function", name: "look_up" };
  assert.deepEqual(buildDeepSeekRequest(ctx).body.tool_choice, { type: "function", function: { name: "look_up" } });
});

test("DeepSeek stream errors preserve the original upstream event", async () => {
  const failure = { error: { code: "overloaded_error", message: "Capacity unavailable.", headers: { "Retry-After": "12" } }, request_id: "synthetic_request" };
  await assert.rejects(exchange(context(), [failure], () => {}), (error: any) => {
    assert.equal(error.message, "Capacity unavailable.");
    assert.equal(error.code, "server_is_overloaded");
    assert.equal(error.headers["retry-after"], "12");
    assert.deepEqual(error.upstream.body, failure);
    return true;
  });
});
