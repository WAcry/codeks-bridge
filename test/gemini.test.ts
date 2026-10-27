import assert from "node:assert/strict";
import test from "node:test";
import { buildGeminiRequest, runGemini } from "../src/backends/gemini.ts";
import { decodeReasoning, encodeReasoning } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { BridgeError } from "../src/errors.ts";
import { formatSse } from "../src/sse.ts";
import type { BackendContext, ResponsesRequest } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const config = validateConfig({
  upstreams: { native: { base_url: "https://example.com/v1beta" } },
  models: {
    flash: { upstream: "native", model: "gemini-3.8-flash", catalog: "gemini-3.8-flash" },
    other: { upstream: "native", model: "gemini-4-argon", catalog: "gemini-4-argon" },
  },
});
const route = resolveModel(config, "flash");
const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const tool = { type: "namespace", name: "files", tools: [{ type: "function", name: "lookup", parameters: {
  $ref: "#/$defs/Args", $defs: { Args: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
} }] };
const usage = { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 10, cachedContentTokenCount: 90, totalTokenCount: 115 };
function context(request: Partial<ResponsesRequest> = {}): BackendContext {
  return { route, request: { model: "flash", input: "Hello", ...request }, signal: new AbortController().signal };
}
const chunk = (parts: any[], end?: string) => ({ candidates: [{ index: 0, content: { role: "model", parts }, ...(end ? { finishReason: end } : {}) }] });
function capture(showSummary = true) {
  const events: any[] = [];
  const writer = new ResponseWriter({ write: value => {
    for (const frame of value.trim().split("\n\n")) if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
  } }, { model: "flash", showSummary });
  writer.start();
  return { writer, events };
}
async function execute(values: unknown[], request: Partial<ResponsesRequest> = {}, showSummary = true) {
  const { writer, events } = capture(showSummary);
  const sent: any[] = [];
  const ctx = context(request);
  ctx.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init!.body as string) });
    return new Response(values.map(value => formatSse(value)).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const result = await runGemini(ctx, writer);
  writer.complete(result.usage, result.endTurn);
  return { result, events, sent, output: events.filter(event => event.type === "response.output_item.done").map(event => event.item) };
}

test("Gemini maps native parameters, preserves JSON schema, latest tools and chronological reminders", () => {
  const newer = structuredClone(tool);
  newer.tools[0].parameters.$defs.Args.required = [];
  const request = context({ instructions: "Base", reasoning: { effort: "medium", summary: "auto" }, input: [
    message("developer", "Initial"), message("user", "Work"), message("assistant", "Working"),
    message("developer", "Later"), { type: "additional_tools", tools: [newer] },
  ], tools: [tool], tool_choice: { type: "function", namespace: "files", name: "lookup" },
  text: { format: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } } } });
  const original = JSON.stringify(request.request);
  const { body } = buildGeminiRequest(request);
  assert.equal(JSON.stringify(request.request), original);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Base" }, { text: "Initial" }] });
  assert.equal(body.contents.at(-1).parts[0].text, "<system-reminder>\nLater\n</system-reminder>");
  assert.equal(body.tools[0].functionDeclarations.length, 1);
  assert.equal(body.tools[0].functionDeclarations[0].parametersJsonSchema.$ref, "#/$defs/Args");
  assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema.$defs.Args.required, []);
  assert.deepEqual(body.toolConfig.functionCallingConfig, { mode: "ANY", allowedFunctionNames: ["files__lookup"] });
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "MEDIUM", includeThoughts: true });
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseJsonSchema, request.request.text.format.schema);
  assert.equal(body.generationConfig.maxOutputTokens, undefined);
});

test("Gemini keeps tools with NONE and honors native generation options without moving the history", () => {
  const ctx = context({ tools: [tool], tool_choice: "none", max_output_tokens: 400, temperature: 0.7 });
  ctx.route = { ...route, upstream: { ...route.upstream, options: { generationConfig: { topK: 20 }, customOption: true } },
    config: { ...route.config, options: { generationConfig: { temperature: 0.5 } } } };
  const { body } = buildGeminiRequest(ctx);
  assert.equal(body.tools[0].functionDeclarations.length, 1);
  assert.equal(body.toolConfig.functionCallingConfig.mode, "NONE");
  assert.deepEqual(body.generationConfig, { thinkingConfig: { thinkingLevel: "MEDIUM", includeThoughts: false }, maxOutputTokens: 400, temperature: 0.5, topK: 20 });
  assert.equal(body.customOption, true);
});

