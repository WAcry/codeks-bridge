import assert from "node:assert/strict";
import test from "node:test";
import { encodeCompaction, encodeReasoning } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { prepareHistory } from "../src/history.ts";
import type { ModelConfig, ResolvedModel } from "../src/types.ts";

function routes(overrides: Record<string, Partial<ModelConfig>> = {}) {
  const models: Record<string, ModelConfig> = {};
  for (const slug of ["a", "b", "c"]) models[slug] = {
    upstream: "example", model: `model-${slug}`, catalog: "gpt-6.1-sol", ...overrides[slug],
  };
  models.claude = { upstream: "example", model: "example-claude", catalog: "claude-sonnet-5-5", ...overrides.claude };
  models.deepseek = { upstream: "example", model: "example-deepseek", catalog: "deepseek-flash", ...overrides.deepseek };
  const config = validateConfig({ upstreams: { example: { base_url: "https://example.com/v1" } }, models });
  return Object.fromEntries(Object.keys(models).map((slug) => [slug, resolveModel(config, slug)]));
}

function reasoning(route: ResolvedModel, data = `cipher-${route.slug}`) {
  return {
    type: "reasoning", summary: [{ type: "summary_text", text: "Visible summary" }],
    encrypted_content: encodeReasoning({ source: route.origin, format: route.profile.reasoning_format, data }),
  };
}
const native = { type: "compaction", id: "cmp_synthetic", encrypted_content: "native-cipher" };
function checkpoint(route: ResolvedModel) {
  return { type: "compaction", encrypted_content: encodeCompaction({
    summary: "Keep the violet flag.",
    native: { source: route.origin, format: route.profile.native_compaction_format!, data: native },
  }) };
}

const defaults = routes();

test("replay permissions are directional, nontransitive, and independent for reasoning and compaction", () => {
  const { a, b, c } = routes({
    b: { replay: { reasoning_from: ["a"] } },
    c: { replay: { reasoning_from: ["b"], native_compaction_from: ["a"] } },
  });
  const input = [reasoning(a), checkpoint(a)];
  assert.equal(prepareHistory(input, b)[0].type, "bridge_reasoning");
  assert.equal(prepareHistory(input, b)[1].type, "message");
  assert.deepEqual(prepareHistory(input, c), [native]);
  assert.equal(prepareHistory([reasoning(b)], a).length, 0);
  assert.equal(prepareHistory([reasoning(b)], c).length, 1);
});

test("changing policy selects existing saved history without rewriting it", () => {
  const savedReasoning = reasoning(defaults.a);
  const input = [
    savedReasoning,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible answer" }] },
    checkpoint(defaults.a),
  ];
  const original = structuredClone(input);
  assert.equal(prepareHistory(input, defaults.b)[0].role, "assistant");
  const enabled = routes({ b: { replay: { reasoning_from: ["a"], native_compaction_from: ["a"] } } }).b;
  assert.deepEqual(enabled.origin, defaults.b.origin);
  const selected = prepareHistory(input, enabled);
  assert.equal(selected.length, 3);
  assert.equal(selected[0].type, "bridge_reasoning");
  assert.equal(selected[0].state.data, "cipher-a");
  assert.deepEqual(selected[0].summary, savedReasoning.summary);
  assert.deepEqual(selected[2], native);
  selected[0].state.source.model = "modified copy";
  selected[2].encrypted_content = "modified copy";
  assert.deepEqual(input, original);
  assert.equal(prepareHistory(input, defaults.b).length, 2);
  assert.equal(prepareHistory(input, defaults.a).length, 3);
});

test("format checks keep incompatible payloads out even for an accepted source", () => {
  const wrongReasoning = { type: "reasoning", encrypted_content: encodeReasoning({
    source: defaults.a.origin, format: "anthropic.thinking.v1", data: { signature: "synthetic" },
  }) };
  const wrongNative = { type: "compaction", encrypted_content: encodeCompaction({
    summary: "Portable checkpoint.", native: { source: defaults.a.origin, format: "other.compaction.v1", data: "opaque" },
  }) };
  assert.deepEqual(prepareHistory([wrongReasoning], defaults.a), []);
  assert.match(prepareHistory([wrongNative], defaults.a)[0].content[0].text, /Portable checkpoint/);
  for (const route of [defaults.claude, defaults.deepseek]) {
    const selected = prepareHistory([reasoning(defaults.a), checkpoint(defaults.a)], route);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].type, "message");
  }
});

test("native replay can be disabled independently from compaction generation", () => {
  const disabled = routes({ a: { compaction: { native_replay: false } } }).a;
  assert.equal(disabled.compaction.mode, "dual");
  const selected = prepareHistory([checkpoint(defaults.a)], disabled);
  assert.equal(selected[0].role, "user");
  assert.match(selected[0].content[0].text, /Keep the violet flag\.$/);
  assert(!JSON.stringify(selected).includes("native-cipher"));
});

test("portable summaries and string input normalize to user messages; unknown reasoning is filtered", () => {
  const item = { type: "compaction", encrypted_content: encodeCompaction({ summary: "A portable checkpoint." }) };
  assert.match(prepareHistory([item], defaults.a)[0].content[0].text, /A portable checkpoint/);
  assert.deepEqual(prepareHistory("Hello", defaults.a), [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
  assert.deepEqual(prepareHistory([{ type: "reasoning", encrypted_content: "unattributed-cipher" }], defaults.a), []);
  assert.throws(() => prepareHistory([{ type: "reasoning", encrypted_content: "cxbr2:broken" }], defaults.a), /Malformed bridge reasoning/);
});

test("unattributed compaction and stored references fail instead of losing history", () => {
  assert.throws(() => prepareHistory([{ type: "compaction", encrypted_content: "unknown" }], defaults.a), /portable summary/);
  assert.throws(() => prepareHistory([{ type: "item_reference", id: "msg_stored" }], defaults.a), /complete conversation/);
  assert.throws(() => prepareHistory([{ type: "bridge_reasoning", state: { data: "unselected" } }], defaults.a), /Internal reasoning/);
});

test("images and tool call identities survive history selection", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" }] },
    { type: "function_call", call_id: "call_one", namespace: "actions", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_one", output: "done" },
  ];
  const selected = prepareHistory(input, defaults.a);
  assert.deepEqual(selected, input);
  selected[0]!.content![0].image_url = "changed";
  assert.notDeepEqual(selected, input);
});

test("agent messages retain author, recipient and ordered content on translated APIs", () => {
  const item = {
    type: "agent_message", author: "worker-1", recipient: "parent",
    content: [
      { type: "input_text", text: "The screenshot follows." },
      { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" },
      { type: "input_text", text: "The button is visible." },
    ],
  };
  for (const route of [defaults.claude, defaults.deepseek]) {
    const result = prepareHistory([item], route);
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content[0].text, 'Agent message from "worker-1" to "parent":\n');
    assert.deepEqual(result[0].content.slice(1), item.content);
    assert.throws(() => prepareHistory([{ ...item, content: [{ type: "encrypted_content", encrypted_content: "cipher" }] }], route), /Encrypted agent messages/);
  }
  assert.deepEqual(prepareHistory([item], defaults.a), [item]);
});
