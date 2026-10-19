import assert from "node:assert/strict";
import test from "node:test";
import { decodeCompaction } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { collectHandoff, compact, handoffRequest, isCompactionRequest, summaryRequest } from "../src/compaction.ts";
import { BridgeError } from "../src/errors.ts";
import { HANDOFF_PROMPT, SUMMARIZATION_PROMPT } from "../src/prompts.ts";
import type { AdapterId, Backend, BackendContext, ModelConfig } from "../src/types.ts";
import type { Usage } from "../src/writer.ts";

const summaryUsage: Usage = { input_tokens: 100, output_tokens: 12, cached_tokens: 80, reasoning_tokens: 4 };
const nativeUsage: Usage = { input_tokens: 100, output_tokens: 8, cached_tokens: 90, cache_write_tokens: 3 };
const checkpoint = { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-checkpoint" };

function context(adapter: AdapterId = "gpt-responses", signal = new AbortController().signal, compaction?: ModelConfig["compaction"]): BackendContext {
  const config = validateConfig({
    upstreams: { example: { base_url: "https://api.example.com/v1" } },
    models: { "example-model": { upstream: "example", model: "example-model", catalog: { "gpt-responses": "gpt-6.1-sol", "claude-messages": "claude-sonnet-5-5", "deepseek-chat": "deepseek-flash" }[adapter], compaction } },
  });
  return {
    request: {
      model: "example-model",
      instructions: "Follow the task.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Remember the number 42." }] },
        { type: "reasoning", summary: [], encrypted_content: "synthetic-reasoning" },
        { type: "compaction_trigger" },
      ],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
    },
    route: resolveModel(config, "example-model"),
    signal,
  };
}

function successfulBackend(onCall?: (ctx: BackendContext) => void): Backend {
  return async (ctx, writer) => {
    ctx.onAccepted?.();
    onCall?.(ctx);
    if (isCompactionRequest(ctx.request)) {
      writer.addItem(checkpoint);
      return { usage: nativeUsage };
    }
    writer.textDelta("The task must preserve the number 42.");
    return { usage: summaryUsage };
  };
}

test("native compaction stores a deferred handoff recipe and accounts only for the native request", async () => {
  const ctx = context();
  let accepted = 0;
  ctx.onAccepted = () => { accepted++; };
  const original = structuredClone(ctx.request);
  const calls: BackendContext[] = [];
  const result = await compact(ctx, successfulBackend((call) => calls.push(call)));
  assert.deepEqual(ctx.request, original);
  assert.equal(calls.length, 1);
  assert.equal(isCompactionRequest(calls[0].request), true);
  assert.equal(accepted, 1);
  assert.equal(calls[0].compacting, true);
  assert.equal(result.item.type, "compaction");
  assert.match(String(result.item.id), /^cmp_/);
  assert.deepEqual(decodeCompaction(result.item.encrypted_content), {
    native: { source: ctx.route.origin, format: "responses.compaction.v1", data: checkpoint },
    handoff: {
      prefix: [],
      parameters: { model: ctx.request.model, instructions: ctx.request.instructions, tools: ctx.request.tools,
        reasoning: { effort: ctx.route.profile.default_effort } },
      responsesLite: false,
    },
  });
  assert.deepEqual(result.usage, nativeUsage);
});

for (const adapter of ["claude-messages", "deepseek-chat"] as const) {
  test(`${adapter} compaction creates a portable summary with one upstream request`, async () => {
    const calls: BackendContext[] = [];
    let accepted = 0;
    const result = await compact({ ...context(adapter), onAccepted: () => { accepted++; } }, successfulBackend((call) => calls.push(call)));
    assert.equal(calls.length, 1);
    assert.equal(accepted, 1);
    assert.equal(isCompactionRequest(calls[0].request), false);
    assert.equal((calls[0].request.input as any[]).at(-1).content[0].text, SUMMARIZATION_PROMPT);
    assert.deepEqual(decodeCompaction(result.item.encrypted_content), {
      summary: "The task must preserve the number 42.",
    });
    assert.deepEqual(result.usage, summaryUsage);
  });
}

test("summary requests retain the prefix and tools and remove the answer format", () => {
  const ctx = context();
  const request = summaryRequest(ctx.request);
  assert.equal(request.instructions, ctx.request.instructions);
  assert.deepEqual(request.tools, ctx.request.tools);
  assert.deepEqual((request.input as unknown[]).slice(0, -1), (ctx.request.input as unknown[]).slice(0, -1));
  assert.deepEqual((request.input as unknown[]).at(-1), {
    type: "message", role: "user", content: [{ type: "input_text", text: SUMMARIZATION_PROMPT }],
  });
  assert.equal(Object.hasOwn(request, "tool_choice"), false);
  assert.equal(request.text, undefined);
  assert.equal(request.stream, true);
});