test("Gemini compaction removes response format but preserves tool choice", () => {
  const ctx = context({ tools: [tool], tool_choice: "auto", text: { format: { type: "json_schema", schema: {} } } });
  ctx.compacting = true;
  ctx.route = { ...route, config: { ...route.config, options: { generationConfig: { responseMimeType: "application/json", responseJsonSchema: {}, temperature: 1 } } } };
  const { body } = buildGeminiRequest(ctx);
  assert.equal(body.generationConfig.responseMimeType, undefined);
  assert.equal(body.generationConfig.responseJsonSchema, undefined);
  assert.equal(body.generationConfig.temperature, 1);
  assert.equal(body.toolConfig.functionCallingConfig.mode, "AUTO");
});

test("Gemini preserves signed stream parts, empty-text signatures and exact visible text once", async () => {
  const parts = [{ thought: true, text: "Plan " }, { thought: true, text: "carefully." }, { text: "Hello " }, { text: "world." }, { text: "", thoughtSignature: "synthetic-text-signature" }];
  const result = await execute([...parts.map(part => chunk([part])), chunk([], "STOP"), { usageMetadata: usage }], { reasoning: { summary: "auto" } });
  assert.deepEqual(result.result.usage, { input_tokens: 100, output_tokens: 15, cached_tokens: 90, reasoning_tokens: 10 });
  assert.equal(result.sent[0].url, "https://example.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
  assert.equal(result.events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), "Hello world.");
  assert.equal(result.output.find(item => item.type === "message").phase, "final_answer");
  assert.ok(result.output.filter(item => item.type === "reasoning").every(item => decodeReasoning(item.encrypted_content)));
  const { body } = buildGeminiRequest(context({ input: [message("user", "Hello"), ...result.output, message("user", "Next")] }));
  assert.deepEqual(body.contents[1], { role: "model", parts });
  const other = buildGeminiRequest({ ...context({ input: [message("user", "Hello"), ...result.output, message("user", "Next")] }), route: resolveModel(config, "other") }).body;
  assert.deepEqual(other.contents[1].parts, [{ text: "Hello world." }]);
});

test("Gemini text and thought deltas remain live before upstream completion", async () => {
  let finish!: () => void;
  let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const end = new Promise<void>(resolve => { finish = resolve; });
  const encoder = new TextEncoder();
  const ctx = context({ reasoning: { summary: "auto" } });
  ctx.fetch = async () => new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(encoder.encode(formatSse(chunk([{ thought: true, text: "Working." }]))));
    controller.enqueue(encoder.encode(formatSse(chunk([{ text: "Visible now." }]))));
    reached();
    await end;
    controller.enqueue(encoder.encode(formatSse({ ...chunk([{ text: "", thoughtSignature: "synthetic-signature" }], "STOP"), usageMetadata: usage })));
    controller.close();
  } }));
  const { writer, events } = capture();
  const pending = runGemini(ctx, writer);
  await ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event.type === "response.reasoning_summary_text.delta"));
  assert.ok(events.some(event => event.type === "response.output_text.delta"));
  assert.ok(!events.some(event => event.type === "response.completed"));
  finish();
  const result = await pending;
  writer.complete(result.usage, result.endTurn);
});

test("Gemini parallel same-name calls retain each part, signature, native ID and result order", async () => {
  const parts = [
    { functionCall: { name: "lookup", args: { path: "a" }, id: "native-a" }, thoughtSignature: "synthetic-call-signature" },
    { functionCall: { name: "lookup", args: { path: "b" }, id: "native-b" } },
  ];
  const result = await execute([...parts.map(part => chunk([part])), { ...chunk([{ text: "" }], "STOP"), usageMetadata: usage }], { tools: [tool] });
  const calls = result.output.filter(item => item.type === "function_call");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(item => [item.namespace, item.name]), [["files", "lookup"], ["files", "lookup"]]);
  const input = [message("user", "Read both"), ...result.output,
    { type: "function_call_output", call_id: calls[1].call_id, output: "B" },
    { type: "function_call_output", call_id: calls[0].call_id, output: "A" },
  ];
  const { body } = buildGeminiRequest(context({ input, tools: [tool] }));
  assert.deepEqual(body.contents[1].parts, [...parts, { text: "" }]);
  assert.deepEqual(body.contents[2].parts.map((part: any) => part.functionResponse), [
    { name: "lookup", id: "native-a", response: { output: "A" } },
    { name: "lookup", id: "native-b", response: { output: "B" } },
  ]);
});

