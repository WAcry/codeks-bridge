import assert from "node:assert/strict";
import test from "node:test";
import { encodeCompaction, encodeReasoning } from "../src/carrier.ts";
import { prepareHistory } from "../src/history.ts";
import type { ResolvedModel } from "../src/types.ts";

const route: ResolvedModel = {
  slug: "test", key: "endpoint-a/model-a", config: { upstream: "test", model: "model-a" },
  upstream: { api: "responses", base_url: "https://example.com/v1" },
};

test("reasoning is selected per request and remains available when switching back", () => {
  const input = [
    { type: "reasoning", id: "rs_a", encrypted_content: encodeReasoning(route.key, "cipher-a") },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible answer" }] },
    { type: "reasoning", encrypted_content: encodeReasoning("endpoint-b/model-b", "cipher-b") },
    { type: "reasoning", encrypted_content: "unattributed-cipher" },
  ];
  const original = structuredClone(input);
  assert.equal(prepareHistory(input, route)[0].encrypted_content, input[0].encrypted_content);
  assert.equal(prepareHistory(input, { ...route, key: "endpoint-b/model-b" })[1].encrypted_content, input[2].encrypted_content);
  assert.equal(prepareHistory(input, route).length, 2);
  assert.deepEqual(input, original);
});

test("native compaction uses its source endpoint and portable text elsewhere", () => {
  const native = { type: "compaction", id: "cmp_synthetic", encrypted_content: "native-cipher" };
  const input = [{ type: "compaction", encrypted_content: encodeCompaction({ v: 1, summary: "Keep the violet flag.", native: { key: route.key, item: native } }) }];
  const same = prepareHistory(input, route);
  assert.deepEqual(same, [native]);
  same[0].encrypted_content = "modified copy";
  assert.deepEqual(prepareHistory(input, route), [native]);
  const other = prepareHistory(input, { ...route, key: "other" });
  assert.equal(other[0].role, "user");
  assert.match(other[0].content[0].text, /Keep the violet flag\.$/);
  assert(!JSON.stringify(other).includes("native-cipher"));
  const chat = prepareHistory(input, { ...route, upstream: { ...route.upstream, api: "chat" } });
  assert.equal(chat[0].type, "message");
});

test("portable-only compaction and string input normalize to user messages", () => {
  const item = { type: "compaction", encrypted_content: encodeCompaction({ v: 1, summary: "A portable checkpoint." }) };
  assert.match(prepareHistory([item], route)[0].content[0].text, /A portable checkpoint/);
  assert.deepEqual(prepareHistory("Hello", route), [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
});

test("unattributed compaction and stored references fail instead of losing history", () => {
  assert.throws(() => prepareHistory([{ type: "compaction", encrypted_content: "unknown" }], route), /portable summary/);
  assert.throws(() => prepareHistory([{ type: "item_reference", id: "msg_stored" }], route), /complete conversation/);
});

test("images and tool call identities survive history selection", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" }] },
    { type: "function_call", call_id: "call_one", namespace: "actions", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_one", output: "done" },
  ];
  const selected = prepareHistory(input, route);
  assert.deepEqual(selected, input);
  selected[0]!.content![0].image_url = "changed";
  assert.notDeepEqual(selected, input);
});

test("agent messages retain author, recipient and ordered content on text-only APIs", () => {
  const item = {
    type: "agent_message", author: "worker-1", recipient: "parent",
    content: [
      { type: "input_text", text: "The screenshot follows." },
      { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" },
      { type: "input_text", text: "The button is visible." },
    ],
  };
  for (const api of ["chat", "anthropic"] as const) {
    const result = prepareHistory([item], { ...route, upstream: { ...route.upstream, api } });
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content[0].text, 'Agent message from "worker-1" to "parent":\n');
    assert.deepEqual(result[0].content.slice(1), item.content);
  }
  assert.deepEqual(prepareHistory([item], route), [item]);
  assert.throws(() => prepareHistory([{ ...item, content: [{ type: "encrypted_content", encrypted_content: "cipher" }] }], {
    ...route, upstream: { ...route.upstream, api: "chat" },
  }), /Encrypted agent messages/);
});
