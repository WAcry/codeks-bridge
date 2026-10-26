import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicRequest } from "../src/backends/anthropic.ts";
import { buildDeepSeekRequest } from "../src/backends/deepseek.ts";
import { responsesBody } from "../src/backends/responses.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { handoffRequest, summaryRequest } from "../src/compaction.ts";
import { prepareToolCall, toolCallForReplay, toolResultForReplay, writeToolCall } from "../src/tool-calls.ts";
import type { ClientToolCall } from "../src/tool-calls.ts";
import { buildToolSet } from "../src/tools.ts";
import type { BackendContext } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const functionTool = (name: string) => ({ type: "function", name, parameters: { type: "object", properties: {} } });
const definitions = [
  { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run JavaScript." }] },
  { type: "namespace", name: "agents", tools: [functionTool("spawn_agent")] },
  { type: "namespace", name: "clock", tools: [functionTool("sleep")] },
];
const code = 'text(await tools.exec_command({cmd: "printf synthetic-marker"}));';
const config = validateConfig({
  upstreams: { synthetic: { base_url: "https://example.com/v1" } },
  models: {
    chat: { upstream: "synthetic", model: "synthetic-chat", catalog: "deepseek-flash" },
    claude: { upstream: "synthetic", model: "synthetic-claude", catalog: "claude-sonnet-5-5" },
    gpt: { upstream: "synthetic", model: "synthetic-gpt", catalog: "gpt-6.1-sol" },
  },
});

function context(model: string, tools: unknown[], input: any[]): BackendContext {
  return {
    route: resolveModel(config, model),
    request: { model, tools, input },
    signal: new AbortController().signal,
  };
}

function committed(prepared: ClientToolCall): any {
  const events: any[] = [];
  const writer = new ResponseWriter({ write: chunk => events.push(JSON.parse(chunk.slice(6))) }, { model: "synthetic" });
  writer.start();
  writeToolCall(writer, prepared);
  assert.equal(events.some(event => event.type === "response.output_item.done"), false,
    "Resolved and failed tool calls both wait for upstream completion");
  writer.complete({ input_tokens: 10, output_tokens: 2 }, false);
  const done = events.filter(event => event.type === "response.output_item.done");
  assert.equal(done.length, 1);
  return done[0].item;
}

function history(item: any, output = "synthetic tool result"): any[] {
  return [
    { type: "message", role: "user", content: "Use the requested tool." },
    item,
    { type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: item.call_id, output },
  ];
}

test("accepted custom aliases execute the same input and replay their exact wire identity on both adapters", () => {
  const tools = buildToolSet(definitions);
  for (const name of ["functions__exec", "functions.exec", "exec"]) {
    const item = committed(prepareToolCall(tools, "wire_custom", name, { input: code }));
    assert.equal(item.type, "custom_tool_call");
    assert.equal(item.namespace, "functions");
    assert.equal(item.name, "exec");
    assert.equal(item.input, code, "Outer aliases must not rewrite the JavaScript");
    const input = history(item);
    const chat = buildDeepSeekRequest(context("chat", definitions, input)).body;
    const chatCall = chat.messages[1].tool_calls[0];
    assert.deepEqual(chatCall, { id: "wire_custom", type: "function", function: {
      name, arguments: JSON.stringify({ input: code }),
    } });
    assert.equal(chat.messages[2].tool_call_id, "wire_custom");
    const claude = buildAnthropicRequest(context("claude", definitions, input)).body;
    assert.deepEqual(claude.messages[1].content[0], { type: "tool_use", id: "wire_custom", name, input: { input: code } });
    assert.equal(claude.messages[2].content[0].tool_use_id, "wire_custom");
    assert.equal(claude.messages[2].content[0].is_error, undefined);
    assert.deepEqual(input, history(item), "Conversion must not modify client history");
  }
});

test("non-default namespaces restore function identity while preserving all accepted wire spellings", () => {
  const tools = buildToolSet(definitions);
  for (const [namespace, name] of [["agents", "spawn_agent"], ["clock", "sleep"]]) {
    for (const spelling of [`${namespace}__${name}`, `${namespace}.${name}`, name]) {
      const item = committed(prepareToolCall(tools, "wire_function", spelling, { value: "synthetic" }));
      assert.equal(item.type, "function_call");
      assert.equal(item.namespace, namespace);
      assert.equal(item.name, name);
      assert.deepEqual(JSON.parse(item.arguments), { value: "synthetic" });
      assert.deepEqual(toolCallForReplay(item, tools), { id: "wire_function", name: spelling });
      assert.deepEqual(toolResultForReplay(history(item).at(-1)), {
        id: "wire_function", output: "synthetic tool result", isError: false,
      });
    }
  }
});

test("an ambiguous default name cannot select the real default tool and returns stable candidate feedback", () => {
  const ambiguousDefinitions = [
    { type: "namespace", name: "functions", tools: [functionTool("read")] },
    { type: "namespace", name: "storage", tools: [functionTool("read")] },
  ];
  const tools = buildToolSet(ambiguousDefinitions);
  const item = committed(prepareToolCall(tools, "wire_ambiguous", "read", { path: "synthetic.txt" }));
  assert.equal(item.type, "function_call");
  assert.equal(tools.get(item.namespace, item.name), undefined, "Dispatch must not target either real tool");
  assert.notEqual(item.namespace, "functions");
  const input = history(item, "unsupported call: synthetic bridge dispatch");
  const chat = buildDeepSeekRequest(context("chat", ambiguousDefinitions, input)).body;
  assert.equal(chat.messages[1].tool_calls[0].function.name, "read");
  assert.equal(chat.messages[1].tool_calls[0].id, "wire_ambiguous");
  const diagnostic = chat.messages[2].content;
  assert.match(diagnostic, /"read" is ambiguous/);
  assert.match(diagnostic, /No tool was executed/);
  assert.match(diagnostic, /functions__read/);
  assert.match(diagnostic, /storage__read/);
  const claude = buildAnthropicRequest(context("claude", ambiguousDefinitions, input)).body;
  assert.equal(claude.messages[1].content[0].name, "read");
  assert.equal(claude.messages[2].content[0].is_error, true);
  assert.equal(claude.messages[2].content[0].content[0].text, diagnostic);

  const changed = [{ type: "namespace", name: "unrelated", tools: [functionTool("read")] }];
  const replay = buildDeepSeekRequest(context("chat", changed, structuredClone(input))).body;
  assert.equal(replay.messages[2].content, diagnostic, "Later tool updates must not rewrite an earlier error prefix");
  assert.equal(input[2].output, "unsupported call: synthetic bridge dispatch");
});

test("unknown names use the normal tool-error loop and retain their original arguments", () => {
  const tools = buildToolSet(definitions);
  const item = committed(prepareToolCall(tools, "wire_unknown", "missing_tool", { query: "synthetic" }));
  assert.equal(tools.get(item.namespace, item.name), undefined);
  const input = history(item, "unsupported call");
  const body = buildDeepSeekRequest(context("chat", definitions, input)).body;
  assert.deepEqual(body.messages[1].tool_calls[0], {
    id: "wire_unknown", type: "function", function: { name: "missing_tool", arguments: '{"query":"synthetic"}' },
  });
  assert.match(body.messages[2].content, /"missing_tool" is unknown/);
  for (const name of ["functions__exec", "agents__spawn_agent", "clock__sleep"]) assert.ok(body.messages[2].content.includes(name));
});

test("canonical call ids and ordinary tool results stay unchanged", () => {
  const tools = buildToolSet(definitions);
  const item = committed(prepareToolCall(tools, "wire_canonical", "clock__sleep", { duration_ms: 1 }));
  assert.equal(item.call_id, "wire_canonical");
  const output = [{ type: "input_text", text: "complete" }];
  assert.deepEqual(toolResultForReplay({ call_id: item.call_id, output }), {
    id: "wire_canonical", output, isError: false,
  });
  assert.throws(() => prepareToolCall(tools, "wire_bad_input", "exec", { input: 3 }), /string input/);
  assert.throws(() => prepareToolCall(tools, "", "exec", { input: code }), /incomplete/);
});

test("aliased image results use the original id in both the result and its image label", () => {
  const tools = buildToolSet(definitions);
  const item = committed(prepareToolCall(tools, "wire_image", "exec", { input: code }));
  const input = history(item);
  input[2].output = [{ type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" }];
  const body = buildDeepSeekRequest(context("chat", definitions, input)).body;
  assert.equal(body.messages[2].tool_call_id, "wire_image");
  assert.equal(body.messages[3].content[0].text, "Images from tool call wire_image:");
  assert(!JSON.stringify(body.messages).includes("cxbt1_"));
});

test("GPT projects carrier ids and diagnostics while retaining Responses tool identity", () => {
  const tools = buildToolSet(definitions);
  const alias = committed(prepareToolCall(tools, "wire_alias_with_a_provider_generated_suffix", "functions.exec", { input: code }));
  const unknown = committed(prepareToolCall(tools, "wire_unknown", "missing_tool", {}));
  const input = [...history(alias), ...history(unknown, "unsupported call")];
  const original = structuredClone(input);
  const body = responsesBody(context("gpt", definitions, input));
  assert.deepEqual(body.tools, definitions);
  for (const [callIndex, resultIndex] of [[1, 2], [4, 5]]) {
    assert.ok(input[callIndex].call_id.length > 64);
    const id = body.input[callIndex].call_id;
    assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/);
    assert(!id.startsWith("cxbt1_"));
    assert.equal(body.input[resultIndex].call_id, id);
    const { id: _id, ...withoutItemId } = input[callIndex];
    assert.deepEqual(body.input[callIndex], { ...withoutItemId, call_id: id });
  }
  assert.deepEqual(body.input[2].output, input[2].output);
  assert.equal(body.input[5].output, toolResultForReplay(input[5]).output);
  assert.match(body.input[5].output, /missing_tool.*unknown/);
  assert.match(body.input[5].output, /functions__exec/);
  assert.deepEqual(responsesBody(context("gpt", definitions, input)).input, body.input);
  assert.deepEqual(input, original);

  // All GPT sampling paths share this projection, including native compaction
  // delegated from another model and a later handoff using retained history.
  const native = { model: "gpt", tools: definitions, input: [...input, { type: "compaction_trigger" }] };
  const handoff = handoffRequest({ prefix: [], parameters: { model: "gpt", tools: definitions }, responsesLite: true },
    input, { type: "compaction", encrypted_content: "synthetic-native-checkpoint" });
  for (const request of [native, summaryRequest(native), handoff]) {
    const projected = responsesBody({ ...context("gpt", definitions, []), request, compacting: true });
    assert.deepEqual(projected.input.slice(0, input.length), body.input);
  }
});

test("GPT preserves distinct carrier identities even when their original upstream ids coincide", () => {
  const tools = buildToolSet(definitions);
  const calls = ["exec", "functions.exec"].map(name =>
    committed(prepareToolCall(tools, "wire_shared", name, { input: code })));
  calls.push(committed(prepareToolCall(tools, "wire_shared", "clock__sleep", { duration_ms: 1 })));
  const input = calls.flatMap(call => history(call));
  const body = responsesBody(context("gpt", definitions, input));
  const ids = [1, 4, 7].map(index => body.input[index].call_id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[2], "wire_shared", "A valid native id is not rewritten");
  assert.ok(calls[0].call_id.startsWith("cxbt1_") && calls[0].call_id.length <= 64);
  assert.equal(ids[0], calls[0].call_id, "A short carrier already accepted by GPT keeps its identity");
  for (const [index, call] of calls.entries()) {
    assert.equal(body.input[index * 3 + 2].call_id, ids[index]);
    assert.equal(responsesBody(context("gpt", definitions, history(call))).input[1].call_id, ids[index],
      "Mapping must not depend on other calls or their position in history");
  }
});

test("GPT bounds other providers' long call ids without interpreting opaque ids or changing tool results", () => {
  const ids = ["a".repeat(64), "a".repeat(65), "a".repeat(65) + " ", "cxbt1_unreadable", "cxbt1_" + "x".repeat(80)];
  for (const kind of ["function", "custom_tool"]) {
    const output = [{ type: "input_text", text: "Done" }, { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" }];
    const input = ids.flatMap(call_id => [
      { type: `${kind}_call`, call_id, namespace: "functions", name: "exec", future: "kept",
        ...(kind === "custom_tool" ? { input: code } : { arguments: JSON.stringify({ input: code }) }) },
      { type: `${kind}_call_output`, call_id, output, future: "kept" },
      { type: `${kind}_call_output`, call_id, output: "Later notification" },
    ]);
    input.push({ type: "function_call_output", namespace: "functions", name: "exec", output: "Proactive notification" } as any);
    const original = structuredClone(input);
    const body = responsesBody(context("gpt", definitions, input));
    const mapped = ids.map((id, index) => {
      const call = body.input[index * 3];
      assert.ok(call.call_id.length <= 64);
      if (id.length <= 64) assert.equal(call.call_id, id);
      for (const offset of [0, 1, 2]) {
        assert.deepEqual(body.input[index * 3 + offset], { ...input[index * 3 + offset], call_id: call.call_id });
      }
      return call.call_id;
    });
    assert.equal(new Set(mapped).size, ids.length, "Do not trim or truncate distinct ids into one identity");
    assert.deepEqual(body.input.at(-1), input.at(-1), "Proactive outputs do not gain an invented id");
    assert.deepEqual(input, original);
  }
});