test("Gemini missing native call IDs are distinct and stay absent in native replay", async () => {
  const parts = [
    { functionCall: { name: "files__lookup", args: { path: "a" } }, thoughtSignature: "synthetic-signature" },
    { functionCall: { name: "files__lookup", args: { path: "b" } } },
  ];
  const result = await execute([{ ...chunk(parts, "STOP"), usageMetadata: usage }], { tools: [tool] });
  const calls = result.output.filter(item => item.type === "function_call");
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  const { body } = buildGeminiRequest(context({ tools: [tool], input: [message("user", "Read both"), ...result.output,
    ...calls.map((call, index) => ({ type: "function_call_output", call_id: call.call_id, output: `Result ${index}` })),
  ] }));
  assert.deepEqual(body.contents[1].parts, parts);
  assert.ok(body.contents[2].parts.every((part: any) => !Object.hasOwn(part.functionResponse, "id")));
});

test("Gemini foreign tool history uses the documented import signature and images remain native", () => {
  const data = "data:image/png;base64,c3ludGhldGlj";
  const { body } = buildGeminiRequest(context({ tools: [tool], input: [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: data }, { type: "input_image", image_url: "https://example.com/image.png" }] },
    { type: "function_call", namespace: "files", name: "lookup", call_id: "foreign-id", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "foreign-id", output: [{ type: "input_text", text: "Image result" }, { type: "input_image", image_url: data }] },
  ] }));
  assert.deepEqual(body.contents[0].parts, [{ inlineData: { mimeType: "image/png", data: "c3ludGhldGlj" } }, { fileData: { fileUri: "https://example.com/image.png" } }]);
  assert.equal(body.contents[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.deepEqual(body.contents[2].parts[0].functionResponse.parts, [{ inlineData: { mimeType: "image/png", data: "c3ludGhldGlj" } }]);
});

test("Gemini unknown tool names produce normal corrective feedback, including custom aliases", async () => {
  const result = await execute([{ ...chunk([{ functionCall: { name: "typo", args: {}, id: "wrong" }, thoughtSignature: "synthetic" }], "STOP"), usageMetadata: usage }], { tools: [tool] });
  const call = result.output.find(item => item.type === "function_call");
  assert.equal(call.namespace, "codeks_bridge_tool_error");
  const { body } = buildGeminiRequest(context({ tools: [tool], input: [message("user", "Work"), ...result.output,
    { type: "function_call_output", call_id: call.call_id, output: "unsupported call" },
  ] }));
  assert.equal(body.contents[1].parts[0].functionCall.name, "typo");
  assert.match(body.contents[2].parts[0].functionResponse.response.error, /files__lookup/);
  const custom = await execute([{ ...chunk([{ functionCall: { name: "exec", args: { input: "text(1)", extra: "original" }, id: "custom" } }], "STOP"), usageMetadata: usage }], {
    tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] }],
  });
  assert.equal(custom.output.find(item => item.type === "custom_tool_call").input, "text(1)");
  assert.match(custom.sent[0].body.tools[0].functionDeclarations[0].description, /Lark grammar/);
  const replay = buildGeminiRequest(context({ input: [message("user", "Work"), ...custom.output, message("user", "Next")] }));
  assert.deepEqual(replay.body.contents[1].parts[0].functionCall.args, { input: "text(1)", extra: "original" });
});

test("Gemini saves a continuation boundary once and reconstructs it across a later turn", async () => {
  const prefix = [message("user", "Work"), message("assistant", "Partial work.")];
  const result = await execute([
    chunk([{ thought: true, text: "Resume." }]),
    { ...chunk([{ text: "Finished." }, { text: "", thoughtSignature: "synthetic-resumed" }], "STOP"), usageMetadata: usage },
  ], { input: prefix, reasoning: { summary: "none" } }, false);
  assert.equal(result.sent[0].body.contents.at(-1).parts[0].text, "Continue.");
  const states = result.output.filter(item => item.type === "reasoning").map(item => decodeReasoning(item.encrypted_content)!.data as any);
  assert.equal(states.filter(state => state.continuation_before).length, 1);
  const { body } = buildGeminiRequest(context({ input: [...prefix, ...result.output, message("user", "Thanks")] }));
  assert.deepEqual(body.contents.map((item: any) => [item.role, item.parts.map((part: any) => part.text).join("")]), [
    ["user", "Work"], ["model", "Partial work."], ["user", "Continue."], ["model", "Resume.Finished."], ["user", "Thanks"],
  ]);
  assert.ok(result.output.filter(item => item.type === "reasoning").every(item => item.summary.length === 0));
});

