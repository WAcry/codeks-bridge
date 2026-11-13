import assert from "node:assert/strict";
import test from "node:test";
import { buildGeminiRequest, runGemini } from "../src/backends/gemini.ts";
import { decodeReasoning, encodeCompaction, encodeReasoning } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { formatSse } from "../src/sse.ts";
import { ResponseWriter } from "../src/writer.ts";

const config = validateConfig({
  upstreams: { native: { base_url: "https://example.com/v1beta" } },
  models: { gemini: { upstream: "native", model: "synthetic-gemini", catalog: "gemini-4-carbon" } },
});
const route = resolveModel(config, "gemini");
const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } } } }];
const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const call = (id: string) => ({ type: "function_call", call_id: id, name: "lookup", arguments: JSON.stringify({ key: id }) });
const result = (id: string, output = "aborted") => ({ type: "function_call_output", call_id: id, output });
const part = (id: string, signed = true) => ({ functionCall: { name: "lookup", args: { key: id } },
  ...(signed ? { thoughtSignature: `synthetic-${id}` } : {}) });
const carrier = (id: string, signed = true, generation?: string, extra: Record<string, unknown> = {}) => ({
  type: "reasoning", encrypted_content: encodeReasoning({ source: route.origin, format: route.profile.reasoning_format,
    data: { parts: [part(id, signed)], projection: { type: "function_call", call_id: id },
      ...(generation ? { generation } : {}), ...extra } }),
});
function build(input: any[]) {
  const snapshot = structuredClone(input);
  const body = buildGeminiRequest({ route, request: { model: "gemini", tools, input }, signal: new AbortController().signal }).body;
  assert.deepEqual(input, snapshot, "Replay must not edit durable history");
  return body.contents as any[];
}
const callsIn = (contents: any[]) => contents.flatMap(content => content.parts).filter(part => part.functionCall);

for (const generation of [undefined, "synthetic-generation"]) {
  test(`Gemini ${generation ? "current" : "legacy"} parallel calls survive a synthetic result after each call`, () => {
    const contents = build([message("user", "Read both"),
      call("a"), result("a"), carrier("a", true, generation),
      call("b"), result("b"), carrier("b", false, generation), message("user", "Next")]);
    assert.deepEqual(contents[1], { role: "model", parts: [part("a"), part("b", false)] });
    assert.deepEqual(contents[2].parts.map((part: any) => part.functionResponse), [
      { name: "lookup", response: { output: "aborted" } }, { name: "lookup", response: { output: "aborted" } },
    ]);
    assert.equal(contents.length, 4);
  });
}

test("Gemini keeps distinct native generations and legacy sequential signed calls separate", () => {
  for (const generations of [[undefined, undefined], ["first", "second"]]) {
    const contents = build([message("user", "Read in order"),
      call("a"), result("a"), carrier("a", true, generations[0]),
      call("b"), result("b"), carrier("b", true, generations[1])]);
    assert.deepEqual(contents.map(content => content.role), ["user", "model", "user", "model", "user"]);
    assert.deepEqual(callsIn(contents), [part("a"), part("b")]);
  }
});

test("Gemini legacy empty trailing parts stay with their native call batch", () => {
  for (const tail of [{ text: "" }, { text: "", thoughtSignature: "synthetic-tail" }]) {
    const state = { type: "reasoning", encrypted_content: encodeReasoning({
      source: route.origin, format: route.profile.reasoning_format, data: { parts: [tail] },
    }) };
    const contents = build([message("user", "Read both"), call("a"), result("a"), carrier("a"),
      call("b"), result("b"), carrier("b", false), state]);
    assert.deepEqual(contents[1].parts, [part("a"), part("b", false), tail]);
    assert.equal(contents.length, 3);
  }
});

test("Gemini restores pre-call state and only the calls present in a fork", () => {
  const prefix = [message("user", "Read both"), carrier("a", true, "one"), call("a"), result("a")];
  assert.deepEqual(callsIn(build(prefix)), [part("a")]);
  assert.deepEqual(callsIn(build([...prefix, carrier("b", false, "one")])), [part("a")],
    "Uncommitted state for B must not invent a call");
  const full = build([...prefix, carrier("b", false, "one"), call("b"), result("b")]);
  assert.deepEqual(full[1].parts, [part("a"), part("b", false)]);
  assert.equal(full.length, 3);
});

test("Gemini groups native text and thinking with the observed calls before their results", () => {
  const state = (parts: any[], projection?: any) => ({ type: "reasoning", encrypted_content: encodeReasoning({
    source: route.origin, format: route.profile.reasoning_format, data: { generation: "one", parts, ...(projection ? { projection } : {}) },
  }) });
  const thought = { text: "A synthetic plan", thought: true };
  const text = { text: "A synthetic explanation", thoughtSignature: "synthetic-text" };
  const contents = build([message("user", "Read"), carrier("a", true, "one"), call("a"), result("a"),
    state([thought]), message("assistant", text.text), state([text], { type: "message" }), message("user", "Next")]);
  assert.deepEqual(contents[1], { role: "model", parts: [part("a"), thought, text] });
  assert.equal(contents[2].parts.length, 1);
  assert.equal(contents.length, 4);
});

test("Gemini preserves result order and additional output notifications", () => {
  const contents = build([message("user", "Read both"), carrier("a", true, "one"), call("a"),
    carrier("b", false, "one"), call("b"), result("b", "B"), result("a", "A"), result("a", "Later A")]);
  assert.deepEqual(contents[1].parts, [part("a"), part("b", false)]);
  assert.deepEqual(contents[2].parts.map((part: any) => part.functionResponse.response.output), ["A", "B"]);
  assert.match(JSON.stringify(contents[3]), /Additional output from tool call/);
  assert.match(JSON.stringify(contents[3]), /Later A/);
});

