import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { buildAnthropicRequest, runAnthropic } from "../src/backends/anthropic.ts";
import { decodeReasoning, encodeReasoning } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { formatSse } from "../src/sse.ts";
import type { BackendContext, ResponsesRequest } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const config = validateConfig({
  upstreams: { example: { base_url: "https://api.example.com/v1" } },
  models: {
    original: { upstream: "example", model: "synthetic-original", catalog: "claude-sonnet-5-5" },
    other: { upstream: "example", model: "synthetic-other", catalog: "claude-sonnet-5-5" },
    shared: {
      upstream: "example", model: "synthetic-shared", catalog: "claude-sonnet-5-5",
      replay: { reasoning_from: ["original"] },
    },
  },
});
const route = resolveModel(config, "original");
const message = (role: string, content: string) => ({ type: "message", role, content });
const thought = (name: string) => ({ type: "thinking", thinking: `Synthetic thought ${name}.`, signature: `synthetic_signature_${name}` });
const text = { type: "text", text: "Synthetic answer." };
const tool = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };

function reasoning(data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: "reasoning", summary: [],
    encrypted_content: encodeReasoning({ source: route.origin, format: route.profile.reasoning_format, data, ...extra }),
  };
}

const history = [message("user", "Continue the task."), reasoning(thought("first"))];

function context(request: Partial<ResponsesRequest> = {}, model = "original"): BackendContext {
  return {
    route: resolveModel(config, model),
    request: { model, input: history, ...request },
    signal: new AbortController().signal,
  };
}

function messages(body: Record<string, any>): Array<{ role: string; content: Record<string, any>[] }> {
  return body.messages.map((message: any) => ({
    role: message.role,
    content: message.content.map(({ cache_control: _cache, ...block }: any) => block),
  }));
}