test("Gemini message-only continuation binds before its projected message", async () => {
  const prefix = [message("user", "Work"), message("assistant", "Partial.")];
  const result = await execute([{ ...chunk([{ text: "Rest." }, { text: "", thoughtSignature: "synthetic-rest" }], "STOP"), usageMetadata: usage }], { input: prefix });
  const { body } = buildGeminiRequest(context({ input: [...prefix, ...result.output, message("user", "Next")] }));
  assert.deepEqual(body.contents.map((item: any) => item.parts.map((part: any) => part.text).join("")), ["Work", "Partial.", "Continue.", "Rest.", "Next"]);
});

for (const failure of ["MAX_TOKENS", "SAFETY", "MALFORMED_FUNCTION_CALL", "CONTINUATION"]) {
  test(`Gemini ${failure} does not release tools or masquerade as successful completion`, async () => {
    const { writer, events } = capture();
    const ctx = context({ tools: [tool] });
    ctx.fetch = async () => new Response(formatSse({ ...chunk([{ functionCall: { name: "files__lookup", args: {}, id: "held" } }], failure), usageMetadata: usage }));
    await assert.rejects(runGemini(ctx, writer), error => error instanceof BridgeError && error.code === "invalid_prompt" && error.message.includes(failure));
    writer.fail({ message: "Synthetic failure", code: "invalid_prompt" });
    assert.ok(!events.some(event => event.type === "response.output_item.done" && event.item.type === "function_call"));
  });
}

test("Gemini EOF, invalid usage and numeric SSE errors fail with no released tools", async () => {
  for (const final of [undefined, { ...chunk([], "STOP"), usageMetadata: { promptTokenCount: -1 } }, { error: { code: 503, status: "UNAVAILABLE", message: "Synthetic capacity error", details: [{ synthetic: true }] } }]) {
    const { writer, events } = capture();
    const ctx = context({ tools: [tool] });
    ctx.fetch = async () => new Response([chunk([{ functionCall: { name: "files__lookup", args: {}, id: "held" } }]), ...(final ? [final] : [])].map(value => formatSse(value)).join(""));
    await assert.rejects(runGemini(ctx, writer), error => error instanceof BridgeError && (final && "error" in final ? error.code === "server_is_overloaded" : error.code === "upstream_error"));
    writer.fail({ message: "Synthetic failure", code: "upstream_error" });
    assert.ok(!events.some(event => event.type === "response.output_item.done" && event.item.type === "function_call"));
  }
});

test("Gemini mismatched projection fails instead of duplicating signed content", () => {
  const state = { type: "reasoning", encrypted_content: encodeReasoning({ source: route.origin, format: route.profile.reasoning_format,
    data: { parts: [{ text: "Original", thoughtSignature: "synthetic" }], projection: { type: "message" } } }) };
  assert.throws(() => buildGeminiRequest(context({ input: [message("user", "Work"), message("assistant", "Changed"), state] })), /does not match/);
});

test("Gemini thinking committed before EOF can retry and preserve the actual continuation prefix", async () => {
  const { writer, events } = capture();
  const ctx = context({ reasoning: { summary: "auto" } });
  ctx.fetch = async () => new Response([chunk([{ thought: true, text: "First thought." }]), chunk([{ text: "Unfinished text" }])].map(value => formatSse(value)).join(""));
  await assert.rejects(runGemini(ctx, writer), /before a finishReason/);
  const persisted = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
  assert.deepEqual(persisted.map(item => item.type), ["reasoning"]);
  const prefix = [message("user", "Work"), ...persisted];
  const recovered = await execute([
    chunk([{ thought: true, text: "Second thought." }]),
    { ...chunk([{ text: "Done." }, { text: "", thoughtSignature: "synthetic-final" }], "STOP"), usageMetadata: usage },
  ], { input: prefix, reasoning: { summary: "auto" } });
  const { body } = buildGeminiRequest(context({ input: [...prefix, ...recovered.output, message("user", "Thanks")] }));
  assert.deepEqual(body.contents.map((content: any) => [content.role, content.parts.map((part: any) => part.text).join("")]), [
    ["user", "Work"], ["model", "First thought."], ["user", "Continue."], ["model", "Second thought.Done."], ["user", "Thanks"],
  ]);
});

test("Gemini cumulative usage replaces earlier snapshots and counts tool prompts only once", async () => {
  const result = await execute([
    { ...chunk([{ text: "" }]), usageMetadata: { trafficType: "ON_DEMAND" } },
    { ...chunk([{ text: "Hello" }]), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 } },
    { ...chunk([{ text: "." }], "STOP"), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, toolUsePromptTokenCount: 3, totalTokenCount: 108 } },
  ]);
  assert.deepEqual(result.result.usage, { input_tokens: 103, output_tokens: 5, cached_tokens: 0, reasoning_tokens: 0 });
});
