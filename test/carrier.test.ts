import test from "node:test";
import assert from "node:assert/strict";
import { decodeCompaction, encodeCompaction, decodeReasoning, encodeReasoning } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";

const route = resolveModel(validateConfig({
  upstreams: { local: { base_url: "https://example.com/v1" } },
  models: { test: { upstream: "local", catalog: "gpt-6.1-sol", model: "test-model" } },
}), "test");
const source = route.origin;
const encoded = (prefix: string, value: unknown) => prefix + Buffer.from(JSON.stringify(value)).toString("base64url");

test("versioned envelopes preserve source facts and raw structured payloads through JSON persistence", () => {
  for (const data of ["中文:opaque:payload", { thinking: "Reason", signature: "synthetic-signature" }, { text: "Keep the flag." }]) {
    const state = { source, format: "example.reasoning.v1", data };
    const stored = JSON.parse(JSON.stringify(encodeReasoning(state)));
    assert.match(stored, /^cxbr2:/);
    assert.deepEqual(decodeReasoning(stored), state);
  }
  const checkpoint = {
    summary: "任务与下一步",
    native: { source, format: "responses.compaction.v1", data: { type: "compaction", encrypted_content: "synthetic-ciphertext" } },
  };
  const stored = JSON.parse(JSON.stringify(encodeCompaction(checkpoint)));
  assert.match(stored, /^cxbc1:/);
  assert.deepEqual(decodeCompaction(stored), checkpoint);
});

test("damaged current reasoning envelopes fail; unrelated and obsolete formats are not decoded", () => {
  for (const value of [undefined, "native-ciphertext"]) assert.equal(decodeReasoning(value), undefined);
  for (const value of [
    "cxbr2:invalid-json",
    encoded("cxbr2:", { format: "reasoning.text.v1", data: "text" }),
    encoded("cxbr2:", { source: { ...source, model: "" }, format: "reasoning.text.v1", data: "text" }),
    encoded("cxbr2:", { source, data: "text" }),
    encoded("cxbr2:", { source, format: "reasoning.text.v1" }),
  ]) assert.throws(() => decodeReasoning(value), /Malformed bridge reasoning/);
});

test("compaction requires a summary or a complete deferred handoff", () => {
  const native = { source, format: "responses.compaction.v1", data: { type: "compaction", encrypted_content: "synthetic-ciphertext" } };
  const handoff = { prefix: [], parameters: { model: "test" }, responsesLite: true };
  assert.deepEqual(decodeCompaction(encodeCompaction({ native, handoff })), { native, handoff });
  assert.deepEqual(decodeCompaction(encodeCompaction({ summary: "Complete", native, handoff })), { summary: "Complete", native, handoff });
  for (const value of [
    {}, { summary: "" }, { summary: "   " }, { native }, { handoff },
    { native, handoff: { ...handoff, prefix: [null] } },
    { native, handoff: { ...handoff, parameters: {} } },
    { native, handoff: { ...handoff, responsesLite: undefined } },
    { summary: "valid", native: { source, data: "cipher" } },
    { summary: "valid", native: { source, format: "responses.compaction.v1" } },
  ]) {
    assert.equal(decodeCompaction(encoded("cxbc1:", value)), undefined);
    assert.throws(() => encodeCompaction(value as any), /Invalid compaction/);
  }
});