async function exchange(ctx: BackendContext, output: Record<string, any>[]) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      ...output.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block },
        { type: "content_block_stop", index },
      ]),
      { type: "message_delta", delta: { stop_reason: output.some(block => block.type === "tool_use") ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ];
    res.end(events.map(event => formatSse(event)).join(""));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const writer = new ResponseWriter({ write() {} }, {
    model: ctx.request.model, showSummary: ctx.request.reasoning?.summary !== "none",
  });
  writer.start();
  try {
    const result = await runAnthropic({
      ...ctx, route: { ...ctx.route, upstream: { ...ctx.route.upstream, base_url: `http://127.0.0.1:${address.port}/v1` } },
    }, writer);
    writer.complete(result.usage, result.endTurn);
    assert.equal(requests.length, 1);
    return { sent: requests[0], items: structuredClone(writer.outputItems) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("Claude preserves one continuation boundary for a recovered multi-thinking response", async () => {
  const output = [thought("second"), thought("third"), text];
  const { sent, items } = await exchange(context(), output);
  assert.deepEqual(messages(sent).at(-1), { role: "user", content: [{ type: "text", text: "Continue." }] });
  const restored = items.filter(item => item.type === "reasoning");
  const envelopes = restored.map(item => decodeReasoning(item.encrypted_content) as any);
  assert.equal(envelopes[0].continuation_before, "Continue.");
  assert.equal(Object.hasOwn(envelopes[1], "continuation_before"), false);
  assert.deepEqual(envelopes.map(envelope => envelope.data), output.slice(0, 2));
  for (const item of restored) assert.match(item.encrypted_content, /^cxbr1:/);
  const input = [...history, ...items, message("user", "Next task.")];
  const snapshot = structuredClone(input);
  const replay = buildAnthropicRequest(context({ input })).body;
  assert.deepEqual(messages(replay), [
    { role: "user", content: [{ type: "text", text: "Continue the task." }] },
    { role: "assistant", content: [thought("first")] },
    { role: "user", content: [{ type: "text", text: "Continue." }] },
    { role: "assistant", content: output },
    { role: "user", content: [{ type: "text", text: "Next task." }] },
  ]);
  assert.deepEqual(input, snapshot);
});

test("ordinary Claude responses and text or tool first continuations have no boundary metadata", async () => {
  const cases = [
    { ctx: context({ input: [message("user", "A new task.")] }), output: [thought("normal"), text] },
    { ctx: context(), output: [text, thought("after_text")] },
    {
      ctx: context({ tools: [tool] }),
      output: [{ type: "tool_use", id: "synthetic_call", name: "lookup", input: {} }, thought("after_tool")],
    },
  ];
  for (const { ctx, output } of cases) {
    const { items } = await exchange(ctx, output);
    const envelopes = items.filter(item => item.type === "reasoning").map(item => decodeReasoning(item.encrypted_content) as any);
    assert.equal(envelopes.length, 1);
    assert.equal(Object.hasOwn(envelopes[0], "continuation_before"), false);
  }
});

test("hidden summaries and redacted thinking still carry the recovery boundary", async () => {
  for (const block of [thought("hidden"), { type: "redacted_thinking", data: "synthetic_redacted_data" }]) {
    const { items } = await exchange(context({ reasoning: { summary: "none" } }), [block, text]);
    const item = items.find(item => item.type === "reasoning")!;
    assert.deepEqual(item.summary, []);
    const envelope = decodeReasoning(item.encrypted_content) as any;
    assert.equal(envelope.continuation_before, "Continue.");
    assert.deepEqual(envelope.data, block);
    const replay = buildAnthropicRequest(context({ input: [...history, ...items, message("user", "Next.")] })).body;
    assert.deepEqual(replay.messages.at(-2).content[0], block);
    assert.equal(Object.hasOwn(replay.messages.at(-2).content[0], "continuation_before"), false);
  }
});

test("continuation metadata follows source filtering and explicit reasoning reuse", () => {
  const stored = "\nResume exactly here.\n";
  const item = reasoning(thought("reused"), { continuation_before: stored });
  const input = [...history, item, message("assistant", "Recovered."), message("user", "Next.")];
  for (const model of ["original", "shared"]) {
    const { body } = buildAnthropicRequest(context({ input }, model));
    assert.deepEqual(messages(body)[2], { role: "user", content: [{ type: "text", text: stored }] });
    assert.deepEqual(body.messages[3].content[0], thought("reused"));
  }
  const filtered = buildAnthropicRequest(context({ input }, "other")).body;
  assert.deepEqual(messages(filtered), [
    { role: "user", content: [{ type: "text", text: "Continue the task." }] },
    { role: "assistant", content: [{ type: "text", text: "Recovered." }] },
    { role: "user", content: [{ type: "text", text: "Next." }] },
  ]);
});

test("invalid continuation metadata fails only when its reasoning carrier is selected", () => {
  for (const continuation_before of ["", null, 7, true, [], {}]) {
    const input = [message("user", "Task."), reasoning(thought("invalid"), { continuation_before }), message("user", "Next.")];
    assert.throws(() => buildAnthropicRequest(context({ input })), { code: "invalid_prompt" });
    assert.doesNotThrow(() => buildAnthropicRequest(context({ input }, "other")));
  }
});

test("legacy carriers retain their payload and gain no synthetic boundary on normal replay", () => {
  const item = reasoning(thought("legacy"));
  const original = item.encrypted_content;
  assert.deepEqual(decodeReasoning(original), {
    source: route.origin, format: route.profile.reasoning_format, data: thought("legacy"),
  });
  const { body } = buildAnthropicRequest(context({
    input: [message("user", "Task."), item, message("assistant", "Done."), message("user", "Next.")],
  }));
  assert.deepEqual(messages(body).map(message => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(body.messages[1].content[0], thought("legacy"));
  assert.equal(item.encrypted_content, original);
});

test("persisted inline declarations anchor their own Continue without duplicating carrier metadata", async () => {
  const update = { type: "additional_tools", tools: [{ ...tool, description: "Updated lookup." }] };
  const input = [...history, update];
  const { sent, items } = await exchange(context({ input, tools: [tool] }), [thought("after_inline"), text]);
  assert.deepEqual(messages(sent).map(message => message.role), ["user", "assistant", "user", "system"]);
  const envelope = decodeReasoning(items.find(item => item.type === "reasoning")!.encrypted_content) as any;
  assert.equal(Object.hasOwn(envelope, "continuation_before"), false);
  const replay = buildAnthropicRequest(context({
    input: [...input, ...items, message("user", "Next.")], tools: [tool],
  })).body;
  assert.deepEqual(messages(replay).slice(0, 4), messages(sent));
  assert.deepEqual(messages(replay).map(message => message.role), ["user", "assistant", "user", "system", "assistant", "user"]);
  assert.equal(replay.messages.flatMap((message: any) => message.content).filter((block: any) => block.text === "Continue.").length, 1);
});
