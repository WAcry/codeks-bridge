import assert from "node:assert/strict";
import test from "node:test";
import { encodeCompaction } from "../src/carrier.ts";
import { CompactionReplayCache } from "../src/compaction-replay.ts";
import { resolveModel } from "../src/config.ts";
import type { BridgeConfig, ResolvedModel, ResponsesRequest } from "../src/types.ts";

function route(): ResolvedModel {
  return resolveModel({
    upstreams: { first: { api: "responses", base_url: "https://example.com/v1" } },
    models: { first: { upstream: "first", model: "model-a" } },
  }, "first");
}

function checkpoint(ciphertext = "synthetic-cipher", id = "cmp_synthetic") {
  return {
    type: "compaction", id,
    encrypted_content: encodeCompaction({
      v: 1, summary: "Keep the violet flag.",
      native: { key: "source-model", item: { type: "compaction", id, encrypted_content: ciphertext } },
    }),
  };
}

function request(turn = "turn-one"): ResponsesRequest {
  return {
    model: "first", client_metadata: { thread_id: "thread-one", turn_id: turn },
    input: [checkpoint()],
  };
}

test("successful fallback is visible to existing and subsequent requests in the same turn", () => {
  const cache = new CompactionReplayCache();
  const first = cache.forRequest(request(), route());
  const concurrent = cache.forRequest(request(), route());
  assert.equal(first.useSummary, false);
  assert.equal(concurrent.useSummary, false);
  assert.equal(cache.forRequest(request(), route()).useSummary, false);
  first.rememberSummary();
  assert.equal(first.useSummary, true);
  assert.equal(concurrent.useSummary, true);
  assert.equal(cache.forRequest(request(), route()).useSummary, true);
});

test("a different thread, turn, or target model retries the native checkpoint", () => {
  const cache = new CompactionReplayCache();
  const original = request();
  const target = route();
  cache.forRequest(original, target).rememberSummary();
  assert.equal(cache.forRequest(request("turn-two"), target).useSummary, false);
  assert.equal(cache.forRequest({ ...original, client_metadata: { ...original.client_metadata, thread_id: "thread-two" } }, target).useSummary, false);
  const config: BridgeConfig = {
    upstreams: { first: { ...target.upstream }, second: { ...target.upstream } },
    models: {
      model: { ...target.config, model: "model-b" },
      provider: { ...target.config, upstream: "second" },
    },
  };
  for (const slug of Object.keys(config.models)) {
    assert.equal(cache.forRequest(original, resolveModel(config, slug)).useSummary, false);
  }
  config.upstreams.first.base_url = "https://region.example.com/v1";
  config.models.endpoint = { ...target.config };
  assert.equal(cache.forRequest(original, resolveModel(config, "endpoint")).useSummary, false);
  assert.equal(cache.forRequest(original, target).useSummary, true);
});

test("target headers and both option layers separate fallback records", () => {
  const cache = new CompactionReplayCache();
  const target = route();
  cache.forRequest(request(), target).rememberSummary();
  for (const other of [
    { ...target, upstream: { ...target.upstream, headers: { "x-region": "second" } } },
    { ...target, upstream: { ...target.upstream, options: { region: "second" } } },
    { ...target, config: { ...target.config, options: { region: "second" } } },
  ]) {
    assert.equal(other.key, target.key);
    assert.equal(cache.forRequest(request(), other).useSummary, false);
  }
});

test("display aliases and object property order do not change the target identity", () => {
  const cache = new CompactionReplayCache();
  const target = route();
  target.upstream.headers = { "x-region": "first", "x-route": "second" };
  target.upstream.options = { routing: { first: 1, second: 2 } };
  target.config.options = { effort: "high", routing: ["first", "second"] };
  cache.forRequest(request(), target).rememberSummary();
  const alias: ResolvedModel = {
    ...target, slug: "alias",
    upstream: {
      ...target.upstream,
      headers: { "x-route": "second", "x-region": "first" },
      options: { routing: { second: 2, first: 1 } },
    },
    config: { ...target.config, options: { routing: ["first", "second"], effort: "high" } },
  };
  assert.equal(cache.forRequest({ ...request(), model: "alias" }, alias).useSummary, true);
});

