import test from "node:test";
import assert from "node:assert/strict";
import { decodeCompaction, encodeCompaction, decodeReasoning, encodeReasoning } from "../src/carrier.ts";

test("carriers survive JSON persistence without changing Unicode or punctuation", () => {
  const reasoning = { key: "model:one", payload: "中文:opaque:payload" };
  const stored = JSON.parse(JSON.stringify(encodeReasoning(reasoning.key, reasoning.payload)));
  assert.deepEqual(decodeReasoning(stored), reasoning);
  const checkpoint = { v: 1 as const, summary: "任务与下一步", native: { key: "model:one", item: { type: "compaction", encrypted_content: "synthetic-ciphertext" } } };
  assert.deepEqual(decodeCompaction(JSON.parse(JSON.stringify(encodeCompaction(checkpoint)))), checkpoint);
});
test("malformed checkpoints do not masquerade as restorable history", () => {
  for (const value of [
    { v: 2, summary: "future" }, { v: 1, summary: "" },
    { v: 1, summary: "valid", native: { key: "x" } },
    { v: 1, summary: "valid", native: { key: "x", item: { type: "message", encrypted_content: "invalid" } } },
  ]) {
    const encoded = "cxbc1:" + Buffer.from(JSON.stringify(value)).toString("base64url");
    assert.equal(decodeCompaction(encoded), undefined);
  }
});