test("summary and deferred handoff preserve tool choice and unknown request parameters", async () => {
  for (const choice of [undefined, "auto", "none", "required", { type: "function", name: "lookup" }]) {
    const ctx = context();
    if (choice !== undefined) ctx.request.tool_choice = choice;
    ctx.request.future_parameter = { mode: "synthetic-value" };
    ctx.request.temperature = 0.7;
    ctx.request.stream = false;
    ctx.requestHeaders = new Headers({ authorization: "Bearer synthetic-private-credential" });
    const original = structuredClone(ctx.request);
    const summary = summaryRequest(ctx.request);
    const native = await compact(ctx, successfulBackend());
    const recipe = decodeCompaction(native.item.encrypted_content)!.handoff!;
    assert.doesNotMatch(JSON.stringify(recipe), /synthetic-private-credential/);
    const handoff = handoffRequest(recipe, [], native.item);
    assert.deepEqual(ctx.request, original);
    for (const request of [summary, recipe.parameters, handoff]) {
      assert.equal(Object.hasOwn(request, "tool_choice"), choice !== undefined);
      assert.deepEqual(request.tool_choice, choice);
      assert.deepEqual(request.future_parameter, { mode: "synthetic-value" });
      assert.equal(request.temperature, 0.7);
      assert.equal(Object.hasOwn(request, "text"), false);
    }
    assert.equal(Object.hasOwn(recipe.parameters, "input"), false);
    assert.equal(Object.hasOwn(recipe.parameters, "stream"), false);
    assert.equal(handoff.stream, true);
  }
});

test("a compaction trigger must be unique and last", async () => {
  const malformed = [
    "plain input",
    [{ type: "message", role: "user", content: "hello" }],
    [{ type: "compaction_trigger" }, { type: "message", role: "user", content: "hello" }],
    [{ type: "compaction_trigger" }, { type: "compaction_trigger" }],
  ];
  for (const input of malformed) {
    const ctx = context();
    ctx.request.input = input;
    await assert.rejects(compact(ctx, async () => { throw new Error("Must not call upstream"); }), BridgeError);
  }
  assert.equal(isCompactionRequest({ model: "example-model", input: "hello" }), false);
});

for (const stage of ["native", "handoff"]) {
  test(`${stage} failures pass through unchanged`, async () => {
    const failure = new BridgeError("Temporary capacity shortage", "server_is_overloaded", 503, { "retry-after": "15" });
    let calls = 0;
    const backend: Backend = async () => { calls++; throw failure; };
    const run = stage === "native" ? compact : collectHandoff;
    await assert.rejects(run(context(), backend), (error) => error === failure);
    assert.equal(calls, 1);
  });
}

test("the handoff uses source instructions and the exact retained input with native state", async () => {
  const ctx = context("gpt-responses", new AbortController().signal, { native_replay: false });
  const declaration = { type: "additional_tools", role: "developer", tools: ctx.request.tools };
  const instructions = { type: "message", role: "developer", content: "Follow the project conventions." };
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the exact value 42." }] };
  ctx.request.input = [
    declaration, instructions, user,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Old work" }] },
    { type: "function_call", name: "lookup", call_id: "call_old", arguments: "{}" },
    { type: "function_call_output", call_id: "call_old", output: "Old tool output" },
    { type: "reasoning", summary: [], encrypted_content: "old-reasoning" },
    { type: "compaction_trigger" },
  ];
  const native = await compact(ctx, successfulBackend());
  const recipe = decodeCompaction(native.item.encrypted_content)!.handoff!;
  const retained = [user, { type: "message", role: "developer", content: "Client-retained update." }];
  const handoff = handoffRequest(recipe, retained, native.item);
  const calls: BackendContext[] = [];
  const result = await collectHandoff({ ...ctx, request: handoff }, successfulBackend(call => calls.push(call)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route.compaction.native_replay, true);
  assert.equal(ctx.route.compaction.native_replay, false);
  assert.deepEqual(result, { summary: "The task must preserve the number 42.", usage: summaryUsage });
  assert.equal(handoff.instructions, ctx.request.instructions);
  assert.deepEqual(handoff.tools, ctx.request.tools);
  assert.equal(Object.hasOwn(handoff, "tool_choice"), false);
  assert.equal(handoff.text, undefined);
  assert.deepEqual(handoff.input, [declaration, instructions, ...retained, native.item, {
    type: "message", role: "user", content: [{ type: "input_text", text: HANDOFF_PROMPT }],
  }]);
});

test("missing, duplicate, and empty native checkpoints are rejected", async () => {
  for (const nativeItems of [[], [checkpoint, checkpoint], [{ type: "compaction", encrypted_content: "" }]]) {
    await assert.rejects(compact(context(), async (ctx, writer) => {
      if (isCompactionRequest(ctx.request)) {
        for (const item of nativeItems) writer.addItem(item);
      } else writer.textDelta("Valid summary.");
      return { usage: summaryUsage };
    }), /exactly one nonempty compaction item/);
  }
});

test("empty, refused, tool, and unfinished summaries never replace history", async () => {
  const backends: Backend[] = [
    async () => ({ usage: summaryUsage }),
    async (_ctx, writer) => {
      writer.addItem({ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] });
      return { usage: summaryUsage };
    },
    async (_ctx, writer) => {
      writer.addFunctionCall({ call_id: "call_synthetic", name: "lookup", arguments: "{}" });
      return { usage: summaryUsage };
    },
    async (_ctx, writer) => {
      writer.textDelta("Partial");
      return { usage: summaryUsage, endTurn: false };
    },
  ];
  for (const backend of backends) {
    await assert.rejects(compact(context("deepseek-chat"), backend), BridgeError);
    await assert.rejects(collectHandoff(context(), backend), BridgeError);
  }
});

