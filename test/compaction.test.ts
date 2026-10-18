import assert from "node:assert/strict";
import test from "node:test";
import { decodeCompaction } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { compact, isCompactionRequest, summaryRequest } from "../src/compaction.ts";
import { BridgeError } from "../src/errors.ts";
import { SUMMARIZATION_PROMPT } from "../src/prompts.ts";
import type { AdapterId, Backend, BackendContext, ModelConfig } from "../src/types.ts";
import type { Usage } from "../src/writer.ts";

const summaryUsage: Usage = { input_tokens: 100, output_tokens: 12, cached_tokens: 80, reasoning_tokens: 4 };
const nativeUsage: Usage = { input_tokens: 100, output_tokens: 8, cached_tokens: 90, cache_write_tokens: 3 };
const checkpoint = { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-checkpoint" };

function context(adapter: AdapterId = "gpt-responses", signal = new AbortController().signal, compaction?: ModelConfig["compaction"]): BackendContext {
  const config = validateConfig({
    upstreams: { example: { base_url: "https://api.example.com/v1" } },
    models: { "example-model": { upstream: "example", model: "example-model", adapter, compaction } },
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
    onCall?.(ctx);
    if (isCompactionRequest(ctx.request)) {
      writer.addItem(checkpoint);
      return { usage: nativeUsage };
    }
    writer.textDelta("The task must preserve the number 42.");
    return { usage: summaryUsage };
  };
}

test("native compaction stores both representations and accounts for both requests", async () => {
  const ctx = context();
  const original = structuredClone(ctx.request);
  const calls: BackendContext[] = [];
  const result = await compact(ctx, successfulBackend((call) => calls.push(call)));
  assert.deepEqual(ctx.request, original);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.compacting === true));
  assert.equal(result.item.type, "compaction");
  assert.match(String(result.item.id), /^cmp_/);
  assert.deepEqual(decodeCompaction(result.item.encrypted_content), {
    summary: "The task must preserve the number 42.",
    native: { source: ctx.route.origin, format: "responses.compaction.v1", data: checkpoint },
  });
  assert.deepEqual(result.usage, {
    input_tokens: 200, output_tokens: 20, cached_tokens: 170, cache_write_tokens: 3, reasoning_tokens: 4,
  });
});

for (const adapter of ["claude-messages", "deepseek-chat"] as const) {
  test(`${adapter} compaction creates a portable summary with one upstream request`, async () => {
    const calls: BackendContext[] = [];
    const result = await compact(context(adapter), successfulBackend((call) => calls.push(call)));
    assert.equal(calls.length, 1);
    assert.equal(isCompactionRequest(calls[0].request), false);
    assert.deepEqual(decodeCompaction(result.item.encrypted_content), {
      summary: "The task must preserve the number 42.",
    });
    assert.deepEqual(result.usage, summaryUsage);
  });
}

test("summary requests retain the prefix and tools but permit only summary text", () => {
  const ctx = context();
  const request = summaryRequest(ctx.request);
  assert.equal(request.instructions, ctx.request.instructions);
  assert.deepEqual(request.tools, ctx.request.tools);
  assert.deepEqual((request.input as unknown[]).slice(0, -1), (ctx.request.input as unknown[]).slice(0, -1));
  assert.deepEqual((request.input as unknown[]).at(-1), {
    type: "message", role: "user", content: [{ type: "input_text", text: SUMMARIZATION_PROMPT }],
  });
  assert.equal(request.tool_choice, "none");
  assert.equal(request.text, undefined);
  assert.equal(request.stream, true);
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

for (const failingSide of ["native", "summary"]) {
  test(`${failingSide} failure aborts the other request and publishes no checkpoint`, async () => {
    const failure = new BridgeError("Temporary capacity shortage", "server_is_overloaded", 503, { "retry-after": "15" });
    let siblingAborted = false;
    let calls = 0;
    const backend: Backend = async (ctx) => {
      calls++;
      if (isCompactionRequest(ctx.request) === (failingSide === "native")) {
        // Give both jobs a chance to enter the backend before either rejects.
        await Promise.resolve();
        throw failure;
      }
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => { siblingAborted = true; resolve(); }, { once: true });
      });
      ctx.signal.throwIfAborted();
      return { usage: summaryUsage };
    };
    await assert.rejects(compact(context(), backend), (error) => error === failure);
    assert.equal(calls, 2);
    assert.equal(siblingAborted, true);
  });
}

test("a completed native half is not returned while the summary is pending", async () => {
  let finishSummary!: () => void;
  const waitForSummary = new Promise<void>((resolve) => { finishSummary = resolve; });
  let resolved = false;
  const pending = compact(context(), async (ctx, writer) => {
    if (isCompactionRequest(ctx.request)) {
      writer.addItem(checkpoint);
      return { usage: nativeUsage };
    }
    await waitForSummary;
    writer.textDelta("Both halves completed.");
    return { usage: summaryUsage };
  }).then((value) => { resolved = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  finishSummary();
  assert.equal(decodeCompaction((await pending).item.encrypted_content)?.summary, "Both halves completed.");
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
  for (const backend of backends) await assert.rejects(compact(context("deepseek-chat"), backend), BridgeError);
});

test("caller cancellation reaches both upstream requests", async () => {
  const cancel = new AbortController();
  const seenSignals: AbortSignal[] = [];
  const pending = compact(context("gpt-responses", cancel.signal), async (ctx) => {
    seenSignals.push(ctx.signal);
    await new Promise<void>((resolve) => { ctx.signal.addEventListener("abort", () => resolve(), { once: true }); });
    ctx.signal.throwIfAborted();
    return { usage: summaryUsage };
  });
  cancel.abort(new Error("Caller disconnected"));
  await assert.rejects(pending, /Caller disconnected/);
  assert.equal(seenSignals.length, 2);
  assert.ok(seenSignals.every((signal) => signal.aborted));
});

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

test("a completed half followed by an upstream error never produces a partial checkpoint", async () => {
  for (const failingSide of ["native", "summary"]) {
    const error = new BridgeError("Native upstream detail", "upstream_error", 502, { "retry-after": "23" });
    const backend: Backend = async (ctx, writer) => {
      if (isCompactionRequest(ctx.request) === (failingSide === "native")) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw error;
      }
      if (isCompactionRequest(ctx.request)) writer.addItem(checkpoint);
      else writer.textDelta("Complete text half.");
      return { usage: summaryUsage };
    };
    await assert.rejects(compact(context(), backend), (actual) => actual === error);
  }
});