test("Gemini tool notifications do not split a native generation", () => {
  const contents = build([message("user", "Read both"), carrier("a", true, "one"), call("a"), result("a"),
    { type: "function_call_output", name: "lookup", output: "Synthetic notification" },
    carrier("b", false, "one"), call("b"), result("b")]);
  assert.deepEqual(contents[1].parts, [part("a"), part("b", false)]);
  assert.equal(contents[2].parts.filter((part: any) => part.functionResponse).length, 2);
  assert.match(JSON.stringify(contents[3]), /Synthetic notification/);
});

test("Gemini first-tool continuation restores the boundary before the native call", () => {
  const contents = build([message("user", "Work"), message("assistant", "Partial answer"),
    carrier("a", true, "one", { continuation_before: "Continue." }), call("a"), result("a")]);
  assert.deepEqual(contents.slice(0, 4), [
    { role: "user", parts: [{ text: "Work" }] }, { role: "model", parts: [{ text: "Partial answer" }] },
    { role: "user", parts: [{ text: "Continue." }] }, { role: "model", parts: [part("a")] },
  ]);
});

test("Gemini state cannot match across user, developer, or compaction boundaries", () => {
  for (const boundary of [message("user", "New task"), message("developer", "New instruction"),
    { type: "compaction", encrypted_content: encodeCompaction({ summary: "Synthetic checkpoint" }) }]) {
    assert.throws(() => build([message("user", "Work"), call("a"), result("a"), boundary, carrier("a")]), /matching call/);
  }
  for (const role of ["user", "developer"]) {
    assert.throws(() => build([message("user", "Work"), carrier("a", true, "one"), message(role, "Boundary"), call("a"), result("a")]), /matching call/);
  }
});

test("Gemini rejects duplicate projections, ambiguous calls, and changed native content", () => {
  assert.throws(() => build([call("a"), carrier("a"), carrier("a"), result("a")]), /unique matching call/);
  assert.throws(() => build([call("a"), carrier("a"), result("a"), call("a"), result("a")]), /unique matching call/);
  assert.throws(() => build([{ ...call("a"), arguments: '{"key":"changed"}' }, result("a"), carrier("a")]), /does not match/);
  assert.throws(() => build([call("a"), carrier("a", true, "one", { generation: 7 }), result("a")]), /generation/);
  assert.throws(() => build([carrier("wrong", true, "one"), call("a"), result("a")]), /matching call/);
  const intervening = { type: "reasoning", encrypted_content: encodeReasoning({
    source: route.origin, format: route.profile.reasoning_format,
    data: { generation: "other", parts: [{ text: "Another step", thought: true }] },
  }) };
  assert.throws(() => build([carrier("a", true, "one"), intervening, call("a"), result("a")]), /another assistant/);
});

test("Gemini source filtering leaves imported tool history without consuming foreign state", () => {
  const foreign = carrier("a", true, "one");
  const state = decodeReasoning(foreign.encrypted_content)!;
  state.source.id = "synthetic-other-source";
  foreign.encrypted_content = encodeReasoning(state);
  const contents = build([message("user", "Work"), foreign, call("a"), result("a")]);
  assert.equal(callsIn(contents)[0].thoughtSignature, "skip_thought_signature_validator");
});

test("Gemini commits tool state before each executable projection, including every truncated prefix", async () => {
  const events: any[] = [];
  const writer = new ResponseWriter({ write: value => {
    for (const frame of value.trim().split("\n\n")) if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
  } }, { model: "gemini", showSummary: false });
  const parts = [part("a"), part("b", false)];
  const ctx = { route, request: { model: "gemini", tools, input: "Read both" }, signal: new AbortController().signal,
    fetch: async () => new Response(formatSse({ candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 5 } })) };
  writer.start();
  const completion = await runGemini(ctx, writer);
  assert.ok(!events.some(event => event.type === "response.output_item.done"), "Tools and their native state stay held until success");
  writer.complete(completion.usage, completion.endTurn);
  const items = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
  assert.deepEqual(items.map(item => item.type), ["reasoning", "function_call", "reasoning", "function_call"]);
  const states = items.filter(item => item.type === "reasoning").map(item => decodeReasoning(item.encrypted_content)!.data as any);
  assert.ok(states.every(state => state.generation === writer.responseId));
  for (let length = 1; length <= items.length; length++) {
    const prefix = items.slice(0, length);
    const calls = prefix.filter(item => item.type === "function_call");
    const contents = build([message("user", "Read both"), ...prefix.flatMap(item => item.type === "function_call" ? [item, result(item.call_id)] : [item])]);
    assert.deepEqual(callsIn(contents), parts.slice(0, calls.length));
  }
});

test("Gemini discards pre-call carriers as well as tools on an incomplete stream", async () => {
  const events: any[] = [];
  const writer = new ResponseWriter({ write: value => {
    for (const frame of value.trim().split("\n\n")) if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
  } }, { model: "gemini" });
  writer.start();
  await assert.rejects(runGemini({ route, request: { model: "gemini", tools, input: "Read" }, signal: new AbortController().signal,
    fetch: async () => new Response(formatSse({ candidates: [{ index: 0, content: { role: "model", parts: [part("a")] } }] })) }, writer), /finishReason/);
  writer.fail({ message: "Synthetic EOF", code: "upstream_error" });
  assert.ok(!events.some(event => event.type === "response.output_item.done"));
});