test("summary tool calls fail explicitly without another request even when the turn is unfinished", async () => {
  for (const stage of ["summary", "handoff"] as const) {
    for (const kind of ["function", "custom"] as const) {
      let calls = 0;
      const backend: Backend = async (_ctx, writer) => {
        calls++;
        writer.textDelta("Partial summary must not replace history.");
        if (kind === "function") writer.addFunctionCall({ call_id: "call_synthetic", name: "lookup", arguments: "{}" });
        else writer.addCustomToolCall({ call_id: "call_synthetic", name: "exec", input: "synthetic input" });
        return { usage: summaryUsage, endTurn: false };
      };
      const pending = stage === "summary" ? compact(context("deepseek-chat"), backend) : collectHandoff(context(), backend);
      await assert.rejects(pending, (error) => error instanceof BridgeError && error.code === "invalid_prompt" &&
        /tool call instead of a summary/.test(error.message));
      assert.equal(calls, 1);
    }
  }
});

for (const phase of ["native", "handoff"]) {
  test(`caller cancellation reaches the active ${phase} request`, async () => {
    const cancel = new AbortController();
    let started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const seenSignals: AbortSignal[] = [];
    const run = phase === "native" ? compact : collectHandoff;
    const pending = run(context("gpt-responses", cancel.signal), async (ctx) => {
      seenSignals.push(ctx.signal);
      started();
      await new Promise<void>((resolve) => { ctx.signal.addEventListener("abort", () => resolve(), { once: true }); });
      ctx.signal.throwIfAborted();
      return { usage: summaryUsage };
    });
    await active;
    cancel.abort(new Error("Caller disconnected"));
    await assert.rejects(pending, /Caller disconnected/);
    assert.equal(seenSignals.length, 1);
    assert.ok(seenSignals.every((signal) => signal.aborted));
  });
}

test("an already canceled request makes no upstream requests", async () => {
  const signal = AbortSignal.abort(new Error("Canceled"));
  await assert.rejects(compact(context("gpt-responses", signal), async () => { assert.fail("Must not call upstream"); }), /Canceled/);
});


test("summary-only Responses compaction is configured independently from native replay", async () => {
  const ctx = context("gpt-responses", new AbortController().signal, { mode: "summary" });
  assert.equal(ctx.route.compaction.native_replay, true);
  const calls: BackendContext[] = [];
  const result = await compact(ctx, successfulBackend((call) => calls.push(call)));
  assert.equal(calls.length, 1);
  assert.equal(isCompactionRequest(calls[0].request), false);
  assert.equal(decodeCompaction(result.item.encrypted_content)?.native, undefined);
  assert.deepEqual(result.usage, summaryUsage);
});

test("unfinished native compaction never produces a checkpoint", async () => {
  let calls = 0;
  await assert.rejects(compact(context(), async (_ctx, writer) => {
    calls++;
    writer.addItem(checkpoint);
    return { usage: nativeUsage, endTurn: false };
  }), /did not finish/);
  assert.equal(calls, 1);
});