test("checkpoint payloads and their order matter, while item IDs do not", () => {
  const cache = new CompactionReplayCache();
  const original = { ...request(), input: [checkpoint("first"), checkpoint("second")] };
  const before = structuredClone(original);
  cache.forRequest(original, route()).rememberSummary();
  assert.equal(cache.forRequest({ ...request(), input: [checkpoint("first", "cmp_new"), checkpoint("second", "cmp_other")] }, route()).useSummary, true);
  for (const input of [
    [checkpoint("first")],
    [checkpoint("second"), checkpoint("first")],
    [checkpoint("first"), checkpoint("third")],
  ]) {
    assert.equal(cache.forRequest({ ...request(), input }, route()).useSummary, false);
  }
  assert.deepEqual(original, before);
});

test("ordinary history additions and portable checkpoints do not alter native checkpoint identity", () => {
  const cache = new CompactionReplayCache();
  cache.forRequest(request(), route()).rememberSummary();
  const expanded = {
    ...request(), input: [
      checkpoint(),
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
      { type: "compaction", encrypted_content: encodeCompaction({ v: 1, summary: "Portable only." }) },
    ],
  };
  assert.equal(cache.forRequest(expanded, route()).useSummary, true);
});

test("missing or invalid turn metadata uses isolated request-local state", () => {
  for (const metadata of [
    undefined, null, [], "turn-one", {}, { thread_id: "thread-one" }, { turn_id: "turn-one" },
    { thread_id: "", turn_id: "turn-one" }, { thread_id: "thread-one", turn_id: " " },
    { thread_id: 1, turn_id: "turn-one" }, { thread_id: "thread-one", turn_id: 1 },
  ]) {
    const cache = new CompactionReplayCache();
    const input = { ...request(), client_metadata: metadata };
    const first = cache.forRequest(input, route());
    const concurrent = cache.forRequest(input, route());
    first.rememberSummary();
    assert.equal(first.useSummary, true);
    assert.equal(concurrent.useSummary, false);
    assert.equal(cache.forRequest(input, route()).useSummary, false);
  }
});

test("requests without native checkpoints cannot create shared fallback records", () => {
  const cache = new CompactionReplayCache();
  for (const input of [undefined, "Hello", [], [
    { type: "compaction", encrypted_content: encodeCompaction({ v: 1, summary: "Portable only." }) },
  ]]) {
    const value = { ...request(), input };
    const replay = cache.forRequest(value, route());
    replay.rememberSummary();
    assert.equal(replay.useSummary, true);
    assert.equal(cache.forRequest(value, route()).useSummary, false);
  }
});

test("fallback memory is bounded to 256 records with FIFO eviction", () => {
  const cache = new CompactionReplayCache();
  const oldest = cache.forRequest(request("turn-0"), route());
  oldest.rememberSummary();
  for (let i = 1; i < 256; i++) {
    cache.forRequest(request(`turn-${i}`), route()).rememberSummary();
  }
  assert.equal(cache.forRequest(request("turn-0"), route()).useSummary, true);
  assert.equal(cache.forRequest(request("turn-1"), route()).useSummary, true);
  cache.forRequest(request("turn-256"), route()).rememberSummary();
  assert.equal(cache.forRequest(request("turn-0"), route()).useSummary, false);
  assert.equal(cache.forRequest(request("turn-1"), route()).useSummary, true);
  assert.equal(cache.forRequest(request("turn-256"), route()).useSummary, true);
  assert.equal(oldest.useSummary, true);
  assert.equal(new CompactionReplayCache().forRequest(request("turn-1"), route()).useSummary, false);
});
